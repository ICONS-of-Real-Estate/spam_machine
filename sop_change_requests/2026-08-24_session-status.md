# Session status — 24 Aug 2026

Everything below is now on `main` (merge commit `3b50467`, pushed). If
picking this up fresh: `git pull origin main` — no branch reconciliation
needed. The Apps Script editor's GitHub sync is confirmed pointed at
`main` (this was the root cause of most of today's confusion — see below).

## Root cause found this session: fixes weren't reaching the live project

The Apps Script editor's GitHub sync branch selector was set to `main`,
but every fix from recent sessions (this one included) had been pushed to
`claude/google-apps-script-handoff-yk0tx5` — a feature branch the live
project never pulled from. This explains the recurring "why isn't my fix
live" pattern across multiple sessions (`MAX_DRAFTS_PER_RUN` not updating,
etc.).

**Fixed by merging, not force-pushing.** `main` had 34 independent commits
not on the feature branch (countPendingAiDrafts_ REST-API fix, cache TTL
bumped to 1h, SOP suggestions batching/dedup/backlog-catchup, DriveApp
sharing fix, quota circuit breaker in runLeadFollowUpCycle, trigger cadence
changes, HANDOFF.md/CLAUDE.md, stalled bookings audit work); the feature
branch had 15 commits not on main (all listed below). Did a real `git
merge` and resolved conflicts by hand in 5 files (`Code.gs`,
`quota_guard_and_alerting.gs`, `learning_loop.gs`,
`lead_followup_sequences.gs`, `setup_all_triggers.gs`) — kept main's
version wherever both sides had independently fixed the same thing (main's
was consistently more evolved/later), layered the feature branch's unique
work on top. Verified: no leftover conflict markers, `node --check` passes
on all 5 files, no duplicate function names anywhere in the repo.

## What shipped today (now live on `main`)

1. **Kimi-vs-Anthropic cost A/B test**, per direct request ("I can add $20
   to each... can we do logging and testing to tell which works out
   cheaper"): `callLlmWithFallback()` in `quota_guard_and_alerting.gs`
   refactored to a data-driven `providers`/`order` structure;
   `LLM_COST_TEST_MODE = true` alternates which provider goes first each
   call (`nextTestPrimaryProvider_()`, Script Properties counter — exact
   50/50 split by call count, not by thread hash). New "LLM Cost Log"
   sheet tab logs every call's provider/model/token usage/estimated cost
   (`logLlmCallCost_`, `estimateCallCostUsd_`, `LLM_PRICING_PER_MTOK` —
   Kimi $0.95/$4.00/M, Anthropic Sonnet 5 $2.00/$10.00/M introductory
   through 2026-08-31, both verified via the pricing skill/WebSearch, not
   memory).
2. **Cost-per-draft attribution**, per direct request ("I want to be able
   to calculate the cost per draft"): `classifyAndDraft()` in `Code.gs`
   derives the serving provider from the response's own `model` field
   (`providerFromModel_()`) and attaches `llmProvider`/`llmCostUsd` to its
   return value; `logDraftToSheet()` writes these as two new trailing
   columns (J/K) on the existing "AI Drafts Log" tab. **Action needed**:
   add "LLM Provider" and "Estimated Cost USD" as header labels for J1/K1
   by hand — the code deliberately never touches row 1 (275+ historical
   rows already have a fixed header).
3. **Fixed a real prompt-caching bug**: `system` was being sent as a plain
   string despite a comment claiming caching was active — confirmed via
   the Anthropic Console's Caching page showing zero activity, and
   Kimi/Moonshot's cost climbing $0.47 → $43.74/day over a week as the SOP
   text grew and got resent in full on every call. Reconciled with main's
   own independent fix of the same bug during the merge — kept main's
   version, which additionally uses `ttl: "1h"` (matches the 5-min
   `runReplyDrafter` cadence better than the 5-min default TTL) and is
   confirmed correct per the caching skill (no beta header needed for 1h
   TTL on Sonnet 5).
4. **"Only draft a lead's first reply, ever"** — real production complaint
   relayed from Joana: the system was drafting 2nd replies to leads who'd
   already gotten a reply (AI-drafted or manual) from the team. Added
   `hasAlreadySentReplyTo_(leadEmail)` in `Code.gs` — checks the real Sent
   folder by lead email address (ground truth, not thread/label state,
   given known Gmail thread-ID fragmentation in this codebase) — and skips
   + labels (`LABEL_ALREADY_REPLIED_ONCE`) any thread where we've ever
   sent that lead anything before. Applies regardless of how the lead's
   message arrived (forward-alias or direct reply).
5. `MAX_DRAFTS_PER_RUN` lowered 20 → 5, citing the 43-draft burst incident
   (reconciled with main's separate 0→10 saga on the same constant during
   the merge — 5 is the value now live, matches `FOLLOWUP_DRAFT_CAP`).

## Billing/cost context (for whoever checks in on the A/B test)

- Both Kimi and Anthropic ran out of credit ~Aug 15-16 (confirmed: flat $0
  on Anthropic's own "Daily token cost" chart since Aug 16; Kimi's balance
  went negative, $125.75 total consumption). Anthropic key is Kris's API
  credit balance (console.anthropic.com), fully separate from any
  claude.ai chat subscription.
- User added $20 to both accounts today. Triggers were stopped by the user
  mid-session, then **re-enabled tonight** — `setupAllTriggers()` ran
  clean, all 9 triggers recreated (confirmed via execution log: 15-min
  `runReplyDrafter`, weekly `runLearningLoop`/audits, daily
  `generateSopSuggestions`/`runLeadFollowUpCycle`/etc., all Europe/Paris
  clock times).

## Open items / not yet done

1. **Rep-tagging for SOP-suggestion corroboration** (raised via an
   external AI's "SOP Drift" commentary, then explicitly recommended by
   Gemini): add a `rep_id` field to the Learning Log schema (source:
   `getRunningAccountEmail()`/`EXPECTED_RUN_ACCOUNT` in
   `lead_followup_sequences.gs`) and require ≥2 distinct reps'
   corroboration before `generateSopSuggestionsInner()` marks a suggestion
   "high" confidence — guards against the feedback loop over-fitting to
   one rep's personal quirks once multi-rep data (e.g. Tomás's sales
   calls) eventually joins the pipeline. **Not started** — only discovery
   done (confirmed where the account-email helper lives).
2. **"Spam Replies Feedback" Google Doc** (id
   `1nyaSzOZX2DbKP4G9xtEtPmgRkrfITz3obAfEwJbQzes`, grown to 525KB, renamed
   from "SPAM REPLIES") — flagged twice by the user as "more learning from
   Goodness," never actually read/analyzed this session. Still pending.
3. **Tomás sales-call analysis** — on hold, explicitly waiting on call
   transcriptions that don't exist yet.
4. **J1/K1 header labels** on "AI Drafts Log" — needs a human to type two
   cell values in the Sheet, code won't do it (see item 2 in "What shipped
   today" above).

## If resuming

- Add the two header labels to the "AI Drafts Log" sheet (J1/K1) if not
  already done.
- Check the "LLM Cost Log" tab after a few hours of live traffic to see
  the actual Kimi-vs-Anthropic cost comparison start filling in, and
  confirm the alternating 50/50 split is behaving as designed.
- Check a fresh `runReplyDrafter` execution log for: no repeat 2nd-reply
  drafts (the Joana fix), and `Cache check` lines showing nonzero
  `cache_read_input_tokens` on repeat calls within the same ~1h window
  (confirms the caching fix is actually landing on both providers).
- Pick up the rep-tagging feature or the "Spam Replies Feedback" doc read,
  whichever the user prioritizes next.
