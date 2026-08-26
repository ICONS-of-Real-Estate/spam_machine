# Future features (parked — not being built yet)

Ideas from Kris (26 Aug 2026) to develop down the track. Recorded here so
they aren't lost, not as a spec to start building from — needs a fresh
go-ahead and answers to the open questions below before any code gets
written.

## 1. Client → sponsor prospecting + outreach campaign

- Maintain a list of clients (real estate podcasts), each with a service
  area — a town or city.
- For each client, use AI to do deep research and build a list of
  potential sponsors in that town, filtered by category — user picks from
  a list (starting categories: mortgage broker, title company, home
  insurance; "we'll do deep research on all the categories" implies more
  added over time).
- Selectable output size per client: 100 / 1,000 / 10,000 potential
  sponsors.
- Run an email campaign to the sponsor list, with several automated
  follow-ups.

Open questions before building:
- **Send path.** spam_machine's core invariant is *never auto-send, only
  draft — a human sends every email*. A cold outreach campaign to
  thousands of sponsors is a fundamentally different risk profile and
  almost certainly needs its own explicit send/approval model, not reuse
  of spam_machine's Joana-Gmail draft pipeline as-is.
- **Cost model at scale.** Deep research on 10,000 sponsors is a lot of
  LLM calls — needs a real cost estimate before picking a default list
  size.
- **Suppression / dedup.** Avoid contacting the same business twice
  across overlapping client service areas or repeat campaigns.
- **Category list.** Open-ended — start with the three named, expect more.

## 2. Maildoso sending-account analytics

- Multiple Maildoso accounts already used for sending (and would be used
  for the campaign in #1 too).
- Want to pull their data — API if one exists, otherwise the web
  interface — to analyze campaign performance and optimize for what's
  winning.

Open questions before building:
- **Does Maildoso have a real API?** Needs actual research against
  Maildoso's docs/account, not assumed from memory — same rule as the
  GHL CRM integration (don't guess API shape, verify first).
- **Definition of "winning."** Reply rate, meeting-booked rate, something
  else — needs a definition before any optimization loop can be built.

## 3. Podcast guest booking for clients

- Set a "guest avatar" per client (the kind of person who'd make a good
  guest — role, industry, market, etc.).
- Use AI to build a list of potential guests matching that avatar.
- Run outreach to that guest list, same pattern as the sponsor campaign
  (#1) — follow-ups, tracked via the Maildoso accounts (#2).

Open questions before building:
- **Guest data source.** Where does "potential guest matching an avatar"
  come from — a people/company data provider (same category as #1's
  sponsor sourcing), a podcast-guest-specific database (people who've
  already guested on similar shows), or both combined?
- **Matching criteria.** What makes someone a good guest beyond avatar
  fields — prior guesting history, follower count, relevance to the
  client's specific show topic?
- **Same send-path and suppression questions as #1** — likely the same
  underlying outreach engine (client → target list → sized list →
  campaign with follow-ups) just with a different sourcing step and a
  different target list (guests vs. sponsors). Worth designing the
  outreach engine itself as shared infrastructure across #1 and #3,
  with sourcing as the only feature-specific step.

See `research/2026-08-26_growth-features-research.md` for initial research
on data sources and tooling for all three features above.

## Likely shape

All three of these look like a new, separate app/service — closer in
spirit to the `spam_machine_dashboard` write-project already being
scaffolded than to spam_machine's Apps Script pipeline. spam_machine's
safety model (never auto-send, human reviews every draft) doesn't map
cleanly onto an automated multi-follow-up campaign to thousands of cold
contacts. #1 and #3 also share almost the same shape (source a target
list → size it → run a followed-up campaign against it) and could
plausibly be one outreach engine with two different sourcing steps,
rather than two separate features.
