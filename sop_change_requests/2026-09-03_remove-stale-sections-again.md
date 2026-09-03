# SOP change request — actually remove the stale sections this time

## Source

Joana's written feedback doc, section 9.1: "The change log says things
were removed that are still in the document. The 25 Aug entry says the
'HORMOZI MODE OVERRIDES' section and the 'Guest Booking Follow-Up Sequence'
section were both removed as stale... Both sections are still there. The
Guest Booking section also still references guest_booking_followups.gs,
which the same change log says was deleted on 17 Aug. Either the removal
never happened or it was reverted, but as written the doc contradicts
itself."

Confirmed by reading the live doc directly: the change log's 25 Aug 2026
entry claims both removals happened, but both sections are still present,
word for word, exactly as an earlier `sop_change_requests/2026-08-25_remove-stale-dead-sections.md`
request described removing them. That earlier request was apparently never
applied (or was reverted) — this is the same change, filed again.

## Target doc

Live SOP Doc (`CONFIG.SOP_DOC_ID`): https://docs.google.com/document/d/15SwaYCEXGshe_8eZ2ZzADa0fk_SkdcvuDgjgajPEhag/edit

## Change 1 — remove the stale "HORMOZI MODE OVERRIDES" section

Not read by any code path — the real Hormozi-mode override text is
hardcoded in `Code.gs`'s `buildSopModeOverride()`, moved there 18-19 Aug
2026. This section is pure dead weight: real billed input tokens on every
single LLM call, doing nothing.

**Search for** (the entire section, from its heading through the blank
lines just before "## FOLLOW-UP DRAFTING"):

```
---

## **HORMOZI MODE OVERRIDES**

(Editor note: found by heading, same as "## FOLLOW-UP DRAFTING." Part of an active A/B split test — roughly half of drafts get HORMOZI MODE and use these paragraphs in place of their standard counterparts; the other half are JOANA MODE and ignore this section. Every draft is labeled at the top with which mode was used.)

**CORE PITCH PARAGRAPH** (replaces the standard one): *"Most agents know they should be building a personal brand, but between showings and closings there's never time to actually create content consistently. That's exactly what this solves: a podcast where you just show up for a relaxed 20-30 minute conversation with a local business owner, lender, or community leader a couple times a month — we handle 100% of the production, editing, publishing, and turning it into social clips, so it adds zero to your workload. We've done this for 100+ agents across 30 states, and for the ones who lean into it, it's turned into real referral relationships in their market, not just downloads."*

**BENEFIT LINE** (new, after the pitch paragraph): *"The real benefit? It grows your sphere of influence, builds your authority as the go-to name in your market, and — most importantly — helps you sell more houses."*

**CTA CLOSE**: *"Here's the quick version: [detail]. Want the full picture in under 15 minutes instead? Grab a slot here*: *[ book a 15-minute Zoom Call here](BOOKING_LINK) — I'll walk you through everything and answer whatever's on your mind."*
```

**Replace with**:

```
---
```

**Why**: this section is not read by any code path (confirmed: `buildSopModeOverride()` in `Code.gs` is the real override text, hardcoded there since 18-19 Aug). It also predates the 19 Aug cost-question fix (the Tonette incident), so even if it WERE somehow being read, its wording would be stale. Every LLM call pays to have this text in context for nothing.

## Change 2 — remove the stale "Guest Booking Follow-Up Sequence" section

Pure human documentation, no drafting instructions in it, and it names
`guest_booking_followups.gs`, a file the doc's own change log says was
deleted 17 Aug 2026.

**Search for**:

```
## Guest Booking Follow-Up Sequence (for no_decline leads sent the state-specific guest invite)

When a no_decline lead is sent the state-specific guest invite (see the no_decline close above) and Joana approves/sends it, that starts a 2-step follow-up sequence, spaced 2 days apart, run automatically by guest_booking_followups.gs. Every step is drafted only — Joana must send each one before the next is drafted. After the second follow-up is sent, the lead is moved to the "Bens Call List" tab for Bens to call directly.

The follow-up message text is NOT static: each Hub Guest follow-up is now AI-drafted per lead, based on what the lead actually said in their reply — see the FOLLOW-UP DRAFTING section below for how those drafts are written. (The old static Follow-up 1/2 templates were removed because Joana was rewriting them from scratch every time.) If the lead's reply was a clear hard decline, no follow-up is drafted at all — the cadence stops.

After Follow-up 2 is sent, the lead moves to the "Bens Call List" tab for Bens to call directly — no further emails from Joana on this thread unless the lead replies first.

If the lead replies at ANY point during this sequence, the automated follow-ups stop on that thread — a human reply always takes priority over the scripted nudge sequence.
```

**Replace with**: (delete entirely — nothing to replace it with)

**Why**: names a deleted file as if it's still the mechanism in use (it's actually `lead_followup_sequences.gs`'s `advanceHubGuestFollowUps()` now), and every fact in it that's still true (per-lead AI drafting, the Bens handoff after step 2, stopping on a human reply) is documentation about the code, not an instruction the drafter needs to follow — it doesn't change what gets drafted. Costs real tokens on every call for zero effect.

## Change log entry to append

```
- [3 Sep 2026] Actually removed "HORMOZI MODE OVERRIDES" and "Guest Booking Follow-Up Sequence" -- the 25 Aug 2026 entry below claimed this already happened, but both sections were still present (Joana caught this in her written feedback, section 9.1). Whatever happened to the earlier attempt, this is the same removal, filed again.
```

## Status

- [ ] Applied to live doc (who / when)
- [ ] Change log updated
