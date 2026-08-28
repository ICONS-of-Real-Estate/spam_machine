/**
 * ONE-OFF CLEANUP -- 28 Aug 2026, real incident.
 *
 * registerNewHubGuestInvites() just enrolled the same 21 bare-"Stop"
 * opt-out leads from this morning's incident into the "Hub Guest Follow-Up
 * Queue" tab -- it trusts the AI Drafts Log's `category` column, which was
 * `no_decline` for these threads from this morning's classifyAndDraft()
 * run (before the drafts were deleted and threads relabeled). See the FIX
 * comment added in registerNewHubGuestInvites() (lead_followup_sequences.gs)
 * for the code-level fix that stops this from happening again; this script
 * is the one-time cleanup for the 21 rows that already got in.
 *
 * All 21 were caught by advanceHubGuestFollowUps' own MAX_ACTIVE_DRAFTS cap
 * this run (left at AWAITING_STEP_1_SCHEDULE, no draft created yet) -- this
 * removes them from the queue before any future run gets to them.
 *
 * Run removeOptOutHubGuestEnrollments() once, check the log, then delete
 * this file.
 */
function removeOptOutHubGuestEnrollments() {
  const THREAD_IDS = [
    '1a042cfd211cfc33', // austin@asmluxuryhomes.com
    '1a042c8fa902805f', // chris.pigg@bhgre-journey.com
    '1a042c891c15c173', // lthomas@realtysouth.com
    '1a042c83a7ae3855', // laura@laurawhome.com
    '1a042c702fef6cf5', // jeff@ironworksrealty.com
    '1a042c6d9789b8d2', // cmcnishrealtoraz@gmail.com
    '1a042c68b9bb1c56', // jaden@kentwood.com
    '1a042c4bf23f1433', // reneepage@prosmartrealty.com
    '1a042c3d4ea838fd', // scott.smith@crye-leike.com
    '1a042c3500034941', // bill@wmsbuilders.com
    '1a042c284b25db4f', // tborina@interorealestate.com
    '1a042c1ffa42d402', // sandy@nwapropertymanager.com
    '1a042c1171fedaad', // cassandra@cassandrawooley.com
    '1a042c0ea4267274', // brielle@vistapropertiesinc.com
    '1a042c002a6554ac', // david@awesomesandiegorealestate.com
    '1a042bfdf7c2a597', // ccourtney@ranchocortinaproperties.com
    '1a042beffa5a3056', // drew.randolph2@gmail.com
    '1a042be85dca3d06', // bethany@1702realestate.com
    '1a042be7f2b9f34f', // preti@poundrealtyllc.com
    '1a042be57dbc7d02', // gailwoods11@gmail.com
    '1a042be39c6c235a', // jodik@longrealty.com
  ];

  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const queueTab = ss.getSheetByName(HUB_GUEST_QUEUE_TAB);
  if (!queueTab) {
    Logger.log('Could not find "' + HUB_GUEST_QUEUE_TAB + '" tab -- aborting.');
    return;
  }

  const data = queueTab.getDataRange().getValues();
  const idSet = new Set(THREAD_IDS);
  let removed = 0;

  // Delete from the bottom up so removing a row doesn't shift the index of
  // rows not yet visited.
  for (let i = data.length - 1; i >= 1; i--) {
    if (idSet.has(data[i][0])) {
      Logger.log('Removing queue row ' + (i + 1) + ': ' + data[i][0] + ' (' + data[i][1] + ', ' + data[i][2] + ')');
      queueTab.deleteRow(i + 1);
      removed++;
    }
  }

  Logger.log('Done. Removed ' + removed + ' of ' + THREAD_IDS.length + ' expected rows from "' + HUB_GUEST_QUEUE_TAB + '".' +
    (removed < THREAD_IDS.length ? ' Some were not found -- may already be gone, or check the tab manually.' : ''));
}
