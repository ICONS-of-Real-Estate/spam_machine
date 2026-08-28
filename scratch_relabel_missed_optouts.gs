/**
 * ONE-OFF CLEANUP -- 28 Aug 2026, real incident.
 *
 * Today's 10:01 AM reconcileMissingDrafts run reopened 22 threads as
 * "phantom-labeled" and runReplyDrafter re-drafted all of them. 21 of the
 * 22 turned out to be bare "Stop" opt-outs that a bug in
 * extractProspectFreshReplyText's zero-commentary-relay fallback (added
 * earlier today) caused to slip past OPT_OUT_PATTERNS -- see the FIX
 * comments on that function and on the opt-out check in
 * runReplyDrafterInner() for the root cause, now fixed.
 *
 * This one-off relabels those 21 threads to match what the opt-out path
 * would have done correctly: strips AI-Drafted-PendingReview, adds
 * AI-Skipped-Suppressed, marks read. It does NOT delete the 21 stray
 * drafts themselves -- Apps Script drafts must be removed by hand
 * (GmailApp has no safe bulk-delete here); do that from the Drafts folder
 * before anyone reviews/sends.
 *
 * READ-ONLY otherwise: touches only these 21 named threads. Run
 * cleanupMissedOptOutThreads() once, check the log, then delete this file.
 */
function cleanupMissedOptOutThreads() {
  const THREAD_IDS = [
    '1a042be39c6c235a', // jodik@longrealty.com
    '1a042be57dbc7d02', // gailwoods11@gmail.com
    '1a042be7f2b9f34f', // preti@poundrealtyllc.com
    '1a042be85dca3d06', // bethany@1702realestate.com
    '1a042beffa5a3056', // drew.randolph2@gmail.com
    '1a042bfdf7c2a597', // ccourtney@ranchocortinaproperties.com
    '1a042c002a6554ac', // david@awesomesandiegorealestate.com
    '1a042c0ea4267274', // brielle@vistapropertiesinc.com
    '1a042c1171fedaad', // cassandra@cassandrawooley.com
    '1a042c1ffa42d402', // sandy@nwapropertymanager.com
    '1a042c284b25db4f', // tborina@interorealestate.com
    '1a042c3500034941', // bill@wmsbuilders.com
    '1a042c3d4ea838fd', // scott.smith@crye-leike.com
    '1a042c4bf23f1433', // reneepage@prosmartrealty.com
    '1a042c68b9bb1c56', // jaden@kentwood.com
    '1a042c6d9789b8d2', // cmcnishrealtoraz@gmail.com
    '1a042c702fef6cf5', // jeff@ironworksrealty.com
    '1a042c83a7ae3855', // laura@laurawhome.com
    '1a042c891c15c173', // lthomas@realtysouth.com
    '1a042c8fa902805f', // chris.pigg@bhgre-journey.com
    // '1a042cfd211cfc33' (austin@asmluxuryhomes.com) relabeled manually already.
  ];

  const labelDrafted = GmailApp.getUserLabelByName(CONFIG.LABEL_AI_DRAFTED);
  const labelSuppressed = GmailApp.getUserLabelByName(CONFIG.LABEL_SUPPRESSED_NO_DRAFT);
  if (!labelDrafted || !labelSuppressed) {
    Logger.log('Could not find one of the required labels -- aborting. labelDrafted=' + !!labelDrafted + ' labelSuppressed=' + !!labelSuppressed);
    return;
  }

  THREAD_IDS.forEach(function (id) {
    try {
      const thread = GmailApp.getThreadById(id);
      if (!thread) { Logger.log('SKIP -- thread not found: ' + id); return; }
      thread.addLabel(labelSuppressed);
      thread.removeLabel(labelDrafted);
      thread.markRead();
      Logger.log('Relabeled: ' + id + ' -- ' + thread.getFirstMessageSubject());
    } catch (e) {
      Logger.log('FAILED on ' + id + ': ' + e);
    }
  });

  Logger.log('Done. Now go delete the 21 stray drafts from the Drafts folder by hand (Austin + these 20).');
}
