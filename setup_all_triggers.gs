/**
 * SETUP ALL TRIGGERS — run this once, manually, to create every trigger
 * this project needs in one shot, instead of adding each one by hand
 * through the Triggers UI.
 * ---------------------------------------------------------------------------
 * Deletes any existing trigger for these same functions first (so running
 * this twice doesn't create duplicates), then creates:
 *   - runReplyDrafter          -- every 15 minutes weekdays, effectively
 *     hourly on weekends (slowed from a flat 5 min, 23 Aug 2026, per direct
 *     request -- the weekend throttle is a code-level check in
 *     runReplyDrafter() itself, not a second trigger; see the note there
 *     and at the trigger below for why)
 *   - runLearningLoop          -- weekly (Saturday -- moved off daily 22 Aug 2026,
 *     see note at the trigger below)
 *   - generateSopSuggestions   -- daily (~6 PM Pacific -- see timezone note below)
 *   - runMissedLeadsAudit      -- weekly (Sunday -- moved off daily 22 Aug 2026,
 *     see note at the trigger below)
 *   - runLeadFollowUpCycle     -- daily (6 AM Europe/Paris -- batch ready before Goodness starts)
 *   - summarizeFollowUpLearning -- daily (8 PM Europe/Paris -- turns the day's edits into SOP suggestions)
 *   - runDailyReport           -- daily (emails Kris, Tomas, Joana)
 *   - runWeekendDeepMissedLeadsAudit -- weekly (Saturday, 180-day lookback)
 *   - reconcileMissingDrafts   -- daily (ADDED 22 Aug 2026, per direct request --
 *     was manual-only; now runs unattended so the phantom-label gap can't sit
 *     open for days between manual runs)
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
    'runWeekendDeepMissedLeadsAudit',
    'reconcileMissingDrafts',
    // WIRED UP (24 Aug 2026, per direct request). History: this was listed
    // here on 17 Aug before the function existed (so it errored on every
    // fire) and was removed; stalled_bookings_audit.gs then landed 23 Aug
    // but was left unscheduled pending "until draft quality is proven out."
    // That caveat was inherited from the other audits and never actually
    // applied here -- runStalledBookingsAudit creates NO drafts (verified:
    // no createDraft, no createThreadedDraft_, no LLM call anywhere in that
    // file). It reads the AI Drafts Log, checks each thread's real last
    // message age, writes the "Stalled Bookings Audit" tab, and emails only
    // when it finds something NEW. There was no draft quality to prove.
    'runStalledBookingsAudit'
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

  // SLOWED from 5 to 15 minutes (23 Aug 2026, per direct request): the
  // MAX_PENDING_DRAFTS_IN_FOLDER cap check in runReplyDrafter runs BEFORE any
  // per-thread processing, so a capped-out run isn't free -- it still costs
  // a quota-check REST call and a GmailApp.search() pulling metadata for
  // hundreds of threads, just to immediately bail (confirmed live, 23 Aug
  // 2026: 327 threads fetched, 0 drafts created, folder already at its cap
  // of 25). That's pure waste during any stretch where the queue outpaces
  // review -- overnight, weekends, or just a busy day. 15 minutes cuts that
  // to a third as many wasted calls; the only real cost is a fresh reply
  // landing right as the folder drains waiting up to 15 min instead of 5 to
  // get drafted, trivial next to how long a human takes to review a batch
  // anyway. 15 is one of Apps Script's supported interval steps (1/5/10/15/30).
  //
  // WEEKEND THROTTLE (23 Aug 2026, same request): this ONE trigger still
  // fires every 15 min all 7 days -- Apps Script has no "every 15 min, but
  // only Mon-Fri" interval option. runReplyDrafter() itself checks the day
  // and, on Sat/Sun, no-ops 3 of every 4 firings (keeping only the one
  // landing in each hour's first 15 minutes), so the real-world effect is
  // ~hourly on weekends without needing a second trigger.
  ScriptApp.newTrigger('runReplyDrafter')
    .timeBased()
    .everyMinutes(15)
    .create();
  Logger.log('Created: runReplyDrafter, every 15 minutes (interval, no fixed clock time).');

  // MOVED off daily to weekly (22 Aug 2026, per direct request): maildoso
  // outreach only sends on weekdays, so this and runMissedLeadsAudit were
  // burning Gmail read/write quota every single day competing with
  // runReplyDrafter/runLeadFollowUpCycle for the same 50,000/day account-wide
  // budget, even though there's no outreach-driven reason to check daily.
  // runLearningLoopInner()'s dedup (skip any Thread ID already in "Learning
  // Log") already makes it naturally cumulative across runs, and it now has
  // the same wall-clock RUNTIME_BUDGET_MS stop-and-resume pattern
  // runReplyDrafter uses (see learning_loop.gs) -- so batching a full week's
  // worth of comparisons into one Saturday run is safe even if it can't
  // finish in one execution; whatever's left over just picks up on the
  // NEXT Saturday's run, same as runReplyDrafter already does across
  // 5-minute runs.
  ScriptApp.newTrigger('runLearningLoop')
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.SATURDAY)
    .atHour(9)
    .create();
  Logger.log('Created: runLearningLoop, weekly on Saturday around 9 AM ' + TZ + ' (after runWeekendDeepMissedLeadsAudit at 8 AM).');

  // SWITCHED to daily (19 Aug 2026, per direct request), now that it emails
  // a same-day reviewable doc to Goodness/Joana/Kris instead of just
  // appending to a sheet tab. Target is ~6 PM PACIFIC, not Paris -- Pacific
  // is UTC-7 in August (daylight time), Paris is UTC+2 (CEST), a 9-hour
  // gap, so 6 PM Pacific lands at 3 AM Paris the NEXT calendar day. Using
  // atHour(3) here to hit that. CAVEAT: US and EU daylight-saving transition
  // on different calendar dates each year (US: 2nd Sun of March / 1st Sun
  // of November; EU: last Sun of March / last Sun of October), so for a
  // ~1-2 week window each spring and fall this drifts up to an hour off
  // 6 PM Pacific. Not worth solving with date math for an internal digest
  // email -- if that ever actually matters, adjust atHour() by 1 during
  // those windows.
  ScriptApp.newTrigger('generateSopSuggestions')
    .timeBased()
    .everyDays(1)
    .atHour(3)
    .create();
  Logger.log('Created: generateSopSuggestions, daily around 3 AM ' + TZ + ' (~6 PM Pacific the previous day).');

  // MOVED off daily to weekly (22 Aug 2026, per direct request -- same
  // quota reasoning as runLearningLoop above: maildoso only sends weekdays,
  // so there's no new-outreach reason to re-check for missed leads every
  // single day). Its own dedup (alreadyLogged, keyed by Thread ID already in
  // the "Missed Leads Audit" tab) already makes runs cumulative, and its
  // 14-day lookback comfortably covers the week between Sundays. Put on
  // Sunday rather than doubling up with runWeekendDeepMissedLeadsAudit's
  // Saturday run, so the two heaviest weekly Gmail-quota jobs aren't
  // competing for the same day's budget.
  ScriptApp.newTrigger('runMissedLeadsAudit')
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.SUNDAY)
    .atHour(8)
    .create();
  Logger.log('Created: runMissedLeadsAudit, weekly on Sunday around 8 AM ' + TZ + '.');

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

  // Runs after runReplyDrafter has had all day to create real drafts for
  // anything reconciled the PREVIOUS day, and before runMissedLeadsAudit at
  // 8 AM so a freshly-unlabeled thread doesn't get double-flagged.
  ScriptApp.newTrigger('reconcileMissingDrafts')
    .timeBased()
    .everyDays(1)
    .atHour(5)
    .create();
  Logger.log('Created: reconcileMissingDrafts, daily around 5 AM ' + TZ + '.');

  // ADDED (24 Aug 2026, per direct request): this audit answers "did a lead
  // get as far as a penciled call time or a teammate handoff and then just
  // go quiet with nobody chasing it," which is only actionable on a day
  // someone is actually working -- so Monday morning rather than joining the
  // weekend audit block. It emails ONLY on new findings (dedup by Thread ID
  // against its own tab), so a quiet week produces no email at all rather
  // than a weekly "all clear" nobody reads.
  ScriptApp.newTrigger('runStalledBookingsAudit')
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.MONDAY)
    .atHour(8)
    .create();
  Logger.log('Created: runStalledBookingsAudit, weekly Monday around 8 AM ' + TZ + '.');

  // ADDED (24 Aug 2026, per direct request): the heartbeat and trigger-health
  // triggers used to live behind a SEPARATE function nobody remembered to run.
  // Deleting all triggers and running only this one therefore left the project
  // with no health check at all -- the single trigger whose entire job is
  // noticing that the others went missing. Creating them here means "run
  // setupAllTriggers()" is the complete answer, which is what everyone
  // reasonably assumed it already was.
  if (typeof setupHeartbeatTriggers === 'function') {
    setupHeartbeatTriggers();
    Logger.log('Created: runHeartbeatCheck + runTriggerHealthCheck (via setupHeartbeatTriggers()).');
  } else {
    Logger.log('WARNING: setupHeartbeatTriggers() not found -- heartbeat_and_trigger_healthcheck.gs is missing from this project. The ten triggers above exist but NOTHING is health-checking them.');
  }

  Logger.log('All ' + functionsToSchedule.length + ' scheduled triggers created (plus the heartbeat pair), all clock times in ' + TZ + '. Check the Triggers page (clock icon) to confirm.');

  // ADDED (24 Aug 2026, real gap found in review): runTriggerHealthCheck()
  // in heartbeat_and_trigger_healthcheck.gs compares the LIVE triggers
  // against its own hardcoded EXPECTED_TRIGGER_FUNCTIONS list. Those two
  // lists had silently drifted apart -- this file scheduled nine functions,
  // that list named seven -- so a vanished summarizeFollowUpLearning or
  // reconcileMissingDrafts trigger would never have been reported. Keeping
  // two hand-maintained lists in sync by memory is exactly what failed, so
  // check it in code instead: this runs at the end of every setupAllTriggers()
  // and shouts if they ever diverge again. Logged + alerted rather than
  // thrown, since the triggers themselves are already correctly created by
  // this point and aborting here would help nobody.
  // Guarded on typeof: this is a manually-run function, and every trigger
  // above has already been created by the time we get here. If
  // heartbeat_and_trigger_healthcheck.gs somehow isn't in the project, a bare
  // reference would throw a ReferenceError and paint the whole execution red
  // -- making a successful setup look like a failed one, right at the moment
  // someone is watching it to confirm the deploy worked.
  if (typeof EXPECTED_TRIGGER_FUNCTIONS === 'undefined') {
    Logger.log('NOTE: EXPECTED_TRIGGER_FUNCTIONS not found -- heartbeat_and_trigger_healthcheck.gs is missing from this project. All triggers above were still created fine, but nothing is health-checking them. Add that file.');
    return;
  }

  const allCreated = functionsToSchedule.concat(
    typeof HEARTBEAT_TRIGGER_FUNCTIONS !== 'undefined' ? HEARTBEAT_TRIGGER_FUNCTIONS : []);
  const notWatched = allCreated.filter(fn => EXPECTED_TRIGGER_FUNCTIONS.indexOf(fn) === -1);
  const watchedButNotScheduled = EXPECTED_TRIGGER_FUNCTIONS.filter(fn => allCreated.indexOf(fn) === -1);
  if (notWatched.length > 0 || watchedButNotScheduled.length > 0) {
    const msg =
      'setupAllTriggers() and EXPECTED_TRIGGER_FUNCTIONS (heartbeat_and_trigger_healthcheck.gs) have drifted apart. ' +
      'Scheduled but NOT health-checked (these can vanish unnoticed): ' + (notWatched.join(', ') || 'none') + '. ' +
      'Health-checked but NOT scheduled (these will alarm as missing every day): ' + (watchedButNotScheduled.join(', ') || 'none') + '. ' +
      'Fix by editing whichever of the two lists is wrong -- they must name the same functions.';
    Logger.log('TRIGGER LIST DRIFT -- ' + msg);
    sendOpsAlert('Trigger list drift between setupAllTriggers and the health check', msg);
  } else {
    Logger.log('Trigger list consistency check OK -- setupAllTriggers() and EXPECTED_TRIGGER_FUNCTIONS name the same ' + allCreated.length + ' functions.');
  }
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