# HANDOFF — Icons of Real Estate Podcast Outreach Reply Drafter

> Context for an incoming engineer / AI pair. Read this before editing any file.

## Branch note (23 Aug 2026)

`main`, `claude/project-codebase-review-wrrcn3`, and `claude/project-onboarding-4twkmg`
are now all at the same commit (`ac508dd`) — a merge reconciling 21 commits that had
landed on `main` (a live threading fix, a stale Zoom-link fix, opt-out detection
broadening, `stalled_bookings_audit.gs`, lock protection on the learning loop, etc.)
with everything built on `wrrcn3`/`onboarding` in parallel (prompt caching, the
self-tracked quota guard, learning-loop batching, the `sop_change_requests/` process).
Nothing was dropped from either side — see the merge commit message for the
per-file conflict reasoning. If you're picking this repo back up: pull `main`
(or `wrrcn3`) fresh rather than rebasing old local work onto either, since both
already contain each other's history as of this merge.

## What this is

A **Google Apps Script** project (V8, `Europe/Paris`) running inside **Joana's Gmail** (`joana@iconsofrealestate.com`). It is an AI email-triage-and-drafting pipeline for podcast-outreach replies. Kris operates it; Joana / Goodness review and send its output.

**The single most important invariant: it NEVER sends email. It only ever creates Gmail drafts.** A human reviews and sends every one. Do not add any auto-send path.

## End-to-end flow

1. Cold outreach invites real-estate agents to host a regional podcast; replies come back CC'd to `network@iconsofrealestate.com` / `network@ardorseo.com`.
2. `runReplyDrafter` (every 15 min) finds those replies, calls the LLM (Kimi primary, Anthropic fallback) to classify intent + draft a reply in Joana's voice per a live SOP Doc.
3. Drafts get Gmail labels (`1. Spam YES` / `2. Spam NO` / `3. Spam STOP`, `0. PRIORITY - Reply First` for hot leads, `AI-Drafted-PendingReview` tracking).
4. Joana/Goodness review and send.
5. `learning_loop.gs` compares drafted vs. sent and proposes SOP edits (proposals only, never auto-applied).
6. `lead_followup_sequences.gs` runs two follow-up cadences (Podcast Sales, Hub Guest), 2 working days apart, drafting multi-step follow-ups.
7. Ops layer (heartbeat, quota circuit-breaker, trigger health, daily report, missed-leads audit) prevents silent failure.

## Runtime & dependencies

- **Platform:** Google Apps Script (script.google.com). No Node/npm/build. Edit `.gs` files directly.
- **Manifest:** `appsscript.json` — V8, Stackdriver, Europe/Paris.
- **External API (corrected 24 Aug 2026 — this said "Anthropic, `claude-sonnet-5`", which has been wrong since 17 Aug):** every LLM call goes through `callLlmWithFallback()` in `quota_guard_and_alerting.gs`. **Kimi (Moonshot) is the PRIMARY** — `CONFIG.MODEL` = `kimi-k2.6`, via Moonshot's Anthropic-compatible endpoint, key `KIMI_API_KEY`. **Anthropic is the fallback** — `CONFIG.ANTHROPIC_FALLBACK_MODEL` = `claude-sonnet-5`, key `ANTHROPIC_API_KEY`. Both keys are Kris's own credit, and both are required.
- **Active A/B test:** `LLM_COST_TEST_MODE = true` alternates which provider is tried first, 50/50 by call count, to compare them on price *and* quality. See "Split test" below.
- **Google services:** GmailApp, MailApp, SpreadsheetApp, DocumentApp, UrlFetchApp, PropertiesService, CacheService, LockService, ScriptApp, Session, Utilities.
- **Hard invariant:** all files share ONE global `CONFIG` (in `Code.gs`) and global helpers. All files must be in the SAME Apps Script project.

### External resources (by ID — keep shared with the running account)
| Thing | ID / value | Use |
|---|---|---|
| Logs spreadsheet | `SPREADSHEET_ID = 1uDrt3WAPZR90iaPgM6wZcfN9rOXzkkuFHJ6tg_XMHHs` | all tabs |
| Live SOP Doc | `SOP_DOC_ID = 15SwaYCEXGshe_8eZ2ZzADa0fk_SkdcvuDgjgajPEhag` | system prompt (live, cached) |
| State Show Directory | `STATE_DIRECTORY_SHEET_ID = 1ULIpgYPJEhK68OespSm7yO8fzSP0OU8Y_cStb4sUHKM` | state → show |
| Hub link | `https://hub.iconsofrealestate.com/` | generic guest invite |
| Joana's Zoom | `CONFIG.BOOKING_LINK_URL` | booking CTA |

## File map

| File | Role | Scheduled |
|---|---|---|
| `Code.gs` | Core: CONFIG, `runReplyDrafter`, classify/draft, state/show match, labels, draft creation, emoji/HTML, SOP fetch+cache | 15 min |
| `lead_followup_sequences.gs` | Follow-up engine: two cadences, register/advance, caps, decline detect, wipes, `classifyAndDraftFollowUp`, `summarizeFollowUpLearning`, `runLeadFollowUpCycle` | daily 6 AM |
| `learning_loop.gs` | `runLearningLoop` (sent-vs-draft → Learning Log), `generateSopSuggestions` | weekly Sat / daily 3 AM |
| `missed_leads_audit.gs` | `runMissedLeadsAudit`, `runWeekendDeepMissedLeadsAudit` (180d) | weekly Sun + weekly Sat |
| `daily_report.gs` | `runDailyReport` → emails Kris/Tomás/Joana | daily 7 AM |
| `heartbeat_and_trigger_healthcheck.gs` | `runHeartbeatCheck` (3h-stale alert), `runTriggerHealthCheck` | hourly / daily |
| `quota_guard_and_alerting.gs` | Quota circuit breaker + `sendOpsAlert` (MailApp, separate quota) | library |
| `setup_all_triggers.gs` | `setupAllTriggers()` — creates all 10 triggers, and checks its list against the health check's | manual once |
| `reconcile_missing_drafts.gs` | `reconcileMissingDrafts()` — clear phantom labels | daily |
| `stalled_bookings_audit.gs` | `runStalledBookingsAudit()` — flags leads stalled after penciled/handed-off | weekly Mon 8 AM |
| `cleanup_poisoned_emails.gs` | One-off queue email fix (batched) | manual |
| `cleanup_learning_log_garbage.gs` | One-off cleanup for garbage Learning Log rows | manual |
| `emoji_*_diagnostic.gs` ×3 | One-off emoji-corruption debug tools (reference only) | none |
| `.clasp.json` / `.claspignore` | Fallback sync path around the broken Git UI | — |
| `sop_change_requests/` | Proposed SOP edits for a human to Find & Replace into the live Doc (see `CLAUDE.md`) | as-needed |
| `README.md` | Populated — quick facts + repo layout | — |

## Global state

- **Script Properties:** `ANTHROPIC_API_KEY`, `KIMI_API_KEY`, `LLM_COST_TEST_CALL_COUNTER`, `GMAIL_QUOTA_EXHAUSTED_DATE_PACIFIC`, `ALERT_SENT_*`, `NO_DECLINE_VARIATION_INDEX`, `FOLLOWUP_DRAFTS_CREATED_DATE/_COUNT`, `CLEANUP_PROGRESS_*`.
- **Sheet tabs (auto-created):** AI Drafts Log, Learning Log, LLM Cost Log, Skip Cache, Stalled Bookings Audit, SOP Suggestions, Missed Leads Audit, Podcast Sales Follow-Up Queue, Hub Guest Follow-Up Queue, Bens Call List, Follow-Up Learning Log, Guest Follow-Up Queue (legacy).
- **Gmail labels:** `1. Spam YES`, `1. Spam YES/Penciled`, `2. Spam NO`, `3. Spam STOP`, `AI-Drafted-PendingReview`, `AI-NeedsTeammateRouting`, `0. PRIORITY - Reply First`, `AI-Skipped-AlreadyAnsweredByTeam`, `AI-Skipped-NotPodcastOutreach`, `AI-Skipped-AlreadyRepliedOnce`.
- **Caches:** SOP text in CacheService (6h, key `SOP_FULL_TEXT`); Anthropic prompt cache via `cache_control: ephemeral`.

## Triggers (via `setupAllTriggers()`)

**Corrected 24 Aug 2026** — this table had drifted from `setup_all_triggers.gs`
on four of nine rows. What follows is read off the code, not memory.

| Function | Cadence (Europe/Paris) |
|---|---|
| `runReplyDrafter` | every 15 min (weekends: the function self-throttles to roughly hourly) |
| `runLearningLoop` | weekly Sat 9 AM |
| `generateSopSuggestions` | daily 3 AM |
| `runMissedLeadsAudit` | weekly Sun 8 AM |
| `runLeadFollowUpCycle` | daily 6 AM |
| `summarizeFollowUpLearning` | daily 8 PM |
| `runDailyReport` | daily 7 AM |
| `runWeekendDeepMissedLeadsAudit` | weekly Sat 8 AM |
| `reconcileMissingDrafts` | daily 5 AM |
| `runStalledBookingsAudit` | weekly Mon 8 AM (wired up 24 Aug 2026) |

`setupAllTriggers()` now cross-checks its own list against
`EXPECTED_TRIGGER_FUNCTIONS` in `heartbeat_and_trigger_healthcheck.gs` and
sends an ops alert if the two ever disagree — they had silently drifted apart,
leaving two of nine triggers unmonitored. **If you add a trigger, add it to
both lists.**

`runHeartbeatCheck` (hourly) + `runTriggerHealthCheck` (daily 6 AM) are created by `setupHeartbeatTriggers()`.

## Design principles (respect these)

1. **Never auto-send** — drafts only.
2. **SOP lives in a Google Doc**, fetched live + cached; hardcoded fallback if read fails. Edit the Doc, not the code, to change behavior.
3. **Self-healing:** quota circuit breaker; `reconcileFollowUpDrafts()` runs each cycle; `reconcileMissingDrafts()`; batch resume keys.
4. **Heavy defensive logging** — log every skip/decision (Kris asked for this).
5. **Wrong-account guard:** `assertRunningAsJoana()` must gate every Gmail-touching entry point.
6. **Never trust the stored "Prospect Email" column** (~27% historically poisoned) — always re-derive via `extractForwardedLeadInfo()`.

## Split test: Kimi vs Anthropic (price and quality)

**Price.** Every LLM *attempt* is logged to the "LLM Cost Log" tab with an
`Outcome`: `ok`, `billed_no_output` (HTTP 200, provider charged for it, no
usable text came back — Kimi's documented thinking-mode failure does this), or
`failed`. Counting only the `ok` rows is what made the sheet disagree with the
provider dashboards; do not go back to that. Per-draft cost also lands on the
"AI Drafts Log" (columns J/K).

**Quality.** The provider that wrote each draft is (a) printed in the draft
itself, so whoever reviews it in Gmail knows which model they are judging, and
(b) recorded on the "Learning Log" next to how heavily the draft was edited
before sending and a 0–100 "Draft Similarity %" of how much survived. Edit rate
and similarity per provider are the quality answer.

Both halves are summarised in the daily report email — today and last 7 days —
so nobody has to open a sheet to see who is winning.

**Live reading, 24 Aug 2026 (9 hours, ~50/50 split):** Kimi ~$17.58 vs
Anthropic ~$2.41. Kimi is roughly **7x more expensive per unit of work**
despite the cheaper headline rate. Cause not yet confirmed — the instrumentation
above was added specifically to answer it. Prime suspects: billed-but-unusable
Kimi calls (previously invisible), and Anthropic's explicit `cache_control`
prefix caching having no working equivalent on Moonshot's endpoint, so Kimi
re-bills the full SOP at full input price on every call.

## Known issues (verified)

- **Kimi's balance was down to ~$2.42 on 24 Aug 2026.** When it hits zero every
  Kimi-first call fails and silently falls back to Anthropic — the split stops
  being 50/50 and the comparison stops being valid. Check the balance before
  trusting any figure from that window.
- **Hardcoded personal data** (Zoom link, @iconsofrealestate.com addresses) — scrub before external sharing.
- **Caps:** `FOLLOWUP_DRAFT_CAP=100`, `FOLLOWUP_DAILY_DRAFT_CAP=100`, `CLEANUP_BATCH_SIZE=40`, wipe batch 100, `MAX_THREADS_PER_RUN=50`. ~6-min execution limit → long jobs are batched + resumable.

(Resolved as of 23 Aug 2026: the `isQuotaExceededError()`/`wipeFollowUpQueuesClean()` duplicate definitions, the double `.gs.gs` extension, and `guest_booking_followups.gs` are all gone — each now has exactly one definition/file, confirmed by grep against the live tree.)

## Suggested first tasks

1. Run `migrateAddLlmColumns()` once from the editor — labels the new
   Sheet columns (this replaces the old "type J1/K1 by hand" item).
2. Work out *why* Kimi costs ~7x Anthropic, using the per-attempt cost log.
3. Scrub hardcoded personal data before any external sharing of this repo.
