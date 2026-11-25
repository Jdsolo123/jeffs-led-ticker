/* Jeff's Ticker desktop widget.
 *
 * Runs the ticker as a frameless always-on-top bar pinned to the bottom edge
 * of the primary screen. Spawns the Python server itself, so launching this is
 * the only step — no terminal, no browser tab.
 *
 * The server + front-end live one directory up (the repo root); this folder is
 * just the Electron shell, so node_modules stays out of the source tree.
 */
const { app, BrowserWindow, Tray, Menu, screen, shell } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');

// Repo root, one level up from widget/. Relative so the repo works wherever
// it is cloned.
const TICKER_DIR = path.resolve(__dirname, '..');
const PORT = 8491;
const URL = `http://localhost:${PORT}/?widget=1`;
const BAR_HEIGHT = 96; // 32 rows x 3px dots

let win = null;
let tray = null;
let server = null;
let settingsWin = null;
let quitting = false;

function log(...a) { console.log('[widget]', ...a); }

/** Resolve a python that exists, preferring the launcher on Windows. */
function pythonCmd() {
  return process.platform === 'win32' ? 'py' : 'python3';
}

function serverAlive() {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/', timeout: 1200 }, res => {
      res.resume();
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function ensureServer() {
  if (await serverAlive()) {
    log('server already running on', PORT);
    return true; // someone else started it (e.g. the dev preview) — reuse it
  }
  const script = path.join(TICKER_DIR, 'server.py');
  if (!fs.existsSync(script)) {
    log('ERROR: server.py not found at', script);
    return false;
  }
  server = spawn(pythonCmd(), [script], { cwd: TICKER_DIR, windowsHide: true });
  server.stdout.on('data', d => log('py:', String(d).trim()));
  server.stderr.on('data', d => log('py!:', String(d).trim()));
  server.on('exit', code => log('server exited', code));

  // Wait for it to answer rather than sleeping a fixed amount.
  for (let i = 0; i < 40; i++) {
    if (await serverAlive()) { log('server up'); return true; }
    await new Promise(r => setTimeout(r, 250));
  }
  log('ERROR: server did not come up');
  return false;
}

function barBounds() {
  const wa = screen.getPrimaryDisplay().workArea; // respects the taskbar
  return { x: wa.x, y: wa.y + wa.height - BAR_HEIGHT, width: wa.width, height: BAR_HEIGHT };
}

/* A non-resizable Windows window ignores setBounds' size (it's clamped to the
 * creation size), which pinned this to a 158x26 stub. So keep the window
 * resizable and just re-assert the bounds; min/max size does the locking. */
function place(w) {
  if (!w) return;
  const b = barBounds();
  w.setMinimumSize(100, 20);
  w.setMaximumSize(b.width, b.height);
  w.setBounds(b);
}

function createWindow() {
  const b = barBounds();
  win = new BrowserWindow({
    x: b.x, y: b.y, width: b.width, height: b.height,
    frame: false,
    transparent: false,
    backgroundColor: '#000000',
    resizable: true,       // must stay true or setBounds can't size it on Windows
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: false,   // never steals focus from what you're doing
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });

  // Above normal windows but below menus/other screen-savers.
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadURL(URL);
  win.once('ready-to-show', () => {
    win.show();
    place(win); // re-assert after show; Windows can adjust bounds on first paint
    const b = win.getBounds();
    log('bar bounds', JSON.stringify(b));
  });

  // Keep it docked if the resolution or taskbar changes.
  screen.on('display-metrics-changed', () => place(win));
  screen.on('display-added', () => place(win));
  screen.on('display-removed', () => place(win));

  win.on('close', e => {
    if (!quitting) { e.preventDefault(); win.hide(); }
  });
}

/* Sports + favorite-teams picker. A real page (not a tray submenu) — a
 * checkbox-per-team tray menu would mean 30+ item lists nested under every
 * sport. Loads the same server every other page on this port already talks
 * to, so it's plain fetch()/POST, no IPC needed. */
function openSettings() {
  if (settingsWin) { settingsWin.show(); settingsWin.focus(); return; }
  settingsWin = new BrowserWindow({
    width: 420, height: 620,
    title: "Jeff's Ticker Settings",
    backgroundColor: '#060606',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  settingsWin.setMenuBarVisibility(false);
  settingsWin.loadURL(`http://localhost:${PORT}/settings.html`);
  settingsWin.on('closed', () => { settingsWin = null; });
}

function buildTray() {
  // Use the app icon if present; Electron falls back to a default otherwise.
  const iconPath = path.join(__dirname, 'icon.png');
  tray = new Tray(fs.existsSync(iconPath) ? iconPath : path.join(__dirname, 'icon.png'));
  const menu = Menu.buildFromTemplate([
    { label: "Jeff's Ticker", enabled: false },
    { type: 'separator' },
    { label: 'Show', click: () => { win.show(); place(win); } },
    { label: 'Hide', click: () => win.hide() },
    { label: 'Reload', click: () => win.reload() },
    { label: 'Settings...', click: openSettings },
    {
      // Mouse wheel over the bar does the same thing in finer steps; this is
      // the discoverable path. Values are px/sec of scroll.
      label: 'Speed',
      submenu: [30, 40, 50, 65, 80, 100].map(v => ({
        label: `${v} px/s${v === 50 ? '  (default)' : ''}`,
        click: () => win.webContents.executeJavaScript(`window.__setSpeed && window.__setSpeed(${v})`),
      })),
    },
    {
      label: 'Start with Windows',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: m => app.setLoginItemSettings({ openAtLogin: m.checked }),
    },
    { label: 'Open full preview in browser', click: () => shell.openExternal(`http://localhost:${PORT}`) },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]);
  tray.setToolTip("Jeff's Ticker");
  tray.setContextMenu(menu);
  tray.on('click', () => (win.isVisible() ? win.hide() : win.show()));
}

// Single instance: a second launch just resurfaces the existing bar.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { win.show(); place(win); } });

  app.whenReady().then(async () => {
    const ok = await ensureServer();
    createWindow();
    if (!ok) log('starting UI anyway; it will retry once the server is up');
    try { buildTray(); } catch (e) { log('tray failed (non-fatal):', e.message); }
  });

  app.on('window-all-closed', () => { /* keep alive in the tray */ });
  app.on('before-quit', () => { quitting = true; });
  app.on('quit', () => { if (server) try { server.kill(); } catch (_) {} });
}
