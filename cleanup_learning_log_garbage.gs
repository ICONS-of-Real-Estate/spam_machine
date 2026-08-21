/**
 * ONE-TIME CLEANUP (20 Aug 2026, real incident).
 * ---------------------------------------------------------------------------
 * PROBLEM THIS FIXES: findSentReplyAfterDraft() in learning_loop.gs used to
 * accept any message sent from Joana's own account as "the sent reply,"
 * without checking it was actually addressed to the lead -- so an internal
 * handoff forward to a teammate (e.g. sean@iconsofrealestate.com), sent
 * from the same account in the same thread, sometimes got logged instead of
 * the real reply. Confirmed live: ~302 of 752 rows (40%) in "Learning Log"
 * have a "Final Sent Text" that's just a blank/quote-only forward, not
 * Joana's actual reply. That bug is now fixed (see findSentReplyAfterDraft()),
 * but the already-logged bad rows stay wrong forever otherwise -- their
 * Thread IDs are already in runLearningLoopInner()'s dedup set, so the
 * fixed logic never gets a chance to re-run on them.
 *
 * WHAT THIS DOES: scans the "Learning Log" tab, finds rows whose Final Sent
 * Text is garbage (empty, or just a forwarded-message header/quote with no
 * real reply content), and deletes those rows outright. Once a row is gone,
 * its Thread ID is no longer in the dedup set, so the next runLearningLoop()
 * pass picks it back up and re-logs it correctly (or correctly skips it, if
 * Joana genuinely hasn't sent a real reply on that thread yet).
 *
 * SAFE TO RUN ANYTIME: only touches rows already identified as garbage by
 * the same heuristic used to diagnose this live. Rows with real reply text
 * are left completely alone, edited or not.
 *
 * Run this ONCE, manually, from the Apps Script editor (select
 * "cleanupLearningLogGarbage" in the function dropdown, click Run), then
 * run runLearningLoop() to let it rebuild the removed rows with the fixed
 * matching logic. Not a scheduled trigger -- delete this file afterward if
 * you want, it has no ongoing purpose once run.
 */

function isGarbageSentText_(text) {
  const trimmed = (text || '').trim();
  if (trimmed.length < 20) return true;
  return trimmed.indexOf('----------') === 0 || trimmed.toLowerCase().indexOf('forwarded message') === 0;
}

function cleanupLearningLogGarbage() {
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const tab = ss.getSheetByName('Learning Log');
  if (!tab) {
    Logger.log('cleanupLearningLogGarbage -- "Learning Log" tab not found, nothing to clean.');
    return;
  }

  const data = tab.getDataRange().getValues();
  const headers = data[0];
  const sentTextCol = headers.indexOf('Final Sent Text');
  if (sentTextCol === -1) {
    Logger.log('cleanupLearningLogGarbage -- "Final Sent Text" column not found, aborting.');
    return;
  }

  let removed = 0;
  // Walk bottom-up so deleteRow() doesn't shift the index of rows not yet checked.
  for (let i = data.length - 1; i >= 1; i--) {
    if (isGarbageSentText_(data[i][sentTextCol])) {
      tab.deleteRow(i + 1); // +1: sheet rows are 1-indexed and data[0] is the header row
      removed++;
    }
  }

  Logger.log(
    'cleanupLearningLogGarbage complete. Removed ' + removed + ' garbage row(s) out of ' +
    (data.length - 1) + ' total. Run runLearningLoop() next to let the fixed matching ' +
    'logic re-log these threads correctly.'
  );
}
