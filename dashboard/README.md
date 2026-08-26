# spam_machine dashboard

Internal review/admin dashboard for spam_machine: draft review, SOP
suggestion approve/reject/comment, and cost/ops reporting. See
`CLAUDE.md` in this directory for the architecture.

This is a **separate app from spam_machine's Apps Script pipeline** —
different language, different deploy target, kept in this repo as its
own top-level directory (`dashboard/`) so it never mixes into the Apps
Script global scope, while still living in the same repo/history as the
project it reports on.

## Status

Scaffold only. Not deployed, not connected to real credentials for
Gmail writes yet. What's real right now:

- Auth (`auth.py`) — same 3-layer Google Workspace OAuth pattern as
  `sales_review_project`'s dashboard.
- Sync (`sync.py`) — pulls `AI Drafts Log`, `Learning Log`,
  `SOP Suggestions`, `LLM Cost Log`, and `Ops Alert Log` from
  spam_machine's real Sheet into a local SQLite mirror.
- Reads (`app.py` + `templates/`) — drafts list, SOP suggestions list,
  cost-by-day table, ops alerts list, all served from the mirror.
- SOP suggestion writes (`sheets_write.py`) — approve/reject/comment
  writes straight to the live Sheet, then triggers an immediate re-sync
  of that one tab.

What's stubbed:

- Gmail draft read/edit/approve (`gmail_write.py`) — runs in `mock` mode
  until a Gmail-write service account exists (needs domain-wide
  delegation impersonating `joana@iconsofrealestate.com`, scoped for
  `gmail.compose`/`gmail.modify`). Check whether
  `sales_review_project`'s existing Phase 4/Phase 8 delegation can just
  have its scope extended before provisioning a new one.

## Local dev

```bash
cd dashboard
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env    # fill in real values
# Put a read-only service_account.json (Viewer on the Sheet) here.
# Put a write-capable service_account_write.json (Editor) here too.
export $(cat .env | xargs)   # or use direnv / your usual approach
python sync.py               # populate dashboard.db once
uvicorn app:app --reload --port 8010
```

## Deploy (same VPS, same style as sales_review_project's dashboard)

Same OVH box as `sales_review_project`'s read-only dashboard
(`vps-b3e68291.tail9f0adb.ts.net`), same posture: plain systemd units, no
Docker, Tailscale-only bind for Phase A (no public exposure), rebind
behind FASTPANEL's nginx once it's ready for Phase B. See
`deploy/setup_vps.sh` for the exact script (mirrors
`sales_review_project/tools/deploy/setup_dashboard.sh` almost line for
line, different service names/port so both dashboards can run at once).

```bash
git clone <repo-url> spam_machine
cd spam_machine/dashboard
# put service_account.json, service_account_write.json, and a filled-in
# .env here (all gitignored -- copy by hand, same as the sibling
# project's credentials.json/token.json pattern)
bash deploy/setup_vps.sh
```

Then:

```bash
sudo systemctl status spam-machine-dashboard
journalctl -u spam-machine-dashboard-sync.service -f
```
