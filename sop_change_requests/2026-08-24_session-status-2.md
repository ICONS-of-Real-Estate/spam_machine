# Session status — 24 Aug 2026 (evening, session 2)

Code-only session. No SOP Doc edits proposed, nothing to Find & Replace.
Filed here because that's where this repo keeps its continuity notes.

## The headline: Kimi is ~7x more expensive than Anthropic

Live balances, ~9 hours after $20 was added to each account, on a 50/50
alternating split:

| Provider | Spent in ~9h | Left |
|---|---|---|
| Kimi (Moonshot) | ~$17.58 | $2.42 |
| Anthropic | ~$2.41 | $17.59 |

This inverts the assumption written throughout the codebase — Kimi has the
cheaper headline rate ($0.95/$4.00 per MTok vs $2.00/$10.00) and was made
primary on 17 Aug partly for that reason.

**Cause not yet confirmed.** Two prime suspects, both now measurable:

1. **Billed-but-unusable Kimi calls were invisible.** `attemptLlmCall_()`
   correctly treats an HTTP 200 with no text block as a failure — that is
   kimi-k2.6's documented thinking-mode blowout, where it spends the whole
   `max_tokens` budget reasoning and never writes an answer. But the provider
   **bills** that call, and `logLlmCallCost_` was only ever called on the
   success path. So every one of those burned real credit, fell back to
   Anthropic, and appeared nowhere in the cost log. The sheet said Kimi was
   cheap; the dashboard disagreed. Fixed — see below.
2. **Prompt caching may not work on Moonshot's endpoint.** Anthropic gets an
   explicit `cache_control: {ephemeral, ttl:1h}` block on the SOP prefix and
   bills cache reads at 0.1x. The code assumes Moonshot caches automatically
   server-side. If it doesn't, Kimi re-bills the full SOP (35k chars) at full
   input price on every single call. The per-attempt token columns will now
   show this directly: compare `Cache Read Tokens` between providers.

**Caveat on any figure from this window:** Kimi's balance is nearly gone. Once
it hits zero, every Kimi-first call fails and falls back to Anthropic, so the
split silently stops being 50/50. Check the balance before trusting a number.

## What shipped

**Split test now measures quality, not just price** (per direct request):

- Every LLM *attempt* is logged to "LLM Cost Log" with a new `Outcome` column
  (`ok` / `billed_no_output` / `failed`) and `Error`. Counting only successes
  is what made the sheet disagree with the billing dashboards.
- `callLlmWithFallback()` now stamps `_servedByProvider` / `_estimatedCostUsd`
  on the response. Callers used to re-derive the provider themselves, giving
  two independent derivations of one fact that could disagree.
- `providerFromModel_()` hardened. It was `model === CONFIG.MODEL ? 'kimi' :
  'anthropic'` — an exact match against the model we *asked* for, applied to
  the string the provider *echoed back*. Any pinned variant (`kimi-k2.6-0824`)
  fell through to `'anthropic'`, attributing Kimi's spend to Anthropic in the
  exact test built to compare them. Now matches on model family, returns
  `null` rather than guessing.
- **Drafts now say which model wrote them** (per direct request) — a
  `[AI MODEL: ...]` line alongside the existing PRIORITY and SOP MODE notes,
  same DELETE-BEFORE-SENDING convention. Whoever reviews in Gmail can now
  attribute "this one's rough" to a provider. Hub Guest follow-ups get it too;
  Podcast Sales follow-ups deliberately do **not** (both steps are hardcoded
  templates with no LLM call — stamping a model on a fixed template would put
  a false data point into the comparison).
- Learning Log carries `LLM Provider` + a 0–100 `Draft Similarity %`. "Was
  Edited" alone is too blunt to compare models: a typo fix and a total rewrite
  both score `true`. Word-overlap based, not edit distance — `levenshteinRough`
  fast-exits with a sentinel 999 past a 20-char difference, so every rewritten
  draft would collapse to one value. Unit-tested.
- Daily report gained a split-test section (today + 7 days): spend, wasted
  spend, failure count, cost per draft, edit rate, avg % surviving — per
  provider. Both halves of the answer now arrive in an email nobody has to
  go looking for. **This is the thing that would have caught the 7x in hour
  one instead of hour nine.**
- `migrateAddLlmColumns()` labels the new Sheet columns. Replaces the old
  "type J1/K1 by hand" item — **run it once from the editor.**

**Trigger health check was blind in two of nine places.** `EXPECTED_TRIGGER_FUNCTIONS`
listed seven functions; `setupAllTriggers()` creates nine. `summarizeFollowUpLearning`
and `reconcileMissingDrafts` could have vanished and the daily check would still
have reported "all expected triggers present" — the exact failure it exists to
catch. Both lists now name the same ten, and `setupAllTriggers()` cross-checks
them and alerts on drift, because keeping two hand-maintained lists in sync by
memory is what broke it.

**`runStalledBookingsAudit` wired up** — weekly Monday 8 AM. It had been held
back on "prove draft quality first," but that caveat never applied: it creates
no drafts at all (no `createDraft`, no `createThreadedDraft_`, no LLM call
anywhere in the file). It reads the AI Drafts Log, checks thread recency,
writes a tab, and emails only on new findings. Monday because stalled bookings
are only actionable on a working day. Also given the Gmail quota circuit
breaker it was missing — it was the last Gmail-touching entry point without
one, which was survivable while it only ran manually.

**Small fixes:** `reconcileMissingDrafts` called `assertRunningAsJoana()` with
no caller name, so its wrong-account alert would have read "undefined fired
under the wrong account." HANDOFF.md's trigger table (wrong on four of nine
rows) and its "Anthropic / claude-sonnet-5" runtime description (wrong since
17 Aug) corrected against the code.

## Verified before commit

All 15 `.gs` files parse; no duplicate global function or const names; the
three trigger lists (scheduled / created / health-checked) agree at ten and
every target function exists exactly once; no new email-send path — all seven
`MailApp.sendEmail` calls still go to internal addresses only.
`draftSimilarityPercent` and `providerFromModel_` unit-tested (21 assertions,
all passing) including the pinned-model-variant case that was the actual bug.

## Next

1. **Run `migrateAddLlmColumns()` once** from the Apps Script editor.
2. Top up Kimi or accept the test ending — it's ~$2.42 from falling back to
   Anthropic-only and quietly invalidating the split.
3. After a day of traffic, read the daily report's split-test section. If
   Kimi's `Cache Read Tokens` are ~0 while Anthropic's are large, caching is
   the answer and Kimi's real price is its headline price on 35k tokens every
   call. If instead `billed_no_output` rows dominate, it's thinking-mode burn.
4. Still open from before: rep-tagging for SOP-suggestion corroboration; the
   525KB "Spam Replies Feedback" doc has still never been read; Tomás
   sales-call analysis (blocked on transcripts).
