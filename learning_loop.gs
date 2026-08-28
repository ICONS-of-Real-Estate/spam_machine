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
    Logger.log('Skipping runLearningLoop -- Gmail quota already known exhausted today, ' + timeUntilQuotaResetDescription_() + '.');
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
  } catch (e) {
    // FIX (27 Aug 2026, real risk found in review): no path here could ever
    // trip the Gmail quota circuit breaker -- see handleGmailJobError_.
    handleGmailJobError_('runLearningLoop', e);
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

  // ADDED (24 Aug 2026, per direct request -- the Kimi-vs-Anthropic test has
  // to measure quality, not just price): the provider that wrote each draft
  // is recorded on the AI Drafts Log row (column J). Carrying it across to
  // the Learning Log is what makes quality measurable at all -- this tab is
  // the only place that knows how much a human changed a draft before
  // sending it, and that edit rate IS the quality signal. Without the
  // provider alongside it there is no way to slice it by model.
  //
  // Prefer the header name; fall back to the known fixed position (column J,
  // index 9) that logDraftToSheet() appends to, because the header labels for
  // J/K may not have been typed in yet -- migrateAddLlmColumns() in Code.gs
  // now does that, but rows written before it ran still have data in J with
  // no label above it, and those rows are still worth attributing.
  const LLM_PROVIDER_FIXED_COL = 9;
  const namedProviderCol = headers.indexOf('LLM Provider');
  const llmProviderCol = namedProviderCol !== -1 ? namedProviderCol : LLM_PROVIDER_FIXED_COL;

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

    // FIX (27 Aug 2026, real risk found in review): this catch accepted ANY
    // exception and asserted one cause ("deleted") for all of them --
    // including the real Gmail daily quota error. isGmailQuotaExhausted()
    // just above only reads the project's SELF-tracked flag, which stays
    // false until something calls markGmailQuotaExhausted() -- and nothing
    // in this loop did. So a genuine quota trip mid-run used to make every
    // remaining row throw, every throw got silently swallowed here, and the
    // run finished reporting "Newly compared: 0" -- indistinguishable from
    // a genuinely quiet week. cleanup_poisoned_emails.gs's own header
    // documents this exact anti-pattern ("a quota exception got treated
    // identically to 'this thread genuinely can't be parsed'... halt,
    // don't catch") -- the lesson just hadn't reached this file yet.
    let thread;
    try {
      thread = GmailApp.getThreadById(threadId);
    } catch (e) {
      if (isGmailSpecificQuotaError(e)) {
        markGmailQuotaExhausted();
        Logger.log('runLearningLoopInner -- Gmail quota exceeded at row ' + (i + 1) + ', stopping rather than silently skipping the rest of the backlog.');
        break;
      }
      Logger.log('runLearningLoopInner -- could not open thread ' + threadId + ' (row ' + (i + 1) + '), skipping: ' + e);
      continue;
    }
    if (!thread) {
      Logger.log('runLearningLoopInner -- thread ' + threadId + ' (row ' + (i + 1) + ') returned null (likely deleted), skipping.');
      continue;
    }
    // SELF-TRACKED QUOTA COUNTER (22 Aug 2026, per direct request): see the
    // fuller comment in quota_guard_and_alerting.gs.
    recordGmailQuotaUsage_(1);

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

    // Only accept a value that actually looks like one of the two providers.
    // Rows predating the cost test have nothing here, and a fixed-index read
    // on an old 9-column row picks up undefined -- both should log blank
    // rather than inventing an attribution.
    const rawProvider = String(row[llmProviderCol] || '').toLowerCase().trim();
    const llmProvider = (rawProvider === 'kimi' || rawProvider === 'anthropic') ? rawProvider : '';

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
      llmProvider,
      // "Was Edited" alone is too blunt to compare two models with: fixing one
      // typo and rewriting the reply from scratch both score `true`. This
      // grades it -- 100 means sent exactly as drafted, 0 means nothing of the
      // draft survived. Across enough rows, the average per provider is a far
      // better answer to "which one writes better drafts" than a binary rate.
      draftSimilarityPercent(draftText, sentText),
    ]);

    compared++;
  }

  Logger.log('Learning loop run complete. Newly compared: ' + compared);
}

function findSentReplyAfterDraft(thread, draftCreatedAt, leadEmail) {
  // FIX (27 Aug 2026, real risk found in review): `draftCreatedAt && ... <=
  // new Date(draftCreatedAt).getTime()` had two ways to silently disable the
  // guard just below. A blank cell is falsy, so the `&&` short-circuited the
  // whole check away. A text-formatted or otherwise unparseable cell makes
  // `new Date(draftCreatedAt)` Invalid, `.getTime()` is NaN, and `x <= NaN`
  // is always false -- so the guard passed every message, including one
  // that predates the draft. That reopens exactly the 18 Aug incident this
  // guard was written to close: an unsent draft logged as "what Joana
  // actually sent," corrupting wasEdited/draftSimilarityPercent and the
  // Kimi-vs-Anthropic quality verdict they feed. Parsed once, up front,
  // with an explicit validity check -- an unreadable timestamp now means
  // "we can't safely apply this guard for this row," not "skip the check
  // silently and trust isDraft() alone."
  const draftCreatedMs = (draftCreatedAt instanceof Date) ? draftCreatedAt.getTime() : new Date(draftCreatedAt).getTime();
  if (draftCreatedAt && isNaN(draftCreatedMs)) {
    Logger.log('findSentReplyAfterDraft -- unreadable draftCreatedAt (' + draftCreatedAt + ') for thread ' + thread.getId() + ' -- cannot safely tell whether a candidate message predates the draft, treating as no sent reply found rather than risk logging an unsent draft as sent.');
    return null;
  }

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
    if (draftCreatedAt && messages[i].getDate().getTime() <= draftCreatedMs) continue;
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
      // FIX (27 Aug 2026, real risk found in review): was a substring test
      // via string concatenation -- joann@x.com matched a search for
      // ann@x.com, and `getTo() + ' ' + getCc()` stringifies a null Cc to
      // the literal word "null" via JS's + coercion. recipientListIncludes_
      // (Code.gs) compares parsed addresses and is called once per header
      // instead.
      const isRecipient = recipientListIncludes_(messages[i].getTo(), leadEmail) ||
        recipientListIncludes_(messages[i].getCc(), leadEmail);
      if (!isRecipient) continue;
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

// ADDED (24 Aug 2026, per direct request -- measure split-test QUALITY):
// how much of the AI's draft actually survived into what the human sent,
// as a 0-100 percentage.
//
// Deliberately word-overlap (multiset intersection over the larger bag),
// not edit distance. levenshteinRough() right above is O(m*n) and, more to
// the point, fast-exits with a sentinel 999 the moment lengths differ by
// more than 20 chars -- fine for its own "is this basically identical"
// job, useless as a graded score, since every genuinely-rewritten draft
// would collapse to the same value. Word overlap is O(n), stays honest
// across big length differences, and ignores pure reordering/reformatting,
// which is what we want: moving a paragraph is not the same kind of edit
// as replacing the argument.
//
// Note this compares against the sent message's FULL plain body, which
// includes the quoted history beneath the reply -- that inflates the score
// somewhat, but it inflates it equally for both providers, so the
// comparison between them stays fair. Read these as relative, not absolute.
function draftSimilarityPercent(draftText, sentText) {
  const words = s => String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 0);
  const draftWords = words(draftText);
  const sentWords = words(sentText);
  if (draftWords.length === 0 || sentWords.length === 0) return 0;

  const sentCounts = {};
  sentWords.forEach(w => { sentCounts[w] = (sentCounts[w] || 0) + 1; });

  let shared = 0;
  draftWords.forEach(w => {
    if (sentCounts[w] > 0) { shared++; sentCounts[w]--; }
  });

  return Math.round((shared / Math.max(draftWords.length, 1)) * 100);
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
  } catch (e) {
    // FIX (27 Aug 2026, real risk found in review): no path here could ever
    // trip the Gmail quota circuit breaker -- see handleGmailJobError_.
    handleGmailJobError_('generateSopSuggestions', e);
  } finally {
    lock.releaseLock();
  }
}

function generateSopSuggestionsInner(opts) {
  // ADDED (23 Aug 2026, per direct request): opts.skipDocAndEmail lets the
  // backlog catch-up trigger below (runSopSuggestionsCatchup()) reuse this
  // exact same batching/marking logic without sending a doc+email after
  // every single run -- it wants ONE email for the whole catch-up, not one
  // per run. The normal daily caller (generateSopSuggestions()) doesn't
  // pass this, so its behavior is unchanged. Either way, this returns
  // whether the backlog is now fully drained (deferredCount === 0), which
  // the catch-up trigger uses to know when to finalize and stop.
  opts = opts || {};
  const skipDocAndEmail = opts.skipDocAndEmail === true;

  if (!CONFIG.SPREADSHEET_ID || CONFIG.SPREADSHEET_ID === 'PASTE_YOUR_SHEET_ID_HERE') return true;

  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const learningTab = ss.getSheetByName('Learning Log');
  const suggestionsTab = ss.getSheetByName('SOP Suggestions');
  if (!learningTab || !suggestionsTab) return true;

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
    return true;
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

  // CHANGED (23 Aug 2026, per direct request -- "Don't email every freaking
  // time"): a 500-example backlog built up while generateSopSuggestions was
  // silently failing on the doc/email step (see the DriveApp fix above). The
  // per-LLM-call size above still needs to stay small (that's what the 17
  // Aug incident was about -- each example can be a huge quoted forwarded
  // thread), but this run used to email a doc after EVERY 5-example batch,
  // so burning down a backlog this size at real speed would have meant one
  // email per handful of examples -- tens of them a day. Instead, loop
  // multiple 5-example LLM calls inside ONE execution, accumulate everything
  // into one doc + one email at the end. Time-boxed well under Apps Script's
  // ~6-min limit so a slow LLM call can't blow the run.
  const SOP_SUGGESTIONS_RUN_TIME_BUDGET_MS = 4.5 * 60 * 1000; // leave headroom under the ~6-min execution limit
  const runStart = new Date().getTime();

  const allBatchEdits = [];
  const allSuggestions = [];
  let remaining = unreviewedEdits.slice();
  let remainingRowIndexes = rowIndexesToMark.slice();

  let batchNum = 0;
  const totalBatches = Math.ceil(unreviewedEdits.length / SOP_SUGGESTIONS_BATCH_SIZE);
  while (remaining.length > 0 && (new Date().getTime() - runStart) < SOP_SUGGESTIONS_RUN_TIME_BUDGET_MS) {
    batchNum++;
    const batchEdits = remaining.slice(0, SOP_SUGGESTIONS_BATCH_SIZE);
    const batchRowIndexes = remainingRowIndexes.slice(0, SOP_SUGGESTIONS_BATCH_SIZE);

    // DIAGNOSTIC (28 Aug 2026, per direct request -- "look how slow the
    // logging is"): this loop used to print NOTHING between the "found N
    // unreviewed edits" line at the top and the "processed N across M
    // batch(es)" summary at the bottom -- every LLM call in between (each
    // one can take 10-20+ seconds) ran silently. Same blind spot
    // reconcile_missing_drafts.gs's progress line was added for on 27 Aug;
    // applying the same fix here.
    Logger.log('generateSopSuggestions -- starting batch ' + batchNum + '/' + totalBatches + ' (' + batchEdits.length + ' edited example(s))...');

    const examplesText = batchEdits
      .map((e, idx) => `EXAMPLE ${idx + 1} (category: ${e.category})\n--- AI DRAFTED ---\n${e.original}\n--- JOANA ACTUALLY SENT ---\n${e.final}`)
      .join('\n\n');

    const systemPrompt = `You review edited email drafts to find patterns in how a human editor (Joana) changes AI-drafted sales replies, and propose specific, concrete updates to the SOP that produced the drafts. You are NOT rewriting the SOP yourself — you are proposing changes for a human to review and approve. Be specific: quote the actual phrasing pattern you see repeated across edits, don't generalize vaguely. If the edits don't show a clear repeated pattern (e.g. they're all one-off stylistic tweaks with no common thread), say so plainly rather than inventing a pattern.`;

    const userPrompt = `Here are ${batchEdits.length} examples of AI-drafted replies versus what Joana actually sent instead:\n\n${examplesText}\n\nReturn ONLY a JSON array, no markdown fences, no preamble, of specific suggested SOP changes. Each item: {"pattern_observed": "...", "suggested_change": "...", "confidence": "high | medium | low"}. If there's truly no pattern worth acting on, return an empty array.`;

    // RAISED (23 Aug 2026, real incident): confirmed live -- 2000 was too
    // small. A single 5-example batch produced 9 detailed suggestions and
    // got cut off mid-JSON-array, JSON.parse() threw, and that whole
    // batch's suggestions were silently lost (rows still marked reviewed,
    // but nothing to show for the LLM call that found them -- not
    // retried). Raised to a size that comfortably fits the largest batches
    // seen in practice, with headroom.
    const data = callLlmWithFallback(systemPrompt, userPrompt, 8000, 'generateSopSuggestions');
    const textBlock = data.content.find(c => c.type === 'text');
    if (!textBlock) break;

    // FIX (27 Aug 2026, real risk found in review): on a parse failure this
    // used to fall back to suggestions = [] and then continue straight on to
    // marking the batch's rows reviewed anyway. The LLM call was already
    // paid for, nothing was written to "SOP Suggestions", and those Learning
    // Log rows -- the only signal this loop has -- were gone permanently
    // (they'd never be re-sent, since the selection query is "not yet
    // reviewed"). The 23 Aug incident this file already documents (a
    // truncated response) only raised max_tokens; it didn't fix the
    // underlying "parse failed -> mark reviewed anyway" behavior, which can
    // still be hit by anything else that makes JSON.parse throw. Also
    // stripped a markdown code fence before parsing -- the sibling
    // implementation in lead_followup_sequences.gs already does this, and a
    // model wrapping its JSON in ```json fences is a routine occurrence, not
    // an edge case.
    let suggestions;
    let parseOk = true;
    try {
      const cleaned = textBlock.text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
      suggestions = JSON.parse(cleaned);
    } catch (e) {
      Logger.log('generateSopSuggestions -- failed to parse suggestions JSON, NOT marking this batch\'s rows reviewed (will retry next run): ' + textBlock.text);
      parseOk = false;
      suggestions = [];
    }
    if (parseOk && !Array.isArray(suggestions)) {
      Logger.log('generateSopSuggestions -- expected a JSON array, got ' + typeof suggestions + ' -- treating as a parse failure, NOT marking reviewed: ' + textBlock.text);
      parseOk = false;
      suggestions = [];
    }

    if (!parseOk) {
      // Don't mark these rows reviewed, don't advance past them, and don't
      // keep spending LLM calls this run on a response shape that just
      // failed -- these rows are still "unreviewed" in the sheet and will be
      // picked up again on the next firing (daily, or the 5-min catch-up
      // trigger while one is running).
      break;
    }

    suggestions.forEach(s => {
      suggestionsTab.appendRow([
        new Date(),
        batchEdits.length,
        `[${s.confidence}] ${s.pattern_observed} -> ${s.suggested_change}`,
        'pending',
      ]);
    });

    // Mark these rows as reviewed immediately -- if the run dies partway
    // through the loop (timeout, quota, crash), whatever's already been
    // processed and logged stays marked so it's never re-sent to the LLM.
    batchRowIndexes.forEach(rowNum => {
      learningTab.getRange(rowNum, reviewedCol + 1).setValue(true);
    });

    allBatchEdits.push(...batchEdits);
    allSuggestions.push(...suggestions);
    remaining = remaining.slice(SOP_SUGGESTIONS_BATCH_SIZE);
    remainingRowIndexes = remainingRowIndexes.slice(SOP_SUGGESTIONS_BATCH_SIZE);
  }

  const deferredCount = remaining.length;
  Logger.log('generateSopSuggestions -- ' + unreviewedEdits.length + ' unreviewed edits found; processed ' + allBatchEdits.length + ' across ' + Math.ceil(allBatchEdits.length / SOP_SUGGESTIONS_BATCH_SIZE) + ' batch(es) this run, deferring ' + deferredCount + ' to the next run(s).');

  if (allBatchEdits.length === 0) return deferredCount === 0;

  Logger.log('Generated ' + allSuggestions.length + ' SOP suggestions from ' + allBatchEdits.length + ' edited examples' + (deferredCount > 0 ? ' (' + deferredCount + ' more deferred to next run).' : '.'));

  // ADDED (19 Aug 2026, per direct request): the "SOP Suggestions" sheet
  // tab above is kept as the permanent structured log, but nobody reliably
  // opens a sheet tab on their own -- this creates an actual reviewable
  // document for today's batch and emails it directly, so review is a
  // reply to an email, not a "remember to go check the sheet" chore.
  // ONE doc + ONE email per run now, covering every batch processed above,
  // not one per 5-example batch. Skipped entirely during backlog catch-up
  // mode (opts.skipDocAndEmail) -- see runSopSuggestionsCatchup() below.
  if (!skipDocAndEmail) {
    // ADDED (23 Aug 2026, per direct request -- "every time it runs the
    // script, it merges duplicates before sending to the team"): each
    // 5-example batch is analyzed by the LLM in total isolation from every
    // other batch, so the same real pattern (e.g. a specific emoji
    // placement, a specific CTA phrasing) can get independently
    // rediscovered and separately worded by many different batches in one
    // run. Confirmed live: the 23 Aug backlog catch-up sent 548 raw
    // findings, most of them the same handful of real patterns repeated.
    // Merge before building the doc/email that goes to the team -- the
    // "SOP Suggestions" sheet tab above still keeps every raw finding,
    // unmerged, as the permanent audit trail.
    const suggestionLines = allSuggestions.map(s => '[' + s.confidence + '] ' + s.pattern_observed + ' -> ' + s.suggested_change);
    const merged = mergeDuplicateSuggestions_(suggestionLines, 'generateSopSuggestions');
    const finalSuggestions = merged || allSuggestions;
    const docFile = createSopSuggestionsDoc(allBatchEdits, finalSuggestions, deferredCount);
    emailSopSuggestionsDoc(docFile, finalSuggestions.length);
  }

  return deferredCount === 0;
}

// ADDED (23 Aug 2026, per direct request): consolidates a list of proposed
// SOP changes that may contain duplicates/near-duplicates -- the same real
// pattern discovered independently by different batches and worded
// slightly differently. Used by both the normal per-run doc/email above
// and the backlog catch-up finalize step below, so EVERY doc/email that
// reaches the team is deduplicated, not just this one-time backlog.
// Returns an array of merged suggestions ({pattern_observed,
// suggested_change, confidence}), or null on any failure -- callers should
// fall back to sending the unmerged list rather than losing the run's
// findings entirely over a merge-step hiccup.
//
// CHUNKED (28 Aug 2026, real incident -- 27 Aug's run generated 52 raw
// suggestions from 35 edits and the doc/email that reached the team still
// had all 52, un-consolidated: "suggesting 52 SOP changes is still too
// much"). ROOT CAUSE: this was a single LLM call handed the ENTIRE list at
// once. At 52 verbose entries (each a multi-sentence pattern_observed +
// suggested_change, per the real doc), a full-fidelity merged response can
// easily need more output than a single call comfortably produces, and the
// same silent-failure path documented above -- no text block, unparseable
// JSON, empty array -- falls all the way back to "send everything
// unmerged." A truncated/failed merge and a merge that's simply too large
// to reason well about both land on the same result: the raw dump. FIX:
// merge in bounded chunks first (each well within one call's comfortable
// output size), then merge the merged results together in a second pass --
// same map-reduce shape as SOP_SUGGESTIONS_BATCH_SIZE already uses for
// generation, applied to consolidation too. A list at or under one chunk
// still does exactly what this function always did: one call, no
// recursion.
const SOP_MERGE_CHUNK_SIZE = 15;

function mergeDuplicateSuggestions_(suggestionLines, callerLabel) {
  if (!suggestionLines || suggestionLines.length <= 1) return null;

  if (suggestionLines.length > SOP_MERGE_CHUNK_SIZE) {
    const chunks = [];
    for (let i = 0; i < suggestionLines.length; i += SOP_MERGE_CHUNK_SIZE) {
      chunks.push(suggestionLines.slice(i, i + SOP_MERGE_CHUNK_SIZE));
    }
    Logger.log(callerLabel + ' -- ' + suggestionLines.length + ' suggestion(s) exceeds the ' + SOP_MERGE_CHUNK_SIZE +
      '-item merge chunk size, splitting into ' + chunks.length + ' chunk(s) before a final combining pass.');

    const chunkResults = [];
    chunks.forEach((chunk, idx) => {
      // DIAGNOSTIC (28 Aug 2026, per direct request -- "look how slow the
      // logging is"): each chunk's merge call can take 15-20+ seconds, and
      // the only log line was AFTER it finished -- same silent-stretch
      // problem as the generation loop above.
      Logger.log(callerLabel + ' -- merging chunk ' + (idx + 1) + '/' + chunks.length + ' (' + chunk.length + ' item(s))...');
      const mergedChunk = mergeSuggestionChunk_(chunk, callerLabel + ':chunk' + (idx + 1));
      // A chunk that fails to merge still contributes its raw entries to the
      // final pass rather than being dropped -- losing real findings to a
      // one-chunk hiccup would be worse than asking the final pass to work
      // a little harder.
      if (mergedChunk) {
        chunkResults.push(...mergedChunk.map(s => '[' + s.confidence + '] ' + s.pattern_observed + ' -> ' + s.suggested_change));
      } else {
        chunkResults.push(...chunk);
      }
    });

    // Final combining pass over the (now much smaller) per-chunk results.
    // Recurses only if the chunked results are STILL over the chunk size --
    // won't happen at realistic volumes (chunks / SOP_MERGE_CHUNK_SIZE
    // chunk-results is always <= SOP_MERGE_CHUNK_SIZE for any list size that
    // matters here), but staying recursive rather than assuming it costs
    // nothing and keeps the guarantee true regardless of how large a future
    // backlog gets.
    Logger.log(callerLabel + ' -- all ' + chunks.length + ' chunk(s) merged (' + chunkResults.length +
      ' item(s) total), starting final combining pass...');
    return mergeDuplicateSuggestions_(chunkResults, callerLabel + ':final') || chunkResults.map(parseSuggestionLine_);
  }

  return mergeSuggestionChunk_(suggestionLines, callerLabel);
}

// Parses a "[confidence] pattern -> change" line back into the structured
// shape, for the rare fallback path where a chunk's raw lines end up in the
// final output untouched (chunk merge failed AND the final pass over the
// combined list also failed) -- keeps the return shape consistent
// ({pattern_observed, suggested_change, confidence}) regardless of which
// path produced it.
function parseSuggestionLine_(line) {
  const m = String(line).match(/^\[(\w+)\]\s*(.*?)\s*->\s*(.*)$/);
  return m
    ? { confidence: m[1], pattern_observed: m[2], suggested_change: m[3] }
    : { confidence: 'low', pattern_observed: String(line), suggested_change: '' };
}

// The actual single-call merge, unchanged from the original implementation
// except the caller-supplied label and a higher max_tokens (see below) --
// operates on one chunk (<= SOP_MERGE_CHUNK_SIZE items) at a time.
function mergeSuggestionChunk_(suggestionLines, callerLabel) {
  if (!suggestionLines || suggestionLines.length <= 1) return null;
  // ':merge' suffix preserved from the pre-chunking version -- keeps merge
  // calls distinguishable from the main generation calls in the LLM Cost
  // Log under the same top-level caller name.
  const llmCallerLabel = callerLabel + ':merge';

  const systemPrompt = `You consolidate a list of proposed SOP changes that may contain duplicate or near-duplicate entries -- the same underlying behavioral pattern independently discovered multiple times and worded slightly differently. Merge duplicates/near-duplicates into a single clear entry each. Keep genuinely distinct suggestions separate. When merging, keep the clearest wording and the highest confidence level seen among the merged entries. Do not invent new suggestions -- only consolidate what is given.`;

  const listText = suggestionLines.map((t, i) => (i + 1) + '. ' + t).join('\n');
  const userPrompt = `Here are ${suggestionLines.length} proposed SOP changes, which may contain duplicates or near-duplicates describing the same underlying pattern:\n\n${listText}\n\nReturn ONLY a JSON array, no markdown fences, no preamble -- the consolidated, deduplicated list. Each item: {"pattern_observed": "...", "suggested_change": "...", "confidence": "high | medium | low"}.`;

  try {
    // RAISED 8000 -> 12000 (28 Aug 2026, same incident as above): a
    // full-fidelity echo of a near-max-size chunk (15 verbose entries) can
    // approach 8000 output tokens on its own with little room left for
    // actual consolidation text -- the same truncation shape as the 23 Aug
    // generation-side incident this function's max_tokens was never
    // revisited for. Chunking keeps each call's input bounded; this keeps
    // its output budget from being the next silent-failure trigger.
    const data = callLlmWithFallback(systemPrompt, userPrompt, 12000, llmCallerLabel);
    const textBlock = data.content.find(c => c.type === 'text');
    if (!textBlock) {
      Logger.log(callerLabel + ' -- merge step got no text block back, sending unmerged (' + suggestionLines.length + ' items).');
      return null;
    }
    const cleaned = textBlock.text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    const merged = JSON.parse(cleaned);
    if (!Array.isArray(merged) || merged.length === 0) {
      Logger.log(callerLabel + ' -- merge step returned no usable list, sending unmerged (' + suggestionLines.length + ' items).');
      return null;
    }
    Logger.log(callerLabel + ' -- merged ' + suggestionLines.length + ' suggestion(s) down to ' + merged.length + '.');
    return merged;
  } catch (e) {
    Logger.log(callerLabel + ' -- merge step failed, sending unmerged (' + suggestionLines.length + ' items): ' + e);
    return null;
  }
}

// ---------- 2b. BACKLOG CATCH-UP MODE (added 23 Aug 2026, per direct request) ----------
// A ~500-example backlog built up in the Learning Log while
// generateSopSuggestions was silently failing on the doc/email step (see the
// DriveApp fixes above it was never actually losing data, just never
// notifying anyone). Direct request: "Bump the trigger to run regularly and
// finish all today. Only email once when the backlog is finished." This is
// a TEMPORARY, SELF-REMOVING trigger, separate from generateSopSuggestions's
// normal daily trigger (unaffected, keeps running as-is):
//   - installSopSuggestionsCatchupTrigger() -- run this ONCE, manually, from
//     the script editor to start it. Records a start timestamp and installs
//     a frequent trigger.
//   - runSopSuggestionsCatchup() -- what that trigger fires. Reuses the
//     exact same batching/marking logic as the normal path (via
//     generateSopSuggestionsInner's skipDocAndEmail option), but sends NO
//     email itself. The run that finds the backlog fully drained builds ONE
//     doc covering every suggestion generated since the start timestamp,
//     emails it once, and removes its own trigger -- so this never keeps
//     firing after the backlog is gone.
//   - removeSopSuggestionsCatchupTrigger() -- manual safety valve to abort
//     early if needed; also called automatically once the backlog clears.

const SOP_CATCHUP_START_PROP = 'SOP_CATCHUP_START_ISO';
const SOP_CATCHUP_TRIGGER_FN = 'runSopSuggestionsCatchup';

function installSopSuggestionsCatchupTrigger() {
  removeSopSuggestionsCatchupTrigger(); // safe to call twice
  PropertiesService.getScriptProperties().setProperty(SOP_CATCHUP_START_PROP, new Date().toISOString());
  ScriptApp.newTrigger(SOP_CATCHUP_TRIGGER_FN)
    .timeBased()
    .everyMinutes(5)
    .create();
  Logger.log('Installed SOP suggestions backlog catch-up trigger (every 5 min) -- will self-remove and send one email once the backlog clears.');
}

function removeSopSuggestionsCatchupTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === SOP_CATCHUP_TRIGGER_FN) {
      ScriptApp.deleteTrigger(t);
    }
  });
}

// FIX (27 Aug 2026, real risk found in review): this 5-minute trigger only
// ever removed itself when generateSopSuggestionsInner returned
// backlogCleared === true. If it throws every run instead -- both LLM
// providers down, or a bad response shape neither Array.isArray guard
// catches -- there was no attempt cap, no age cap, and no quota check, so
// it would fire every 5 minutes indefinitely, each time looping LLM calls
// for up to its own runtime budget. This is the clearest unbounded-API-call
// path in the project. Capped at 24h since install: if the backlog still
// hasn't cleared by then, something is systematically wrong and continuing
// to retry every 5 minutes isn't going to fix it -- it needs a human.
const SOP_CATCHUP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function runSopSuggestionsCatchup() {
  const startIso = PropertiesService.getScriptProperties().getProperty(SOP_CATCHUP_START_PROP);
  if (startIso && (Date.now() - new Date(startIso).getTime()) > SOP_CATCHUP_MAX_AGE_MS) {
    removeSopSuggestionsCatchupTrigger();
    sendOpsAlert('SOP catch-up trigger self-removed after 24h',
      'runSopSuggestionsCatchup never reported the backlog cleared within 24 hours of being installed -- removing its 5-minute trigger rather than continuing to fire indefinitely. Check the execution log for the repeating error, then re-run installSopSuggestionsCatchupTrigger() once it is fixed.');
    return;
  }

  const lock = LockService.getScriptLock();
  const gotLock = lock.tryLock(10000);
  if (!gotLock) {
    Logger.log('Another generateSopSuggestions/catch-up execution is already in progress -- skipping this run rather than racing it.');
    return;
  }
  try {
    const backlogCleared = generateSopSuggestionsInner({ skipDocAndEmail: true });
    if (backlogCleared) {
      finalizeSopSuggestionsCatchup();
      removeSopSuggestionsCatchupTrigger();
    }
  } catch (e) {
    // FIX (27 Aug 2026, real risk found in review): no path here could ever
    // trip the Gmail quota circuit breaker -- see handleGmailJobError_. Note
    // this job's actual API cost is LLM calls, not Gmail, but a quota error
    // here still needs the same visibility rather than silently retrying
    // every 5 minutes.
    handleGmailJobError_('runSopSuggestionsCatchup', e);
  } finally {
    lock.releaseLock();
  }
}

// ADDED (27 Aug 2026, per direct request -- "fix all emails"): all three SOP
// suggestions emails below shared the same defect -- the actual thing to act
// on (the Doc) was a bare pasted URL on its own line, not a clickable link.
// One shared card for all three so the visual language stays identical and
// a future wording tweak to one doesn't quietly drift from the other two.
function docLinkCardHtml_(url, label) {
  return (
    '<div style="margin:14px 0; padding:14px 18px; border:1px solid #e0e0e0; border-left:4px solid #1a2b4c; border-radius:6px;">' +
      '<a href="' + url + '" style="color:#1a2b4c; font-weight:bold; font-size:15px; text-decoration:none;">&#128196; ' + escapeHtml(label) + '</a>' +
    '</div>'
  );
}

function finalizeSopSuggestionsCatchup() {
  const props = PropertiesService.getScriptProperties();
  const startIso = props.getProperty(SOP_CATCHUP_START_PROP);
  const startDate = startIso ? new Date(startIso) : new Date(0);

  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const suggestionsTab = ss.getSheetByName('SOP Suggestions');
  const newSuggestionRows = suggestionsTab
    ? suggestionsTab.getDataRange().getValues().slice(1).filter(r => r[0] instanceof Date && r[0] >= startDate)
    : [];

  // ADDED (23 Aug 2026, per direct request -- "merge duplicates before
  // sending to the team"): each 5-example batch analyzed the LLM in
  // isolation from every other batch, so the same real pattern got
  // independently rediscovered and separately worded across ~110 batches.
  // Merge before this goes to the team -- the sheet rows above (the
  // permanent audit trail) are untouched, still one row per raw finding.
  const rawSuggestionLines = newSuggestionRows.map(r => String(r[2]));
  const merged = mergeDuplicateSuggestions_(rawSuggestionLines, 'runSopSuggestionsCatchup');
  const finalSuggestions = merged || rawSuggestionLines.map(line => ({ pattern_observed: line, suggested_change: '', confidence: '' }));

  const dateStr = Utilities.formatDate(new Date(), 'America/Los_Angeles', 'MMMM d, yyyy');
  const doc = DocumentApp.create('SOP Suggestions -- Backlog Catch-up -- ' + dateStr);
  const body = doc.getBody();
  body.appendParagraph('SOP Suggestions -- Backlog Catch-up').setHeading(DocumentApp.ParagraphHeading.HEADING1);
  body.appendParagraph(
    'The Learning Log backlog that built up while the SOP-suggestions email was silently ' +
    'failing has now been fully processed. ' + finalSuggestions.length + ' distinct suggestion' +
    (finalSuggestions.length === 1 ? '' : 's') + ' remain after merging duplicates (from ' +
    newSuggestionRows.length + ' raw finding' + (newSuggestionRows.length === 1 ? '' : 's') +
    ' across the whole catch-up run):'
  );
  body.appendParagraph('PROPOSALS ONLY -- nothing here has been applied to the live SOP. Review each one and copy anything real into the live SOP doc by hand.');
  body.appendHorizontalRule();

  if (finalSuggestions.length === 0) {
    body.appendParagraph('No suggestions were generated from the backlog.');
  } else {
    finalSuggestions.forEach((s, idx) => {
      body.appendParagraph('Suggestion ' + (idx + 1) + (s.confidence ? ' -- ' + String(s.confidence).toUpperCase() + ' confidence' : '')).setHeading(DocumentApp.ParagraphHeading.HEADING2);
      body.appendParagraph('Pattern observed: ' + s.pattern_observed);
      if (s.suggested_change) {
        body.appendParagraph('Suggested change: ' + s.suggested_change);
      }
    });
  }

  doc.saveAndClose();
  const file = DriveApp.getFileById(doc.getId());
  const ownerEmail = file.getOwner() ? file.getOwner().getEmail() : null;
  const viewers = ['goodness@iconsofrealestate.com', 'joana@iconsofrealestate.com', 'kris@iconsofrealestate.com', 'tomas@iconsofrealestate.com']
    .filter(addr => addr.toLowerCase() !== (ownerEmail || '').toLowerCase());
  if (viewers.length > 0) {
    file.addViewers(viewers);
  }

  MailApp.sendEmail({
    to: 'goodness@iconsofrealestate.com,joana@iconsofrealestate.com',
    cc: 'kris@iconsofrealestate.com,tomas@iconsofrealestate.com',
    subject: '[Written by Claude] SOP Suggestions -- backlog fully processed -- ' + dateStr,
    body:
      'This email was written by Claude.\n\n' +
      'The Learning Log backlog has been fully processed. ' + finalSuggestions.length +
      ' distinct potential SOP update' + (finalSuggestions.length === 1 ? '' : 's') +
      ' remain after merging duplicates (from ' + newSuggestionRows.length + ' raw finding' +
      (newSuggestionRows.length === 1 ? '' : 's') + ' across the whole catch-up run):\n\n' +
      file.getUrl() + '\n\n' +
      'Please review and decide whether to add any of these to the live SOP -- nothing here has been applied automatically.',
    htmlBody:
      '<div style="font-family:Arial,sans-serif; font-size:14px; color:#222;">' +
        '<p>This email was written by Claude.</p>' +
        '<p>The Learning Log backlog has been fully processed. <b>' + finalSuggestions.length +
          '</b> distinct potential SOP update' + (finalSuggestions.length === 1 ? '' : 's') +
          ' remain after merging duplicates (from ' + newSuggestionRows.length + ' raw finding' +
          (newSuggestionRows.length === 1 ? '' : 's') + ' across the whole catch-up run):</p>' +
        docLinkCardHtml_(file.getUrl(), 'SOP Suggestions -- Backlog Catch-up -- ' + dateStr) +
        '<p style="color:#555555; font-size:13px;">Please review and decide whether to add any of these to the live SOP &mdash; nothing here has been applied automatically.</p>' +
      '</div>'
  });

  props.deleteProperty(SOP_CATCHUP_START_PROP);
  Logger.log('SOP suggestions backlog catch-up complete -- ' + newSuggestionRows.length + ' raw findings merged to ' + finalSuggestions.length + ', one email sent: ' + file.getUrl());
}

// ONE-OFF (23 Aug 2026, per direct request): the backlog catch-up trigger
// already finished and sent its email BEFORE the merge step above existed
// -- 548 raw, un-deduplicated findings went out. Run this ONCE, manually,
// to send a corrected, deduplicated doc+email covering everything logged
// today, superseding that earlier one. Not part of any schedule -- delete
// or ignore once run. (finalizeSopSuggestionsCatchup()'s own start-time
// marker was already cleared when that run completed, so this filters by
// today's calendar date instead, which covers the same rows.)
function mergeAndResendTodaysSopSuggestions() {
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const suggestionsTab = ss.getSheetByName('SOP Suggestions');
  if (!suggestionsTab) {
    Logger.log('mergeAndResendTodaysSopSuggestions -- "SOP Suggestions" tab not found.');
    return;
  }

  const todayStr = Utilities.formatDate(new Date(), 'Europe/Paris', 'yyyy-MM-dd');
  const todaysRows = suggestionsTab.getDataRange().getValues().slice(1)
    .filter(r => r[0] instanceof Date && Utilities.formatDate(r[0], 'Europe/Paris', 'yyyy-MM-dd') === todayStr);

  if (todaysRows.length === 0) {
    Logger.log('mergeAndResendTodaysSopSuggestions -- no suggestions logged today, nothing to merge.');
    return;
  }

  const rawLines = todaysRows.map(r => String(r[2]));
  Logger.log('mergeAndResendTodaysSopSuggestions -- merging ' + rawLines.length + ' suggestion(s) logged today.');

  const merged = mergeDuplicateSuggestions_(rawLines, 'mergeAndResendTodaysSopSuggestions');
  const finalSuggestions = merged || rawLines.map(line => ({ pattern_observed: line, suggested_change: '', confidence: '' }));

  const dateStr = Utilities.formatDate(new Date(), 'America/Los_Angeles', 'MMMM d, yyyy');
  const doc = DocumentApp.create('SOP Suggestions -- Backlog Catch-up (Deduplicated) -- ' + dateStr);
  const body = doc.getBody();
  body.appendParagraph('SOP Suggestions -- Backlog Catch-up (Deduplicated)').setHeading(DocumentApp.ParagraphHeading.HEADING1);
  body.appendParagraph(
    'This supersedes the earlier "backlog fully processed" email sent today, which listed ' +
    rawLines.length + ' raw, un-deduplicated findings -- most of the ~110 independent batches ' +
    'rediscovered the same real pattern worded slightly differently. Same underlying findings, ' +
    'merged down to ' + finalSuggestions.length + ' distinct suggestion' + (finalSuggestions.length === 1 ? '' : 's') + ':'
  );
  body.appendParagraph('PROPOSALS ONLY -- nothing here has been applied to the live SOP. Review each one and copy anything real into the live SOP doc by hand.');
  body.appendHorizontalRule();

  finalSuggestions.forEach((s, idx) => {
    body.appendParagraph('Suggestion ' + (idx + 1) + (s.confidence ? ' -- ' + String(s.confidence).toUpperCase() + ' confidence' : '')).setHeading(DocumentApp.ParagraphHeading.HEADING2);
    body.appendParagraph('Pattern observed: ' + s.pattern_observed);
    if (s.suggested_change) {
      body.appendParagraph('Suggested change: ' + s.suggested_change);
    }
  });

  doc.saveAndClose();
  const file = DriveApp.getFileById(doc.getId());
  const ownerEmail = file.getOwner() ? file.getOwner().getEmail() : null;
  const viewers = ['goodness@iconsofrealestate.com', 'joana@iconsofrealestate.com', 'kris@iconsofrealestate.com', 'tomas@iconsofrealestate.com']
    .filter(addr => addr.toLowerCase() !== (ownerEmail || '').toLowerCase());
  if (viewers.length > 0) {
    file.addViewers(viewers);
  }

  MailApp.sendEmail({
    to: 'goodness@iconsofrealestate.com,joana@iconsofrealestate.com',
    cc: 'kris@iconsofrealestate.com,tomas@iconsofrealestate.com',
    subject: '[Written by Claude] SOP Suggestions -- deduplicated (supersedes earlier email) -- ' + dateStr,
    body:
      'This email was written by Claude.\n\n' +
      'The earlier "backlog fully processed" email sent today listed ' + rawLines.length +
      ' raw findings -- most were the same real pattern rediscovered independently by different ' +
      'batches. Same findings, merged down to ' + finalSuggestions.length + ' distinct, reviewable ' +
      'suggestion' + (finalSuggestions.length === 1 ? '' : 's') + ':\n\n' +
      file.getUrl() + '\n\n' +
      'This supersedes the earlier email today -- please review this one instead.',
    htmlBody:
      '<div style="font-family:Arial,sans-serif; font-size:14px; color:#222;">' +
        '<p>This email was written by Claude.</p>' +
        '<p><b>This supersedes the earlier email today</b> &mdash; please review this one instead.</p>' +
        '<p>The earlier &ldquo;backlog fully processed&rdquo; email sent today listed ' + rawLines.length +
          ' raw findings &mdash; most were the same real pattern rediscovered independently by different batches. ' +
          'Same findings, merged down to <b>' + finalSuggestions.length + '</b> distinct, reviewable ' +
          'suggestion' + (finalSuggestions.length === 1 ? '' : 's') + ':</p>' +
        docLinkCardHtml_(file.getUrl(), 'SOP Suggestions -- Backlog Catch-up (Deduplicated) -- ' + dateStr) +
      '</div>'
  });

  Logger.log('mergeAndResendTodaysSopSuggestions -- done. ' + rawLines.length + ' raw -> ' + finalSuggestions.length + ' merged. Emailed: ' + file.getUrl());
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
    // READABILITY (28 Aug 2026, per direct request -- "blocks of text like
    // this is very hard to read... bold, highlight, spacing makes it
    // easier"): every line here used to be one plain, unstyled paragraph --
    // a heading followed by two dense sentences with no visual separation
    // from the confidence level, the "Pattern observed"/"Suggested change"
    // labels, or the next suggestion. Confidence now gets a colored heading
    // (matches categoryColor_'s green/red convention in daily_report.gs --
    // high confidence should read as "act on this," not require reading the
    // word), the two labels are bold and inline instead of narrative
    // prose, and each suggestion gets breathing room below it.
    const confidenceColor_ = c => {
      const s = String(c).toLowerCase();
      if (s === 'high') return '#1a7f37';
      if (s === 'low') return '#888888';
      return '#e08e0b'; // medium
    };
    suggestions.forEach((s, idx) => {
      const heading = body.appendParagraph('Suggestion ' + (idx + 1) + ' -- ' + String(s.confidence).toUpperCase() + ' confidence');
      heading.setHeading(DocumentApp.ParagraphHeading.HEADING2);
      heading.editAsText().setForegroundColor(confidenceColor_(s.confidence));

      const patternPara = body.appendParagraph('Pattern observed: ' + s.pattern_observed);
      patternPara.editAsText().setBold(0, 'Pattern observed:'.length - 1, true);

      const changePara = body.appendParagraph('Suggested change: ' + s.suggested_change);
      changePara.editAsText().setBold(0, 'Suggested change:'.length - 1, true);
      changePara.setSpacingAfter(14);
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
  // FIXED (23 Aug 2026, real incident): confirmed live -- this threw
  // "Access denied: DriveApp." on every run. Root cause: the doc is created
  // (and owned) by whichever account the trigger runs as -- Joana's -- and
  // Drive rejects addViewers() outright if the list includes the file's own
  // owner (you can't add an owner as a mere viewer). The whole batch call
  // failed, not just that one entry, so nobody ever got shared. Filter the
  // owner out of the list before sharing.
  const ownerEmail = file.getOwner() ? file.getOwner().getEmail() : null;
  // ADDED (23 Aug 2026, per direct request): Tomás is now CC'd on the email
  // below, so he needs view access to the doc the email links to as well --
  // otherwise he's CC'd a link he can't open.
  const viewers = ['goodness@iconsofrealestate.com', 'joana@iconsofrealestate.com', 'kris@iconsofrealestate.com', 'tomas@iconsofrealestate.com']
    .filter(addr => addr.toLowerCase() !== (ownerEmail || '').toLowerCase());
  if (viewers.length > 0) {
    file.addViewers(viewers);
  }
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

  // CHANGED (23 Aug 2026, per direct request -- "Make sure Tomas and Kris
  // are on CC too"): Kris moved from `to` into `cc`, Tomás added to `cc`.
  // Joana/Goodness are the actual reviewers who'd act on this; Kris/Tomás
  // are kept in the loop but not the primary "please review" audience.
  const htmlBody =
    '<div style="font-family:Arial,sans-serif; font-size:14px; color:#222;">' +
      '<p>This email was written by Claude.</p>' +
      '<p>Today\'s automated review of edited replies found <b>' + suggestionsCount + '</b> potential SOP update' +
        (suggestionsCount === 1 ? '' : 's') + ', based on real differences between what the AI drafted and what Joana actually sent:</p>' +
      docLinkCardHtml_(docFile.getUrl(), 'SOP Suggestions -- ' + dateStr) +
      '<p style="color:#555555; font-size:13px;">Please review and decide whether to add any of these to the live SOP &mdash; nothing here has been applied automatically.</p>' +
    '</div>';

  MailApp.sendEmail({
    to: 'goodness@iconsofrealestate.com,joana@iconsofrealestate.com',
    cc: 'kris@iconsofrealestate.com,tomas@iconsofrealestate.com',
    subject: '[Written by Claude] Daily SOP Suggestions -- ' + dateStr,
    body: body,
    htmlBody: htmlBody
  });

  Logger.log('SOP suggestions doc emailed to Goodness and Joana, CC Kris and Tomas: ' + docFile.getUrl());
}
