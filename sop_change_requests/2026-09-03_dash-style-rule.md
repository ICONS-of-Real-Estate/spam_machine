# SOP change request — no em dash / no double hyphen

## Source

Joana's written feedback doc ("Feedback: Reply Drafter"), section 2c: "Never
use the em dash '—'. It reads as AI-written. Also stop the double hyphen
'--', which just looks like a typo." She asked for this enforced two ways:
(1) a hard formatting rule in the SOP doc, and (2) a post-processing replace
in the script so it doesn't depend on the model behaving. Part (2) is
already live (`normalizeDashesForSending_()`, `Code.gs`, applied to every
drafted reply in `classifyAndDraft()`). This request is part (1) — the SOP
doc itself needs the rule stated, and also needs cleaning: as Joana noted,
"the SOP doc itself is full of '—' and '--'. The model is copying the style
of the document it's told to follow, so the source doc has to be cleaned too
or the rule won't stick."

## Target doc

Live SOP Doc (`CONFIG.SOP_DOC_ID`): https://docs.google.com/document/d/15SwaYCEXGshe_8eZ2ZzADa0fk_SkdcvuDgjgajPEhag/edit

## Change 1 — add the hard rule

**Search for** (the existing "Formatting rules" bullet list, right after the
link-formatting hard rule):

```
**Formatting rules, also hard requirements, not style preferences:**

- Do NOT use hyphen/dash bullet points ("- like this") anywhere in a reply. If you need to list multiple things, write them as natural sentences instead.

- Use **bold** (double asterisks around the text) for emphasis on genuinely important points in longer emails — a specific date/time being confirmed, a key number, a direct answer to their question. Don't overuse it; a few bolded phrases in a longer email, not every sentence.
```

**Replace with**:

```
**Formatting rules, also hard requirements, not style preferences:**

- Do NOT use hyphen/dash bullet points ("- like this") anywhere in a reply. If you need to list multiple things, write them as natural sentences instead.

- Never use an em dash or a double hyphen ("--"). Both read as AI-written. Use a single hyphen ("-") instead, or just restructure the sentence.

- Use **bold** (double asterisks around the text) for emphasis on genuinely important points in longer emails, a specific date/time being confirmed, a key number, a direct answer to their question. Don't overuse it; a few bolded phrases in a longer email, not every sentence.
```

**Why**: states the rule explicitly where the model already reads the other
formatting hard rules. Also fixes the one em dash sitting in the very
sentence describing the bold rule, which is exactly the kind of modeled bad
example Joana flagged.

## Change 2 — clean up existing em dashes and double hyphens in the doc

This is NOT a single find/replace pair — the doc uses em dashes and double
hyphens throughout its prose (dozens of instances), and the doc also uses a
literal three-hyphen line (`---`) as a section-divider convention in
several places, which must NOT be touched (it's a different, intentional,
structural use, not a typo).

**Do this in two passes, by hand, in the live doc:**

1. **Em dash pass (safe to Replace All):** Find & Replace, search for `—`
   (the em dash character, not a hyphen), replace with `-`, click
   **Replace all**. This character never appears as a structural divider in
   this doc, so a blanket replace is safe.
2. **Double-hyphen pass (do NOT use Replace All):** Find `--` and step
   through each match individually. Replace a genuine mid-sentence `--`
   (used as punctuation, e.g. "confirmed real incident, 20-21 Aug 2026")
   with a single `-`. **Skip every `---` divider** (the three-hyphen section
   breaks between major sections, e.g. right after the opening "Do not
   delete this doc..." paragraph) — those are not the double-hyphen typo
   this rule targets.

**Why**: per Joana's own point — the model is demonstrably copying this
doc's own dash usage, so the script-side post-processing fix alone won't
make the model stop reaching for dashes it sees modeled constantly in its
own instructions; only the in-body notes get silently corrected today,
not the model's underlying habit.

## Change log entry to append

```
- [3 Sep 2026] Added hard rule: no em dash, no double hyphen -- use a single hyphen instead (Joana's feedback, both read as AI-written). Cleaned up existing em dashes/double hyphens throughout the doc's own prose so the model stops copying that style.
```

## Status

- [ ] Applied to live doc (who / when)
- [ ] Change log updated
