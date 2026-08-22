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
 */

function reconcileMissingDrafts() {
  // ADDED (22 Aug 2026, per direct request -- "shouldn't this be on a
  // timer?"): this was a manual-only utility until now, meaning the phantom-
  // label gap it fixes (see header comment) could sit open for days between
  // manual runs. Every Gmail-touching entry point in this project must have
  // both of these guards -- this one never did, since nobody expected it to
  // run unattended. Now scheduled daily in setupAllTriggers().
  assertRunningAsJoana();
  if (isGmailQuotaExhausted()) {
    Logger.log('Skipping reconcileMissingDrafts -- Gmail quota already known exhausted today.');
    return;
  }

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
  let alreadyAnswered = 0;

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
    alreadyAnswered + ' threads left alone (already genuinely answered, not phantom). ' +
    couldNotParse + ' threads skipped (could not parse lead email, left untouched).'
  );
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
    const recipients = (messages[i].getTo() + ' ' + messages[i].getCc()).toLowerCase();
    if (recipients.indexOf(target) !== -1) return true;
  }
  return false;
}
