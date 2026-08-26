# What to get before this goes live

Everything in `dashboard/` runs today with zero real credentials
(`DASHBOARD_SYNC_MODE=mock`, the default — see `README.md`). This is the
checklist for flipping it to real data and real writes, in the order
you'll actually hit each blocker.

## 1. Read access (needed to show real drafts/costs/alerts/SOP suggestions)

- [ ] Create a Google Cloud service account (any existing GCP project
      the Workspace admin already uses is fine — e.g. the same one behind
      `sales_review_project`'s Phase 4/Phase 8 delegation, if convenient).
- [ ] Download its JSON key, save as `dashboard/service_account.json` on
      whatever machine runs `sync.py` (gitignored — never commit it).
- [ ] Share spam_machine's Sheet
      (`1uDrt3WAPZR90iaPgM6wZcfN9rOXzkkuFHJ6tg_XMHHs`) with that service
      account's email address, as **Viewer**.
- [ ] Set `SPAM_MACHINE_SHEET_ID` and `DASHBOARD_SYNC_MODE=live` in `.env`.
- [ ] Run `python sync.py` once by hand and confirm it prints real row
      counts instead of the mock fixture counts.

## 2. Write access (needed for SOP suggestion approve/reject/comment)

- [ ] Create a second service account (or reuse #1's, just granted more —
      kept as a separate env var/file either way so they can be split
      later without touching code).
- [ ] Download its JSON key, save as `dashboard/service_account_write.json`.
- [ ] Share the same Sheet with it as **Editor** (not just Viewer).
- [ ] Set `DASHBOARD_WRITE_SERVICE_ACCOUNT_FILE` in `.env` if using a
      different filename than the default.
- [ ] Test: approve or reject one suggestion in the UI, confirm the live
      Sheet's "SOP Suggestions" tab actually updated (Status column, plus
      new Reviewer Comment / Reviewed By / Reviewed At columns appearing).

## 3. Login (needed for anyone but you to use it)

- [ ] In Google Cloud Console: OAuth consent screen → **Internal** (not
      External) — this alone blocks any non-Workspace account from
      completing login, before the app's own `hd` check even runs.
- [ ] Create an OAuth 2.0 Client ID (Web application type).
- [ ] Add the authorized redirect URI once you know where this will be
      reachable — e.g. `https://<tailscale-hostname>/auth/callback`.
- [ ] Set `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`,
      `GOOGLE_OAUTH_REDIRECT_URI` in `.env`.
- [ ] Set `DASHBOARD_ALLOWED_EMAILS` to the real list (you, Joana,
      Goodness, Emmanuel, whoever else).
- [ ] Generate a real `DASHBOARD_SESSION_SECRET` (any long random string —
      e.g. `python3 -c "import secrets; print(secrets.token_hex(32))"`).

## 4. Deploy (same VPS as sales_review_project's dashboard)

- [ ] Confirm Tailscale is already joined on
      `vps-b3e68291.tail9f0adb.ts.net` (it should be, from the sibling
      dashboard's setup).
- [ ] `git clone`/`pull` this repo onto the box, put the two service
      account files and a filled-in `.env` in `dashboard/`.
- [ ] Run `bash deploy/setup_vps.sh` — see `README.md` for the full steps.

## 5. Gmail draft writes (separate, later step — not required for 1-4)

This is the one everything else doesn't block on. Needed only once you
want in-dashboard draft approve/edit rather than "open in Gmail" links.

- [ ] Decide: extend the scope of `sales_review_project`'s existing
      Phase 4/Phase 8 domain-wide-delegation service account (currently
      `gmail.readonly` only), or provision a brand new one. Either way
      it's a Workspace Admin console change (Security → API controls →
      Domain-wide delegation), not something done from code.
- [ ] Whichever account, it needs to impersonate
      `joana@iconsofrealestate.com` with `gmail.compose` and/or
      `gmail.modify` scope.
- [ ] Once that exists, `gmail_write.py`'s `NotImplementedError` branches
      need real implementations — flagged clearly in that file already.
