# SOP change request — remove two stale, dead sections

## Source

User exported the live SOP Doc as a PDF and shared it directly (no other
read access to the live Doc exists in this session — verified: no Google
connector, and even a raw fetch to docs.google.com is blocked by network
egress). That let me read the actual live text for the first time this
session, cross-check it against `Code.gs`, and confirm both sections below
are genuinely dead: not read by any code path, but still sent to the LLM
as real billed tokens on every single `classifyAndDraft` call, since
`buildSystemPrompt()` sends the entire Doc body verbatim with no section
filtering.

## Target doc

Live SOP Doc, `CONFIG.SOP_DOC_ID` in `Code.gs`:
https://docs.google.com/document/d/15SwaYCEXGshe_8eZ2ZzADa0fk_SkdcvuDgjgajPEhag/edit

## A note on HOW to apply these two changes

Both blocks below are several paragraphs long. Exact Find & Replace worked
cleanly for the four shorter edits applied yesterday (single sentences or
short insertions), but a match across this many paragraphs is fragile — a
single curly quote, em-dash, or line-wrap space that doesn't byte-for-byte
match what's below (this was extracted from a PDF export, which isn't
guaranteed to preserve exact characters) makes Find & Replace silently
report 0 matches, with nothing to warn you it failed.

**Safer method for a block this size:** use Find (Ctrl/Cmd+F, not
Find & Replace) just to jump to the **start anchor** and **end anchor**
given below — both are short, distinctive phrases very unlikely to have
any character mismatch. Then manually select everything from the start of
the start anchor through the end of the end anchor (click before it, then
shift-click after) and delete the selection. This sidesteps the exact-match
risk entirely.

If you'd rather try Find & Replace first: paste the **Search for** block in,
and if it reports 0 matches, don't keep adjusting it — just fall back to
the manual-selection method above.

## Change 1 — delete the entire "HORMOZI MODE OVERRIDES" section

**Start anchor** (search to jump here): `HORMOZI MODE OVERRIDES`

**End anchor** (search to jump here, then select through the end of this
sentence): `answer whatever's on your mind.`

**Search for** (best-effort exact text, for Find & Replace — see note above
on the fallback if this doesn't match):

```
---

HORMOZI MODE OVERRIDES

(Editor note: found by heading, same as "## FOLLOW-UP DRAFTING." Part of an active A/B split test — roughly half of drafts get HORMOZI MODE and use these paragraphs in place of their standard counterparts; the other half are JOANA MODE and ignore this section. Every draft is labeled at the top with which mode was used.)

CORE PITCH PARAGRAPH (replaces the standard one): "Most agents know they should be building a personal brand, but between showings and closings there's never time to actually create content consistently. That's exactly what this solves: a podcast where you just show up for a relaxed 20-30 minute conversation with a local business owner, lender, or community leader a couple times a month — we handle 100% of the production, editing, publishing, and turning it into social clips, so it adds zero to your workload. We've done this for 100+ agents across 30 states, and for the ones who lean into it, it's turned into real referral relationships in their market, not just downloads."

BENEFIT LINE (new, after the pitch paragraph): "The real benefit? It grows your sphere of influence, builds your authority as the go-to name in your market, and — most importantly — helps you sell more houses."

COST-QUESTION CLOSE: "Great question! ... There is a cost involved: a $497 one-time start-up kit, then $600/month for ongoing production. Don't want to hide the pricing from you, but what matters is understanding your goals and seeing how launching your own show on the ICONS network will help you grow your business. A lot of hosts also bring on a sponsor to offset the cost..."

CTA CLOSE: "Here's the quick version: [detail]. Want the full picture in under 15 minutes instead? Grab a slot here: [ book a 15-minute Zoom Call here](BOOKING_LINK) — I'll walk you through everything and answer whatever's on your mind."
```

**Replace with**: nothing — leave the Replace field blank (or just delete
the manually-selected range). CORRECTED (25 Aug 2026): there is no `---`
divider between the CTA CLOSE paragraph and "## FOLLOW-UP DRAFTING" — that
heading follows immediately, so there's nothing else to preserve. Delete
exactly the block above and "## FOLLOW-UP DRAFTING" continues right after.

**Why**: this section is not read by any code path. The Hormozi-mode
override the model actually receives is a hardcoded string inside
`buildSopModeOverride()` in `Code.gs` — moved there deliberately on
18-19 Aug 2026 after confirming that asking the model to "find this
heading and apply it" didn't reliably work. This Doc section is a leftover
from before that fix, and it's gone stale: its COST-QUESTION CLOSE still
states the flat, unqualified "$497... $600/month" framing that caused the
real Tonette incident (a hot lead anchored on the cheapest package instead
of being routed to a call) — the actual code override was rewritten on
19 Aug specifically to fix that, but this Doc paragraph was never updated
to match. It's currently harmless (the model is explicitly told to use
"the exact text below," i.e. the code's version, "not the standard wording
above") but it is real, billed input tokens on every single call in BOTH
modes, for a paragraph nobody reads and that actively misleads anyone who
edits this Doc believing it controls Hormozi-mode pricing — it doesn't.

## Change 2 — delete the "Guest Booking Follow-Up Sequence" section

**Start anchor**: `## Guest Booking Follow-Up Sequence`

**End anchor**: `a human reply always takes priority over the scripted nudge sequence.`

**Search for**:

```
## Guest Booking Follow-Up Sequence (for no_decline leads sent the state-specific guest invite)

When a no_decline lead is sent the state-specific guest invite (see the no_decline close above) and Joana approves/sends it, that starts a 2-step follow-up sequence, spaced 2 days apart, run automatically by guest_booking_followups.gs. Every step is drafted only — Joana must send each one before the next is drafted. After the second follow-up is sent, the lead is moved to the "Bens Call List" tab for Bens to call directly.

The follow-up message text is NOT static: each Hub Guest follow-up is now AI-drafted per lead, based on what the lead actually said in their reply — see the FOLLOW-UP DRAFTING section below for how those drafts are written. (The old static Follow-up 1/2 templates were removed because Joana was rewriting them from scratch every time.) If the lead's reply was a clear hard decline, no follow-up is drafted at all — the cadence stops.

After Follow-up 2 is sent, the lead moves to the "Bens Call List" tab for Bens to call directly — no further emails from Joana on this thread unless the lead replies first.

If the lead replies at ANY point during this sequence, the automated follow-ups stop on that thread — a human reply always takes priority over the scripted nudge sequence.
```

**Replace with**: nothing — leave the Replace field blank. The `## Link
formatting` heading that follows it stays as-is.

**Why**: purely descriptive of a downstream process (what happens after a
no_decline reply goes out) — no instruction in it changes how to draft the
CURRENT reply, and it's redundant with `HANDOFF.md`/`README.md`/`Code.gs`'s
own comments, so nothing is lost by removing it from here. It's also stale:
it names `guest_booking_followups.gs` as the file that runs the cadence,
but that file was deleted 17 Aug 2026 and its logic replaced by
`advanceHubGuestFollowUps()` in `lead_followup_sequences.gs` — a human
troubleshooting the cadence off this Doc would go looking for a file that
no longer exists. Like Change 1, it's also just real tokens billed on
every call for text with zero bearing on drafting behavior.

## Change log entry to append

```
- [25 Aug 2026] Removed the stale "HORMOZI MODE OVERRIDES" section -- not read by any code path (the real override is hardcoded in Code.gs's buildSopModeOverride(), moved there 18-19 Aug 2026), and its cost-question wording predated the 19 Aug fix for the Tonette incident. Also removed the "Guest Booking Follow-Up Sequence" explainer -- pure human documentation with no drafting instructions in it, and it named guest_booking_followups.gs, a file deleted 17 Aug 2026. Both were real billed input tokens on every call for text nobody used.
```

## Status

- [ ] Applied to live doc (who / when)
- [ ] Change log updated
