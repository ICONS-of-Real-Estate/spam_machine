# SOP doc restructuring plan (section 6 of Joana's feedback doc)

**Different shape than a normal change request in this folder.** Every other
file here is a Find & Replace diff (see `TEMPLATE.md`) — a small, surgical
text edit. Section 6 is a full structural reorganization (splitting one long
doc into tabs, adding searchable tokens, adding a color legend) that Find &
Replace can't express. This file is an instruction set for you (Kris) to
apply by hand in the Google Docs editor; there's no tool that can create
Docs tabs or bulk-recolor text from here.

## Source

Joana's feedback doc ("Feedback: Reply Drafter"), section 6 — "Documents:
make them reviewable." Her exact framing: *"The SOP doc and the suggestions
sheet are effectively unreadable right now, which is the actual reason
feedback isn't happening."*

## Target doc

Live SOP doc (`CONFIG.SOP_DOC_ID` in Code.gs):
https://docs.google.com/document/d/15SwaYCEXGshe_8eZ2ZzADa0fk_SkdcvuDgjgajPEhag/edit

**Before touching anything: File > Make a copy, and do the restructuring on
the copy first.** This doc is read live by the script on every single draft
— a mid-edit mistake (a broken heading the code searches for, e.g. `## FOLLOW-UP
DRAFTING`) breaks production immediately, not on the next deploy. Once the
copy looks right, either copy its content back into the live doc, or swap
`CONFIG.SOP_DOC_ID` to the new doc's ID (tell me if you do the latter — the
code needs the change too).

## Already done (from Joana's section 6, items 4–6) — no action needed here

Items 4 ("dedupe the daily suggestions"), 5 ("cap the daily email at top
5–10"), and most of item 6's intent were built this session:
`fingerprintSopSuggestion_()` suppresses any pattern already surfaced before
(pending, approved, or rejected — any status counts), the email is capped
to the top 5–10 with one-line summaries and direct row links, and the doc
itself now groups by confidence tier instead of coloring every line. This
file covers only the remaining, Doc-only pieces: tabs, action tokens, the
color legend, and the Status-column dropdown.

## 1. Split into Google Docs tabs

Use Docs' native tabs feature (the tab list on the left edge of the editor,
"+" to add a tab). Proposed 7 tabs, with what currently-live content moves
into each (headings below refer to the live doc's current section names):

1. **How this works / how to edit** — the intro block ("This document is
   read directly by podcast_reply_drafter.gs...", "Do not delete this doc
   or change its file ID..."), plus a short explainer of the tab structure
   itself so a first-time reader orients immediately.
2. **Categories and scripts** — "Who you're writing as", "HARD RULE — NAME
   MISMATCH", "Opening acknowledgment", "Core pitch paragraph", and every
   category section (yes_general through no_data_error). This is the tab
   that maps directly onto the new "Templates & Objections" doc (section 7)
   — cross-link the two once both exist, so an editor working in one knows
   the other exists.
3. **Formatting hard rules** — "Link formatting — hard rule", the bullet
   formatting rules, "Tone" section, "Replying to a stale/backlogged
   thread", and the general "Hard rules" section (no AI disclosure, no
   dollar figures in standard mode, no fabricated contact info).
4. **Follow-ups** — "FOLLOW-UP DRAFTING" section (all 6 patterns + style
   rules) and whatever survives of "Guest Booking Follow-Up Sequence" (see
   the deletion flagged below).
5. **Links and directory** — booking links, HUB_LINK, the State Podcast Show
   Directory reference, success-stories link. (Currently these are scattered
   inline through category text — pull the canonical link list out into one
   place here, and leave the inline category text referencing them by name
   rather than repeating the URL.)
6. **Change log** — move as-is, no content changes needed for the move
   itself (see the two deletions below, which do change its content).
7. **Deprecated / do not use** — anything superseded but worth keeping for
   history. Right now that's exactly the two blocks flagged for deletion
   below — move them here instead of deleting outright, so the change log's
   own history stays traceable.

## 2. Searchable action tokens

Add these literal, Ctrl+F-able tokens at the point in the doc where each
applies, so a reviewer can jump straight to open items instead of reading
linearly:

- `[ACTION-JOANA]` — something only Joana can decide or supply (e.g. a
  missing booking link, a tone call).
- `[ACTION-TOMAS]` — needs Tomás's input (CRM/booking-state fields, the
  cost-number policy question flagged in the Templates & Objections doc).
- `[ACTION-KRIS]` — needs a code/script change, not a doc edit.
- `[NEEDS-DECISION]` — an open question with more than one reasonable answer,
  not yet resolved either way.

Two concrete places to seed these right away, both surfaced this session:

- The Hormozi-mode cost-number question (see the Templates & Objections doc,
  "Is there a cost? — Hormozi mode" entry) → `[NEEDS-DECISION]` in the
  Categories tab, next to the Hormozi cost-question text.
- Bens' real booking link, still missing from wherever the routing logic
  reads it → `[ACTION-JOANA]` in the Links and directory tab.

## 3. Color legend (visual layer on top of the tokens, not instead of them)

Per Joana: *"Text tokens matter more than colour, because colour isn't
searchable."* So tokens above are the primary system; color is a fast-scan
layer on top, not a replacement.

- **Red** — action needed (pairs with the `[ACTION-*]` tokens)
- **Yellow** — open decision (pairs with `[NEEDS-DECISION]`)
- **Green** — live and approved
- **Grey** — deprecated (everything moved to the Deprecated tab should be
  grey by default, so its presence in the tab list itself signals "don't
  use this")
- **Bold** — a hard rule (already used this way in a few places in the live
  doc; extend it consistently once the tabs are split out)

## 4. Two stale blocks to actually delete (not just flag)

Confirmed via a live read of the doc, 4 Sep 2026 — both are exactly what
Joana's section 9.1 already called out, still unresolved:

- The **"## HORMOZI MODE OVERRIDES"** section. The doc's own change log
  claims this was removed 25 Aug 2026 as unused — it is still present, word
  for word, and still costs real tokens on every single call. The actual
  Hormozi-mode text the model receives comes from `Code.gs`'s
  `buildSopModeOverride('hormozi')` instead (confirmed current, see the
  Templates & Objections doc). Move this block to the Deprecated tab (or
  delete outright — it's redundant with the code version either way).
- The **"Guest Booking Follow-Up Sequence"** explainer section. Same change
  log entry claims this was also removed 25 Aug — also still present. It
  references `guest_booking_followups.gs`, which that same change log says
  was deleted 17 Aug. Pure human documentation, no drafting instructions in
  it — safe to move to Deprecated or delete.

## Change log entry to append (once the above is actually applied)

```
- [YYYY-MM-DD] Restructured into 7 tabs (How this works, Categories and
  scripts, Formatting hard rules, Follow-ups, Links and directory, Change
  log, Deprecated) per Joana's feedback doc section 6. Added searchable
  [ACTION-JOANA]/[ACTION-TOMAS]/[ACTION-KRIS]/[NEEDS-DECISION] tokens and a
  red/yellow/green/grey color legend. Deleted the stale HORMOZI MODE
  OVERRIDES and Guest Booking Follow-Up Sequence sections (both already
  claimed removed in the 25 Aug entry above, but were still present).
```

## Status

- [ ] Copy made, restructuring drafted on the copy
- [ ] Reviewed against this plan
- [ ] Applied to live doc (who / when)
- [ ] `CONFIG.SOP_DOC_ID` updated in Code.gs, if a new doc ID was used instead of copying content back
- [ ] Change log updated
