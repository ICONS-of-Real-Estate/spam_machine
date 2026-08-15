/**
 * ICONS OF REAL ESTATE — Daily Report (companion file, same project --
 * shares CONFIG and helper functions)
 * ---------------------------------------------------------------------------
 * Sends a daily email to Kris, Tomás, and Joana with real numbers pulled
 * from the existing log tabs -- not estimates. Covers:
 *   - New leads received today (raw inbound count from Gmail)
 *   - How many Claude actually drafted today
 *   - How many Joana edited before sending (vs. sent as-is)
 *   - How many got booked to a call (penciled time, or handed to Sean/Bens)
 *   - Category breakdown (interested / declined / opted out) for today
 *   - Same numbers again for the last 7 days and last 30 days, so you can
 *     see daily vs. weekly vs. monthly trend, not just one day in isolation
 *   - All-time totals for context
 *
 * ASSUMPTION MADE EXPLICIT: "booked to a call" is defined as category =
 * yes_penciled (a specific time confirmed) OR needs_teammate_routing = true
 * (handed to Sean/Bens for a qualification call). If that definition isn't
 * quite right, it's a one-line change in bookedCount() below.
 *
 * SCHEDULING: add a trigger for runDailyReport -- Time-driven -- Day timer,
 * whatever time you want the report to land each morning.
 */

function runDailyReport() {
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const draftsTab = ss.getSheetByName('AI Drafts Log');
  const learningTab = ss.getSheetByName('Learning Log');

  if (!draftsTab || !learningTab) {
    Logger.log('Daily report: could not find AI Drafts Log or Learning Log tab -- aborting.');
    return;
  }

  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const sevenDaysAgo = new Date(todayStart.getTime() - 7 * 24 * 60 * 60 * 1000);
  const thirtyDaysAgo = new Date(todayStart.getTime() - 30 * 24 * 60 * 60 * 1000);

  const addressClauses = CONFIG.REQUIRED_CC_ADDRESSES
    .map(addr => 'to:"' + addr + '" OR cc:"' + addr + '"')
    .join(' OR ');
  const recentThreads = GmailApp.search('(' + addressClauses + ') newer_than:1d', 0, 200);
  let leadsReceivedToday = 0;
  recentThreads.forEach(thread => {
    if (CONFIG.SUBJECT_PATTERN.test(thread.getFirstMessageSubject())) leadsReceivedToday++;
  });

  const draftsData = draftsTab.getDataRange().getValues().slice(1);

  function rowsSince(rows, sinceDate) {
    return rows.filter(r => r[0] instanceof Date && r[0] >= sinceDate);
  }

  function categoryBreakdown(rows) {
    const counts = {};
    rows.forEach(r => {
      const cat = r[4] || 'unknown';
      counts[cat] = (counts[cat] || 0) + 1;
    });
    return counts;
  }

  function bookedCount(rows) {
    return rows.filter(r => r[4] === 'yes_penciled' || r[5] === true).length;
  }

  const draftsToday = rowsSince(draftsData, todayStart);
  const drafts7d = rowsSince(draftsData, sevenDaysAgo);
  const drafts30d = rowsSince(draftsData, thirtyDaysAgo);
  const draftsAllTime = draftsData;

  const learningData = learningTab.getDataRange().getValues().slice(1);

  function editStats(rows, sinceDate) {
    const inRange = rows.filter(r => r[0] instanceof Date && r[0] >= sinceDate);
    const edited = inRange.filter(r => r[6] === true).length;
    return { total: inRange.length, edited: edited, sentAsIs: inRange.length - edited };
  }

  const editToday = editStats(learningData, todayStart);
  const edit7d = editStats(learningData, sevenDaysAgo);
  const edit30d = editStats(learningData, thirtyDaysAgo);
  const editAllTime = editStats(learningData, new Date(0));

  function formatSection(label, rows, editStatsArg) {
    const cats = categoryBreakdown(rows);
    const booked = bookedCount(rows);
    const catLines = Object.keys(cats).map(c => '    ' + c + ': ' + cats[c]).join('\n');
    return (
      label + ':\n' +
      '  Drafted by Claude: ' + rows.length + '\n' +
      '  Booked to a call (penciled time or handed to Sean/Bens): ' + booked + '\n' +
      '  Edited by Joana before sending: ' + editStatsArg.edited + ' of ' + editStatsArg.total + ' sent (' +
        (editStatsArg.total > 0 ? Math.round((editStatsArg.edited / editStatsArg.total) * 100) : 0) + '%)\n' +
      '  By category:\n' + catLines
    );
  }

  const body =
    'This email was written by Claude.\n\n' +
    'DAILY REPORT -- ' + now.toDateString() + '\n\n' +
    'New leads received today (raw inbound count): ' + leadsReceivedToday + '\n\n' +
    formatSection('TODAY', draftsToday, editToday) + '\n\n' +
    formatSection('LAST 7 DAYS', drafts7d, edit7d) + '\n\n' +
    formatSection('LAST 30 DAYS', drafts30d, edit30d) + '\n\n' +
    formatSection('ALL TIME', draftsAllTime, editAllTime) + '\n\n' +
    'Averages:\n' +
    '  Per day (last 7 days): ' + (drafts7d.length / 7).toFixed(1) + ' drafted\n' +
    '  Per day (last 30 days): ' + (drafts30d.length / 30).toFixed(1) + ' drafted\n\n' +
    'Full detail is always available in the "AI Drafts Log" and "Learning Log" tabs: ' +
    'https://docs.google.com/spreadsheets/d/' + CONFIG.SPREADSHEET_ID + '/edit';

  MailApp.sendEmail({
    to: 'kris@iconsofrealestate.com',
    cc: 'tomas@iconsofrealestate.com,joana@iconsofrealestate.com',
    subject: '[Written by Claude] Daily Podcast Reply Report -- ' + now.toDateString(),
    body: body
  });

  Logger.log('Daily report sent. Today: ' + draftsToday.length + ' drafted, ' + leadsReceivedToday + ' leads received.');
}
