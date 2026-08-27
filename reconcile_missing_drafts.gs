/**
 * ICONS OF REAL ESTATE — Draft Reconciliation (one-time / as-needed utility,
 * same project -- shares CONFIG and helper functions)
 * ---------------------------------------------------------------------------
 * PROBLEM THIS FIXES: since drafts are created standalone (GmailApp.createDraft,
 * not thread.createDraftReply -- necessary to fix an earlier bug where replies
 * went to the wrong recipient), the "AI-Drafted-PendingReview" label on the
 * ORIGINAL lead thread has no live connection to whether the actual draft
 * still exists. If a draft gets deleted (accidentally, in bulk, or on
 * purpose), the original thread stays marked "already handled" forever --
 * the script will never touch it again, even though there's nothing for
 * Joana to actually review or send.
 *
 * WHAT THIS DOES: finds every thread labeled AI-Drafted-PendingReview,
 * extracts the real lead email from its forwarded-message body (same parser
 * Code.gs uses), checks whether a live draft actually exists addressed to
 * that email, and if NOT, strips AI-Drafted-PendingReview (and the business
 * label -- 1. Spam YES / 2. Spam NO / 3. Spam STOP) so the thread becomes
 * eligible for reprocessing on the next runReplyDrafter pass.
 *
 * SAFE TO RUN ANYTIME: only touches threads where no live draft exists AND
 * no real reply was ever actually sent to the lead. Threads with a live
 * draft, or a genuine sent reply, are left alone either way (see
 * hasSentReplyToLead_() -- FIX 20 Aug 2026, real incident: this function
 * used to treat "Joana sent it" and "the draft got lost" identically, since
 * both leave no unsent draft behind. That wrongly un-labeled threads Joana
 * had already replied to, making a lead's SECOND message get drafted as if
 * it were their first).
 *
 * GOING FORWARD: the actual fix is procedural, not just this script --
 * don't bulk-delete drafts without also running this reconciliation
 * afterward, or the same gap reopens every time.
 *
 * BATCHED + RESUMABLE (27 Aug 2026, real incident -- a live run on the actual
 * backlog took 5m16s to examine exactly RECONCILE_BATCH_SIZE threads, uncomfortably
 * close to Apps Script's ~6-minute hard limit for a single execution). Two
 * separate problems, both fixed here:
 *   1. A run that gets killed mid-batch by the platform (not this script's own
 *      time-budget check) never reaches the final Logger.log summary and never
 *      saves progress -- the next run starts from the same offset and repeats
 *      the same work, making no forward progress on a large backlog.
 *   2. Even a run that finishes cleanly only ever looked at getThreads(0, 500)
 *      -- always the SAME top 500 threads by Gmail's ordering for a label,
 *      since a thread only leaves that list once its label is actually
 *      removed. Any thread left alone (real draft still exists, or already
 *      answered) keeps the label and reappears at the same position on every
 *      future run, permanently blocking anything sitting further back if the
 *      true backlog is larger than one batch.
 * Fix for both: a persisted offset (RECONCILE_OFFSET_PROPERTY, in
 * PropertiesService -- survives across runs the same way
 * NO_DECLINE_VARIATION_INDEX already does elsewhere in this project) plus a
 * RUNTIME_BUDGET_MS check inside the loop, same pattern runReplyDrafter
 * already uses for the same reason. The offset advances by however many
 * threads were ACTUALLY examined this run (not the full batch size, if the
 * time budget cut it short), and wraps back to 0 once a batch comes back
 * shorter than requested -- that's the signal there was nothing left after
 * it, so the next run starts a fresh pass over the label (picking up
 * anything newly created since, too).
 */

const RECONCILE_BATCH_SIZE = 500; // Gmail label listing fetched per run
const RECONCILE_RUNTIME_BUDGET_MS = 5 * 60 * 1000; // 5 min, leaving a 1-min buffer before the 6-min hard limit
const RECONCILE_OFFSET_PROPERTY = 'RECONCILE_MISSING_DRAFTS_NEXT_OFFSET';
// ADDED (27 Aug 2026, per direct request -- "should we run this at the end of
// each day, or some validation?"): the daily 5 AM trigger already existed
// before today, yet 134 phantom-labeled threads had silently piled up --
// most likely this exact job stalling on the same top-500 threads or dying
// past the 6-minute limit with nothing logged, day after day, completely
// invisibly. Running it more often wouldn't have caught that; nothing was
// watching the OUTCOME. A single run clearing more than this many phantoms
// means backlog had been quietly accumulating and is worth a human's
// attention now, not buried in a Logger.log line nobody's watching.
const RECONCILE_ALERT_THRESHOLD = 20;

function reconcileMissingDrafts() {
  // ADDED (22 Aug 2026, per direct request -- "shouldn't this be on a
  // timer?"): this was a manual-only utility until now, meaning the phantom-
  // label gap it fixes (see header comment) could sit open for days between
  // manual runs. Every Gmail-touching entry point in this project must have
  // both of these guards -- this one never did, since nobody expected it to
  // run unattended. Now scheduled daily in setupAllTriggers().
  // FIXED (24 Aug 2026, found in review): called with no callerName, so the
  // wrong-account ops alert this raises would have read "undefined fired
  // under the wrong account" -- the one piece of information that alert
  // exists to convey. Also brought into line with the `if (!...) return;`
  // idiom every other call site uses.
  if (!assertRunningAsJoana('reconcileMissingDrafts')) return;
  if (isGmailQuotaExhausted()) {
    Logger.log('Skipping reconcileMissingDrafts -- Gmail quota already known exhausted today, ' + timeUntilQuotaResetDescription_() + '.');
    return;
  }

  // ADDED (27 Aug 2026, real incident): this function strips
  // AI-Drafted-PendingReview (and the business label) off threads it judges
  // to be phantoms, but took NO script lock -- while runReplyDrafter, which
  // holds one for up to its full 5-minute budget, fires four times inside
  // this job's 5 AM hour. Apps Script's own draft-propagation lag (documented
  // at Code.gs's existingDrafts fetch, confirmed there by a real duplicate 21
  // seconds apart) means the getDraftMessages() call below can miss a draft
  // the drafter created seconds earlier. It then declares a perfectly good
  // draft a phantom and strips its labels -- which drops it out of
  // countPendingAiDrafts_, makes runMissedLeadsAudit report the lead as
  // unanswered, and loses the human's triage label.
  //
  // 2 minutes rather than the 10 seconds the other callers use: this job runs
  // once a day, so waiting out a drafter run is far cheaper than skipping a
  // day. If it still cannot get in, that is now said out loud -- the old
  // silent `return` on a lock miss is exactly the pattern that made this
  // class of problem invisible for weeks.
  // DIAGNOSTIC (27 Aug 2026, per direct request -- "this needs more
  // logging"): tryLock(120000) blocks SILENTLY for up to 2 full minutes if
  // another job (usually runReplyDrafter) already holds the lock -- from the
  // Executions log, a run stuck in that wait looks identical to a run that
  // has hung or died right after assertRunningAsJoana, with nothing printed
  // either way until the wait resolves one way or the other.
  Logger.log('reconcileMissingDrafts -- attempting to acquire the project-wide script lock (will wait up to 2 minutes if another job holds it)...');
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(120000)) {
    Logger.log('reconcileMissingDrafts could not acquire the script lock within 2 minutes -- another job in this project (most likely runReplyDrafter, which holds it for up to 5 minutes) is still running. Skipping this run; the next daily firing will pick it up.');
    sendOpsAlert(
      'reconcileMissingDrafts skipped -- could not get the script lock',
      'reconcileMissingDrafts waited 2 minutes for the project-wide script lock and did not get it, so today\'s reconcile did not run. The lock is held by whichever job was running at the time -- runReplyDrafter fires every 15 minutes and holds it for up to 5, so it is the usual holder. Harmless once; if this repeats daily, the 5 AM schedule is colliding with the drafter and one of them should move.'
    );
    return;
  }
  Logger.log('reconcileMissingDrafts -- lock acquired, starting.');

  try {
  const labelDrafted = GmailApp.getUserLabelByName(CONFIG.LABEL_AI_DRAFTED);
  if (!labelDrafted) {
    Logger.log('AI-Drafted-PendingReview label not found -- nothing to reconcile.');
    return;
  }

  const businessLabels = [
    GmailApp.getUserLabelByName(CONFIG.LABEL_YES),
    GmailApp.getUserLabelByName(CONFIG.LABEL_YES_PENCILED),
    GmailApp.getUserLabelByName(CONFIG.LABEL_NO),
    GmailApp.getUserLabelByName(CONFIG.LABEL_STOP),
    GmailApp.getUserLabelByName(CONFIG.LABEL_NEEDS_ROUTING)
  ].filter(l => l !== null);

  // RESUMABLE (27 Aug 2026, real incident -- see header comment): start where
  // the previous run left off, not always at 0, so a backlog bigger than one
  // batch actually gets covered across multiple runs instead of the same top
  // 500 threads being re-examined forever.
  const startOffset = Number(PropertiesService.getScriptProperties().getProperty(RECONCILE_OFFSET_PROPERTY)) || 0;
  const threads = labelDrafted.getThreads(startOffset, RECONCILE_BATCH_SIZE);
  // DIAGNOSTIC (27 Aug 2026, same request): the ONLY other log line between
  // here and the final summary was the "could not find AI-Drafted-..." early
  // exit -- a real run over hundreds of threads (each forcing a full
  // thread.getMessages() body fetch, not just cheap metadata) printed nothing
  // at all for however long that took. Same blind spot as the lock wait above.
  Logger.log('reconcileMissingDrafts -- found ' + threads.length + ' thread(s) labeled AI-Drafted-PendingReview to check, starting at offset ' + startOffset + '.');

  // FIX (27 Aug 2026, real risk found in review): draftAlreadyExistsFor's own
  // header comment claimed this call site checks "one lead in isolation, not
  // in a per-thread loop" -- that was false. Called with no precomputedDrafts
  // below, each iteration did its own fresh GmailApp.getDraftMessages() (plus
  // a .getTo() per draft in that folder) -- up to 500 threads times a folder
  // that can hold dozens of drafts is roughly 25,000 Gmail read operations in
  // one 5 AM run, against a 50,000/day self-tracked ceiling. Fetched once
  // here instead, exactly like Code.gs's runReplyDrafterInner does.
  const existingDrafts = GmailApp.getDraftMessages();
  recordGmailQuotaUsage_(1 + existingDrafts.length);

  let reconciled = 0;
  let leftAlone = 0;
  let couldNotParse = 0;
  let alreadyAnswered = 0;
  let examined = 0; // BATCHED (27 Aug 2026): threads actually looked at this run -- may be less than threads.length if the time budget below cuts the run short
  const runStartTime = Date.now();
  let stoppedEarly = false;

  for (let i = 0; i < threads.length; i++) {
    // TIME BUDGET (27 Aug 2026, real incident -- see header comment): stop
    // cleanly BEFORE Apps Script's own ~6-minute limit kills the execution
    // outright. A platform kill never reaches the summary log or saves
    // progress; stopping here does both, and the offset save below picks up
    // exactly where this run left off instead of repeating it.
    if (Date.now() - runStartTime > RECONCILE_RUNTIME_BUDGET_MS) {
      Logger.log('reconcileMissingDrafts -- approaching the execution time limit, stopping cleanly at ' +
        examined + '/' + threads.length + ' examined this run. The next run will resume from offset ' + (startOffset + examined) + '.');
      stoppedEarly = true;
      break;
    }
    // Same reasoning as runReplyDrafter's mid-run check: recordGmailQuotaUsage_
    // below can flip this to true partway through a long batch, and every
    // remaining iteration still costs a real Gmail read otherwise.
    if (isGmailQuotaExhausted()) {
      Logger.log('reconcileMissingDrafts -- Gmail quota marked exhausted mid-run, stopping cleanly at ' +
        examined + '/' + threads.length + ' examined this run. The next run will resume from offset ' + (startOffset + examined) + '.');
      stoppedEarly = true;
      break;
    }

    const thread = threads[i];
    examined++;

    // DIAGNOSTIC (27 Aug 2026, same request): progress every 25 threads --
    // the loop had no output at all between the "found N threads" line above
    // and the final summary, regardless of N. On a full 500-thread run that
    // silence could span several minutes with genuinely nothing to look at.
    if (i > 0 && i % 25 === 0) {
      Logger.log('reconcileMissingDrafts -- progress: ' + i + '/' + threads.length + ' checked so far (' +
        reconciled + ' reconciled, ' + leftAlone + ' left alone, ' + alreadyAnswered + ' already answered, ' + couldNotParse + ' could not parse).');
    }

    const isOptOut = thread.getLabels().some(l => l.getName() === CONFIG.LABEL_STOP);
    if (isOptOut) {
      leftAlone++;
      continue;
    }

    // SELF-TRACKED QUOTA COUNTER (22 Aug 2026, per direct request): see the
    // fuller comment in quota_guard_and_alerting.gs.
    recordGmailQuotaUsage_(1);
    const messages = thread.getMessages();
    const forwardMsg = messages[0];
    const forwardInfo = extractForwardedLeadInfo(forwardMsg);

    if (!forwardInfo) {
      couldNotParse++;
      continue;
    }

    const hasLiveDraft = draftAlreadyExistsFor(forwardInfo.email, existingDrafts);

    if (hasLiveDraft) {
      leftAlone++;
      continue;
    }

    // FIX (20 Aug 2026, real incident -- Tomás/Joana flagged live: AI
    // drafting a reply to a lead's SECOND message as if it were their
    // first, re-apologizing for a "delayed reply" and re-pitching from
    // scratch even though Joana had already replied the day before).
    // ROOT CAUSE: "no live draft" is ambiguous -- it's true both when a
    // draft was genuinely lost (needs reprocessing) AND when Joana simply
    // SENT it (already handled, converting the draft into a sent message).
    // This function only ever checked the first case. Once she sends the
    // first reply, this always stripped the label and made the thread look
    // brand new to runReplyDrafterInner() -- so when the lead replied again,
    // it was treated as an unanswered first contact. Check for a real sent
    // reply to the lead before assuming "phantom label."
    if (hasSentReplyToLead_(thread, forwardInfo.email)) {
      alreadyAnswered++;
      continue;
    }

    thread.removeLabel(labelDrafted);
    businessLabels.forEach(l => {
      if (thread.getLabels().some(tl => tl.getName() === l.getName())) {
        thread.removeLabel(l);
      }
    });
    reconciled++;
    // DIAGNOSTIC (27 Aug 2026, same request): this is the one outcome here
    // that actually changes something (strips labels, re-opens the thread to
    // runReplyDrafter) -- naming it per-thread, not just in the final tally,
    // means a phantom you're specifically checking for shows up by name
    // instead of only as a number that went up somewhere in the run.
    Logger.log('reconcileMissingDrafts -- RECONCILED (phantom label cleared, will be reprocessed): ' +
      forwardInfo.email + ' -- ' + thread.getFirstMessageSubject());
  }

  // BATCHED + RESUMABLE (27 Aug 2026, see header comment): a batch shorter
  // than requested (and not cut short by the time/quota checks above) means
  // there was nothing left after it -- wrap back to 0 so the next run starts
  // a fresh pass over the label instead of an offset that no longer points
  // anywhere useful. Otherwise, advance by exactly how many were actually
  // examined (which can be less than the full batch if this run stopped early).
  const reachedEndOfLabel = !stoppedEarly && threads.length < RECONCILE_BATCH_SIZE;
  const nextOffset = reachedEndOfLabel ? 0 : startOffset + examined;
  PropertiesService.getScriptProperties().setProperty(RECONCILE_OFFSET_PROPERTY, String(nextOffset));

  Logger.log(
    'Reconciliation complete (examined ' + examined + ' of ' + threads.length + ' fetched, starting at offset ' + startOffset + '). ' +
    reconciled + ' phantom-labeled threads cleared (will be reprocessed next run). ' +
    leftAlone + ' threads left alone (real draft confirmed to still exist). ' +
    alreadyAnswered + ' threads left alone (already genuinely answered, not phantom). ' +
    couldNotParse + ' threads skipped (could not parse lead email, left untouched). ' +
    (reachedEndOfLabel
      ? 'Reached the end of the label -- next run starts a fresh pass from offset 0.'
      : 'Next run resumes from offset ' + nextOffset + '.')
  );

  // VALIDATION (27 Aug 2026, per direct request -- see RECONCILE_ALERT_THRESHOLD
  // above): a normal, healthy day should reconcile close to zero -- phantoms
  // only happen from an accidental bulk draft deletion or a job failing
  // partway through. Crossing the threshold in ONE run means either that just
  // happened, or (as this morning) a backlog had been building silently for a
  // while. Rate-limited to once per Pacific day by sendOpsAlert() itself, so
  // this can't spam even if several runs in a row are still working through
  // the same large backlog.
  if (reconciled > RECONCILE_ALERT_THRESHOLD) {
    sendOpsAlert(
      'reconcileMissingDrafts cleared ' + reconciled + ' phantom-labeled threads in one run',
      'This run reconciled ' + reconciled + ' threads that were labeled "AI-Drafted-PendingReview" with no real ' +
      'draft behind them -- well above the normal-day threshold of ' + RECONCILE_ALERT_THRESHOLD + '. That usually ' +
      'means either a bulk draft deletion just happened, or this job has been stalling/failing silently for a ' +
      'while and a backlog built up unnoticed (the exact incident this alert was added after, 27 Aug 2026). All ' +
      reconciled + ' threads are now reopened and will be picked up by the next runReplyDrafter pass -- ' +
      'worth a quick look at today\'s Executions log for this job\'s recent history if this keeps recurring.'
    );
  }
  } catch (e) {
    // FIX (27 Aug 2026, real risk found in review): no path here could ever
    // trip the Gmail quota circuit breaker -- see handleGmailJobError_.
    handleGmailJobError_('reconcileMissingDrafts', e);
  } finally {
    lock.releaseLock();
  }
}

/**
 * ADDED (20 Aug 2026, real incident): true only if a message actually SENT
 * BY Joana's account, addressed TO the lead's real email, exists in this
 * thread -- as distinct from merely "no unsent draft remains," which is
 * also true right after she legitimately sends one. Mirrors the same fix
 * applied to findSentReplyAfterDraft() in learning_loop.gs (that bug: an
 * internal handoff forward to a teammate, sent from the same account, got
 * mistaken for the real reply -- same "from == Joana" isn't enough on its
 * own" lesson applies here too).
 */
function hasSentReplyToLead_(thread, leadEmail) {
  const target = leadEmail.toLowerCase();
  const messages = thread.getMessages();
  for (let i = 0; i < messages.length; i++) {
    const from = (messages[i].getFrom() || '').toLowerCase();
    if (from.indexOf(EXPECTED_RUN_ACCOUNT) === -1) continue;
    // FIX (27 Aug 2026, real risk found in review): same substring-match bug
    // as draftAlreadyExistsFor -- see recipientListIncludes_ in Code.gs.
    if (recipientListIncludes_(messages[i].getTo(), target) || recipientListIncludes_(messages[i].getCc(), target)) return true;
  }
  return false;
}
