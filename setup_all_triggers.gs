/**
 * SETUP ALL TRIGGERS — run this once, manually, to create every trigger
 * this project needs in one shot, instead of adding each one by hand
 * through the Triggers UI.
 * ---------------------------------------------------------------------------
 * Deletes any existing trigger for these same functions first (so running
 * this twice doesn't create duplicates), then creates:
 *   - runReplyDrafter          -- every 5 minutes
 *   - runLearningLoop          -- daily
 *   - generateSopSuggestions   -- weekly (Monday)
 *   - runMissedLeadsAudit      -- daily
 *   - runLeadFollowUpCycle     -- daily (6 AM Europe/Paris -- batch ready before Goodness starts)
 *   - summarizeFollowUpLearning -- daily (8 PM Europe/Paris -- turns the day's edits into SOP suggestions)
 *   - runDailyReport           -- daily (emails Kris, Tomas, Joana)
 *   - runWeekendDeepMissedLeadsAudit -- weekly (Saturday, 180-day lookback)
 *
 * Must be run under the account that should own these triggers (Joana's,
 * since the script needs to run against her inbox). Run it the same way as
 * any other function: select "setupAllTriggers" in the dropdown, click Run.
 *
 * If triggers ever show up owned by a different account (check the
 * Executions view -- "Other user" rows), see deleteAllMyTriggers() below.
 */

function setupAllTriggers() {
  const functionsToSchedule = [
    'runReplyDrafter',
    'runLearningLoop',
    'generateSopSuggestions',
    'runMissedLeadsAudit',
    'runLeadFollowUpCycle',
    'summarizeFollowUpLearning',
    'runDailyReport',
    'runWeekendDeepMissedLeadsAudit'
    // NOTE (17 Aug 2026, real incident): 'runStalledBookingsAudit' used to be
    // listed here, but that function was never actually built -- Task 2 from
    // the original handoff, design proposed, still awaiting sign-off. Every
    // time that trigger fired (it showed up in the Executions view under
    // "Other user"), it errored immediately since the function doesn't
    // exist. Add it back here once runStalledBookingsAudit is real.
  ];

  // Delete any existing triggers for these functions first, so re-running
  // this doesn't create duplicates alongside ones already set up manually.
  const existingTriggers = ScriptApp.getProjectTriggers();
  let deletedCount = 0;
  existingTriggers.forEach(trigger => {
    if (functionsToSchedule.indexOf(trigger.getHandlerFunction()) !== -1) {
      ScriptApp.deleteTrigger(trigger);
      deletedCount++;
    }
  });
  Logger.log('Removed ' + deletedCount + ' existing trigger(s) for these functions before recreating.');

  // NOTE ON TIMEZONES: every .atHour()/.everyDays() trigger fires in the
  // SCRIPT's timezone, which is Europe/Paris (see "timeZone" in
  // appsscript.json) -- NOT the viewer's local timezone and NOT Pacific.
  // So "6 AM" below means 6 AM in Paris. The only trigger without a clock
  // time is runReplyDrafter (an interval trigger).
  const TZ = 'Europe/Paris';

  ScriptApp.newTrigger('runReplyDrafter')
    .timeBased()
    .everyMinutes(5)
    .create();
  Logger.log('Created: runReplyDrafter, every 5 minutes (interval, no fixed clock time).');

  ScriptApp.newTrigger('runLearningLoop')
    .timeBased()
    .everyDays(1)
    .atHour(6)
    .create();
  Logger.log('Created: runLearningLoop, daily around 6 AM ' + TZ + '.');

  ScriptApp.newTrigger('generateSopSuggestions')
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.MONDAY)
    .atHour(7)
    .create();
  Logger.log('Created: generateSopSuggestions, weekly on Monday around 7 AM ' + TZ + '.');

  ScriptApp.newTrigger('runMissedLeadsAudit')
    .timeBased()
    .everyDays(1)
    .atHour(8)
    .create();
  Logger.log('Created: runMissedLeadsAudit, daily around 8 AM ' + TZ + '.');

  // 6 AM so the day's batch of ~100 follow-up drafts is READY before Goodness
  // starts her European workday, rather than drafting right as she sits down.
  ScriptApp.newTrigger('runLeadFollowUpCycle')
    .timeBased()
    .everyDays(1)
    .atHour(6)
    .create();
  Logger.log('Created: runLeadFollowUpCycle, daily around 6 AM ' + TZ + ' (batch ready before Goodness starts).');

  // Runs after Goodness's workday so the day's edits are captured before it
  // batches them into SOP suggestions.
  ScriptApp.newTrigger('summarizeFollowUpLearning')
    .timeBased()
    .everyDays(1)
    .atHour(20)
    .create();
  Logger.log('Created: summarizeFollowUpLearning, daily around 8 PM ' + TZ + ' (after Goodness\'s workday).');

  ScriptApp.newTrigger('runDailyReport')
    .timeBased()
    .everyDays(1)
    .atHour(7)
    .create();
  Logger.log('Created: runDailyReport, daily around 7 AM ' + TZ + ' (emails Kris, Tomas, Joana).');

  ScriptApp.newTrigger('runWeekendDeepMissedLeadsAudit')
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.SATURDAY)
    .atHour(8)
    .create();
  Logger.log('Created: runWeekendDeepMissedLeadsAudit, weekly on Saturday around 8 AM ' + TZ + ' (looks back 180 days).');

  Logger.log('All ' + functionsToSchedule.length + ' triggers created, all clock times in ' + TZ + '. Check the Triggers page (clock icon) to confirm.');
}

// ---------- TRIGGER CLEANUP (17 Aug 2026, real incident) ----------
//
// PROBLEM THIS SOLVES: the Triggers/Executions view showed multiple
// executions of runReplyDrafter, runLeadFollowUpCycle, runDailyReport, and
// others attributed to "Other user" -- a DIFFERENT Google account than
// Joana's has its own triggers firing in this same project. This is the
// exact "duplicate trigger set created under the wrong account" failure
// mode heartbeat_and_trigger_healthcheck.gs already exists to catch, and
// is the likely cause of duplicate drafts appearing for the same lead
// within the same minute (two executions racing each other).
//
// CRITICAL PLATFORM LIMITATION, worth understanding before running this:
// ScriptApp.getProjectTriggers() only returns triggers owned by whoever is
// CURRENTLY RUNNING the script -- there is no API to see or delete another
// user's triggers. This is a hard Google security boundary, not something
// that can be coded around. This function can only ever delete the
// triggers of whichever account runs it.
//
// SO: if triggers exist under more than one account (confirmed here),
// EACH person who has ever set one up must run this function themselves
// (Extensions > Apps Script > select "deleteAllMyTriggers" > Run, while
// logged in as THEM), or delete their own manually via the Triggers page.
// There is no single-click fix from one account for all of them.
function deleteAllMyTriggers() {
  const account = getRunningAccountEmail();
  const triggers = ScriptApp.getProjectTriggers();

  Logger.log('Running as: ' + (account || 'UNKNOWN'));
  Logger.log('Found ' + triggers.length + ' trigger(s) owned by THIS account. (Triggers owned by other accounts are invisible here and untouched by this run.)');

  triggers.forEach(t => {
    Logger.log('Deleting trigger for: ' + t.getHandlerFunction() + ' (' + t.getEventType() + ')');
    ScriptApp.deleteTrigger(t);
  });

  Logger.log('Done. ' + triggers.length + ' trigger(s) deleted for account: ' + (account || 'UNKNOWN') + '.');

  if (account === EXPECTED_RUN_ACCOUNT) {
    Logger.log('This was Joana\'s account -- run setupAllTriggers() next to recreate the correct set under her account only.');
  } else {
    Logger.log('NOTE: this account is NOT ' + EXPECTED_RUN_ACCOUNT + '. If the goal was cleaning up ALL stray triggers, whoever owns the remaining ones (check the Executions view for other "Other user" rows) needs to log in and run this same function themselves.');
  }
}