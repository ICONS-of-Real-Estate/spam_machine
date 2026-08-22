# SOP change request — Aug 21 training call follow-up

## Source

Emmanuel/Hazel training call, recorded 21 Aug 2026 (transcript: "Training
SPAM Aug 21.txt"), cross-checked against the objections spreadsheet and
the live SOP Doc.

Note: the recipient-swap ("take the fake Joana out, put the real lead
email in") issue Joana spent the most time on in the call is **not**
included below — checked live drafts in Gmail on 22 Aug 2026 and
`createThreadedDraft_()` already puts the real lead in `To` and
`network@iconsofrealestate.com` in `Cc` correctly. That part of the
training is now outdated; no doc change needed for it.

## Target doc 1 — Live SOP Doc

https://docs.google.com/document/d/15SwaYCEXGshe_8eZ2ZzADa0fk_SkdcvuDgjgajPEhag/edit

### Change 1 — booking link/CTA missing from yes_has_own_podcast

Confirmed live incident: on the call, Joana manually added a booking link
to an AI draft in this category ("it doesn't have a booking link... it's
better if we can include one"). The section currently has no path that
offers one.

**Search for**:

```
- Prior broadcast/media experience (radio, TV) is a high-value signal worth leaning into: "That changes everything -- we help people with existing broadcast authority like yours turn it into an omnichannel digital presence." Flag these specifically with needs_teammate_routing = true, since this segment is worth fast-tracking to a real conversation rather than just email.
```

**Replace with**:

```
- Prior broadcast/media experience (radio, TV) is a high-value signal worth leaning into: "That changes everything -- we help people with existing broadcast authority like yours turn it into an omnichannel digital presence." Flag these specifically with needs_teammate_routing = true, since this segment is worth fast-tracking to a real conversation rather than just email.

Regardless of which path above you use, close with one line offering a Zoom overview: "If you're ever curious to see how it could work for your show specifically, happy to jump on a quick Zoom: [book a 15-minute Zoom Call here](BOOKING_LINK)." This follows the same ONE-CTA-PER-REPLY rule as yes_general -- exactly one CTA, never stacked with another booking-link paragraph.
```

**Why**: closes a real gap Joana had to hand-fix live on the call; makes
the fuller-pitch/light-touch/discovery paths all end with a path to
booking instead of dead-ending.

### Change 2 — New Agent objection missing from live SOP (spreadsheet-only)

The objections spreadsheet has a good push-back script for "I just
recently started in Real Estate" that Claude never sees, since only the
live Doc is fed as the system prompt at runtime.

**Search for**:

```
- If a lead provides a phone number and/or a specific time to be reached (e.g. "call me tomorrow," "here's my number," "feel free to call/text me"), the reply must repeat that number back and/or acknowledge the specific timing directly -- do not fall back to the generic "I'll have one of our team give you a call" without including what they actually gave you. This is confirmed to work well and already demonstrated in real drafts (e.g. "I'll have one of our team give you a call at 305-525-7324 today" / "at 305-318-1213 — and don't worry, it'll show up as a real number, not spam"), but it has also been missed on leads who gave the same kind of information (a real incident, 19 Aug 2026: Sheri gave both a phone number and asked to be called "tomorrow," and the draft used the generic team-callback line with neither detail included). Treat repeating back a number or specific time they gave you as a hard requirement whenever the lead's message contains one, not an optional nice-to-have
```

**Replace with**:

```
- If a lead provides a phone number and/or a specific time to be reached (e.g. "call me tomorrow," "here's my number," "feel free to call/text me"), the reply must repeat that number back and/or acknowledge the specific timing directly -- do not fall back to the generic "I'll have one of our team give you a call" without including what they actually gave you. This is confirmed to work well and already demonstrated in real drafts (e.g. "I'll have one of our team give you a call at 305-525-7324 today" / "at 305-318-1213 — and don't worry, it'll show up as a real number, not spam"), but it has also been missed on leads who gave the same kind of information (a real incident, 19 Aug 2026: Sheri gave both a phone number and asked to be called "tomorrow," and the draft used the generic team-callback line with neither detail included). Treat repeating back a number or specific time they gave you as a hard requirement whenever the lead's message contains one, not an optional nice-to-have

- If the lead says they're new to real estate as a reason to hesitate, push back once, warmly: "Being newer is exactly why this could be a smart move -- instead of waiting years to earn visibility through transaction volume, a podcast builds it directly by putting you in front of local business owners and other agents." Then close with the standard Zoom offer.

- If asked whether this is limited to a specific brokerage (e.g. "Is this for eXp agents?"): "Not at all -- we work with agents across a variety of brokerages and independent teams. What matters most is being knowledgeable about your market, a good communicator, and genuinely connected to your community."

- When a lead flatly says they don't want to pay, one real technique: ask a genuine curiosity question before defending price -- "Out of curiosity, if there wasn't any cost involved, would you potentially be open to exploring it?" This surfaces whether the objection is really about price or about interest, and shapes whether to keep pushing or let it go.
```

**Why**: three concrete, tested scripts that live only in Joana's
spreadsheet today and never reach Claude at runtime -- new-agent
objection, brokerage-limitation question, and the "if it were free"
price-curiosity probe.

## Target doc 2 — "SOP - SPAM Campaign Replies" process doc

https://docs.google.com/document/d/1xIYMbzrzVuCeQI4YHUHuLBqbggb7dVX-L9X6oM8IZco/edit

### Change 3 — add explicit To/CC check to the review step

Not a bug fix (confirmed the code already gets this right, 22 Aug 2026)
but Joana treats this as a mandatory manual check every time, and the
process doc's review step doesn't mention it.

**Search for**:

```
3.  Check if the draft makes sense, and that we’re answering to everything asked by the lead
```

**Replace with**:

```
3.  Check if the draft makes sense, and that we're answering to everything asked by the lead. Also confirm the To field is the real lead's email (not the outreach alias) and network@iconsofrealestate.com is on CC -- check this on every draft, even ones the AI got otherwise right.
```

**Why**: cheap insurance with two new people now sending from Joana's
account, even though the recipient-swap bug itself is already fixed in
code.

## Change log entries to append (live SOP Doc's own "## Change log" section)

```
- [22 Aug 2026] Added booking-link CTA to yes_has_own_podcast (was missing in all three paths -- real incident from training call, Joana manually added one).
- [22 Aug 2026] Merged New Agent, Brokerage Limitations, and "if it were free" price-curiosity scripts from the objections spreadsheet into yes_general -- these existed only in the spreadsheet and were never fed to Claude at runtime.
```

## Status

- [ ] Applied to live SOP Doc (who / when)
- [ ] Applied to process doc (who / when)
- [ ] Change log updated
