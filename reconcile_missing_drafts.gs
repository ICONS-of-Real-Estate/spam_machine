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
 * SAFE TO RUN ANYTIME: only touches threads where no live draft exists for
 * that lead. Threads with a real, live draft sitting there are left alone.
 *
 * GOING FORWARD: the actual fix is procedural, not just this script --
 * don't bulk-delete drafts without also running this reconciliation
 * afterward, or the same gap reopens every time.
 */

function reconcileMissingDrafts() {
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

  const threads = labelDrafted.getThreads(0, 500);

  let reconciled = 0;
  let leftAlone = 0;
  let couldNotParse = 0;

  threads.forEach(thread => {
    const isOptOut = thread.getLabels().some(l => l.getName() === CONFIG.LABEL_STOP);
    if (isOptOut) {
      leftAlone++;
      return;
    }

    const messages = thread.getMessages();
    const forwardMsg = messages[0];
    const forwardInfo = extractForwardedLeadInfo(forwardMsg);

    if (!forwardInfo) {
      couldNotParse++;
      return;
    }

    const hasLiveDraft = draftAlreadyExistsFor(forwardInfo.email);

    if (hasLiveDraft) {
      leftAlone++;
      return;
    }

    thread.removeLabel(labelDrafted);
    businessLabels.forEach(l => {
      if (thread.getLabels().some(tl => tl.getName() === l.getName())) {
        thread.removeLabel(l);
      }
    });
    reconciled++;
  });

  Logger.log(
    'Reconciliation complete. ' +
    reconciled + ' phantom-labeled threads cleared (will be reprocessed next run). ' +
    leftAlone + ' threads left alone (real draft confirmed to still exist). ' +
    couldNotParse + ' threads skipped (could not parse lead email, left untouched).'
  );
}
