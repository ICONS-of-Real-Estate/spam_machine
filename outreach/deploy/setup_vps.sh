#!/usr/bin/env bash
set -euo pipefail

# One-time setup for the outreach engine (outreach/, this repo) on the
# same OVH VPS as dashboard/ and sales_review_project's dashboard
# (vps-b3e68291.tail9f0adb.ts.net). Same style as
# dashboard/deploy/setup_vps.sh and sales_review_project's
# tools/deploy/setup_dashboard.sh -- see those for the reasoning behind
# each systemd directive. No sync timer here (unlike dashboard/) since
# this app's own SQLite db is the source of truth, not a mirror.
#
# Run this ONCE by hand, as a user with sudo, after filling in
# outreach/.env from .env.example (OAuth client, allowed emails --
# sourcing stays in mock mode until real credentials exist, see
# SETUP_CHECKLIST.md).

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="$REPO_DIR"
VENV_DIR="$APP_DIR/.venv"
SERVICE_USER="${SUDO_USER:-$(whoami)}"
ENV_FILE="/etc/outreach-engine/env"

if [[ ! -f "$APP_DIR/.env" ]]; then
  echo "Missing $APP_DIR/.env -- copy .env.example and fill in real values first." >&2
  exit 1
fi

echo "==> Installing system packages (python3, venv)"
sudo apt-get update -y
sudo apt-get install -y python3 python3-venv python3-pip

echo "==> Creating Python virtualenv at $VENV_DIR"
python3 -m venv "$VENV_DIR"
"$VENV_DIR/bin/pip" install --upgrade pip
"$VENV_DIR/bin/pip" install -r "$APP_DIR/requirements.txt"

echo "==> Copying $APP_DIR/.env to $ENV_FILE"
sudo mkdir -p /etc/outreach-engine
sudo cp "$APP_DIR/.env" "$ENV_FILE"
sudo chmod 0600 "$ENV_FILE"

echo "==> Installing outreach-engine.service"
sudo tee /etc/systemd/system/outreach-engine.service > /dev/null <<EOF
[Unit]
Description=outreach engine (FastAPI web app)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$VENV_DIR/bin/uvicorn app:app --host \${OUTREACH_BIND_HOST} --port \${OUTREACH_BIND_PORT}
Restart=always
RestartSec=5

NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ReadWritePaths=$APP_DIR
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
MemoryMax=512M

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now outreach-engine.service

echo ""
echo "==> Done."
echo "    Check the app: sudo systemctl status outreach-engine"
