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
 *
 * Must be run under the account that should own these triggers (Joana's,
 * since the script needs to run against her inbox). Run it the same way as
 * any other function: select "setupAllTriggers" in the dropdown, click Run.
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

  // NOTE (housekeeping): a trigger for runStalledBookingsAudit used to be created
  // here, but that function is not defined anywhere in the project -- the trigger
  // would have fired into a missing-handler error every week. Removed. Re-add here
  // only once a real runStalledBookingsAudit() is implemented.
  if (ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === 'runStalledBookingsAudit')) {
    ScriptApp.getProjectTriggers().forEach(t => {
      if (t.getHandlerFunction() === 'runStalledBookingsAudit') {
        ScriptApp.deleteTrigger(t);
        Logger.log('Removed dangling trigger for undefined runStalledBookingsAudit.');
      }
    });
  }

  Logger.log('All ' + functionsToSchedule.length + ' triggers created, all clock times in ' + TZ + '. Check the Triggers page (clock icon) to confirm.');
}