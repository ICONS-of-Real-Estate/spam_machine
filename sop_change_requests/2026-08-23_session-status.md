# Session status — 23 Aug 2026

Snapshot of everything done in this session, for continuity if this
conversation gets compacted or picked up fresh later.

## Branch state

`main`, `claude/project-codebase-review-wrrcn3`, and
`claude/project-onboarding-4twkmg` (this session's original branch) were
reconciled — `main` and `wrrcn3` are now identical, both at commit
`096c7bc` on GitHub. 21 commits that had landed on `main` independently
(threading fix, stale Zoom-link fix, opt-out detection broadening,
`stalled_bookings_audit.gs`, lock protection on the learning loop, etc.)
were merged with everything built on `wrrcn3`/`onboarding` in parallel.
Nothing was dropped from either side — see merge commit `ac508dd` for the
per-file conflict reasoning. `HANDOFF.md` carries a "Branch note (23 Aug
2026)" callout documenting this for anyone/any session picking the repo
up next.

**If resuming work: pull `main` or `wrrcn3` fresh — don't rebase old
local checkouts onto either, they may predate this merge.**

## Training-call follow-up (Emmanuel/Hazel onboarding, 21 Aug 2026 call)

- **Recipient-swap ("fake Joana" → real lead email) issue**: confirmed
  live in Gmail that this is already fixed in code
  (`createThreadedDraft_()`) — NOT a live bug. The training taught a
  manual step that's no longer needed.
- **Live SOP Doc** (`15SwaYCEXGshe_8eZ2ZzADa0fk_SkdcvuDgjgajPEhag`):
  booking-link CTA added to `yes_has_own_podcast`; New Agent /
  Brokerage Limitations / price-curiosity scripts merged in from Joana's
  objections spreadsheet. Both confirmed applied correctly, live.
- **Process doc** ("SOP - SPAM Campaign Replies",
  `1nyaSzOZX2DbKP4G9xtEtPmgRkrfITz3obAfEwJbQzes`): one edit still
  pending — a To/CC review-step note. Proposed in a Google Doc
  (`1NLwtnp-AjZVcWU_cUpkKuJS3ShTOA0zl1AaP0gg2MP8`, "SOP Change Request —
  22 Aug 2026"). **Joana was emailed about this** (23 Aug, CC Kris/Tomás)
  — not yet applied as of this writing.
- **Monday-morning email to Emmanuel/Hazel**: drafted and sent (user
  confirmed "I sent the email") — covers the recipient-swap non-issue,
  the two SOP additions, and the GHL Chrome-extension reminder.
- **GHL Chrome-extension onboarding gap**: flagged (auto-BCC-to-CRM only
  works via a browser extension on Joana's side; Emmanuel/Hazel need it
  too) — mentioned in the Monday email, no separate onboarding doc
  written yet.

## Trigger changes (`setup_all_triggers.gs`, `Code.gs`)

- `runReplyDrafter`: slowed from every 5 min to every 15 min — confirmed
  live that a capped-out run (`MAX_PENDING_DRAFTS_IN_FOLDER`) still costs
  a quota-check call + a `GmailApp.search()` over hundreds of threads
  before bailing; wasteful when the queue outpaces review.
- **Weekend throttle**: `runReplyDrafter()` now no-ops 3 of every 4
  15-min firings on Sat/Sun (keeps only the one per hour), giving an
  effective ~hourly cadence on weekends with the same single trigger —
  Apps Script has no native day-restricted interval trigger.
- User has run `setupAllTriggers()` twice this session (once before the
  15-min change, once after) — confirmed clean in the Executions log
  both times, no errors, no "Other user" rows.

## Documentation fixes

- `HANDOFF.md`: file map, "Known issues", and "Suggested first tasks"
  were stale (referenced files/duplicates that no longer exist —
  `cleanup_poisoned_emails.gs.gs`, `wipe_followup_queues.gs`,
  `guest_booking_followups.gs`). Cleaned up to match the actual current
  tree.
- `sop_change_requests/` process established (`TEMPLATE.md` +
  this file's sibling `2026-08-22_training-call-followup.md`) for any
  future proposed SOP edit, since no tool here can write into an
  existing Google Doc's body directly.

## Open items (not done, no action taken)

1. Process-doc To/CC edit (Change 3) — Joana notified, not yet applied.
2. `runStalledBookingsAudit` — exists (`stalled_bookings_audit.gs`,
   merged in from `main`), deliberately NOT wired to a trigger yet.
   Wiring it in is a judgment call for Kris/Joana once draft quality is
   proven out manually.
3. Scrubbing hardcoded personal data before external sharing — explicitly
   skipped per direct request ("3. Skip").
4. No fresh review yet of the *new* features that came in from `main`'s
   21 commits (hardened Hub Guest no_decline classification, "Needs
   Classification Review" tab) — those were built by whoever worked on
   `main`, not analyzed as part of this session's training-call work.
