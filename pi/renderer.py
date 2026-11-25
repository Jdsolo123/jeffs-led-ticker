import requests, io, config
from PIL import Image, ImageDraw, ImageFont

_logo_cache = {}

def _hex_to_rgb(hex_str):
    h = hex_str.lstrip('#')
    return tuple(int(h[i:i+2], 16) for i in (0, 2, 4))

def _fetch_logo(url, size):
    if url in _logo_cache:
        return _logo_cache[url]
    try:
        r = requests.get(url, timeout=3)
        img = Image.open(io.BytesIO(r.content)).convert('RGBA')
        img = img.resize((size, size), Image.LANCZOS)
        bg = Image.new('RGBA', (size, size), (0, 0, 0, 255))
        bg.paste(img, mask=img.split()[3])
        result = bg.convert('RGB')
        _logo_cache[url] = result
        return result
    except Exception:
        img = Image.new('RGB', (size, size), (30, 30, 30))
        _logo_cache[url] = img
        return img

def _load_font(size=10):
    try:
        return ImageFont.truetype(f'{config.FONT_DIR}/6x10.bdf', size)
    except Exception:
        return ImageFont.load_default()

def render_game(game):
    H = config.ROWS
    logo_sz = config.LOGO_SIZE
    pad = 2
    font = _load_font()

    # Build score/odds text
    if game['state'] == 'in':
        score_line = f"{game['away_score']} {game['away_team']}  {game['home_team']} {game['home_score']}"
        status_line = f"Q{game['period']} {game['clock']}" if game['period'] else game['clock']
    elif game['state'] == 'post':
        score_line = f"FINAL: {game['away_team']} {game['away_score']}  {game['home_team']} {game['home_score']}"
        status_line = ''
    else:
        score_line = f"{game['away_team']} @ {game['home_team']}"
        status_line = ''

    odds_parts = []
    if game['spread'] is not None:
        s = game['spread']
        odds_parts.append(f"SPR {'+' if s > 0 else ''}{s}")
    if game['total'] is not None:
        odds_parts.append(f"O/U {game['total']}")
    if game['home_ml'] is not None:
        ml = game['home_ml']
        odds_parts.append(f"ML {'+' if ml > 0 else ''}{ml}")
    odds_line = '  '.join(odds_parts)

    # Calculate width
    dummy = Image.new('RGB', (1, 1))
    draw = ImageDraw.Draw(dummy)
    def text_w(t):
        bb = draw.textbbox((0, 0), t, font=font)
        return bb[2] - bb[0]

    content_w = max(text_w(score_line), text_w(odds_line) if odds_line else 0, text_w(game['league']))
    total_w = pad + logo_sz + pad + content_w + pad + logo_sz + pad + config.DIVIDER_W

    img = Image.new('RGB', (total_w, H), (0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Away logo
    away_logo = _fetch_logo(game['away_logo'], logo_sz)
    img.paste(away_logo, (pad, (H - logo_sz) // 2))

    # Text block
    tx = pad + logo_sz + pad
    ty = 1
    draw.text((tx, ty), game['league'], font=font, fill=(160, 160, 160))
    ty += 11
    draw.text((tx, ty), score_line, font=font, fill=(255, 255, 255))
    if status_line:
        ty += 11
        draw.text((tx, ty), status_line, font=font, fill=(200, 200, 50))
    if odds_line:
        ty += 11
        draw.text((tx, ty), odds_line, font=font, fill=(100, 200, 100))

    # Home logo
    hx = total_w - pad - logo_sz - config.DIVIDER_W
    home_logo = _fetch_logo(game['home_logo'], logo_sz)
    img.paste(home_logo, (hx, (H - logo_sz) // 2))

    # Divider
    dx = total_w - config.DIVIDER_W
    draw.line([(dx, 4), (dx, H - 4)], fill=(40, 40, 40), width=1)

    return img

def build_canvas(games):
    if not games:
        # Placeholder when no data
        img = Image.new('RGB', (config.TOTAL_WIDTH * 2, config.ROWS), (0, 0, 0))
        draw = ImageDraw.Draw(img)
        draw.text((10, 12), 'NO GAMES', font=_load_font(), fill=(80, 80, 80))
        return img
    segments = [render_game(g) for g in games]
    total_w = sum(s.width for s in segments)
    canvas = Image.new('RGB', (total_w, config.ROWS), (0, 0, 0))
    x = 0
    for seg in segments:
        canvas.paste(seg, (x, 0))
        x += seg.width
    return canvas
