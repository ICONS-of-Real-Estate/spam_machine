/**
 * ONE-OFF CLEANUP -- 30 Aug 2026, real incident.
 *
 * The "Missed leads audit hit the 500-result ceiling" / heartbeat
 * false-positive investigation on 30 Aug turned up 8 threads matching the
 * drafter's own pending-reply search (buildPendingReplySearchQuery_ in
 * Code.gs) even though every one of them was already fully handled months
 * ago. Root cause: none of them ever carry one of the permanent tracking
 * labels, because the main drafter loop (runReplyDrafterInner) has never
 * actually visited them -- they're old enough, and buried far enough down
 * Gmail's search ordering, that normal runs never reach them. Different
 * incident from the "Stop" opt-out backfill in
 * scratch_relabel_missed_optouts.gs -- these are genuinely resolved
 * threads, not misclassified ones.
 *
 * Two shapes found, handled differently to match how runReplyDrafterInner
 * itself would classify each:
 *   - Miranda, Edward: thread's actual last message is Joana's own sent
 *     reply -- exactly what LABEL_ALREADY_ANSWERED_BY_TEAM exists for.
 *     Gets the permanent label, same as recordPermanentSkip_ would apply.
 *   - Catherine, Cameron, Michael, Priscilla, Kathy, Jan/Cristen: thread's
 *     actual last message is a mailer-daemon bounce/delay notification.
 *     Code.gs deliberately does NOT give bounces a permanent label (see the
 *     bounce-check comment in runReplyDrafterInner) -- a TTL'd Skip Cache
 *     entry instead, so a bounce gets periodically re-verified rather than
 *     excluded forever. This backfill just seeds that cache entry so these
 *     stop showing as "pending" immediately; whether they keep getting
 *     re-cached going forward still depends on the main loop actually
 *     reaching them again before the 6h TTL lapses, which is the same
 *     "never visited" gap as above and not something a one-off can fix.
 *
 * READ-ONLY otherwise: touches only these 8 named threads. Run
 * backfillStaleAnsweredThreads() once, check the log, then delete this file.
 */
function backfillStaleAnsweredThreads() {
  if (!assertRunningAsJoana('backfillStaleAnsweredThreads')) return;

  const ALREADY_ANSWERED_THREAD_IDS = [
    '19dbfb8bcaebdfd1', // Miranda -- miranda@mirandadtate.com
    '19c939856b0d69ce', // Edward -- staversells@gmail.com
  ];

  const BOUNCE_THREAD_IDS = [
    { id: '19f214ac72d92622', reason: 'lead email looks like a bounce/system address, not a real lead' }, // Catherine -- catherinekleve@krislindahl.com
    { id: '19e06465c8f35026', reason: 'lead email looks like a bounce/system address, not a real lead' }, // Cameron -- cameron@thecatronteam.com
    { id: '19df7afcfb55376a', reason: 'lead email looks like a bounce/system address, not a real lead' }, // Michael -- michaelwilliamglunk@gmail.com
    { id: '19df796d5798e967', reason: 'lead email looks like a bounce/system address, not a real lead' }, // Priscilla -- pssemambo@spradlingrealtygroup.com
    { id: '19da5763ebbba80c', reason: 'lead email looks like a bounce/system address, not a real lead' }, // Kathy -- kaparker.realtor@gmail.com
    { id: '19ce6b74dbc12a74', reason: 'lead email looks like a bounce/system address, not a real lead' }, // Jan/Cristen -- cristen@livingroomre.com
  ];

  const labelAlreadyAnsweredByTeam = GmailApp.getUserLabelByName(CONFIG.LABEL_ALREADY_ANSWERED_BY_TEAM);
  if (!labelAlreadyAnsweredByTeam) {
    Logger.log('Could not find the "' + CONFIG.LABEL_ALREADY_ANSWERED_BY_TEAM + '" label -- aborting.');
    return;
  }

  ALREADY_ANSWERED_THREAD_IDS.forEach(function (id) {
    try {
      const thread = GmailApp.getThreadById(id);
      if (!thread) { Logger.log('SKIP -- thread not found: ' + id); return; }
      thread.addLabel(labelAlreadyAnsweredByTeam);
      Logger.log('Labeled AlreadyAnsweredByTeam: ' + id + ' -- ' + thread.getFirstMessageSubject());
    } catch (e) {
      Logger.log('FAILED on ' + id + ': ' + e);
    }
  });

  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const skipCache = loadSkipCache(ss);
  BOUNCE_THREAD_IDS.forEach(function (entry) {
    try {
      const thread = GmailApp.getThreadById(entry.id);
      if (!thread) { Logger.log('SKIP -- thread not found: ' + entry.id); return; }
      skipCache[entry.id] = { reason: entry.reason, lastCheckedAt: new Date(), messageCount: thread.getMessageCount() };
      Logger.log('Cached as bounce (' + SKIP_CACHE_TTL_HOURS + 'h TTL): ' + entry.id + ' -- ' + thread.getFirstMessageSubject());
    } catch (e) {
      Logger.log('FAILED on ' + entry.id + ': ' + e);
    }
  });
  saveSkipCache(ss, skipCache);

  Logger.log('Done. ' + ALREADY_ANSWERED_THREAD_IDS.length + ' thread(s) permanently labeled, ' +
    BOUNCE_THREAD_IDS.length + ' thread(s) cached. The bounce ones will start showing as "pending" again once their ' +
    SKIP_CACHE_TTL_HOURS + 'h cache entry expires unless the main drafter loop revisits them before then -- ' +
    'that underlying "never visited" gap is not fixed by this one-off.');
}
