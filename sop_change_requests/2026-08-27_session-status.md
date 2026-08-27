# Session status — 27 Aug 2026

Everything code-related below is already on `main` and
`claude/project-review-e0u5b9` (commit `7d2a2d7`). Nothing uncommitted at
end of session. **Nothing from today has been pasted into the live Apps
Script editor yet** — see item 1.

## What shipped today

1. **Fixed false-positive blank-reply detection** (real incident: lead
   "Lisa" replied "Send more details", AI drafted a joke about receiving
   "dead air"/an empty message). Root cause: `extractProspectFreshReplyText()`
   correctly extracted the lead's real text — verified directly via the
   `gs_tests` harness, this was NOT an extraction bug like this week's
   CRLF/NFKC/quote-parsing fixes. The bug was one step downstream:
   `looksLikeBlankOrSignatureOnly_()` in `Code.gs` had no request/imperative
   words in its whitelist, so short replies like "Send more details" fell
   through to a default `true` ("looks blank") — that false flag is what
   goes into `classifyAndDraft()`'s `blankHintBlock`, which is what misled
   the LLM. Fixed by adding
   `send|share|tell|give|show|explain|details|detail|info|information|more|pricing|price|cost`
   to the whitelist regex. 8 new regression tests added
   (`gs_tests/run_tests.js`, section 8); full suite + cross-file collision
   check both pass. **Action needed: paste the updated
   `looksLikeBlankOrSignatureOnly_` function (Code.gs) into the Apps Script
   editor** — git push does not deploy.

2. **Built a concrete lead-ranking pass** against the user-supplied
   `Sales_Team__Leads_Mirror_May_2026.xlsx` (the "Remarketing" pipeline
   export — confirmed via Tomás's pipeline note below to be the most
   current/maintained one). 123 real leads (1 test row excluded), every
   funnel column (Dial 1-3, SM Outreach, Tomas Email, QC/SC Booked/Taken,
   SALE) `False` for all of them — this is the untouched backlog Tomás
   described sweeping, not a converted-client history, so no outcome data
   exists yet to learn a real ICP-fit model from. Scored instead on real
   signals already in the sheet: email domain tier (own business domain >
   known franchise domain > freemail/ISP webmail), recency, and a
   data-quality flag (caught one malformed email,
   `dbolton@kwcommercial.com.com`, double-`.com`, will bounce). Delivered
   as `ranked_leads_backlog.csv` (sent to user, not committed to the repo —
   it's PII, doesn't belong in git history). Top 25 = suggested first draft
   batch, matching the user's "only draft 25 at a time" instruction from
   the Tomás-comments Q&A. **Caveat flagged to user**: this is a proxy, not
   real ICP fit — no team-size/transaction-volume/market data exists in
   this export.

3. **Relayed Tomás's CRM pipeline feedback and got two decisions locked
   in**:
   - Pipelines today: "Icons Podcast", "Cold Calling" (created as #2
     because #1 wasn't kept updated), and others accumulated via old
     automations. **Remarketing pipeline is the most current/maintained
     one right now** — matches the Excel file in item 2. Everything
     eventually merges into the overall sales system, but lead source
     matters for understanding the lead.
   - Tomás's ask: **"the house needs organizing before you connect
     anything."**
   - **Decision 1 (user confirmed): pause ALL GHL integration work** —
     no read or write path — until Tomás confirms the pipeline cleanup is
     done. Follow-up tracking stays inside spam_machine's own sheets
     (existing Bens/Sean call-list pattern) in the meantime.
   - **Decision 2 (user confirmed): spam_machine's leads get their own
     separate "SPAM" pipeline** (vs. merging into one pipeline with
     everything else), once GHL work resumes. Matches Tomás's suggested
     split (Icons 100 / SPAM / others).

## Open items / not yet done

1. **"Spam Replies Feedback" Google Doc** (id
   `1nyaSzOZX2DbKP4G9xtEtPmgRkrfITz3obAfEwJbQzes`) — still not checked for
   new rows since the 24 Aug review (which covered through 18 Aug and
   shipped 4 SOP changes, applied 25 Aug — see
   `2026-08-24_spam-replies-feedback-review.md`). Blocked this session on
   Google Drive/Gmail connector access not being available in this
   particular Claude Code session (account-level connector was confirmed
   connected; this session just didn't have it wired in) — a fresh
   session the user opened separately (`sales_review_project`) *did* have
   both Gmail and Drive connected with no extra setup, so this should
   just work in a new chat. **First thing to try next session.**
2. **`lead_followup_sequences.gs`'s actual registration bug**
   (`registerNewPodcastSalesLeads()`, the `needsRouting !== true` condition
   that's likely suppressing most of the Podcast Sales cadence) — still
   not fixed. Was waiting on the Tomás-comments Q&A to land before
   touching cadence logic; that Q&A is now answered (3-day cadence, GHL
   tracking — now paused per above, Icons 100 defined, symmetric
   hosting cross-pivot, 25-at-a-time backlog sweep — now partially
   delivered via item 2 above). Still unimplemented in code:
   - the routing-condition bug itself
   - re-enabling Hub Guest (`HUB_GUEST_FOLLOWUPS_ENABLED = false`,
     currently a deliberate kill switch)
   - the richer Sean/Bens 2-3 day cycling logic
   - the symmetric cross-pivot (Hub Guest cold → offer hosting) — I had
     asked whether this was the intended read of Tomás's "if they are
     dead lead for podcast production, offer them hosting"; never got an
     explicit yes/no confirmation, only the original statement. Confirm
     before implementing.
3. **`followup-system-proposal.docx`** — the one-pager sent to
   Joana/Tomás — is now stale relative to Tomás's comments and today's
   pipeline feedback. Not yet revised. Revise if/when asked.
4. **Wendy-thread `AI-Skipped-AlreadyRepliedOnce` label** — flagged
   multiple times in earlier sessions as possibly needing manual removal.
   Resolution status still unconfirmed as of this session.

## If resuming

- Try the Goodness doc read again first — should just work in a fresh
  session per the `sales_review_project` example above. If it does, check
  for rows dated after 18 Aug 2026 that the 24 Aug review didn't see.
- Confirm the symmetric-cross-pivot reading before writing any
  `lead_followup_sequences.gs` code.
- Remember: nothing from today (`7d2a2d7`) is live in production until
  it's pasted into the Apps Script editor by hand.
