# Research: sponsor prospecting, Maildoso analytics, guest booking

Initial research for the three parked features in `FUTURE_FEATURES.md`.
Web search only (no accounts/credentials tested) — treat vendor claims as
unverified marketing copy until checked against a real account. Not a
build plan, just groundwork to make the next real scoping conversation
faster.

## 1. Sponsor prospecting — sourcing the target list

The core need: given a town/city + a category (mortgage broker, title
company, home insurance, ...), get a list of real local businesses with
contact info, at a chosen scale (100 / 1,000 / 10,000).

Two different classes of tool came up, and they solve different halves
of the problem:

- **Local business discovery by category + location** — Google Places
  API (New). Search by text query or category type, filterable to a
  city/locality. Returns structured data (name, address, phone,
  category, hours, ratings) per place. This is the right tool for "find
  every mortgage broker in Austin, TX" — but Places API does **not**
  return verified decision-maker emails, just the business listing
  (phone/website, sometimes no email at all).
  [Places API overview](https://developers.google.com/maps/documentation/places/web-service/overview) ·
  [Place Search](https://developers.google.com/maps/documentation/places/web-service/legacy/search) ·
  [Place Types](https://developers.google.com/maps/documentation/places/web-service/legacy/supported_types)

- **Contact/email enrichment on top of a business list** — Apollo.io,
  ZoomInfo, People Data Labs, etc. take a company/domain and return
  verified people + emails at that company. Apollo.io is the more
  affordable, API-first, SMB-friendly option (94% email deliverability
  claimed in one comparison); ZoomInfo is priced for enterprise, bigger
  dataset, more accurate direct-dial data. Clearbit as a standalone
  product is **dead** — HubSpot acquired it in Dec 2023, sunset the
  standalone API/free tools through 2025, folded it into HubSpot Breeze
  Intelligence.
  [Apollo B2B data enrichment](https://www.apollo.io/solutions/b2b-data-enrichment) ·
  [ZoomInfo vs Apollo vs Clearbit comparison](https://intel.42agency.com/zoominfo-vs-apollo-vs-clearbit/) ·
  [B2B data provider comparison 2026](https://starnus.com/blog/best-b2b-data-providers-zoominfo-apollo-pdl)

**Likely real pipeline**: Places API (or equivalent) to find the
businesses in a town/category → Apollo.io (or similar) to resolve each
business to a real contact + verified email → AI research step (already
planned) to personalize outreach per prospect. This is a two-vendor
stack, not one API — worth pricing both at the 10,000-contact tier before
picking a default list size, since per-contact enrichment cost is where
this gets expensive fast.

**Not yet checked**: actual per-request pricing at scale for either
Places API or Apollo/ZoomInfo, and whether Apollo's data actually covers
small local businesses (title companies, local insurance agents) as well
as it covers tech/SaaS companies — Apollo's dataset skews toward
tech/B2B SaaS in most reviews found. Would need a real trial account
against a sample town/category before committing to it as the sourcing
layer.

## 2. Maildoso — API for sending + analytics

Maildoso does have a real, documented API:
[developers.maildoso.com](https://developers.maildoso.com/) (I could not
fetch this page directly — network egress to that domain is blocked from
this environment — so the following is from search-result summaries only
and needs direct verification against the real docs).

What's confirmed from search results:
- Public REST API, API key generated from account settings.
- `GET /v1/user/me` as a connectivity-check endpoint.
- Core capability is **domain/mailbox provisioning and management** —
  connecting domains, creating mailboxes, automating infrastructure setup
  ("automate your entire cold email activity").
- Also referenced: an MCP integration for automating infrastructure via
  AI workflows.
  [Maildoso API & MCP](https://maildoso.ai/blog/recommendations/automate-infrastructure-api-mcp) ·
  [Product updates](https://maildoso.ai/resources/updates)

**Not confirmed**: whether the API exposes per-campaign **performance**
data (opens, replies, bounces, deliverability/spam-placement stats) —
search results only describe provisioning/infrastructure endpoints, not
analytics endpoints. This is the actual question the feature needs
answered, and it needs a real logged-in look at
`developers.maildoso.com` (or Kris's account) rather than another search
— flagging as the #1 thing to check before scoping this feature further.
If the API doesn't expose analytics, the fallback is the web interface
(scraping/automation) mentioned as the alternative in the original ask.

## 3. Podcast guest booking — sourcing potential guests

Three relevant tools, each solving a different piece:

- **Listen Notes** — the largest podcast search index (3.8M+ podcasts,
  192M+ episodes) available as an API. Good for finding *shows* and
  *past guest appearances* by keyword/topic, including transcript/show-
  notes search. This is discovery/research, not a guest database with
  contact info per se.
  [Listen Notes API](https://www.listennotes.com/api/)

- **Podchaser API** — the most guest-data-rich option found: 11M+
  creator/guest credits, audience demographics, RSS-feed-derived contact
  emails, sponsor/brand-safety data. REST + GraphQL, three paid tiers
  ($30/mo Starter, $300/mo Professional, Enterprise custom).
  [Podchaser API](https://www.podchaser.com/api) ·
  [Podchaser Enterprise GraphQL docs](https://api-docs.podchaser.com/docs/overview/)

- **Rephonic** — positioned specifically for podcast *guest* outreach:
  25+ filters (listener count, audience location/demographics, whether a
  show accepts guests, previous guests/sponsors), compiles "target
  lists," exports to CSV, built-in pitch templates. No public API found
  in search results — appears to be a web-tool-only product; would need
  to contact them directly to confirm API availability.
  [Rephonic guest search](https://rephonic.com/podcast-guest) ·
  [Rephonic podcast database](https://rephonic.com/podcast-database)

- **PodMatch** — AI-matching platform pairing hosts and guests
  automatically, explicitly **not** an API/mass-outreach tool — it's a
  matching marketplace, opposite approach to programmatic sourcing.
  Relevant as a category comparison, not as a building block.

**Likely real pipeline**: Podchaser API (or Rephonic, pending API
confirmation) to find people who match the client's guest avatar via
topic/demographic/past-appearance filters → same AI personalization +
outreach engine as #1. Worth noting this sourcing step is genuinely
different data (media/creator database) from #1's sourcing step (local
business database) — they don't share a data vendor, only the outreach
engine downstream of sourcing.

## Compliance — applies to both #1 and #3

Both are B2B cold email at scale, which CAN-SPAM permits without prior
consent, but with hard technical/content requirements: accurate
From/To/Reply-To headers, non-deceptive subject line, a physical mailing
address in the footer, clear ad identification, a working opt-out
honored within 10 business days. Penalties run up to ~$53,088 **per
email** that violates the law (Jan 2026 inflation-adjusted figure), and
liability follows the business even if a third party (agency, tool) sent
the email on its behalf.
[Cold email compliance guide 2026](https://mailshake.com/blog/cold-email-compliance/) ·
[CAN-SPAM compliance guide 2026](https://litemail.ai/blog/can-spam-compliance-guide-for-cold-email-2026)

This needs to be a first-class design constraint for the outreach engine
(#1/#3), not an afterthought bolted on later — unsubscribe handling and
footer requirements affect the email templates and the follow-up
sequencing logic from day one.

## Open items for the next real scoping pass

1. Get a real (non-search-result) look at `developers.maildoso.com` —
   confirm whether campaign analytics endpoints exist at all.
2. Price Places API + Apollo/ZoomInfo (or equivalent) at the 10,000-
   contact tier for at least one category, to sanity-check the "10,000
   sponsors" option's real cost before it's offered as a default.
3. Confirm whether Apollo/ZoomInfo-class providers actually have good
   coverage of small local businesses (title companies, local insurance
   agents), not just tech/SaaS companies.
4. Contact Rephonic directly (or check Podchaser's docs in depth) to
   settle whether a real API exists for guest sourcing, vs. web-tool-only.
5. Decide whether #1 (sponsors) and #3 (guests) share one outreach engine
   with pluggable sourcing, or are built as two separate pipelines.
