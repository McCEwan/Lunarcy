#!/bin/bash
# Lunarcy server setup (run as root via Azure run-command)
set -e
export DEBIAN_FRONTEND=noninteractive
apt-get update -y -q
apt-get install -y -q python3-venv python3-pip curl gnupg debian-keyring debian-archive-keyring apt-transport-https

# app user and code
id lunarcy >/dev/null 2>&1 || useradd -r -m -d /opt/lunarcy -s /usr/sbin/nologin lunarcy
mkdir -p /opt/lunarcy/app /opt/lunarcy/data
# CODE_URL: a link to a .tar.gz of this repo (e.g. a short-lived Azure blob SAS link)
curl -fsSL "${CODE_URL:?set CODE_URL}" -o /tmp/lunarcy.tgz
rm -rf /opt/lunarcy/app.new && mkdir -p /opt/lunarcy/app.new && tar xzf /tmp/lunarcy.tgz -C /opt/lunarcy/app.new
if [ -d /opt/lunarcy/app/data/horizons_cache ]; then cp -rn /opt/lunarcy/app/data/horizons_cache /opt/lunarcy/app.new/data/ || true; fi
rm -rf /opt/lunarcy/app && mv /opt/lunarcy/app.new /opt/lunarcy/app
python3 -m venv /opt/lunarcy/venv
/opt/lunarcy/venv/bin/pip install -q --upgrade pip
/opt/lunarcy/venv/bin/pip install -q -r /opt/lunarcy/app/requirements.txt
chmod +x /opt/lunarcy/app/startup.sh
chown -R lunarcy:lunarcy /opt/lunarcy

cat > /etc/systemd/system/lunarcy.service <<'EOF'
[Unit]
Description=Lunarcy lunar landing site navigator
After=network-online.target
Wants=network-online.target

[Service]
User=lunarcy
WorkingDirectory=/opt/lunarcy/app
Environment=LUNAR_DATA_DIR=/opt/lunarcy/data
Environment=LOLA_PPD=64
Environment=PORT=8000
Environment=PATH=/opt/lunarcy/venv/bin:/usr/bin:/bin
ExecStart=/opt/lunarcy/app/startup.sh
Restart=always
RestartSec=10
TimeoutStartSec=infinity

[Install]
WantedBy=multi-user.target
EOF
sed -i 's/--host 0.0.0.0/--host 127.0.0.1/' /opt/lunarcy/app/startup.sh

# Caddy (reverse proxy; automatic HTTPS once a domain points here)
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y -q && apt-get install -y -q caddy
fi
cat > /etc/caddy/Caddyfile <<'EOF'
lunarcy.earth, www.lunarcy.earth, lunarcy-earth.canadaeast.cloudapp.azure.com {
	encode gzip
	reverse_proxy 127.0.0.1:8000
}
EOF

systemctl daemon-reload
systemctl enable --now lunarcy
systemctl restart lunarcy
systemctl enable caddy
systemctl reload caddy || systemctl restart caddy
echo "SETUP DONE"
