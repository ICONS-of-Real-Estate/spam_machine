/**
 * HEARTBEAT CHECK + TRIGGER SELF-VERIFICATION -- longevity monitoring.
 *
 * Requires quota_guard_and_alerting.gs to be in the same project
 * (uses sendOpsAlert(), isGmailQuotaExhausted(), todayPacificDateString()).
 *
 * PROBLEM THIS SOLVES: nobody found out the reply drafter had been
 * dead for 6 days until manually noticing the backlog. This adds two
 * new scheduled checks:
 *
 * 1. runHeartbeatCheck() -- run this hourly. Reads the most recent
 *    timestamp in the AI Drafts Log tab. If it's been more than
 *    HEARTBEAT_STALE_HOURS since the last entry AND it's currently
 *    business hours Eastern time, sends an alert. Does NOT alert if
 *    the quota is currently known-exhausted (that already sends its
 *    own alert once via markGmailQuotaExhausted/sendOpsAlert) -- this
 *    is specifically for catching OTHER kinds of silent failure
 *    (broken trigger, auth expired, code error, etc.) where nothing
 *    else would have flagged it.
 *
 * 2. runTriggerHealthCheck() -- run this daily (once, e.g. 6 AM).
 *    Confirms all 8 expected trigger functions actually have an
 *    active trigger registered. Alerts if any are missing -- this
 *    catches exactly the kind of thing that happened tonight (a
 *    duplicate trigger set created under the wrong account, or a
 *    trigger silently vanishing).
 *
 * SETUP: after pasting this file in, run setupHeartbeatTriggers() ONCE
 * manually to create both new triggers. It's safe to re-run --
 * it clears any existing triggers for these two functions first so it
 * won't create duplicates.
 */

const HEARTBEAT_STALE_HOURS = 3;
const BUSINESS_HOURS_START_ET = 8;   // 8 AM Eastern
const BUSINESS_HOURS_END_ET = 19;    // 7 PM Eastern

// FIX (24 Aug 2026, real gap found in review): this list is the ONLY thing
// standing between "a trigger silently disappeared" and nobody noticing, so
// it has to match setupAllTriggers() exactly. It didn't -- setupAllTriggers()
// creates NINE triggers, this listed seven. summarizeFollowUpLearning and
// reconcileMissingDrafts were both missing, meaning either one could vanish
// and runTriggerHealthCheck() would still report "all expected triggers
// present" every single day. That is the exact failure mode this function
// exists to catch, so the check was quietly blind in two of nine places.
//
// IF YOU ADD A TRIGGER TO setupAllTriggers(), ADD IT HERE TOO. There is a
// consistency check at the bottom of setupAllTriggers() that fails loudly if
// these two lists ever drift apart again, precisely because keeping them in
// sync by memory is what broke it the first time.
// ADDED (24 Aug 2026, per direct request -- "setupHeartbeatTriggers should be
// in install all triggers"): named separately so setupAllTriggers() can both
// create these and include them in its own drift check without hardcoding the
// names in two files. This gap was not theoretical -- deleting all triggers
// and running only setupAllTriggers() left the project with no heartbeat and,
// worse, no runTriggerHealthCheck, meaning nothing at all was watching the
// other ten.
const HEARTBEAT_TRIGGER_FUNCTIONS = ['runHeartbeatCheck', 'runTriggerHealthCheck'];

const EXPECTED_TRIGGER_FUNCTIONS = [
  'runReplyDrafter',
  'runLearningLoop',
  'generateSopSuggestions',
  'runMissedLeadsAudit',
  'runLeadFollowUpCycle',
  'summarizeFollowUpLearning',
  'runDailyReport',
  'runWeekendDeepMissedLeadsAudit',
  'reconcileMissingDrafts',
  // ADDED (24 Aug 2026, per direct request): runStalledBookingsAudit is now
  // wired to a real weekly trigger in setupAllTriggers(). The previous note
  // here claimed it "is not defined anywhere in the project" -- that stopped
  // being true on 23 Aug 2026 when stalled_bookings_audit.gs landed. It was
  // held back from a trigger on the grounds of "prove draft quality first,"
  // but that caveat never actually applied: the audit creates no drafts at
  // all (verified -- no createDraft/createThreadedDraft_/LLM call anywhere in
  // that file). It reads the AI Drafts Log, checks thread recency, writes a
  // sheet tab, and emails ONLY when it finds something new.
  'runStalledBookingsAudit',
  // The heartbeat pair watches everything above; runTriggerHealthCheck also
  // watches itself, which is tautological but harmless -- if it is missing it
  // cannot run to complain, which is precisely why setupAllTriggers() now
  // creates it rather than leaving it to a second function someone forgets.
  'runHeartbeatCheck',
  'runTriggerHealthCheck'
];

function setupHeartbeatTriggers() {
  const existing = ScriptApp.getProjectTriggers();
  existing.forEach(t => {
    const fn = t.getHandlerFunction();
    if (fn === 'runHeartbeatCheck' || fn === 'runTriggerHealthCheck') {
      ScriptApp.deleteTrigger(t);
    }
  });

  ScriptApp.newTrigger('runHeartbeatCheck')
    .timeBased()
    .everyHours(1)
    .create();

  ScriptApp.newTrigger('runTriggerHealthCheck')
    .timeBased()
    .atHour(6)
    .everyDays(1)
    .create();

  Logger.log('Heartbeat triggers created: runHeartbeatCheck (hourly), runTriggerHealthCheck (daily 6 AM).');
}

function isCurrentlyBusinessHoursEastern() {
  const hourEastern = parseInt(Utilities.formatDate(new Date(), 'America/New_York', 'H'), 10);
  return hourEastern >= BUSINESS_HOURS_START_ET && hourEastern < BUSINESS_HOURS_END_ET;
}

function runHeartbeatCheck() {
  if (isGmailQuotaExhausted()) {
    Logger.log('Heartbeat check skipped -- Gmail quota already known exhausted today, that alert already fired, ' + timeUntilQuotaResetDescription_() + '.');
    return;
  }

  if (!isCurrentlyBusinessHoursEastern()) {
    Logger.log('Heartbeat check skipped -- outside business hours Eastern.');
    return;
  }

  let lastEntryTime;
  try {
    const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    const tab = ss.getSheetByName('AI Drafts Log');
    const data = tab.getDataRange().getValues();
    if (data.length <= 1) {
      Logger.log('Heartbeat check -- AI Drafts Log has no data rows at all.');
      sendOpsAlert(
        'AI Drafts Log is empty',
        'The AI Drafts Log tab has no data rows. Either nothing has ever been drafted, or something wiped the log. Check directly.'
      );
      return;
    }
    lastEntryTime = data[data.length - 1][0]; // Timestamp column, last row
  } catch (e) {
    Logger.log('Heartbeat check FAILED to read the sheet: ' + e);
    sendOpsAlert(
      'Heartbeat check itself is failing',
      'runHeartbeatCheck could not read the AI Drafts Log sheet. Error: ' + e
    );
    return;
  }

  if (!(lastEntryTime instanceof Date)) {
    Logger.log('Heartbeat check -- last entry timestamp is not a valid date: ' + lastEntryTime);
    return;
  }

  const hoursSinceLastEntry = (Date.now() - lastEntryTime.getTime()) / (1000 * 60 * 60);
  Logger.log('Heartbeat check -- last AI Drafts Log entry was ' + hoursSinceLastEntry.toFixed(1) + ' hours ago.');

  if (hoursSinceLastEntry > HEARTBEAT_STALE_HOURS) {
    sendOpsAlert(
      'No new drafts in over ' + HEARTBEAT_STALE_HOURS + ' hours',
      'The last entry in AI Drafts Log was ' + hoursSinceLastEntry.toFixed(1) + ' hours ago (' + lastEntryTime + '), during business hours. ' +
      'This does not necessarily mean anything is broken -- it could just be a quiet stretch with no new prospect replies -- but it is worth a quick manual check of the runReplyDrafter trigger and its recent execution history.'
    );
  }
}

function runTriggerHealthCheck() {
  const existing = ScriptApp.getProjectTriggers();
  const presentFunctions = new Set(existing.map(t => t.getHandlerFunction()));

  const missing = EXPECTED_TRIGGER_FUNCTIONS.filter(fn => !presentFunctions.has(fn));

  if (missing.length > 0) {
    Logger.log('TRIGGER HEALTH CHECK FAILED -- missing triggers for: ' + missing.join(', '));
    sendOpsAlert(
      'Missing scheduled triggers',
      'The following expected triggers are NOT currently registered in the Apps Script project: ' + missing.join(', ') + '. ' +
      'These need to be recreated (see setupAllTriggers() in setup_all_triggers.gs) or something deleted them.'
    );
  } else {
    Logger.log('Trigger health check OK -- all ' + EXPECTED_TRIGGER_FUNCTIONS.length + ' expected triggers present.');
  }

  // Also flag duplicates -- more than one trigger for the same function
  // is exactly the "created under the wrong account" bug from tonight.
  const counts = {};
  existing.forEach(t => {
    const fn = t.getHandlerFunction();
    counts[fn] = (counts[fn] || 0) + 1;
  });
  const duplicated = Object.keys(counts).filter(fn => counts[fn] > 1);
  if (duplicated.length > 0) {
    Logger.log('TRIGGER HEALTH CHECK -- duplicate triggers found for: ' + duplicated.join(', '));
    sendOpsAlert(
      'Duplicate triggers detected',
      'More than one trigger exists for: ' + duplicated.join(', ') + '. This can cause double-processing or race conditions. Check Apps Script > Triggers and remove the extras.'
    );
  }
}