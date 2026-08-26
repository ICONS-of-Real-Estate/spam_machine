#!/usr/bin/env bash
set -euo pipefail

# One-time setup for the spam_machine dashboard (dashboard/, this repo)
# on the same OVH VPS as sales_review_project's read-only dashboard
# (vps-b3e68291.tail9f0adb.ts.net). Installs Python deps into their own
# venv and registers two systemd units:
#   spam-machine-dashboard.service       - the FastAPI web app (uvicorn)
#   spam-machine-dashboard-sync.service/.timer - Sheet -> SQLite mirror, every 10min
#
# Matches sales_review_project/tools/deploy/setup_dashboard.sh's style
# exactly (same box, same FASTPANEL/Tailscale posture, same systemd
# hardening) -- see that file for the reasoning behind each directive.
# This app binds to a DIFFERENT port (8010 vs sales-dashboard's 8000) so
# both can run on the box at once.
#
# Run this ONCE by hand, as a user with sudo, after:
#   1. Creating a READ-ONLY Google service account key, saved at
#      dashboard/service_account.json, shared onto the spam_machine Sheet
#      as Viewer. Used by sync.py.
#   2. Creating a WRITE-CAPABLE Google service account key, saved at
#      dashboard/service_account_write.json, shared onto the spam_machine
#      Sheet as Editor. Used by sheets_write.py for SOP suggestion
#      approve/reject/comment. Can be the same account as #1 with Editor
#      instead of Viewer, kept as a separate file so they can be split
#      onto different accounts later without code changes.
#   3. Setting up a Google OAuth client (Internal consent screen) and
#      filling in dashboard/.env from dashboard/.env.example.
#   4. Installing and joining Tailscale on this box, if not already done
#      for sales_review_project's dashboard.

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="$REPO_DIR"
VENV_DIR="$APP_DIR/.venv"
SERVICE_USER="${SUDO_USER:-$(whoami)}"
ENV_FILE="/etc/spam-machine-dashboard/env"

if [[ ! -f "$APP_DIR/service_account.json" ]]; then
  echo "Missing $APP_DIR/service_account.json (read-only, Viewer on the Sheet)." >&2
  echo "See dashboard/CLAUDE.md and .env.example for what's needed." >&2
  exit 1
fi
if [[ ! -f "$APP_DIR/service_account_write.json" ]]; then
  echo "Missing $APP_DIR/service_account_write.json (write-capable, Editor on the Sheet)." >&2
  exit 1
fi
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
sudo mkdir -p /etc/spam-machine-dashboard
sudo cp "$APP_DIR/.env" "$ENV_FILE"
sudo chmod 0600 "$ENV_FILE"

echo "==> Installing spam-machine-dashboard.service (the web app)"
sudo tee /etc/systemd/system/spam-machine-dashboard.service > /dev/null <<EOF
[Unit]
Description=spam_machine dashboard (FastAPI web app)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$VENV_DIR/bin/uvicorn app:app --host \${DASHBOARD_BIND_HOST} --port \${DASHBOARD_BIND_PORT}
Restart=always
RestartSec=5

# Hardening, same reasoning as sales_review_project's
# tools/deploy/setup_dashboard.sh -- deliberately NO ProtectHome=yes (it
# reliably breaks exec under this box's venv layout even with a matching
# ReadWritePaths= override).
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ReadWritePaths=$APP_DIR
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
MemoryMax=512M

[Install]
WantedBy=multi-user.target
EOF

echo "==> Installing spam-machine-dashboard-sync.service + .timer (Sheet -> SQLite, every 10min)"
sudo tee /etc/systemd/system/spam-machine-dashboard-sync.service > /dev/null <<EOF
[Unit]
Description=Pull spam_machine's Sheet into the local SQLite mirror for the dashboard
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=$SERVICE_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$VENV_DIR/bin/python $APP_DIR/sync.py
Nice=10

[Install]
WantedBy=multi-user.target
EOF

sudo tee /etc/systemd/system/spam-machine-dashboard-sync.timer > /dev/null <<EOF
[Unit]
Description=Run spam-machine-dashboard-sync every 10 minutes

[Timer]
OnBootSec=1min
OnUnitActiveSec=10min

[Install]
WantedBy=timers.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now spam-machine-dashboard-sync.timer
sudo systemctl start spam-machine-dashboard-sync.service   # populate dashboard.db before the app starts
sudo systemctl enable --now spam-machine-dashboard.service

echo ""
echo "==> Done."
echo "    Edit $ENV_FILE if bind host/port needs to change, then:"
echo "      sudo systemctl restart spam-machine-dashboard"
echo "    Check the app:    sudo systemctl status spam-machine-dashboard"
echo "    Check the sync:   journalctl -u spam-machine-dashboard-sync.service -f"
echo "    Force a sync now: sudo systemctl start spam-machine-dashboard-sync.service"
