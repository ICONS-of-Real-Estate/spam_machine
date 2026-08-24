# CLAUDE.md — guidance for working in this repo

Google Apps Script automation that drafts podcast-outreach replies with Claude inside Joana's Gmail. **Read `HANDOFF.md` first** for full architecture, then `README.md`, then `Code.gs` (global CONFIG) and `setup_all_triggers.gs` (schedule).

## Critical invariants — do not violate

- **NEVER sends email. It only ever creates Gmail drafts.** A human reviews and sends every one. Never add an auto-send path.
- **One global scope.** All `.gs` files live in a single Apps Script project and share a global `CONFIG` and global helpers. Never redefine an existing global function name in a second file — a duplicate silently shadows the real one and has caused real bugs here.
- **SOP lives in a Google Doc** fetched at runtime (cached). Edit the Doc, not the code, to change drafting behavior. Don't hardcode SOP text.
- **Proposing an SOP change:** no available tool can edit the live Google Doc's body in place (only read/download + file-metadata rename exist here) — so don't describe the edit in chat and stop there. Write a file under `sop_change_requests/` (see `TEMPLATE.md`) with the target doc's live link, the exact search text, the exact replacement text, and the change-log line to append. A human applies it via Find & Replace; Google Docs' version history captures the diff.
- **Every Gmail-touching entry point** must call `assertRunningAsJoana()` first and respect the `isGmailQuotaExhausted()` circuit breaker.
- **Never trust the stored "Prospect Email" column** (~27% historically poisoned). Always re-derive the real lead email from the thread via `extractForwardedLeadInfo()`.
- **Keep the heavy defensive `Logger.log` lines** — the owner explicitly wants every skip/decision logged.

## Environment

- Google Apps Script (V8), timezone **Europe/Paris**. No Node/npm/build — edit `.gs` directly.
- LLM calls all go through `callLlmWithFallback()` (`quota_guard_and_alerting.gs`) via `UrlFetchApp`. **Kimi/Moonshot is primary** (`CONFIG.MODEL`, key `KIMI_API_KEY`); **Anthropic is the fallback** (`CONFIG.ANTHROPIC_FALLBACK_MODEL`, key `ANTHROPIC_API_KEY`). Both keys required. An A/B test comparing them on price and quality is currently active — if you touch that call path, keep every attempt logged to the "LLM Cost Log" tab, including billed-but-unusable ones.
- Runs as `joana@iconsofrealestate.com`.
- Git author identity is configured **repo-local** (`Kris <kris@iconsofrealestate.com>`) — use it as-is.
- **Do NOT push to origin** unless explicitly asked — commit locally and leave pushing to the user.

## Conventions

- Match the existing style: plain ES6 `.gs`, extensive `Logger.log`, header comments explaining *why* a change was made (with dates), not just *what*.
- Long-running jobs are **batched + resumable** (Apps Script ~6-min limit) — keep that pattern.
- Caps/thresholds live as named `const`s at the top of their file, not scattered magic numbers.
