// ============================================================
// ONE-OFF CLEANUP (14 Aug 2026): wipes both follow-up queue tabs
// completely clean, keeping only the header row. Safe to run because
// zero leads have been successfully processed through either cadence
// yet -- every row currently in these tabs is either a duplicate, a
// permanently-stuck blank-status row, or mid-cadence junk from the
// broken registration logic (now fixed). Nothing real is lost.
//
// After running this, the NEXT runLeadFollowUpCycle() will re-enroll
// everything fresh, using the fixed registerNewPodcastSalesLeads()
// and registerNewHubGuestInvites() (with the existing.add(threadId)
// fix already in place), so no duplicates this time.
//
// Run this ONCE, manually, from the Apps Script editor. Not a
// scheduled trigger -- delete this function afterward if you want,
// it has no ongoing purpose once run.
// ============================================================

function wipeFollowUpQueuesClean() {
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);

  [PODCAST_SALES_QUEUE_TAB, HUB_GUEST_QUEUE_TAB].forEach(tabName => {
    const tab = ss.getSheetByName(tabName);
    if (!tab) {
      Logger.log('wipeFollowUpQueuesClean -- tab not found, skipping: ' + tabName);
      return;
    }

    const lastRow = tab.getLastRow();
    const lastCol = tab.getLastColumn();

    if (lastRow <= 1) {
      Logger.log('wipeFollowUpQueuesClean -- ' + tabName + ' already has no data rows (only header, or empty). Nothing to do.');
      return;
    }

    const rowsToDelete = lastRow - 1; // everything except the header
    tab.getRange(2, 1, rowsToDelete, lastCol).clearContent();

    Logger.log('wipeFollowUpQueuesClean -- ' + tabName + ': cleared ' + rowsToDelete + ' data row(s), header row kept intact.');
  });

  Logger.log('wipeFollowUpQueuesClean COMPLETE. Both queues are now empty and ready for a clean re-enrollment on the next runLeadFollowUpCycle().');
}