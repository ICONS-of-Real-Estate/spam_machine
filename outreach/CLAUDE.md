# CLAUDE.md — outreach/ (scoped to this directory)

This subtree is a **separate Python/FastAPI application**, unrelated to
spam_machine's Apps Script project and to `dashboard/`'s architecture.
The repo root's `CLAUDE.md` (Apps Script conventions) does not apply
here. `dashboard/CLAUDE.md`'s conventions don't automatically apply here
either, though several patterns are deliberately copied (see below).
Everything below is scoped to `outreach/`.

## What this is

The sponsor-prospecting + podcast-guest-booking engine described in the
repo root's `FUTURE_FEATURES.md` (items #1 and #3) -- one engine, two
sourcing paths, sharing the same target-list -> campaign shape. Per an
explicit product decision: **client → target list (sponsors or guests,
AI-researched) → sized list (100/1,000/10,000) → campaign with follow-up
steps.** This app builds and stores that; it does **not** send anything
yet (see "No send path" below).

## Critical difference from dashboard/ — read this before touching db.py

`dashboard/`'s SQLite file is a **disposable mirror**, rebuilt from
scratch from a Google Sheet on a timer -- the Sheet is the source of
truth, and the db can be deleted and regenerated at any time with zero
data loss.

**This app's SQLite file is the opposite: it IS the source of truth.**
Clients, target lists, targets, and campaigns are created here and exist
nowhere else. Never write a "rebuild from scratch" sync script against
this database the way `dashboard/sync.py` does against its mirror --
that would be silent, permanent data loss here. If a future GHL CRM
integration is added, it should sync data INTO this db (or vice versa),
not replace this db's role as the record of what target lists/campaigns
exist.

## No send path (deliberate, not a gap to quietly fill)

Campaigns only ever reach `status='draft'` here. There is no code
anywhere in this app that sends an email. This is intentional, not an
oversight to "finish": per `FUTURE_FEATURES.md`, a cold campaign to
thousands of sponsors/guests is a fundamentally different risk profile
from spam_machine's Joana-drafts-reviewed-by-a-human pipeline, and needs
its own explicit decision about what "send" even means here (who
approves, what rate limits, which Maildoso mailbox) before any send code
gets written. Don't add a send button or a "go live" action without that
decision being made explicitly by the user first.

## CAN-SPAM compliance is a day-one constraint, not a later pass

`compliance.py` checks every campaign step for `{{unsubscribe_link}}`
and `{{mailing_address}}` merge-field placeholders and flags steps
missing them directly in the UI. Keep this check (and probably others --
non-deceptive subject lines, opt-out honored within 10 business days --
once a send path exists to check against) wired in from the start of any
new campaign-related feature, not added after the fact.

## Mock mode

No real sourcing credentials exist (`sourcing.py`, `OUTREACH_SOURCING_MODE=mock`
default) and Maildoso analytics access is unconfirmed even in principle
(`maildoso.py`, not wired to any UI yet). See
`SETUP_CHECKLIST.md`/`sourcing.py`'s docstring for what real
credentials this needs later, and
`../research/2026-08-26_growth-features-research.md` for the underlying
research. Same mock/live pattern as `dashboard/`'s `gmail_write.py` and
`sync.py`, and `qc-pipeline`'s `hub_client.py` -- keep using it for any
new integration added before its real credential exists.

## Conventions copied from dashboard/ (deliberately, for consistency)

- `DASHBOARD_DEV_BYPASS_AUTH`-style pattern here as
  `OUTREACH_DEV_BYPASS_AUTH`, same safety rail (ignored once
  `GOOGLE_OAUTH_CLIENT_ID` is set).
- Same 3-layer Google Workspace OAuth (`auth.py`) -- copied rather than
  imported from `dashboard/auth.py` since these are separate apps; see
  that file's docstring.
- Same deploy style: plain systemd units on the same VPS
  (`vps-b3e68291.tail9f0adb.ts.net`), Tailscale-only bind, no Docker.
  Different service name/port than `dashboard/` so both run at once.
- Env vars are namespaced `OUTREACH_*` here vs. `DASHBOARD_*` there, to
  keep the two apps' config unambiguous even if ever inspected together.
