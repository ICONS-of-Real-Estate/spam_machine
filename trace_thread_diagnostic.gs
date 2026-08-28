/**
 * ONE-OFF EXECUTION TRACE -- 28 Aug 2026.
 * Replicates EVERY gate in runReplyDrafterInner()'s per-thread loop, in the
 * same order, and prints PASS/SKIP at each one so the exact short-circuit
 * point is visible. READ-ONLY: creates no drafts, applies no labels,
 * writes no cache. Paste, run traceThreads(), read log, delete this file.
 */
function traceThreads() {
  const THREADS = [
    { name: 'Mandy (Arkansas)', id: '19f1a0ab6fabf1fa' },
    { name: 'Brian (Michigan)', id: '19f5f6ff9889bcb1' },
  ];

  Logger.log('CODE_VERSION: ' + CONFIG.CODE_VERSION);

  // GATE 0 -- does the thread even come back from the search query?
  // (Query string copied verbatim from the live run's own diagnostic log.)
  const searchQuery = '(to:"network@iconsofrealestate.com" OR cc:"network@iconsofrealestate.com" OR to:"network@ardorseo.com" OR cc:"network@ardorseo.com") newer_than:180d -label:"AI-Drafted-PendingReview" -label:"3. Spam STOP" -label:"AI-Skipped-AlreadyAnsweredByTeam" -label:"AI-Skipped-NotPodcastOutreach" -label:"AI-Skipped-AlreadyRepliedOnce" -label:"AI-Skipped-Suppressed"';
  const found = GmailApp.search(searchQuery, 0, 500).map(t => t.getId());
  Logger.log('GATE 0 -- search returned ' + found.length + ' thread(s) total.');

  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const skipCache = loadSkipCache(ss);
  const existingDrafts = GmailApp.getDraftMessages();
  Logger.log('Drafts currently in folder: ' + existingDrafts.length +
    ' | MAX_PENDING_DRAFTS_IN_FOLDER: ' + CONFIG.MAX_PENDING_DRAFTS_IN_FOLDER +
    ' | MAX_DRAFTS_PER_RUN: ' + CONFIG.MAX_DRAFTS_PER_RUN +
    ' | DRAFT_ONLY_POSITIVE_FOR_NOW: ' + CONFIG.DRAFT_ONLY_POSITIVE_FOR_NOW);

  THREADS.forEach(function (t) {
    Logger.log('');
    Logger.log('===== TRACE: ' + t.name + ' (' + t.id + ') =====');
    try {
      const thread = GmailApp.getThreadById(t.id);
      if (!thread) { Logger.log('  !! getThreadById returned null'); return; }

      Logger.log('  GATE 0 in search results: ' + (found.indexOf(t.id) !== -1));
      Logger.log('  current labels: [' + thread.getLabels().map(l => l.getName()).join(', ') + ']');

      const subject = thread.getFirstMessageSubject();
      if (!matchesSubjectPattern_(subject)) { Logger.log('  GATE 1 subject pattern: SKIP -- "' + subject + '"'); return; }
      Logger.log('  GATE 1 subject pattern: PASS -- "' + subject + '"');

      const threadId = thread.getId();
      const cacheEntry = skipCache[threadId];
      if (isSkipCacheFresh_(cacheEntry, thread.getMessageCount())) {
        Logger.log('  GATE 2 skip cache: SKIP -- fresh entry: ' + cacheEntry.reason); return;
      }
      Logger.log('  GATE 2 skip cache: PASS' + (cacheEntry ? ' (stale entry present: ' + cacheEntry.reason + ')' : ' (no entry)'));

      const messages = thread.getMessages();
      const lastMsg = lastNonDraftMessage_(messages) || messages[messages.length - 1];
      Logger.log('  messages in thread: ' + messages.length);

      if (!isCcdToNetworkGroupAnywhereInThread(messages)) { Logger.log('  GATE 3 network CC: SKIP'); return; }
      Logger.log('  GATE 3 network CC: PASS');

      const lastSenderEmail = extractEmail(lastMsg.getFrom());
      Logger.log('  last message From: ' + lastMsg.getFrom() + ' -> ' + lastSenderEmail);
      if (isRealTeamReply(lastSenderEmail)) { Logger.log('  GATE 4 already answered by team: SKIP'); return; }
      Logger.log('  GATE 4 already answered by team: PASS');

      // ---- lead resolution (mirrors Code.gs's branch structure) ----
      const isNetworkListRelay = CONFIG.REQUIRED_CC_ADDRESSES.some(a => a.toLowerCase() === lastSenderEmail.toLowerCase());
      const isAliasItself = isNetworkListRelay || isForwardedFromSendingAlias_(lastMsg, lastSenderEmail);
      Logger.log('  isNetworkListRelay: ' + isNetworkListRelay + ' | isAliasItself: ' + isAliasItself);
      Logger.log('  getEffectivePlainBody_ length: ' + getEffectivePlainBody_(lastMsg).length +
        ' (getPlainBody: ' + lastMsg.getPlainBody().length + ', attachments: ' + lastMsg.getAttachments().length + ')');

      let leadEmail = null;
      if (!isAliasItself) {
        leadEmail = lastSenderEmail;
        Logger.log('  lead resolution: direct-sender shortcut -> ' + leadEmail);
      } else {
        const info = extractForwardedLeadInfo(lastMsg);
        if (info) { leadEmail = info.email; Logger.log('  lead resolution: body parse -> ' + leadEmail); }
        else {
          Logger.log('  lead resolution: body parse FAILED; walking back through prior messages...');
          for (let i = messages.indexOf(lastMsg) - 1; !leadEmail && i >= 0; i--) {
            const ps = extractEmail(messages[i].getFrom());
            if (CONFIG.REQUIRED_CC_ADDRESSES.some(a => a.toLowerCase() === ps.toLowerCase())) continue;
            if (isInternal(ps)) {
              leadEmail = firstMailableLeadIn_(extractAllEmailsFrom_(messages[i].getTo()).concat(extractAllEmailsFrom_(messages[i].getCc())));
            } else if (isForwardedFromSendingAlias_(messages[i], ps)) {
              const pi = extractForwardedLeadInfo(messages[i]);
              if (pi) leadEmail = pi.email;
            } else {
              leadEmail = firstMailableLeadIn_([ps]);
            }
            if (leadEmail) break;
          }
          Logger.log('  lead resolution: backward walk -> ' + leadEmail);
        }
      }
      if (!leadEmail) { Logger.log('  GATE 5 lead resolution: SKIP -- could not resolve a lead email'); return; }
      Logger.log('  GATE 5 lead resolution: PASS -> ' + leadEmail);

      if (isNonHumanSender(leadEmail)) { Logger.log('  GATE 6 non-human sender: SKIP'); return; }
      Logger.log('  GATE 6 non-human sender: PASS');

      if (isUnmailableAsLead_(leadEmail)) { Logger.log('  GATE 7 unmailable (ours): SKIP'); return; }
      Logger.log('  GATE 7 unmailable (ours): PASS');

      if (draftAlreadyExistsFor(leadEmail, existingDrafts)) { Logger.log('  GATE 8 draft already exists: SKIP'); return; }
      Logger.log('  GATE 8 draft already exists: PASS');

      if (hasAlreadySentReplyTo_(leadEmail)) { Logger.log('  GATE 9 hasAlreadySentReplyTo_: SKIP <-- would label AI-Skipped-AlreadyRepliedOnce'); return; }
      Logger.log('  GATE 9 hasAlreadySentReplyTo_: PASS');

      const replyBody = extractProspectFreshReplyText(lastMsg);
      Logger.log('  replyBody (' + replyBody.length + ' chars): "' + replyBody.slice(0, 300).replace(/\n/g, ' | ') + '"');

      if (threadHasLabel(thread, CONFIG.LABEL_STOP) || OPT_OUT_PATTERNS.test(replyBody)) { Logger.log('  GATE 10 opt-out: SKIP'); return; }
      Logger.log('  GATE 10 opt-out: PASS');

      if (looksLikeAutoReplyBody_(replyBody) || AUTOREPLY_SUBJECT_PATTERNS.test(lastMsg.getSubject())) {
        Logger.log('  GATE 11 auto-reply/OOO: SKIP (bodyMatch=' + looksLikeAutoReplyBody_(replyBody) +
          ', subjectMatch=' + AUTOREPLY_SUBJECT_PATTERNS.test(lastMsg.getSubject()) + ', lastMsg subject="' + lastMsg.getSubject() + '")'); return;
      }
      Logger.log('  GATE 11 auto-reply/OOO: PASS');

      Logger.log('  >>> REACHES classifyAndDraft() -- this thread SHOULD get a draft.');
    } catch (e) {
      Logger.log('  !! EXCEPTION during trace: ' + e + ' | stack: ' + (e.stack || 'none'));
    }
  });
}
