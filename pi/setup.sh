#!/bin/bash
set -e

echo "=== LED Sports Ticker Setup ==="

# System deps
sudo apt-get update
sudo apt-get install -y python3-pip python3-pillow git libgraphicsmagick++-dev \
    libwebp-dev libjpeg-dev libpng-dev

# Disable audio (DMA conflict with LED matrix)
CONFIG_FILE="/boot/firmware/config.txt"
[ -f /boot/config.txt ] && CONFIG_FILE="/boot/config.txt"
if ! grep -q "dtparam=audio=off" "$CONFIG_FILE"; then
    echo "dtparam=audio=off" | sudo tee -a "$CONFIG_FILE"
fi
echo "blacklist snd_bcm2835" | sudo tee /etc/modprobe.d/blacklist-rgb-matrix.conf

# Clone and build rpi-rgb-led-matrix
cd /home/pi
if [ ! -d rpi-rgb-led-matrix ]; then
    git clone https://github.com/hzeller/rpi-rgb-led-matrix
fi
cd rpi-rgb-led-matrix
make -j4
cd bindings/python
sudo make install

# Python packages
pip3 install requests pillow

# Copy ticker files
mkdir -p /home/pi/sports-ticker
cp /home/pi/sports-ticker-src/*.py /home/pi/sports-ticker/

# Systemd service
sudo tee /etc/systemd/system/sports-ticker.service > /dev/null <<'EOF'
[Unit]
Description=Sports Ticker
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=/home/pi/sports-ticker
ExecStart=/usr/bin/python3 /home/pi/sports-ticker/ticker.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable sports-ticker
sudo systemctl start sports-ticker

echo "=== Done. Reboot for audio disable to take effect. ==="
echo "Check status: sudo systemctl status sports-ticker"
