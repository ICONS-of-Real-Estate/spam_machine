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
  // ADDED (17 Aug 2026, real incident): confirmed live that a different
  // account than Joana's has its own trigger firing this function -- see
  // assertRunningAsJoana() in lead_followup_sequences.gs. This calls
  // GmailApp.search() to count "leads received today" -- running as the
  // wrong account would silently report a wrong number pulled from a
  // different mailbox instead of Joana's.
  if (!assertRunningAsJoana('runDailyReport')) return;

  // ADDED (20 Aug 2026, real incident): this calls GmailApp.search() but
  // never checked the quota circuit breaker -- only runReplyDrafter did.
  // Same gap as runLearningLoop; see that fix for the full incident.
  if (isGmailQuotaExhausted()) {
    Logger.log('Skipping runDailyReport -- Gmail quota already known exhausted today.');
    return;
  }

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

  // ADDED (24 Aug 2026, per direct request -- "we are meant to be split
  // testing Anthropic and Kimi to see quality and price, make sure that is
  // measured"). Both halves were being recorded but neither was being
  // REPORTED, so answering "which one is winning" meant opening two tabs and
  // doing arithmetic by hand -- which is why a 7x cost difference ran for
  // nine hours unnoticed. This puts both numbers in the email that already
  // lands every morning.
  //
  // PRICE comes from the LLM Cost Log tab, and deliberately counts the
  // 'billed_no_output' rows too -- a provider that charges for a call that
  // came back unusable is really costing that money, and excluding those is
  // exactly what made the sheet disagree with the billing dashboard.
  // QUALITY comes from the Learning Log: how often a human changed the draft
  // before sending, and how much of it survived (see draftSimilarityPercent
  // in learning_loop.gs). Neither number means anything until a provider has
  // a few dozen rows, so sample sizes are printed alongside rather than
  // hidden behind a percentage.
  function buildSplitTestSection(sinceDate, label) {
    const costTab = ss.getSheetByName('LLM Cost Log');
    if (!costTab) return label + ':\n  (no "LLM Cost Log" tab yet -- nothing recorded)';

    const costRows = costTab.getDataRange().getValues().slice(1)
      .filter(r => r[0] instanceof Date && r[0] >= sinceDate);

    const learningRows = learningData.filter(r => r[0] instanceof Date && r[0] >= sinceDate);
    const draftRows = rowsSince(draftsData, sinceDate);

    const lines = ['kimi', 'anthropic'].map(provider => {
      const calls = costRows.filter(r => String(r[2] || '').toLowerCase() === provider);
      const spend = calls.reduce((sum, r) => sum + (Number(r[8]) || 0), 0);
      // Outcome column (J, index 9) is blank on rows written before it
      // existed -- treat those as 'ok', which is what they were.
      const outcomeOf = r => String(r[9] || 'ok').toLowerCase();
      const wasted = calls.filter(r => outcomeOf(r) === 'billed_no_output');
      const wastedSpend = wasted.reduce((sum, r) => sum + (Number(r[8]) || 0), 0);
      const failed = calls.filter(r => outcomeOf(r) === 'failed');

      // Drafts attributed to this provider (AI Drafts Log column J, index 9).
      const drafts = draftRows.filter(r => String(r[9] || '').toLowerCase() === provider);
      const costPerDraft = drafts.length > 0 ? spend / drafts.length : null;

      // Quality (Learning Log: J = provider index 9, G = was edited index 6,
      // K = similarity index 10).
      const judged = learningRows.filter(r => String(r[9] || '').toLowerCase() === provider);
      const editedCount = judged.filter(r => r[6] === true).length;
      const similarities = judged.map(r => Number(r[10])).filter(n => !isNaN(n));
      const avgSimilarity = similarities.length > 0
        ? Math.round(similarities.reduce((a, b) => a + b, 0) / similarities.length)
        : null;

      return (
        '  ' + provider.toUpperCase() + ':\n' +
        '    Spend: $' + spend.toFixed(4) + ' across ' + calls.length + ' call(s)\n' +
        '    Wasted (billed but returned nothing usable): $' + wastedSpend.toFixed(4) +
          ' across ' + wasted.length + ' call(s)\n' +
        '    Outright failures (no charge, fell back to the other provider): ' + failed.length + '\n' +
        '    Drafts produced: ' + drafts.length +
          (costPerDraft !== null ? ' -- $' + costPerDraft.toFixed(4) + ' per draft' : ' -- no cost-per-draft yet') + '\n' +
        '    Edited before sending: ' + (judged.length > 0
            ? editedCount + ' of ' + judged.length + ' (' + Math.round((editedCount / judged.length) * 100) + '%)'
            : 'no reviewed drafts yet') + '\n' +
        '    Avg of draft surviving into what was sent: ' + (avgSimilarity !== null
            ? avgSimilarity + '% (n=' + similarities.length + ')'
            : 'not enough data yet')
      );
    });

    return label + ':\n' + lines.join('\n');
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
    // ADDED (22 Aug 2026, per direct request): surface the self-tracked
    // Gmail quota counter (see quota_guard_and_alerting.gs) so someone
    // actually sees it day to day, instead of it only mattering silently
    // behind the scenes.
    'Gmail quota usage today (self-tracked, approximate): ' + getGmailQuotaUsageToday_() + ' / ' + GMAIL_CALL_SOFT_CAP + ' soft cap\n\n' +
    'KIMI vs ANTHROPIC SPLIT TEST (price and quality; ' +
      (LLM_COST_TEST_MODE ? 'test ACTIVE -- providers alternate 50/50 by call' : 'test OFF -- Kimi first always') + ')\n' +
    buildSplitTestSection(todayStart, 'TODAY') + '\n\n' +
    buildSplitTestSection(sevenDaysAgo, 'LAST 7 DAYS') + '\n\n' +
    'Reading this: cost-per-draft is the price answer. Edit rate and % surviving\n' +
    'are the quality answer -- lower edit rate and higher % surviving is better.\n' +
    'A cheap provider that gets rewritten every time is not actually cheaper.\n\n' +
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
