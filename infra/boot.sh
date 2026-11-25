# First-boot setup for the chaat-mix VM (Ubuntu 24.04). ensure.sh prepends the env file and a shebang.
set -euo pipefail
set -a; . /etc/chaat-mix.env; set +a
# Keep a boot log and upload it to the bucket when this script ends (success or failure): SSH is closed,
# so <STATE_PAR_URL>/boot.log is how to see what happened.
exec > >(tee -a /var/log/chaat-boot.log) 2>&1
trap 'echo "boot.sh exit $?"; curl -fsS -X PUT --data-binary @/var/log/chaat-boot.log "${STATE_PAR_URL%/}/boot.log" || true' EXIT
chmod 600 /etc/chaat-mix.env
set -x # trace from here on: after loading the env file, so no secret lands in the log

# 1 GB RAM on the free AMD shape: swap so npm install and the build don't run out of memory.
if [ ! -f /swapfile ]; then
	fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
	echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# Oracle's Ubuntu images block every inbound port except 22 in iptables; open web traffic.
# Insert at the top: a fixed position breaks if the image ships fewer rules.
iptables -I INPUT -m state --state NEW -p tcp -m multiport --dports 80,443 -j ACCEPT
netfilter-persistent save

# Node 24 (not 25+: SvelteKit's build logger crashes there), Caddy from Ubuntu's own archive, git.
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt-get install -y nodejs caddy git

# Point the DuckDNS name at this VM now and every 5 minutes (the IP changes on rebuild).
cat > /usr/local/bin/chaat-duckdns <<'EOF'
#!/bin/bash
set -a; . /etc/chaat-mix.env; set +a
curl -fsS "https://www.duckdns.org/update?domains=${DUCKDNS_SUBDOMAIN}&token=${DUCKDNS_TOKEN}&ip=" > /dev/null
EOF

# Pull and rebuild when main changes; the VM updates itself, so nothing needs SSH.
cat > /usr/local/bin/chaat-update <<'EOF'
#!/bin/bash
set -euo pipefail
exec 9>/run/chaat-update.lock; flock -n 9 || exit 0
cd /opt/chaat-mix
runuser -u chaat -- env HOME=/home/chaat git fetch -q origin main
[ "$(runuser -u chaat -- env HOME=/home/chaat git rev-parse HEAD)" = "$(runuser -u chaat -- env HOME=/home/chaat git rev-parse origin/main)" ] && [ "${1:-}" != force ] && exit 0 # as chaat: git refuses repos owned by another user
runuser -u chaat -- env HOME=/home/chaat git reset -q --hard origin/main
cd app && runuser -u chaat -- env HOME=/home/chaat npm ci --no-audit --no-fund && runuser -u chaat -- env HOME=/home/chaat npm run build
systemctl restart chaat-mix
EOF

# Back up Caddy's certificates daily so a rebuild reuses them (Let's Encrypt: 5 duplicate certs per 7 days).
cat > /usr/local/bin/chaat-backup-certs <<'EOF'
#!/bin/bash
set -a; . /etc/chaat-mix.env; set +a
tar czf - -C /var/lib/caddy .local/share/caddy | curl -fsS -X PUT --data-binary @- "${STATE_PAR_URL%/}/caddy.tgz" > /dev/null
EOF
chmod 755 /usr/local/bin/chaat-duckdns /usr/local/bin/chaat-update /usr/local/bin/chaat-backup-certs

cat > /etc/cron.d/chaat-mix <<'EOF'
*/5 * * * * root /usr/local/bin/chaat-duckdns
*/5 * * * * root /usr/local/bin/chaat-update >> /var/log/chaat-update.log 2>&1
17 4 * * * root /usr/local/bin/chaat-backup-certs
EOF
/usr/local/bin/chaat-duckdns || true

# App
id chaat >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin chaat
mkdir -p /var/lib/chaat-mix && chown chaat /var/lib/chaat-mix
[ -d /opt/chaat-mix ] || { mkdir -p /opt/chaat-mix && chown chaat /opt/chaat-mix && runuser -u chaat -- env HOME=/home/chaat git clone -q "$REPO_URL" /opt/chaat-mix; }

cat > /etc/systemd/system/chaat-mix.service <<'EOF'
[Unit]
Description=chaat-mix
After=network-online.target
Wants=network-online.target

[Service]
User=chaat
WorkingDirectory=/opt/chaat-mix/app
EnvironmentFile=/etc/chaat-mix.env
Environment=HOST=127.0.0.1 PORT=3000 STATE_FILE=/var/lib/chaat-mix/state.json
ExecStart=/usr/bin/node build
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable chaat-mix
/usr/local/bin/chaat-update force

# Caddy: restore saved certificates first, then serve HTTPS in front of the app.
if curl -fsS "${STATE_PAR_URL%/}/caddy.tgz" -o /tmp/caddy.tgz; then
	mkdir -p /var/lib/caddy && tar xzf /tmp/caddy.tgz -C /var/lib/caddy && chown -R caddy:caddy /var/lib/caddy
fi
cat > /etc/caddy/Caddyfile <<EOF
${PUBLIC_URL#https://} {
	reverse_proxy 127.0.0.1:3000
}
EOF
systemctl restart caddy
