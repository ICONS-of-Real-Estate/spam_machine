# outreach engine

Sponsor prospecting + podcast guest booking, per the repo root's
`FUTURE_FEATURES.md` items #1 and #3. See `CLAUDE.md` in this directory
for the architecture -- especially the note that this app's SQLite db is
real data, not a disposable mirror like `dashboard/`'s.

## Status

Early build. What's real right now:

- Clients (name + service area town) -- create and list.
- Target lists -- generate a sponsor list (by category: mortgage broker,
  title company, home insurance) or a guest list (free-text avatar
  description) at a chosen size (100/1,000/10,000), via `sourcing.py`.
- Campaigns -- define a named campaign against a target list, with
  ordered follow-up steps (delay, subject, body). CAN-SPAM check
  (`compliance.py`) flags any step missing the required unsubscribe/
  mailing-address merge fields.

What's stubbed / deliberately not built:

- **No send path.** Campaigns stay `status='draft'` forever right now --
  see `CLAUDE.md` for why that's deliberate, not unfinished.
- **Sourcing** (`sourcing.py`) runs in mock mode -- no Google Places,
  Apollo.io, or Podchaser credentials exist yet. Every generated target
  is clearly labeled `[MOCK]`.
- **Maildoso analytics** (`maildoso.py`) -- not wired to any UI. Whether
  Maildoso's API even exposes campaign performance data is still
  unconfirmed (see the file's docstring).

## Local dev

```bash
cd outreach
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements-dev.txt
pytest tests/
cp .env.example .env    # defaults already run in mock mode, no credentials needed
export $(cat .env | xargs)
uvicorn app:app --reload --port 8020
```

Open `http://127.0.0.1:8020` -- auto-logs you in (dev bypass), lets you
add a client, generate a mock target list, and build a campaign's step
sequence end to end.

## Deploy (same VPS, same style as dashboard/)

```bash
git clone <repo-url> spam_machine
cd spam_machine/outreach
# filled-in .env here (gitignored)
bash deploy/setup_vps.sh
```

Different systemd service name/port than `dashboard/` (`outreach-engine`,
port 8020 by default) so both apps run on the box at once.
