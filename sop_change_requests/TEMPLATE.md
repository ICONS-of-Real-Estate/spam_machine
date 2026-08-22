# SOP change request — process

Why this exists: the live SOP Doc (and the "SOP - SPAM Campaign Replies"
process doc) can't be edited in place by Claude directly — no available
tool does a Google Docs body edit, only read/download and file-metadata
updates. So instead of describing edits in chat (easy to lose, hard to
apply correctly), every proposed SOP change gets written to a file here.
A human opens the live doc, uses Find & Replace with the exact strings
below, and Google Docs' own version history captures the diff.

Copy this template for each new change request: `sop_change_requests/YYYY-MM-DD_short-slug.md`.

---

## Source

What prompted this change (a training call, a real incident, a backlog
review, an audit). Link the transcript/doc if there is one.

## Target doc

Name + live link of the doc being edited (usually the live SOP Doc,
`SOP_DOC_ID` in `CONFIG` — sometimes the "SOP - SPAM Campaign Replies"
process doc instead). State which.

## Change 1 — <short title>

**Search for** (paste exact, unique text from the doc — enough surrounding
context to be a unique match, not just a fragment that appears twice):

```
<exact current text>
```

**Replace with**:

```
<exact current text, plus the addition/edit>
```

**Why**: one or two sentences — what real reply/incident/gap this fixes,
and what it's expected to change in future drafts.

## Change 2, 3, ... 

Same shape as above, one per distinct edit.

## Change log entry to append

The live SOP Doc keeps a "## Change log" section, newest entry on top,
one line per change. Draft the exact line(s) to add there so whoever
applies the edit doesn't have to word it themselves:

```
- [YYYY-MM-DD] <one-line summary of what changed and why>
```

## Status

- [ ] Applied to live doc (who / when)
- [ ] Change log updated
