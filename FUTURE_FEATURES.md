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

## Likely shape

Both of these look like a new, separate app/service — closer in spirit to
the `spam_machine_dashboard` write-project already being scaffolded than
to spam_machine's Apps Script pipeline. spam_machine's safety model (never
auto-send, human reviews every draft) doesn't map cleanly onto an
automated multi-follow-up campaign to thousands of cold contacts.
