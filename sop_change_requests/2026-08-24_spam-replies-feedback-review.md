# SOP change request — "Spam Replies Feedback" doc review

## Source

Full read-through of the "Spam Replies Feedback" Google Doc (id
`1nyaSzOZX2DbKP4G9xtEtPmgRkrfITz3obAfEwJbQzes`, ~65 real AI-draft-vs-final-sent
row comparisons, June 15 – Aug 18 2026), flagged twice by the user as unread
feedback from Goodness, done this session via a background sub-agent that
read the doc end to end. Cross-checked every finding against the live SOP
Doc and against `git log` on `Code.gs` before proposing anything, to avoid
re-proposing fixes that already shipped.

**Two of the doc's most serious-looking incidents turned out to already be
fixed in code — no doc change needed for either:**

- **Hostile/abusive rejection still getting a full outreach draft** (lead
  "Jose," reply was literally "Fuck off," AI still drafted continued
  outreach). `OPT_OUT_PATTERNS` in `Code.gs` (checked *before* the LLM call,
  no draft created at all when it matches) already includes `fuck off`,
  `fuck you`, `piss off`, `get lost`, `leave me the fuck alone` — added
  17–20 Aug 2026 (`git log -S "fuck off" -- Code.gs`). The Jose row in the
  feedback doc is undated but the doc's other dated rows run through
  mid-August, so this is very likely the same incident that prompted that
  fix, already resolved.
- **AI drafted a brand-new reply on a thread "Joana already replied to this
  a long time ago"** — this is exactly what `hasAlreadySentReplyTo_()`
  (shipped earlier today, 24 Aug 2026, in this same session) guards
  against: it checks the real Sent folder for any prior reply to the lead
  before drafting a first-ever reply. Should already be closed.

Everything below is what's left after excluding those two.

## Target doc

Live SOP Doc, `CONFIG.SOP_DOC_ID` in `Code.gs`:
https://docs.google.com/document/d/15SwaYCEXGshe_8eZ2ZzADa0fk_SkdcvuDgjgajPEhag/edit

## Change 1 — never fabricate contact info

Real incident (lead "Chris," 8 Jul 2026): asked "what is your phone
number?" and the AI draft answered with a fake placeholder number
`(801) 555-0198` that was never given anywhere in context. Human caught it
and sent nothing. The SOP already has a hard rule against inventing a
dollar figure but nothing against inventing other facts.

**Search for**:

```
Never mention that you are an AI or that this was auto-drafted. Never state an exact dollar figure under any circumstances. Emoji ARE required per the Tone section above -- the earlier "do not use emoji" rule here was left over from before the rendering bug was fixed, and directly contradicted the Tone section. This line corrects that.
```

**Replace with**:

```
Never mention that you are an AI or that this was auto-drafted. Never state an exact dollar figure under any circumstances. Never invent, guess, or fabricate contact information -- a phone number, email address, or physical address -- that was not explicitly given to you in the thread context or the SOP itself. If a lead asks for a phone number and none is available in context, do not make one up; offer the booking link instead, or say a teammate will reach out to them directly. (Real incident, 8 Jul 2026, lead Chris: asked for a phone number, got a fabricated placeholder number back that nobody had actually provided.) Emoji ARE required per the Tone section above -- the earlier "do not use emoji" rule here was left over from before the rendering bug was fixed, and directly contradicted the Tone section. This line corrects that.
```

**Why**: closes a hallucination risk on factual claims, not just tone --
the dollar-figure rule already treats "don't invent numbers" as important
enough for a hard rule; contact info deserves the same treatment.

## Change 2 — add the relationships/success-stories fuller pitch to yes_general

Across 15+ real final-sent replies (Julia, Elia, Adnan, Destiny, Ciara,
Heather, Allie, Meka, Jason, Merek, Jessica, Rosa, Stenie, Trey, Troy, and
more) Joana consistently expands the bare core pitch paragraph with a
relationship-building angle and a link to real success stories -- this
combination doesn't currently exist anywhere in the live SOP.

**Search for**:

```
- If the lead's location or role doesn't match what was pitched (wrong state, not an active agent, etc.), pivot rather than force it: acknowledge the mismatch honestly and offer that the network also covers "broader local, business, lifestyle, and community-focused" shows if relevant, rather than just repeating the real-estate-specific pitch.
```

**Replace with**:

```
- If the lead's location or role doesn't match what was pitched (wrong state, not an active agent, etc.), pivot rather than force it: acknowledge the mismatch honestly and offer that the network also covers "broader local, business, lifestyle, and community-focused" shows if relevant, rather than just repeating the real-estate-specific pitch.

- When a fuller answer is called for (not just the short core pitch), leaning into the relationship-building side works well and is Joana's real, frequently-used fuller version: mention that podcasting is also a great way to connect with other agents and influential local people, that hosts often see this turn into real referrals and collaborations, and point to real proof: "You can check some success stories on our website!" linked as [success stories](https://iconsofrealestate.com/success-stories/). This is not a replacement for the core pitch paragraph -- use it as an extension of it, not instead of it, and remember the ONE-CTA-PER-REPLY rule still applies to whatever close follows.
```

**Why**: this is Joana's actual default full-length reply in the large
majority of real yes_general threads reviewed, not a one-off -- the SOP's
current core pitch paragraph alone is noticeably shorter and thinner than
what she really sends.

## Change 3 — add "Guest Booking and Coordination" as a 4th value point

Real incident (lead "Dane," dated row in the feedback doc): Joana's actual
sent reply added a 4th bolded value point the AI's draft didn't have.

**Search for**:

```
- If they seem like a good fit for a deeper production partnership, a fuller pitch works well: "Since you've already got the show live, we can completely bypass the 'getting started' phase. Where we typically slide in for agents at your level is taking over the tedious, time-consuming back end so you can focus strictly on production and scaling your real estate business" -- optionally followed by three bolded value points: **Full Post-Production**, **The Micro-Content Machine** (repurposing each episode into 5-10 short social clips), and **Distribution & Growth**.
```

**Replace with**:

```
- If they seem like a good fit for a deeper production partnership, a fuller pitch works well: "Since you've already got the show live, we can completely bypass the 'getting started' phase. Where we typically slide in for agents at your level is taking over the tedious, time-consuming back end so you can focus strictly on production and scaling your real estate business" -- optionally followed by four bolded value points: **Full Post-Production**, **The Micro-Content Machine** (repurposing each episode into 5-10 short social clips), **Distribution & Growth**, and **Guest Booking and Coordination** (we put your guest avatar in front of you, so you're not spending your own time chasing down guests).
```

**Why**: a real, demonstrated 4th offering Joana already includes by hand;
the AI's version is currently incomplete relative to what actually goes out.

## Change 4 — give neutral_acknowledgment a concrete spam-folder line

The current neutral_acknowledgment guidance says to "acknowledge the
spam-folder point directly" but gives no example wording. Two independent
real threads (Troy, Jashawn) landed on the same light, self-deprecating
phrasing rather than a formal apology.

**Search for**:

```
**neutral_acknowledgment** (the reply is a non-committal remark that is neither interest nor a decline — e.g. "this was in my spam folder," "who is this with?," "got your email"): Do NOT use "I'm glad you're open to exploring it!" — the lead has not expressed openness. Open with a neutral "Thanks for getting back to me!", briefly address what they actually said (e.g. acknowledge the spam-folder point directly), give a light one-paragraph overview, and offer — do not push — a next step. Set priority to false.
```

**Replace with**:

```
**neutral_acknowledgment** (the reply is a non-committal remark that is neither interest nor a decline — e.g. "this was in my spam folder," "who is this with?," "got your email"): Do NOT use "I'm glad you're open to exploring it!" — the lead has not expressed openness. Open with a neutral "Thanks for getting back to me!", briefly address what they actually said, give a light one-paragraph overview, and offer — do not push — a next step. Set priority to false. When the lead specifically mentions the spam folder, keep it light and self-deprecating rather than formally apologetic -- real examples: "It sounds like my emails took the scenic route through your spam folder!" -- the joke is on the outreach/deliverability, never on the lead.
```

**Why**: makes an already-correct rule concrete and consistent instead of
leaving the exact wording to be reinvented per draft.

## Change log entries to append (live SOP Doc's own "## Change log" section)

```
- [24 Aug 2026] Added hard rule against fabricating contact info (phone/email/address) not present in context -- real incident, fake phone number given to a lead who asked for one.
- [24 Aug 2026] Added relationships + success-stories fuller-pitch variant to yes_general (matches Joana's real default full-length reply, seen in 15+ real threads).
- [24 Aug 2026] Added 4th value point "Guest Booking and Coordination" to the yes_has_own_podcast fuller pitch (real incident, Dane).
- [24 Aug 2026] Gave neutral_acknowledgment a concrete spam-folder line ("took the scenic route through your spam folder") instead of leaving the wording to be reinvented each time.
```

## Other findings from the doc review -- NOT proposed as doc changes (need code/data work, not SOP text)

- **Wrong booking link for the assigned team member**: at least two live
  booking links exist (`.../joana-podcast-production`,
  `.../sean-podcast-production`); Joana's real replies pick the one for
  whoever is actually taking the call (often Sean Church, Network
  Manager), but the AI always defaults to Joana's. Fixing this needs a
  data signal (who's assigned) fed into the BOOKING_LINK substitution,
  not an SOP wording change -- flagging for whoever picks up the
  BOOKING_LINK code path next.
- **Booking/scheduling ask drafted for a lead who already has a meeting
  booked**: no code currently checks calendar/booking state before
  drafting a scheduling ask. Would need a real calendar or booking-sheet
  check, out of scope for a quick fix.
- **AI applied the "never replied" bump template (Guest Booking
  Follow-Up, case 6 in FOLLOW-UP DRAFTING) to leads who had just sent a
  genuine substantive reply** -- clustered around one batch window, 28
  Jul 2026 evening (Ryan Cox and others). This lives in
  `guest_booking_followups.gs`'s reply-detection logic, not reviewed this
  session -- worth checking whether it has the same kind of thread-state
  bug `hasAlreadySentReplyTo_()` and `findSentReplyAfterDraft()` were
  built to fix elsewhere.
- **Raw quoted-email chrome (`>` lines, "On ... wrote:") leaking into a
  draft body** (Terri 7/31, Sandy) -- `extractProspectFreshReplyText()`
  already has dedicated stripping logic for this class of bug and has
  been patched multiple times (17-19 Aug 2026 commits); these two rows
  may already predate the current stripping logic. Noting in case it
  recurs, not proposing a fix blind.

## Status

- [ ] Applied to live SOP Doc (who / when)
- [ ] Change log updated
