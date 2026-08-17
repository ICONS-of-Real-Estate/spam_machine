/**
 * ICONS OF REAL ESTATE — Learning Loop (companion to podcast_reply_drafter.gs)
 * -----------------------------------------------------------------------------
 * This is a SECOND file in the SAME Apps Script project as
 * podcast_reply_drafter.gs (it shares that file's CONFIG object, so both
 * files must be in one project). It does two things, on its own schedule:
 *
 * 1. runLearningLoop() — run this daily. It looks at every thread logged
 *    in the "AI Drafts Log" tab, checks Joana's Sent folder for the reply
 *    that actually went out, and records whether she sent the draft as-is
 *    or changed it — logging both versions side by side in "Learning Log".
 *
 * 2. generateSopSuggestions() — run this weekly (or whenever you want a
 *    check-in). It reads any un-reviewed edited rows from "Learning Log",
 *    sends them to the LLM (Kimi, falling back to Claude -- see
 *    callLlmWithFallback() in quota_guard_and_alerting.gs) in a batch, and
 *    asks it to identify patterns
 *    and propose SPECIFIC SOP changes. These land in the "SOP Suggestions"
 *    tab as PROPOSALS ONLY — nothing here rewrites the live SOP file or
 *    the automation's system prompt automatically. A human (Kris, or
 *    Kris + Claude in a chat) should review "SOP Suggestions" and merge
 *    anything real into Icons_Podcast_Reply_SOP.md and the drafter's
 *    system prompt by hand. This is deliberate: unsupervised SOP rewrites
 *    based on live sales replies can drift in ways nobody notices until
 *    it's already gone out to real leads.
 *
 * Add both as time-driven triggers in the same project:
 *   - runLearningLoop      -> Day timer, once daily (e.g. overnight)
 *   - generateSopSuggestions -> Week timer, once weekly
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
  const threadIdCol = headers.indexOf('Thread ID');
  const subjectCol = headers.indexOf('Subject');
  const categoryCol = headers.indexOf('Category');
  const draftTextCol = headers.indexOf('Draft Text');

  let compared = 0;

  for (let i = 1; i < draftRows.length; i++) {
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

    const sentReply = findSentReplyAfterDraft(thread);
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
    ]);

    compared++;
  }

  Logger.log('Learning loop run complete. Newly compared: ' + compared);
}

function findSentReplyAfterDraft(thread) {
  const messages = thread.getMessages();
  // Look from the end for a message sent by our own account (i.e. Joana actually replied)
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].isDraft && messages[i].isDraft()) continue;
    const from = messages[i].getFrom().toLowerCase();
    const isOwnAccount = CONFIG.INTERNAL_DOMAINS.some(d => from.indexOf('@' + d) !== -1);
    // Heuristic: it's a genuine sent reply if it's from an internal address
    // AND it's not one of the original 4-touch sequence messages (those come
    // from the lookalike outreach domains, not the real inbox owner sending).
    if (isOwnAccount) return messages[i];
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
  const SOP_SUGGESTIONS_BATCH_SIZE = 15;
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
}
