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

No real credentials wired up yet — see `SETUP_CHECKLIST.md` for exactly
what to get and in what order. Until then it runs entirely on fixture
data (`DASHBOARD_SYNC_MODE=mock`, the default) so the whole thing can be
clicked through today. What's real right now:

- Auth (`auth.py`) — same 3-layer Google Workspace OAuth pattern as
  `sales_review_project`'s dashboard. Local dev doesn't need a real OAuth
  client at all: `DASHBOARD_DEV_BYPASS_AUTH=true` (on by default in
  `.env.example`) auto-logs-in as a fake dev user, and turns itself off
  the instant a real `GOOGLE_OAUTH_CLIENT_ID` is configured — see
  checklist step 3 for real login.
- Sync (`sync.py`) — pulls `AI Drafts Log`, `Learning Log`,
  `SOP Suggestions`, `LLM Cost Log`, `Ops Alert Log`, and
  `Missed Leads Audit`, either from spam_machine's real Sheet
  (`DASHBOARD_SYNC_MODE=live`) or from realistic fixture data
  (`fixtures.py`, the default) into a local SQLite mirror.
- Reads (`app.py` + `templates/`) — drafts list (with a per-thread detail
  page, filterable by category/provider/search), SOP suggestions list,
  cost table (daily/weekly/monthly, toggle in the UI), a Learning Log
  effectiveness view (edited-% and avg-similarity, overall/by-category/
  by-provider), missed leads audit, ops alerts list, all served from the
  mirror. Every list page has a CSV export link.
- SOP suggestion writes (`sheets_write.py`) — approve/reject/comment
  writes straight to the live Sheet, then triggers an immediate re-sync
  of that one tab. Needs `DASHBOARD_SYNC_MODE=live` and a real write
  credential — mock mode doesn't cover this path.
- Draft read/edit/approve (`gmail_write.py`, via `/drafts/{thread_id}`) —
  wired into real routes, but the underlying data is fixture text until
  the Gmail-write credential exists (see "What's stubbed" below). The UI
  shows a visible banner while that's true.
- A staleness banner (`freshness.py`) — warns if the mirror hasn't
  synced in the last 20 minutes (2 missed timer cycles) instead of
  silently showing old data as if it were current.
- Tests (`tests/`, run with `pytest`) — 36 cases covering the
  sheet-parsing logic in `sync.py`, cost aggregation in `cost_stats.py`,
  A1-notation column math in `sheets_write.py`, the staleness check in
  `freshness.py`, and full route-level integration tests
  (`test_app_routes.py`) via `DASHBOARD_DEV_BYPASS_AUTH`. All run against
  fixtures, no credentials needed. CI (`.github/workflows/dashboard-tests.yml`)
  runs this suite automatically on any push/PR touching `dashboard/`.

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
pip install -r requirements-dev.txt   # requirements.txt + pytest
pytest tests/                          # sanity check, no credentials needed
cp .env.example .env                   # defaults already run in mock mode
export $(cat .env | xargs)             # or use direnv / your usual approach
python sync.py                         # populates dashboard.db from fixtures.py
uvicorn app:app --reload --port 8010
```

That's enough to click through the whole UI with realistic fake data —
no service account, no OAuth client, no Sheet access needed. To point it
at real data, see `SETUP_CHECKLIST.md`.

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
