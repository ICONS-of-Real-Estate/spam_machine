# What to get before this goes live

Everything in `outreach/` runs today with zero real credentials
(`OUTREACH_SOURCING_MODE=mock`, the default). This is the checklist for
flipping it to real sourcing, in the order you'll actually need it.

## 1. Login (same as dashboard/ -- do this once, applies to both apps)

If you've already done this for `dashboard/`, you likely just need a
second OAuth Client ID (or reuse the same GCP project/consent screen and
add a second redirect URI for this app's `/auth/callback`).

- [ ] GCP Console → OAuth consent screen → **Internal** (if not already).
- [ ] Create Credentials → OAuth Client ID → Web application, with this
      app's redirect URI (`https://<host>/auth/callback`, this app's port).
- [ ] Set `GOOGLE_OAUTH_CLIENT_ID`/`SECRET`/`REDIRECT_URI` and
      `OUTREACH_ALLOWED_EMAILS` in `outreach/.env`.

## 2. Sponsor sourcing (Google Places API + a contact-enrichment vendor)

- [ ] Enable the Places API (New) in the same GCP project, get an API key.
- [ ] Pick a contact-enrichment vendor -- Apollo.io was the cheaper,
      API-first option in research; confirm it actually covers small
      local businesses (title companies, local insurance agents) well,
      not just tech/SaaS, before committing to it. Get an API key.
- [ ] Price both at the 10,000-contact tier for at least one category
      before offering that list size as a real default anywhere.
- [ ] Once both exist, `sourcing.py`'s `source_sponsors()` needs a real
      implementation (currently raises `NotImplementedError` in live
      mode) -- see that file's docstring.

## 3. Guest sourcing (Podchaser API, or a confirmed Rephonic API)

- [ ] Podchaser API: podchaser.com/api, tiered pricing from $30/mo.
- [ ] Or confirm Rephonic has a real API (unconfirmed as of the initial
      research -- contact them directly) as an alternative/addition.
- [ ] Once one exists, `sourcing.py`'s `source_guests()` needs a real
      implementation.

## 4. Maildoso analytics (unconfirmed even in principle -- do this first if you want #4 to matter)

- [ ] Get a real, logged-in look at `developers.maildoso.com` (not
      another web search) to confirm whether campaign analytics
      endpoints (opens/replies/bounces) actually exist in the API.
- [ ] If yes: implement `maildoso.py`'s `get_campaign_stats()` for real,
      then build a UI page for it (deliberately not built yet).
- [ ] If no: this becomes a "scrape/automate the web interface" task
      instead, per the original ask's stated fallback.

## 5. The actual send path (a real decision, not just credentials)

Nothing above requires this, and nothing here should be built without an
explicit go-ahead -- see `CLAUDE.md`'s "No send path" section. When
you're ready, this needs actual answers to: who approves a campaign
before it sends, what per-mailbox/per-day rate limits apply, how
suppression/unsubscribe gets enforced across campaigns, and which
Maildoso mailbox(es) send which campaigns.
