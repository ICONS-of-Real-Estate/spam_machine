/**
 * ICONS OF REAL ESTATE — Learning Loop (companion to podcast_reply_drafter.gs)
 * -----------------------------------------------------------------------------
 * This is a SECOND file in the SAME Apps Script project as
 * podcast_reply_drafter.gs (it shares that file's CONFIG object, so both
 * files must be in one project). It does two things, on its own schedule:
 *
 * 1. runLearningLoop() — run this weekly (MOVED off daily 22 Aug 2026, per
 *    direct request -- maildoso outreach only sends weekdays, so there's no
 *    daily-outreach reason to burn Gmail quota checking every single day;
 *    see setup_all_triggers.gs). It looks at every thread logged in the
 *    "AI Drafts Log" tab, checks Joana's Sent folder for the reply that
 *    actually went out, and records whether she sent the draft as-is or
 *    changed it — logging both versions side by side in "Learning Log". Its
 *    dedup makes runs cumulative, and it now stops-and-resumes within a
 *    wall-clock budget (see runLearningLoopInner()) the same way
 *    runReplyDrafter does, so a full week's backlog in one run is safe.
 *
 * 2. generateSopSuggestions() — run this daily (18 Aug -> 19 Aug 2026:
 *    switched from weekly to daily, per direct request, once the doc+email
 *    step below made a daily cadence reviewable instead of overwhelming).
 *    It reads any un-reviewed edited rows from "Learning Log", sends them
 *    to the LLM (Kimi, falling back to Claude -- see callLlmWithFallback()
 *    in quota_guard_and_alerting.gs) in a batch, and asks it to identify
 *    patterns and propose SPECIFIC SOP changes. These still land in the
 *    "SOP Suggestions" tab as a structured log (unchanged), but ALSO get
 *    written into a same-day Google Doc (createSopSuggestionsDoc()) and
 *    emailed to Goodness, Joana, and Kris (emailSopSuggestionsDoc()) so
 *    there's an actual daily reviewable artifact instead of a sheet tab
 *    nobody remembers to open. PROPOSALS ONLY, same as before — nothing
 *    here rewrites the live SOP file or the drafter's system prompt
 *    automatically. A human should review the emailed doc and merge
 *    anything real into the live SOP by hand. This is deliberate:
 *    unsupervised SOP rewrites based on live sales replies can drift in
 *    ways nobody notices until it's already gone out to real leads.
 *
 * Add both as time-driven triggers in the same project (see
 * setup_all_triggers.gs):
 *   - runLearningLoop      -> weekly, Saturday morning
 *   - generateSopSuggestions -> Day timer, once daily, timed so the email
 *     lands around 6 PM Pacific (see the timezone note in
 *     setup_all_triggers.gs -- the script's own trigger clock runs on
 *     Europe/Paris, not Pacific)
 */

// ---------- 1. COMPARE SENT VS. DRAFTED ----------

function runLearningLoop() {
  // ADDED (17 Aug 2026, real incident): confirmed live that a different
  // account than Joana's has its own trigger firing this function -- see
  // assertRunningAsJoana() in lead_followup_sequences.gs. This reads real
  // Gmail threads/sent messages, so running as the wrong account would just
  // fail to find any of the thread IDs logged (they belong to Joana's
  // mailbox specifically) rather than silently doing something useful.
  if (!assertRunningAsJoana('runLearningLoop')) return;

  // ADDED (20 Aug 2026, real incident): this is a Gmail-touching entry point
  // (getThreadById/getMessages per row) that never checked the quota
  // circuit breaker -- only runReplyDrafter did. Confirmed live: reprocessing
  // 302 rows here exhausted the account's daily Gmail quota mid-run, and
  // without this check, every subsequent scheduled fire today would have
  // kept trying and failing instead of skipping cleanly like runReplyDrafter
  // already does.
  if (isGmailQuotaExhausted()) {
    Logger.log('Skipping runLearningLoop -- Gmail quota already known exhausted today.');
    return;
  }

  // ADDED (17 Aug 2026): this function's dedup (skip a Thread ID already
  // present in "Learning Log") is correct for a SINGLE execution, but
  // nothing stopped two overlapping executions from both reading the log
  // before either had appended anything -- both would then log the SAME
  // thread comparison as a duplicate row. Same class of race as today's
  // cross-account trigger duplicate-draft incident. Locking the same way
  // runReplyDrafter() already does.
  const lock = LockService.getScriptLock();
  const gotLock = lock.tryLock(10000);
  if (!gotLock) {
    Logger.log('Another runLearningLoop execution is already in progress -- skipping this run rather than racing it.');
    return;
  }
  try {
    runLearningLoopInner();
  } finally {
    lock.releaseLock();
  }
}

function runLearningLoopInner() {
  if (!CONFIG.SPREADSHEET_ID || CONFIG.SPREADSHEET_ID === 'PASTE_YOUR_SHEET_ID_HERE') {
    Logger.log('CONFIG.SPREADSHEET_ID not set — skipping learning loop.');
    return;
  }

  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const draftsTab = ss.getSheetByName('AI Drafts Log');
  const learningTab = ss.getSheetByName('Learning Log');
  if (!draftsTab || !learningTab) {
    Logger.log('Required tabs missing — run setup() in podcast_reply_drafter.gs first.');
    return;
  }

  const alreadyCompared = new Set(
    learningTab.getDataRange().getValues().slice(1).map(row => row[1]) // Thread ID column
  );

  const draftRows = draftsTab.getDataRange().getValues();
  const headers = draftRows[0];
  const timestampCol = headers.indexOf('Timestamp');
  const threadIdCol = headers.indexOf('Thread ID');
  const subjectCol = headers.indexOf('Subject');
  const categoryCol = headers.indexOf('Category');
  const draftTextCol = headers.indexOf('Draft Text');
  const sopModeCol = headers.indexOf('SOP Mode'); // -1 for rows logged before the split test existed

  let compared = 0;

  // ADDED (22 Aug 2026, per direct request): moved from a daily trigger to a
  // weekly one (see setup_all_triggers.gs) to stop burning Gmail quota every
  // day when there's no daily-outreach reason to. That means a single run
  // can now face a full week's backlog instead of one day's, so it needs the
  // same wall-clock stop-and-resume pattern runReplyDrafterInner() already
  // uses -- otherwise a big backlog either gets killed mid-run by Apps
  // Script's 6-minute hard limit, or burns the whole day's Gmail quota in
  // one execution (the exact incident that started this fix, 20 Aug 2026).
  // The dedup above (alreadyCompared, keyed by Thread ID already in
  // "Learning Log") already makes this naturally resumable across runs --
  // whatever's left when the budget runs out just gets picked up on next
  // Saturday's run.
  const RUNTIME_BUDGET_MS = 5 * 60 * 1000; // 5 min, leaving a 1-min buffer before the 6-min hard limit
  const runStartTime = Date.now();

  for (let i = 1; i < draftRows.length; i++) {
    if (Date.now() - runStartTime > RUNTIME_BUDGET_MS) {
      Logger.log('Approaching Apps Script\'s execution time limit -- stopping this run early so it completes cleanly instead of getting killed mid-run. Remaining rows will be picked up next run.');
      break;
    }
    if (isGmailQuotaExhausted()) {
      Logger.log('Gmail quota hit mid-run -- stopping cleanly so the rest of today\'s attempts don\'t keep failing. Remaining rows will be picked up next run.');
      break;
    }

    const row = draftRows[i];
    const threadId = row[threadIdCol];
    if (!threadId || alreadyCompared.has(threadId)) continue;

    let thread;
    try {
      thread = GmailApp.getThreadById(threadId);
    } catch (e) {
      continue; // thread may have been deleted
    }
    if (!thread) continue;

    // FIX (18 Aug 2026, real incident): findSentReplyAfterDraft() relied on
    // isDraft() to skip the still-unsent draft itself, but that
    // misidentified an unsent createThreadedDraft_() draft (Nancy's Hawaii
    // thread, confirmed live -- still just one unsent draft in Gmail while
    // the "sent reply" already showed up in Learning Log) as a genuine sent
    // reply. Root cause is likely isDraft() not reliably recognizing drafts
    // created via the Advanced Gmail API (raw MIME) the same way it
    // recognizes GmailApp.createDraft() ones. Rather than chase that
    // compatibility gap, guard with a fact that can't be wrong regardless of
    // cause: a genuine sent reply can only have a timestamp AFTER the draft
    // was created.
    const draftCreatedAt = row[timestampCol];
    // FIX (20 Aug 2026, real incident): findSentReplyAfterDraft() checked
    // only that a message was sent FROM Joana's own account, never that it
    // was sent TO the lead. Many threads have Joana send two things after a
    // draft: the real reply to the lead, and a separate internal forward to
    // a teammate (e.g. sean@iconsofrealestate.com) for handoff. Walking
    // newest-first and returning the first match from her account grabbed
    // whichever came later -- confirmed live: ~40% of Learning Log rows
    // (skewed heavily toward yes_general, exactly the needs_teammate_routing
    // category) logged that internal forward's blank/quote-only body as if
    // it were "what Joana sent the lead." Per this project's own standing
    // rule, never trust the stored Prospect Email column (~27% historically
    // poisoned) -- re-derive the real lead email from the thread the same
    // way every other Gmail-touching entry point does.
    const forwardInfo = extractForwardedLeadInfo(thread.getMessages()[0]);
    const leadEmail = forwardInfo ? forwardInfo.email : null;
    const sentReply = findSentReplyAfterDraft(thread, draftCreatedAt, leadEmail);
    if (!sentReply) continue; // Joana hasn't sent it yet — check again tomorrow

    const draftText = row[draftTextCol];
    const sentText = sentReply.getPlainBody();
    const wasEdited = !textsRoughlyMatch(draftText, sentText);

    learningTab.appendRow([
      new Date(),
      threadId,
      row[subjectCol],
      row[categoryCol],
      draftText,
      sentText,
      wasEdited,
      false, // Reviewed For SOP — starts false, generateSopSuggestions() flips it to true
      sopModeCol !== -1 ? (row[sopModeCol] || 'joana') : 'joana',
    ]);

    compared++;
  }

  Logger.log('Learning loop run complete. Newly compared: ' + compared);
}

function findSentReplyAfterDraft(thread, draftCreatedAt, leadEmail) {
  const messages = thread.getMessages();
  // Look from the end for a message sent by our own account (i.e. Joana actually replied)
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].isDraft && messages[i].isDraft()) continue;
    // PRIMARY GUARD (18 Aug 2026, real incident): isDraft() alone isn't
    // trustworthy for drafts created via the Advanced Gmail API (see the
    // real incident noted at the call site) -- it let an unsent draft
    // through and got logged as a "sent reply" that was never actually
    // sent. A message that predates the draft it's supposedly replying to
    // cannot possibly be the real sent reply, so this check catches that
    // case even when isDraft() is wrong.
    if (draftCreatedAt && messages[i].getDate().getTime() <= new Date(draftCreatedAt).getTime()) continue;
    const from = messages[i].getFrom().toLowerCase();
    // FIX (18 Aug 2026, real incident): this used to accept ANY
    // CONFIG.INTERNAL_DOMAINS address as "Joana's genuine reply" -- but
    // network@ardorseo.com is a forwarding/distribution alias, not a real
    // reply sender: it's the address the lead's OWN forwarded message
    // routes through (see the search query in Code.gs targeting
    // to:"network@ardorseo.com"). A "Fwd: Re: ..." message from that alias
    // satisfied the old check and got returned as the "sent reply" even
    // though its body is just the forwarded lead text with zero actual
    // reply content -- this is confirmed to be why the vast majority of
    // Learning Log rows came back with an empty/no-reply Final Sent Text
    // across every category (83-92% empty in a full audit). Only Joana's
    // own sending address is ever a genuine reply.
    const isOwnAccount = from.indexOf(EXPECTED_RUN_ACCOUNT) !== -1;
    if (!isOwnAccount) continue;

    // FIX (20 Aug 2026, real incident): being sent by Joana's own account is
    // NOT enough on its own -- she also sends internal handoff forwards to
    // teammates (e.g. sean@iconsofrealestate.com) from this same account,
    // in this same thread, sometimes AFTER the real reply to the lead. Only
    // a message actually addressed to the lead's real email counts as "the
    // reply." Skip the recipient check entirely if leadEmail couldn't be
    // determined (extractForwardedLeadInfo() failed) rather than reject
    // every candidate -- an unverifiable match is better than none here,
    // and this loop already tolerates some noise (see textsRoughlyMatch()).
    if (leadEmail) {
      const recipients = (messages[i].getTo() + ' ' + messages[i].getCc()).toLowerCase();
      if (recipients.indexOf(leadEmail) === -1) continue;
    }

    return messages[i];
  }
  return null;
}

function textsRoughlyMatch(a, b) {
  const normalize = s => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return true;
  // Cheap similarity check: if the shorter text is >90% contained in the
  // longer one length-wise and they share most words, call it "not edited".
  // This intentionally errs toward flagging things as "edited" when unsure —
  // false positives here just mean an extra row a human skims past;
  // false negatives mean a real edit gets missed.
  const lenRatio = Math.min(na.length, nb.length) / Math.max(na.length, nb.length || 1);
  return lenRatio > 0.97 && levenshteinRough(na, nb) < 5;
}

function levenshteinRough(a, b) {
  // Small, non-optimized edit distance — fine at these string lengths (email replies, not novels).
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > 20) return 999; // fast exit for clearly different lengths
  const dp = Array(n + 1).fill(0).map((_, j) => j);
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const temp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = temp;
    }
  }
  return dp[n];
}

// ---------- 2. SURFACE SOP SUGGESTIONS (proposals only, never auto-applied) ----------

function generateSopSuggestions() {
  // ADDED (17 Aug 2026, real incident): without a lock, two overlapping
  // executions could both read the same unreviewed rows before either
  // marks them reviewed, and both send the same examples to the LLM --
  // wasted API cost and duplicate rows in "SOP Suggestions". Same fix as
  // runLearningLoopInner() above and runReplyDrafter() in Code.gs.
  const lock = LockService.getScriptLock();
  const gotLock = lock.tryLock(10000);
  if (!gotLock) {
    Logger.log('Another generateSopSuggestions execution is already in progress -- skipping this run rather than racing it.');
    return;
  }
  try {
    generateSopSuggestionsInner();
  } finally {
    lock.releaseLock();
  }
}

function generateSopSuggestionsInner() {
  if (!CONFIG.SPREADSHEET_ID || CONFIG.SPREADSHEET_ID === 'PASTE_YOUR_SHEET_ID_HERE') return;

  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const learningTab = ss.getSheetByName('Learning Log');
  const suggestionsTab = ss.getSheetByName('SOP Suggestions');
  if (!learningTab || !suggestionsTab) return;

  const rows = learningTab.getDataRange().getValues();
  const headers = rows[0];
  const wasEditedCol = headers.indexOf('Was Edited');
  const reviewedCol = headers.indexOf('Reviewed For SOP');
  const categoryCol = headers.indexOf('Category');
  const originalCol = headers.indexOf('Original AI Draft');
  const finalCol = headers.indexOf('Final Sent Text');

  const unreviewedEdits = [];
  const rowIndexesToMark = [];

  for (let i = 1; i < rows.length; i++) {
    if (rows[i][wasEditedCol] === true && rows[i][reviewedCol] !== true) {
      unreviewedEdits.push({
        category: rows[i][categoryCol],
        original: rows[i][originalCol],
        final: rows[i][finalCol],
      });
      rowIndexesToMark.push(i + 1); // sheet rows are 1-indexed, plus header
    }
  }

  if (unreviewedEdits.length === 0) {
    Logger.log('No new edited examples to review.');
    return;
  }

  // CAPPED (17 Aug 2026, real incident): this function was designed around a
  // weekly trickle of a handful of edits, and dumped ALL unreviewed edits
  // into ONE LLM call with no batching. The first real run found 74 edits
  // at once (this exact function had never run before today) and the
  // resulting request -- 1,203,882 tokens -- blew past Kimi's 262,144 limit
  // and would have blown past any provider's context window regardless of
  // which one was used; this was never a "wrong provider" problem. Slicing
  // to a bounded batch per run and leaving the rest for the next run fixes
  // it regardless of how large the backlog ever gets again.
  //
  // KEPT at 5 (19 Aug 2026) even though this now runs daily instead of
  // weekly, and even though the doc+email step below makes a bigger batch
  // easier to actually read than raw sheet rows were -- same "start small,
  // verify quality, raise later once trusted" reasoning as everywhere else
  // in this project. Raise it once a few days of daily docs have come back
  // clean.
  const SOP_SUGGESTIONS_BATCH_SIZE = 5; // start small, verify quality, raise later once trusted
  const deferredCount = Math.max(0, unreviewedEdits.length - SOP_SUGGESTIONS_BATCH_SIZE);
  const batchEdits = unreviewedEdits.slice(0, SOP_SUGGESTIONS_BATCH_SIZE);
  const batchRowIndexes = rowIndexesToMark.slice(0, SOP_SUGGESTIONS_BATCH_SIZE);
  if (deferredCount > 0) {
    Logger.log('generateSopSuggestions -- ' + unreviewedEdits.length + ' unreviewed edits found; processing ' + batchEdits.length + ' this run, deferring ' + deferredCount + ' to the next run(s).');
  }

  const examplesText = batchEdits
    .map((e, idx) => `EXAMPLE ${idx + 1} (category: ${e.category})\n--- AI DRAFTED ---\n${e.original}\n--- JOANA ACTUALLY SENT ---\n${e.final}`)
    .join('\n\n');

  const systemPrompt = `You review edited email drafts to find patterns in how a human editor (Joana) changes AI-drafted sales replies, and propose specific, concrete updates to the SOP that produced the drafts. You are NOT rewriting the SOP yourself — you are proposing changes for a human to review and approve. Be specific: quote the actual phrasing pattern you see repeated across edits, don't generalize vaguely. If the edits don't show a clear repeated pattern (e.g. they're all one-off stylistic tweaks with no common thread), say so plainly rather than inventing a pattern.`;

  const userPrompt = `Here are ${batchEdits.length} examples of AI-drafted replies versus what Joana actually sent instead:\n\n${examplesText}\n\nReturn ONLY a JSON array, no markdown fences, no preamble, of specific suggested SOP changes. Each item: {"pattern_observed": "...", "suggested_change": "...", "confidence": "high | medium | low"}. If there's truly no pattern worth acting on, return an empty array.`;

  const data = callLlmWithFallback(systemPrompt, userPrompt, 2000, 'generateSopSuggestions');
  const textBlock = data.content.find(c => c.type === 'text');
  if (!textBlock) return;

  let suggestions;
  try {
    suggestions = JSON.parse(textBlock.text.trim());
  } catch (e) {
    Logger.log('Failed to parse suggestions JSON: ' + textBlock.text);
    return;
  }

  suggestions.forEach(s => {
    suggestionsTab.appendRow([
      new Date(),
      batchEdits.length,
      `[${s.confidence}] ${s.pattern_observed} -> ${s.suggested_change}`,
      'pending',
    ]);
  });

  // Mark these rows as reviewed so they don't get re-batched next week
  batchRowIndexes.forEach(rowNum => {
    learningTab.getRange(rowNum, reviewedCol + 1).setValue(true);
  });

  Logger.log('Generated ' + suggestions.length + ' SOP suggestions from ' + batchEdits.length + ' edited examples' + (deferredCount > 0 ? ' (' + deferredCount + ' more deferred to next run).' : '.'));

  // ADDED (19 Aug 2026, per direct request): the "SOP Suggestions" sheet
  // tab above is kept as the permanent structured log, but nobody reliably
  // opens a sheet tab on their own -- this creates an actual reviewable
  // document for today's batch and emails it directly, so review is a
  // reply to an email, not a "remember to go check the sheet" chore.
  const docFile = createSopSuggestionsDoc(batchEdits, suggestions, deferredCount);
  emailSopSuggestionsDoc(docFile, suggestions.length);
}

// ---------- 3. DAILY REVIEWABLE DOC + EMAIL (added 19 Aug 2026) ----------

function createSopSuggestionsDoc(batchEdits, suggestions, deferredCount) {
  const dateStr = Utilities.formatDate(new Date(), 'America/Los_Angeles', 'MMMM d, yyyy');
  const doc = DocumentApp.create('SOP Suggestions -- ' + dateStr);
  const body = doc.getBody();

  body.appendParagraph('SOP Suggestions -- ' + dateStr).setHeading(DocumentApp.ParagraphHeading.HEADING1);
  body.appendParagraph(
    'Generated automatically from ' + batchEdits.length + ' real edited repl' + (batchEdits.length === 1 ? 'y' : 'ies') +
    ' found today (AI draft vs. what Joana actually sent).' +
    (deferredCount > 0 ? ' ' + deferredCount + ' more edited example(s) are still queued and will show up in a future day\'s doc.' : '')
  );
  body.appendParagraph('PROPOSALS ONLY -- nothing here has been applied to the live SOP. Review each one below and copy anything real into the live SOP doc by hand.');
  body.appendHorizontalRule();

  if (suggestions.length === 0) {
    body.appendParagraph('No clear repeated pattern found in today\'s edits -- nothing to propose.');
  } else {
    suggestions.forEach((s, idx) => {
      body.appendParagraph('Suggestion ' + (idx + 1) + ' -- ' + String(s.confidence).toUpperCase() + ' confidence').setHeading(DocumentApp.ParagraphHeading.HEADING2);
      body.appendParagraph('Pattern observed: ' + s.pattern_observed);
      body.appendParagraph('Suggested change: ' + s.suggested_change);
    });
  }

  body.appendHorizontalRule();
  body.appendParagraph('Underlying examples this was generated from').setHeading(DocumentApp.ParagraphHeading.HEADING2);
  batchEdits.forEach((e, idx) => {
    body.appendParagraph('Example ' + (idx + 1) + ' (' + e.category + ')').setHeading(DocumentApp.ParagraphHeading.HEADING3);
    body.appendParagraph('AI drafted: ' + e.original);
    body.appendParagraph('Joana actually sent: ' + e.final);
  });

  doc.saveAndClose();
  const file = DriveApp.getFileById(doc.getId());
  // Share with just the three reviewers, not "anyone with the link" --
  // this is real lead-reply content, no reason to widen access beyond who
  // actually needs to review it.
  file.addViewers(['goodness@iconsofrealestate.com', 'joana@iconsofrealestate.com', 'kris@iconsofrealestate.com']);
  return file;
}

function emailSopSuggestionsDoc(docFile, suggestionsCount) {
  const dateStr = Utilities.formatDate(new Date(), 'America/Los_Angeles', 'MMMM d, yyyy');
  const body =
    'This email was written by Claude.\n\n' +
    'Today\'s automated review of edited replies found ' + suggestionsCount + ' potential SOP update' + (suggestionsCount === 1 ? '' : 's') +
    ', based on real differences between what the AI drafted and what Joana actually sent:\n\n' +
    docFile.getUrl() + '\n\n' +
    'Please review and decide whether to add any of these to the live SOP -- nothing here has been applied automatically.';

  MailApp.sendEmail({
    to: 'goodness@iconsofrealestate.com,joana@iconsofrealestate.com,kris@iconsofrealestate.com',
    subject: '[Written by Claude] Daily SOP Suggestions -- ' + dateStr,
    body: body
  });

  Logger.log('SOP suggestions doc emailed to Goodness, Joana, and Kris: ' + docFile.getUrl());
}
