# CLAUDE.md — dashboard/ (scoped to this directory)

This subtree is a **separate Python/FastAPI application**, not part of
spam_machine's Apps Script project. The repo root's `CLAUDE.md` (Apps
Script conventions: single global scope, no Node/npm, edit `.gs` directly)
does **not** apply in here. Everything below is scoped to `dashboard/`.

## What this is

An internal review/admin dashboard for spam_machine: draft review, SOP
suggestion approve/reject/comment, and cost/ops reporting for Kris,
Joana, Goodness, and Emmanuel. It is a **write** project — unlike the
read-only dashboard pattern in the sibling `sales_review_project` repo,
this one writes back to the source Google Sheet and (once credentials
exist) to Gmail drafts.

## Architecture (mirrors `sales_review_project/tools/dashboard/`)

- **FastAPI + Jinja2**, server-rendered, no JS build step.
- **SQLite mirror** (`dashboard.db`) of the spam_machine Sheet
  (`CONFIG.SPREADSHEET_ID` in the repo root's `Code.gs`) — read-only,
  disposable, rebuilt from scratch by `sync.py` on its own systemd timer.
  The app **never** live-queries Google Sheets for reads; only `sync.py`
  touches the read path.
- **Writes bypass the mirror.** SOP suggestion approve/reject/comment
  writes go straight to the live Sheet via `sheets_write.py` using a
  separate write-capable service account, then trigger a one-tab re-sync
  so the UI reflects it immediately without waiting for the timer.
- **Gmail draft writes** (approve/edit a draft) go through `gmail_write.py`
  — **not yet wired to real credentials**. Needs a domain-wide-delegation
  service account impersonating `joana@iconsofrealestate.com` with
  `gmail.compose`/`gmail.modify` scope. Check first whether the existing
  Phase 4/Phase 8 delegation in `sales_review_project` (currently
  `gmail.readonly` only) can just have its scope extended, rather than
  provisioning a second credential from scratch — same Workspace admin
  either way.
- **Auth**: Google OAuth (Authlib), three layers — GCP consent screen set
  to Internal, `hd` claim checked against `iconsofrealestate.com`, email
  allowlist on top. Session = signed cookie, no server-side store. Same
  pattern as `sales_review_project/tools/dashboard/auth.py`.
- **Deploy**: plain systemd units on the same OVH VPS as
  `sales_review_project`'s dashboard (`vps-b3e68291.tail9f0adb.ts.net`),
  Tailscale-only bind for Phase A, no Docker, no public ports. See
  `deploy/setup_vps.sh` and `README.md`.

## Mock mode

No real credentials exist yet (see `SETUP_CHECKLIST.md` for what to get
and in what order). Until then, everything defaults to mock/bypass so
the app is genuinely usable today:

- `sync.py` pulls from `fixtures.py` instead of the real Sheets API
  (`DASHBOARD_SYNC_MODE=mock`, default) — through the *same* parsing code
  path as live mode (a fake Sheets-API-shaped object, not a separate
  branch), so mock-mode testing actually exercises the real logic.
- `app.py`'s login can be bypassed for local dev
  (`DASHBOARD_DEV_BYPASS_AUTH=true`) — guarded so it's automatically
  ignored the instant a real `GOOGLE_OAUTH_CLIENT_ID` is set, so
  configuring real login can't leave the bypass silently active.
- `gmail_write.py` mocks Gmail entirely (`GMAIL_WRITE_MODE=mock`,
  default) until the write-capable service account exists.

Keep this pattern for any new integration added before its real
credential exists — mock behind the same interface, not a parallel
"if mock" branch sprinkled through calling code.

## Conventions

- Column-name-keyed Sheet parsing, not position-keyed — tabs get columns
  added over time in the Apps Script side (see the repo root's migration
  functions like `migrateAddSopModeColumn`) and this app must survive
  that without a hand sync.
- No secrets in git: `service_account.json` (read) and
  `service_account_write.json` (write) and `.env` are gitignored — copy
  them onto the VPS by hand, same as `sales_review_project`'s
  `credentials.json`/`token.json` pattern.
- Don't add features beyond what's actually wired up. If a route reads
  data that doesn't exist yet (e.g. Gmail draft bodies before the
  write-credential exists), say so in the UI rather than faking it.
