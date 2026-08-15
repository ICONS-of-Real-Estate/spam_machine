/**
 * ONE-TIME FIX v4.
 *
 * REAL ROOT CAUSE FOUND (12 Aug, ~7:35 AM run): "Service invoked too
 * many times for one day: premium gmail." This is a hard Google
 * Workspace daily quota on Gmail service calls (getPlainBody(),
 * getThreadById(), etc. all count against it). It is NOT a data
 * problem and NOT a parsing bug.
 *
 * v1/v2/v3 all had the same flaw: any exception inside the per-row
 * try/catch -- including a quota exception -- got treated identically
 * to "this thread genuinely can't be parsed" and written as
 * INVALID_EMAIL. Once the quota was hit mid-run, EVERY remaining row
 * got silently mislabeled INVALID_EMAIL for the rest of that run, with
 * no indication anything was wrong. This is why v1's 30-minute run
 * appears to have flagged so much, and is also the leading theory for
 * why reconcileFollowUpDrafts() reported "0 stuck, 0 left alone"
 * earlier tonight when 20 rows were expected.
 *
 * FIX: detect the quota-exceeded message specifically and HALT THE
 * ENTIRE SCRIPT immediately (throw, don't catch) rather than flagging
 * the row and continuing. A halted script with a clear error is far
 * better than one that silently mislabels 300 rows.
 *
 * resetInvalidEmailFlags() only touches the spreadsheet -- no Gmail
 * calls -- so it's always safe to run regardless of quota state.
 */

const CLEANUP_BATCH_SIZE = 40;
const QUOTA_ERROR_SUBSTRING = 'too many times for one day';

function isQuotaExceededError(e) {
  return String(e).indexOf(QUOTA_ERROR_SUBSTRING) !== -1;
}

function debugSingleThread(threadId) {
  Logger.log('--- DEBUG: ' + threadId + ' ---');

  let thread;
  try {
    thread = GmailApp.getThreadById(threadId);
  } catch (e) {
    if (isQuotaExceededError(e)) {
      Logger.log('GMAIL QUOTA EXCEEDED for today -- stop and try again after the daily reset. Raw error: ' + e);
      return;
    }
    Logger.log('getThreadById THREW (not quota): ' + e);
    return;
  }
  if (!thread) {
    Logger.log('getThreadById returned null/undefined.');
    return;
  }

  const messages = thread.getMessages();
  Logger.log('Thread found. Message count: ' + messages.length);

  for (let m = messages.length - 1; m >= 0; m--) {
    const msg = messages[m];
    let result;
    try {
      result = extractForwardedLeadInfo(msg);
    } catch (e) {
      if (isQuotaExceededError(e)) {
        Logger.log('  message[' + m + ']: GMAIL QUOTA EXCEEDED -- stopping debug here. Raw error: ' + e);
        return;
      }
      Logger.log('  message[' + m + ']: extractForwardedLeadInfo THREW (not quota): ' + e);
      continue;
    }
    if (result) {
      Logger.log('  message[' + m + ']: MATCH -> email=' + result.email + ', subject=' + result.originalSubject);
    } else {
      const bodySnippet = msg.getPlainBody().slice(0, 300).replace(/\n/g, ' | ');
      Logger.log('  message[' + m + ']: no match. Body starts: ' + bodySnippet);
    }
  }

  Logger.log('--- END DEBUG ---');
}

function debugJennifer() {
  debugSingleThread('19f9897a2a2dcaa0');
}

function cleanupEnrolledQueueEmails() {
  let podcastDone, hubDone;
  try {
    podcastDone = cleanupPodcastSalesQueueEmails();
  } catch (e) {
    if (isQuotaExceededError(e)) {
      Logger.log('=== GMAIL QUOTA EXCEEDED FOR TODAY. Stopping here -- do not re-run until tomorrow. Podcast Sales Queue progress was saved; it will resume where it stopped. ===');
      return;
    }
    throw e;
  }

  try {
    hubDone = cleanupHubGuestQueueEmails();
  } catch (e) {
    if (isQuotaExceededError(e)) {
      Logger.log('=== GMAIL QUOTA EXCEEDED FOR TODAY. Stopping here -- do not re-run until tomorrow. Hub Guest Queue progress was saved; it will resume where it stopped. ===');
      return;
    }
    throw e;
  }

  if (podcastDone && hubDone) {
    Logger.log('=== ALL ROWS PROCESSED for both queues. Cleanup is complete. ===');
  } else {
    Logger.log('=== Batch complete. Run this function again to continue -- more rows remain. ===');
  }
}

function resetCleanupProgress() {
  const props = PropertiesService.getScriptProperties();
  props.deleteProperty('CLEANUP_PROGRESS_PODCAST_SALES');
  props.deleteProperty('CLEANUP_PROGRESS_HUB_GUEST');
  Logger.log('Progress reset. Next run starts from row 1 for both queues.');
}

/**
 * Pure spreadsheet operation -- NO Gmail calls, safe to run anytime
 * regardless of quota state. Clears every INVALID_EMAIL flag back to
 * blank so those rows get properly re-checked once quota resets,
 * instead of permanently trusting a flag that may only mean "quota was
 * exhausted when this row was checked."
 */
function resetInvalidEmailFlags() {
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);

  const podcastTab = ss.getSheetByName(PODCAST_SALES_QUEUE_TAB);
  const podcastData = podcastTab.getDataRange().getValues();
  let podcastReset = 0;
  for (let r = 1; r < podcastData.length; r++) {
    if (podcastData[r][6] === 'INVALID_EMAIL') {
      podcastTab.getRange(r + 1, 7).setValue('');
      podcastReset++;
    }
  }
  Logger.log('Podcast Sales Queue -- reset ' + podcastReset + ' INVALID_EMAIL rows back to blank.');

  const hubTab = ss.getSheetByName(HUB_GUEST_QUEUE_TAB);
  const hubData = hubTab.getDataRange().getValues();
  let hubReset = 0;
  for (let r = 1; r < hubData.length; r++) {
    if (hubData[r][9] === 'INVALID_EMAIL') {
      hubTab.getRange(r + 1, 10).setValue('');
      hubReset++;
    }
  }
  Logger.log('Hub Guest Queue -- reset ' + hubReset + ' INVALID_EMAIL rows back to blank.');

  resetCleanupProgress();
}

function cleanupPodcastSalesQueueEmails() {
  const props = PropertiesService.getScriptProperties();
  const startRow = parseInt(props.getProperty('CLEANUP_PROGRESS_PODCAST_SALES') || '1', 10);

  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const queueTab = ss.getSheetByName(PODCAST_SALES_QUEUE_TAB);
  const data = queueTab.getDataRange().getValues();

  Logger.log('Podcast Sales Queue -- starting at row ' + (startRow + 1) + ' of ' + (data.length - 1));

  let fixed = 0, flagged = 0, alreadyOk = 0, skipped = 0, processedThisRun = 0;
  let r = startRow;

  for (; r < data.length && processedThisRun < CLEANUP_BATCH_SIZE; r++) {
    if (r === 0) continue;

    const row = data[r];
    const threadId = row[0];
    const currentEmail = String(row[2] || '').toLowerCase().trim();
    const currentStatus = row[6];

    Logger.log('[' + (r + 1) + '/' + (data.length - 1) + '] checking ' + threadId + ' (' + currentEmail + ')');
    processedThisRun++;

    if (currentStatus === 'INVALID_EMAIL') {
      Logger.log('  -> already flagged INVALID_EMAIL, skipping');
      skipped++;
      continue;
    }

    let thread;
    try {
      thread = GmailApp.getThreadById(threadId);
    } catch (e) {
      if (isQuotaExceededError(e)) {
        props.setProperty('CLEANUP_PROGRESS_PODCAST_SALES', String(r));
        throw e; // halt entirely -- do NOT mark this row INVALID_EMAIL
      }
      queueTab.getRange(r + 1, 7).setValue('INVALID_EMAIL');
      Logger.log('  -> FLAGGED (thread not found: ' + e + ')');
      flagged++;
      continue;
    }
    if (!thread) {
      queueTab.getRange(r + 1, 7).setValue('INVALID_EMAIL');
      Logger.log('  -> FLAGGED (thread null)');
      flagged++;
      continue;
    }

    const messages = thread.getMessages();
    let sourceMsg = null;
    try {
      for (let m = messages.length - 1; m >= 0; m--) {
        if (extractForwardedLeadInfo(messages[m])) {
          sourceMsg = messages[m];
          break;
        }
      }
    } catch (e) {
      if (isQuotaExceededError(e)) {
        props.setProperty('CLEANUP_PROGRESS_PODCAST_SALES', String(r));
        throw e;
      }
      throw e;
    }

    if (!sourceMsg) {
      queueTab.getRange(r + 1, 7).setValue('INVALID_EMAIL');
      Logger.log('  -> FLAGGED (no forwarded block found in any of ' + messages.length + ' messages)');
      flagged++;
      continue;
    }

    const realEmail = extractForwardedLeadInfo(sourceMsg).email;

    if (isInternal(realEmail) || CONFIG.REQUIRED_CC_ADDRESSES.some(a => a.toLowerCase() === realEmail)) {
      queueTab.getRange(r + 1, 7).setValue('INVALID_EMAIL');
      Logger.log('  -> FLAGGED (re-derived email still internal/alias: ' + realEmail + ')');
      flagged++;
      continue;
    }

    if (realEmail === currentEmail) {
      Logger.log('  -> already correct');
      alreadyOk++;
      continue;
    }

    queueTab.getRange(r + 1, 3).setValue(realEmail);
    Logger.log('  -> FIXED: ' + currentEmail + ' -> ' + realEmail);
    fixed++;
  }

  const isDone = r >= data.length;
  props.setProperty('CLEANUP_PROGRESS_PODCAST_SALES', String(r));

  Logger.log('Podcast Sales Queue batch summary -- fixed: ' + fixed + ', flagged: ' + flagged + ', already correct: ' + alreadyOk + ', skipped (already flagged): ' + skipped + (isDone ? ' -- QUEUE FULLY PROCESSED' : ' -- more rows remain, run again'));

  return isDone;
}

function cleanupHubGuestQueueEmails() {
  const props = PropertiesService.getScriptProperties();
  const startRow = parseInt(props.getProperty('CLEANUP_PROGRESS_HUB_GUEST') || '1', 10);

  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const queueTab = ss.getSheetByName(HUB_GUEST_QUEUE_TAB);
  const data = queueTab.getDataRange().getValues();

  Logger.log('Hub Guest Queue -- starting at row ' + (startRow + 1) + ' of ' + (data.length - 1));

  let fixed = 0, flagged = 0, alreadyOk = 0, skipped = 0, processedThisRun = 0;
  let r = startRow;

  for (; r < data.length && processedThisRun < CLEANUP_BATCH_SIZE; r++) {
    if (r === 0) continue;

    const row = data[r];
    const threadId = row[0];
    const currentEmail = String(row[2] || '').toLowerCase().trim();
    const currentStatus = row[9];

    Logger.log('[' + (r + 1) + '/' + (data.length - 1) + '] checking ' + threadId + ' (' + currentEmail + ')');
    processedThisRun++;

    if (currentStatus === 'INVALID_EMAIL') {
      Logger.log('  -> already flagged INVALID_EMAIL, skipping');
      skipped++;
      continue;
    }

    let thread;
    try {
      thread = GmailApp.getThreadById(threadId);
    } catch (e) {
      if (isQuotaExceededError(e)) {
        props.setProperty('CLEANUP_PROGRESS_HUB_GUEST', String(r));
        throw e;
      }
      queueTab.getRange(r + 1, 10).setValue('INVALID_EMAIL');
      Logger.log('  -> FLAGGED (thread not found: ' + e + ')');
      flagged++;
      continue;
    }
    if (!thread) {
      queueTab.getRange(r + 1, 10).setValue('INVALID_EMAIL');
      Logger.log('  -> FLAGGED (thread null)');
      flagged++;
      continue;
    }

    const messages = thread.getMessages();
    let sourceMsg = null;
    try {
      for (let m = messages.length - 1; m >= 0; m--) {
        if (extractForwardedLeadInfo(messages[m])) {
          sourceMsg = messages[m];
          break;
        }
      }
    } catch (e) {
      if (isQuotaExceededError(e)) {
        props.setProperty('CLEANUP_PROGRESS_HUB_GUEST', String(r));
        throw e;
      }
      throw e;
    }

    if (!sourceMsg) {
      queueTab.getRange(r + 1, 10).setValue('INVALID_EMAIL');
      Logger.log('  -> FLAGGED (no forwarded block found in any of ' + messages.length + ' messages)');
      flagged++;
      continue;
    }

    const realEmail = extractForwardedLeadInfo(sourceMsg).email;

    if (isInternal(realEmail) || CONFIG.REQUIRED_CC_ADDRESSES.some(a => a.toLowerCase() === realEmail)) {
      queueTab.getRange(r + 1, 10).setValue('INVALID_EMAIL');
      Logger.log('  -> FLAGGED (re-derived email still internal/alias: ' + realEmail + ')');
      flagged++;
      continue;
    }

    if (realEmail === currentEmail) {
      Logger.log('  -> already correct');
      alreadyOk++;
      continue;
    }

    queueTab.getRange(r + 1, 3).setValue(realEmail);
    Logger.log('  -> FIXED: ' + currentEmail + ' -> ' + realEmail);
    fixed++;
  }

  const isDone = r >= data.length;
  props.setProperty('CLEANUP_PROGRESS_HUB_GUEST', String(r));

  Logger.log('Hub Guest Queue batch summary -- fixed: ' + fixed + ', flagged: ' + flagged + ', already correct: ' + alreadyOk + ', skipped (already flagged): ' + skipped + (isDone ? ' -- QUEUE FULLY PROCESSED' : ' -- more rows remain, run again'));

  return isDone;
}