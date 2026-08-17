# Icons of Real Estate — Podcast Outreach Reply Drafter

An **Apps Script** automation (V8, Europe/Paris) running inside Joana's Gmail that uses **Claude** to read podcast-outreach replies and **draft** responses in her voice. It also runs follow-up sequences, a learning loop, and an ops/monitoring layer.

> **It never sends email — it only ever creates Gmail drafts.** A human reviews and sends every one.

## Quick facts

- **Platform:** Google Apps Script (no Node/npm/build). All `.gs` files live in one shared project and share a single global `CONFIG` (in `Code.gs`) and global helpers — they must be deployed together.
- **AI:** Anthropic Messages API via `UrlFetchApp`. Model in `CONFIG.MODEL`. Key is `ANTHROPIC_API_KEY` in Script Properties.
- **Behavior is driven by a live SOP Google Doc**, not hardcoded — edit the Doc, not the code, to change drafting behavior.
- **Entry points:** `runReplyDrafter` (every 5 min), `runLeadFollowUpCycle` (daily), plus learning/report/audit jobs. All Gmail-touching entry points are gated by `assertRunningAsJoana()` and a Gmail-quota circuit breaker.

## Repo layout

| File | Role |
|---|---|
| `Code.gs` | Core: CONFIG + `runReplyDrafter` main loop, classify/draft, labels, emoji/HTML, SOP fetch+cache |
| `lead_followup_sequences.gs` | Two follow-up cadences (Podcast Sales, Hub Guest), caps, decline detection, wipes, learning digest |
| `learning_loop.gs` | Compare sent-vs-drafted; propose SOP edits (proposals only) |
| `missed_leads_audit.gs` | Find replied-but-unanswered threads (daily + 180-day weekend sweep) |
| `daily_report.gs` | Daily stats email to the team |
| `heartbeat_and_trigger_healthcheck.gs` | Stale-draft heartbeat + trigger self-verification |
| `quota_guard_and_alerting.gs` | Gmail-quota circuit breaker + ops alerting (MailApp) |
| `setup_all_triggers.gs` | One-shot creation of every scheduled trigger |
| `reconcile_missing_drafts.gs` | Clear phantom `AI-Drafted-PendingReview` labels when drafts were deleted |
| `cleanup_poisoned_emails.gs` | One-off: repair bad lead emails in the follow-up queues |
| `guest_booking_followups.gs` | Legacy/superseded guest sequence |
| `emoji_*_diagnostic.gs` | One-off emoji-corruption debug tools (reference only) |

## Docs

- **`HANDOFF.md`** — full architecture, data model, triggers, design invariants, and known issues. **Read this before editing.**

## Setup / operations

1. All files must be in the **same Apps Script project**, run under **`joana@iconsofrealestate.com`**.
2. Set `ANTHROPIC_API_KEY` in **Project Settings → Script Properties**.
3. Run `setup()` once, then `setupAllTriggers()` and `setupHeartbeatTriggers()` (each once) to register the schedule.
4. The SOP Doc, Logs spreadsheet, and State Show Directory (IDs in `CONFIG`) must be shared with the running account.
