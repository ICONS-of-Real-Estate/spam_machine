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
    Logger.log('Skipping runDailyReport -- Gmail quota already known exhausted today, ' + timeUntilQuotaResetDescription_() + '.');
    return;
  }

  try {
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const draftsTab = ss.getSheetByName('AI Drafts Log');
  const learningTab = ss.getSheetByName('Learning Log');

  if (!draftsTab || !learningTab) {
    Logger.log('Daily report: could not find AI Drafts Log or Learning Log tab -- aborting.');
    return;
  }

  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  // ADDED (25 Aug 2026, per direct request): TODAY only covers midnight to
  // whenever this runs (~7 AM), which is barely any of the day -- the
  // question "how many emails yesterday, what did it cost" needs an actual
  // bounded [yesterdayStart, todayStart) range, not another "since X, still
  // counting" bucket like TODAY/7d/30d/all-time below.
  const yesterdayStart = new Date(todayStart.getTime() - 24 * 60 * 60 * 1000);
  const sevenDaysAgo = new Date(todayStart.getTime() - 7 * 24 * 60 * 60 * 1000);
  const thirtyDaysAgo = new Date(todayStart.getTime() - 30 * 24 * 60 * 60 * 1000);

  const addressClauses = CONFIG.REQUIRED_CC_ADDRESSES
    .map(addr => 'to:"' + addr + '" OR cc:"' + addr + '"')
    .join(' OR ');
  const recentThreads = GmailApp.search('(' + addressClauses + ') newer_than:1d', 0, 200);
  let leadsReceivedToday = 0;
  recentThreads.forEach(thread => {
    if (matchesSubjectPattern_(thread.getFirstMessageSubject())) leadsReceivedToday++;
  });

  const draftsData = draftsTab.getDataRange().getValues().slice(1);

  function rowsSince(rows, sinceDate) {
    return rows.filter(r => r[0] instanceof Date && r[0] >= sinceDate);
  }

  function rowsInRange(rows, startDate, untilDate) {
    return rows.filter(r => r[0] instanceof Date && r[0] >= startDate && r[0] < untilDate);
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

  const draftsYesterday = rowsInRange(draftsData, yesterdayStart, todayStart);
  const draftsToday = rowsSince(draftsData, todayStart);
  const drafts7d = rowsSince(draftsData, sevenDaysAgo);
  const drafts30d = rowsSince(draftsData, thirtyDaysAgo);
  const draftsAllTime = draftsData;

  const learningData = learningTab.getDataRange().getValues().slice(1);

  function editStats(rows, sinceDate, untilDate) {
    const inRange = untilDate
      ? rows.filter(r => r[0] instanceof Date && r[0] >= sinceDate && r[0] < untilDate)
      : rows.filter(r => r[0] instanceof Date && r[0] >= sinceDate);
    const edited = inRange.filter(r => r[6] === true).length;
    return { total: inRange.length, edited: edited, sentAsIs: inRange.length - edited };
  }

  const editYesterday = editStats(learningData, yesterdayStart, todayStart);
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

  // ADDED (25 Aug 2026, per direct request -- "log all the information to
  // one log file so it's easy to read"): this report already WAS the single
  // consolidated log (leads/drafts/edits/cost all in one email) -- what was
  // missing was readability. HTML twin of formatSection(), same numbers,
  // bold labels + bordered card instead of a plain-text wall, matching the
  // style already shipped for the stalled-bookings alert.
  function formatSectionHtml(label, rows, editStatsArg) {
    const cats = categoryBreakdown(rows);
    const booked = bookedCount(rows);
    const catLines = Object.keys(cats).map(c => '<li>' + escapeHtml(String(c)) + ': ' + cats[c] + '</li>').join('');
    const editPct = editStatsArg.total > 0 ? Math.round((editStatsArg.edited / editStatsArg.total) * 100) : 0;
    return (
      '<div style="margin:0 0 14px 0; padding:10px 14px; border:1px solid #e0e0e0; border-radius:6px;">' +
        '<div style="font-weight:bold; margin-bottom:6px;">' + escapeHtml(label) + '</div>' +
        '<div style="line-height:1.7;">' +
          '<b>Drafted by Claude:</b> ' + rows.length + '<br>' +
          '<b>Booked to a call</b> (penciled time or handed to Sean/Bens): ' + booked + '<br>' +
          '<b>Edited by Joana before sending:</b> ' + editStatsArg.edited + ' of ' + editStatsArg.total + ' sent (' + editPct + '%)<br>' +
          '<b>By category:</b><ul style="margin:4px 0 0 0;">' + catLines + '</ul>' +
        '</div>' +
      '</div>'
    );
  }

  const body =
    'This email was written by Claude.\n\n' +
    'DAILY REPORT -- ' + now.toDateString() + '\n\n' +
    'New leads received today (raw inbound count): ' + leadsReceivedToday + '\n\n' +
    formatSection('YESTERDAY', draftsYesterday, editYesterday) + '\n\n' +
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
    'Gmail quota usage today (self-tracked, approximate): ' + getGmailQuotaUsageToday_() + ' / ' + GMAIL_CALL_REAL_LIMIT_ESTIMATE + ' estimated daily limit\n\n' +
    'KIMI vs ANTHROPIC SPLIT TEST (price and quality; ' +
      (LLM_COST_TEST_MODE ? 'test ACTIVE -- providers alternate 50/50 by call' : 'test OFF -- Kimi first always') + ')\n' +
    buildSplitTestSection_(ss, draftsData, learningData, rowsSince, yesterdayStart, 'YESTERDAY', todayStart) + '\n\n' +
    buildSplitTestSection_(ss, draftsData, learningData, rowsSince, todayStart, 'TODAY') + '\n\n' +
    buildSplitTestSection_(ss, draftsData, learningData, rowsSince, sevenDaysAgo, 'LAST 7 DAYS') + '\n\n' +
    'Reading this: cost-per-draft is the price answer. Edit rate and % surviving\n' +
    'are the quality answer -- lower edit rate and higher % surviving is better.\n' +
    'A cheap provider that gets rewritten every time is not actually cheaper.\n\n' +
    'Full detail is always available in the "AI Drafts Log" and "Learning Log" tabs: ' +
    'https://docs.google.com/spreadsheets/d/' + CONFIG.SPREADSHEET_ID + '/edit';

  const htmlBody =
    '<div style="font-family:Arial,sans-serif; font-size:14px; color:#222;">' +
      '<p>This email was written by Claude.</p>' +
      '<h2 style="margin:0 0 4px 0; font-size:17px;">Daily Report &mdash; ' + escapeHtml(now.toDateString()) + '</h2>' +
      '<p><b>New leads received today</b> (raw inbound count): ' + leadsReceivedToday + '</p>' +
      '<hr style="border:none; border-top:1px solid #ccc; margin:16px 0;">' +
      formatSectionHtml('YESTERDAY', draftsYesterday, editYesterday) +
      formatSectionHtml('TODAY', draftsToday, editToday) +
      formatSectionHtml('LAST 7 DAYS', drafts7d, edit7d) +
      formatSectionHtml('LAST 30 DAYS', drafts30d, edit30d) +
      formatSectionHtml('ALL TIME', draftsAllTime, editAllTime) +
      '<p><b>Averages:</b><br>' +
        'Per day (last 7 days): ' + (drafts7d.length / 7).toFixed(1) + ' drafted<br>' +
        'Per day (last 30 days): ' + (drafts30d.length / 30).toFixed(1) + ' drafted</p>' +
      '<p><b>Gmail quota usage today</b> (self-tracked, approximate): ' + getGmailQuotaUsageToday_() + ' / ' + GMAIL_CALL_REAL_LIMIT_ESTIMATE + ' estimated daily limit</p>' +
      '<hr style="border:none; border-top:1px solid #ccc; margin:16px 0;">' +
      '<h2 style="margin:0 0 8px 0; font-size:17px;">Kimi vs Anthropic split test</h2>' +
      '<p style="color:#555;">(price and quality; ' +
        (LLM_COST_TEST_MODE ? 'test ACTIVE -- providers alternate 50/50 by call' : 'test OFF -- Kimi first always') + ')</p>' +
      buildSplitTestSectionHtml_(ss, draftsData, learningData, rowsSince, yesterdayStart, 'YESTERDAY', todayStart) +
      buildSplitTestSectionHtml_(ss, draftsData, learningData, rowsSince, todayStart, 'TODAY') +
      buildSplitTestSectionHtml_(ss, draftsData, learningData, rowsSince, sevenDaysAgo, 'LAST 7 DAYS') +
      '<p style="color:#555;">Reading this: cost-per-draft is the price answer. Edit rate and % surviving are ' +
        'the quality answer &mdash; lower edit rate and higher % surviving is better. A cheap provider that gets ' +
        'rewritten every time is not actually cheaper.</p>' +
      '<hr style="border:none; border-top:1px solid #ccc; margin:16px 0;">' +
      '<p style="color:#555;">Full detail is always available in the "AI Drafts Log" and "Learning Log" tabs: ' +
        '<a href="https://docs.google.com/spreadsheets/d/' + CONFIG.SPREADSHEET_ID + '/edit">open the sheet</a></p>' +
    '</div>';

  MailApp.sendEmail({
    to: 'kris@iconsofrealestate.com',
    cc: 'tomas@iconsofrealestate.com,joana@iconsofrealestate.com',
    subject: '[Written by Claude] Daily Podcast Reply Report -- ' + now.toDateString(),
    body: body,
    htmlBody: htmlBody
  });

  Logger.log('Daily report sent. Today: ' + draftsToday.length + ' drafted, ' + leadsReceivedToday + ' leads received.');
  } catch (e) {
    // FIX (27 Aug 2026, real risk found in review): no path here could ever
    // trip the Gmail quota circuit breaker -- see handleGmailJobError_.
    handleGmailJobError_('runDailyReport', e);
  }
}

// ---------- SPLIT-TEST REPORTING (24 Aug 2026) ----------
//
// EXTRACTED to a global from inside runDailyReport() so the on-demand
// checker below can share it. Two copies of this arithmetic drifting apart
// would be worse than useless -- it would produce two different answers to
// the one question the split test exists to settle.
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
// EXTRACTED (25 Aug 2026, per direct request -- "log all the information to
// one log file so it's easy to read"): pulled the arithmetic out of
// buildSplitTestSection_ so the new HTML version (buildSplitTestSectionHtml_,
// for the daily report email) and the plain-text version (still used by
// logSplitTestSummary()'s Logger.log output) compute from one shared place --
// the whole point of the original 24 Aug extraction was to avoid two copies
// of this arithmetic drifting apart, and a naive HTML copy-paste would have
// broken that same guarantee again.
// untilDate is optional -- omit it for the existing "since X, still
// counting" buckets (TODAY/7d/30d/all-time); pass it for a bounded
// [sinceDate, untilDate) range like YESTERDAY.
function computeSplitTestStats_(ss, draftsData, learningData, rowsSince, sinceDate, untilDate) {
  const costTab = ss.getSheetByName('LLM Cost Log');
  if (!costTab) return null;

  const inRange = untilDate
    ? (r => r[0] instanceof Date && r[0] >= sinceDate && r[0] < untilDate)
    : (r => r[0] instanceof Date && r[0] >= sinceDate);

  const costRows = costTab.getDataRange().getValues().slice(1).filter(inRange);
  const learningRows = learningData.filter(inRange);
  const draftRows = untilDate
    ? draftsData.filter(inRange)
    : rowsSince(draftsData, sinceDate);

  return ['kimi', 'anthropic'].map(provider => {
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

    // ADDED (24 Aug 2026): token averages, because SPEND ALONE CANNOT TELL
    // YOU WHY. A provider looking expensive per call has two completely
    // different possible causes with opposite fixes: it is being billed for
    // uncached input every time (a caching problem, fixable in our code), or
    // our hardcoded rate in LLM_PRICING_PER_MTOK is simply wrong for the model
    // it actually served (an accounting problem -- and then every dollar
    // figure here is wrong too). Tokens are measured facts reported by the
    // provider; the dollars are our own arithmetic on top of a rate someone
    // typed in by hand. When the two disagree, trust the tokens.
    //
    // Read it like this: cache-read near zero while input is ~9k means the SOP
    // is being re-billed in full every call and caching is not working. Large
    // cache-read with small input means caching IS working, so any remaining
    // gap is the rate card, not the plumbing.
    const okCalls = calls.filter(r => outcomeOf(r) === 'ok');
    const avg = (idx) => okCalls.length > 0
      ? Math.round(okCalls.reduce((sum, r) => sum + (Number(r[idx]) || 0), 0) / okCalls.length)
      : 0;

    return {
      provider: provider,
      spend: spend, callCount: calls.length,
      avgInput: avg(4), avgCacheRead: avg(6), avgCacheWrite: avg(7), avgOutput: avg(5),
      wastedSpend: wastedSpend, wastedCount: wasted.length,
      failedCount: failed.length,
      draftCount: drafts.length, costPerDraft: costPerDraft,
      editedCount: editedCount, judgedCount: judged.length,
      avgSimilarity: avgSimilarity, similarityN: similarities.length
    };
  });
}

function buildSplitTestSection_(ss, draftsData, learningData, rowsSince, sinceDate, label, untilDate) {
  const stats = computeSplitTestStats_(ss, draftsData, learningData, rowsSince, sinceDate, untilDate);
  if (!stats) return label + ':\n  (no "LLM Cost Log" tab yet -- nothing recorded)';

  const lines = stats.map(s => (
    '  ' + s.provider.toUpperCase() + ':\n' +
    '    Spend: $' + s.spend.toFixed(4) + ' across ' + s.callCount + ' call(s)\n' +
    '    Avg tokens/call: ' + s.avgInput + ' input, ' + s.avgCacheRead + ' cache-read, ' +
      s.avgCacheWrite + ' cache-write, ' + s.avgOutput + ' output\n' +
    '    Wasted (billed but returned nothing usable): $' + s.wastedSpend.toFixed(4) +
      ' across ' + s.wastedCount + ' call(s)\n' +
    '    Outright failures (no charge, fell back to the other provider): ' + s.failedCount + '\n' +
    '    Drafts produced: ' + s.draftCount +
      (s.costPerDraft !== null ? ' -- $' + s.costPerDraft.toFixed(4) + ' per draft' : ' -- no cost-per-draft yet') + '\n' +
    '    Edited before sending: ' + (s.judgedCount > 0
        ? s.editedCount + ' of ' + s.judgedCount + ' (' + Math.round((s.editedCount / s.judgedCount) * 100) + '%)'
        : 'no reviewed drafts yet') + '\n' +
    '    Avg of draft surviving into what was sent: ' + (s.avgSimilarity !== null
        ? s.avgSimilarity + '% (n=' + s.similarityN + ')'
        : 'not enough data yet')
  ));

  return label + ':\n' + lines.join('\n');
}

// HTML twin of buildSplitTestSection_ -- same computeSplitTestStats_ data,
// bold labels + a bordered card per provider instead of an indented text
// block. Used only by runDailyReport's htmlBody; logSplitTestSummary() still
// uses the plain-text version above since Logger.log has no HTML rendering.
function buildSplitTestSectionHtml_(ss, draftsData, learningData, rowsSince, sinceDate, label, untilDate) {
  const stats = computeSplitTestStats_(ss, draftsData, learningData, rowsSince, sinceDate, untilDate);
  if (!stats) return '<h4 style="margin:18px 0 8px 0; font-size:14px;">' + escapeHtml(label) + '</h4><p>(no "LLM Cost Log" tab yet -- nothing recorded)</p>';

  const cards = stats.map(s => (
    '<div style="margin:0 0 14px 0; padding:10px 14px; border:1px solid #e0e0e0; border-radius:6px;">' +
      '<div style="font-weight:bold; margin-bottom:6px;">' + escapeHtml(s.provider.toUpperCase()) + '</div>' +
      '<div style="line-height:1.7;">' +
        '<b>Spend:</b> $' + s.spend.toFixed(4) + ' across ' + s.callCount + ' call(s)<br>' +
        '<b>Avg tokens/call:</b> ' + s.avgInput + ' input, ' + s.avgCacheRead + ' cache-read, ' +
          s.avgCacheWrite + ' cache-write, ' + s.avgOutput + ' output<br>' +
        '<b>Wasted</b> (billed, nothing usable): $' + s.wastedSpend.toFixed(4) + ' across ' + s.wastedCount + ' call(s)<br>' +
        '<b>Outright failures</b> (no charge, fell back): ' + s.failedCount + '<br>' +
        '<b>Drafts produced:</b> ' + s.draftCount +
          (s.costPerDraft !== null ? ' &mdash; $' + s.costPerDraft.toFixed(4) + ' per draft' : ' &mdash; no cost-per-draft yet') + '<br>' +
        '<b>Edited before sending:</b> ' + (s.judgedCount > 0
            ? s.editedCount + ' of ' + s.judgedCount + ' (' + Math.round((s.editedCount / s.judgedCount) * 100) + '%)'
            : 'no reviewed drafts yet') + '<br>' +
        '<b>Draft survival into sent:</b> ' + (s.avgSimilarity !== null
            ? s.avgSimilarity + '% (n=' + s.similarityN + ')'
            : 'not enough data yet') +
      '</div>' +
    '</div>'
  )).join('');

  return '<h4 style="margin:18px 0 8px 0; font-size:14px;">' + escapeHtml(label) + '</h4>' + cards;
}

// ADDED (24 Aug 2026, per direct request -- "we can see if Kimi did good
// with $2.42 or still burning money"): the daily report only lands at 7 AM,
// and the remaining Kimi balance is worth roughly 90 minutes of runtime. A
// summary that arrives after the money is gone cannot inform a decision
// about the money. Run this from the editor whenever you want the current
// numbers; it only reads sheets, sends nothing, and is safe to run as often
// as you like.
//
// WHAT TO LOOK FOR, in priority order:
//   1. Kimi's "Cache Read Tokens" -- if ~0 while Anthropic's is large for
//      the same caller, prompt caching is not working on Moonshot's endpoint
//      and Kimi is re-billing the full SOP at full rate on every call. That
//      alone can account for the entire observed cost gap, and it is not
//      something a cheaper per-token rate can win back.
//   2. "billed_no_output" call count -- calls the provider charged for that
//      returned nothing usable, then fell back to the other provider. These
//      were invisible before today.
//   3. Cost per draft -- the actual price answer, as opposed to the rate card.
function logSplitTestSummary() {
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const draftsTab = ss.getSheetByName('AI Drafts Log');
  const learningTab = ss.getSheetByName('Learning Log');
  if (!draftsTab) {
    Logger.log('logSplitTestSummary -- no "AI Drafts Log" tab found, nothing to report.');
    return;
  }

  const draftsData = draftsTab.getDataRange().getValues().slice(1);
  const learningData = learningTab ? learningTab.getDataRange().getValues().slice(1) : [];
  function rowsSince(rows, sinceDate) {
    return rows.filter(r => r[0] instanceof Date && r[0] >= sinceDate);
  }

  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  // ADDED (25 Aug 2026, per direct request): a real, exact YESTERDAY number
  // for "how many emails sent, how much did it cost" on demand, instead of
  // only getting that from the 7 AM email or an imprecise manual estimate.
  const yesterdayStart = new Date(todayStart.getTime() - 24 * 60 * 60 * 1000);
  const lastHour = new Date(now.getTime() - 60 * 60 * 1000);

  Logger.log('=== KIMI vs ANTHROPIC -- ' + (LLM_COST_TEST_MODE
    ? 'test ACTIVE (providers alternate 50/50 by call)'
    : 'test OFF (Kimi first always)') + ' ===');
  Logger.log(buildSplitTestSection_(ss, draftsData, learningData, rowsSince, lastHour, 'LAST HOUR'));
  Logger.log(buildSplitTestSection_(ss, draftsData, learningData, rowsSince, todayStart, 'TODAY'));
  Logger.log(buildSplitTestSection_(ss, draftsData, learningData, rowsSince, yesterdayStart, 'YESTERDAY', todayStart));
  Logger.log('Quality figures stay empty until runLearningLoop() has compared drafts against what was actually sent. That trigger is WEEKLY (Saturday) -- run runLearningLoop() by hand once Joana has sent a few of these drafts if you want the quality numbers before then.');
}
