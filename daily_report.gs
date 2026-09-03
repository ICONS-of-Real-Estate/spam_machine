/**
 * ICONS OF REAL ESTATE — Daily Report (companion file, same project --
 * shares CONFIG and helper functions)
 * ---------------------------------------------------------------------------
 * Sends a daily email to Kris, Tomás, and Joana with real numbers pulled
 * from the existing log tabs -- not estimates. Covers:
 *   - New leads received today (raw inbound count from Gmail)
 *   - How many Claude actually drafted, and how many were confirmed sent
 *   - How many Joana edited before sending (vs. sent as-is)
 *   - Penciled call times and teammate handoffs, tracked SEPARATELY (per
 *     Tomás's feedback, 3 Sep 2026 -- a confirmed call and a routing
 *     decision are two different things, not one "booked" number)
 *   - Category breakdown (interested / declined / opted out)
 *   - YESTERDAY leads (the one complete day at send time), then TODAY
 *     (partial, still useful later in the day)
 *   - LAST 7 DAYS only on Mondays, LAST 30 DAYS only on the 1st of the
 *     month -- gated to a slower cadence per Tomás's feedback ("less
 *     information, easier to read"); the report itself still sends daily.
 *   - All-time totals for context
 *   - Kimi vs Anthropic split test, Mondays only (same feedback -- "not
 *     really useful for a daily update")
 *
 * ASSUMPTION MADE EXPLICIT: "booking rate" is penciledCount (category =
 * yes_penciled, a specific time confirmed) + handoffCount (needs_teammate_
 * routing = true, handed to Sean/Bens) as two separate numbers, not one
 * combined count. If that split isn't quite right, it's a one-line change
 * in penciledCount()/handoffCount() below.
 *
 * SCHEDULING: add a trigger for runDailyReport -- Time-driven -- Day timer,
 * whatever time you want the report to land each morning.
 */

// ---------- TINY HTML BAR-CHART HELPERS (27 Aug 2026, per direct request --
// "add graphs, it's very hard to read") ----------
//
// MailApp has no chart-image support without hosting an image externally --
// nothing here calls out to a chart-image API or a Drive-hosted image, since
// that would be one more thing that can silently 404 inside an email nobody
// re-checks. These are plain HTML/CSS bar charts instead: a <table> of
// colored <div>s sized by width. Renders identically for every recipient of
// this report, since all three (Kris, Tomas, Joana) read it in Gmail, and
// degrades gracefully -- the real value is always ALSO printed as text, so
// even a client that strips inline CSS still shows the actual numbers.
function barRowHtml_(label, rawValue, maxValue, color, barWidthPx, displayText) {
  const width = maxValue > 0 ? Math.max(2, Math.round((rawValue / maxValue) * barWidthPx)) : 0;
  const text = displayText !== undefined ? displayText : rawValue;
  return (
    '<tr>' +
      '<td style="padding:2px 8px 2px 0; color:#555555; white-space:nowrap; font-size:12px;">' + escapeHtml(String(label)) + '</td>' +
      '<td style="padding:2px 0;">' +
        '<div style="background:#eeeeee; border-radius:3px; width:' + barWidthPx + 'px; height:10px;">' +
          '<div style="background:' + color + '; border-radius:3px; width:' + width + 'px; height:10px;"></div>' +
        '</div>' +
      '</td>' +
      '<td style="padding:2px 0 2px 8px; text-align:right; font-weight:bold; font-size:12px; white-space:nowrap;">' + text + '</td>' +
    '</tr>'
  );
}

// Buckets a category name by its "yes_"/"no_" prefix (matching the label
// conventions already used throughout this project -- LABEL_YES/LABEL_NO in
// Code.gs) so a reader can tell interested-vs-declined apart at a glance
// instead of reading every word. Neutral categories (info_request, *_error,
// unknown) stay gray rather than guessing a color that isn't there.
function categoryColor_(cat) {
  const c = String(cat).toLowerCase();
  if (c.indexOf('yes') === 0) return '#1a7f37';
  if (c.indexOf('no') === 0 || c.indexOf('scam') !== -1 || c.indexOf('stop') !== -1) return '#c0392b';
  return '#555555';
}

function categoryBarsHtml_(cats) {
  const keys = Object.keys(cats);
  if (keys.length === 0) return '<div style="color:#888; font-size:12px;">no drafts in this window</div>';
  const maxCount = Math.max.apply(null, keys.map(k => cats[k]));
  const rows = keys.map(k => barRowHtml_(k, cats[k], maxCount, categoryColor_(k), 160)).join('');
  return '<table style="border-collapse:collapse; margin:4px 0 0 0;">' + rows + '</table>';
}

// ADDED (28 Aug 2026, per direct request -- "that chart doesn't tell any
// useful information"): categoryBarsHtml_ scales each category's bar
// against the LARGEST category, not against the total. That answers "which
// category is biggest" -- which the number next to it already says just as
// clearly -- but not the question a reader actually opens this section to
// answer: what fraction of today's replies are people saying yes versus no?
// This renders that directly as one stacked bar (green/red/gray, same
// three-way split categoryColor_ already computes per category) plus the
// percentages in words, same "always print the real number next to the
// bar" rule as every other chart in this file. Placed ABOVE the per-category
// list, which stays as-is for anyone who wants the category-level detail.
function categorySummaryBarHtml_(cats) {
  const keys = Object.keys(cats);
  const total = keys.reduce((sum, k) => sum + cats[k], 0);
  if (total === 0) return '';

  const groups = { positive: 0, negative: 0, neutral: 0 };
  keys.forEach(k => {
    const color = categoryColor_(k);
    if (color === '#1a7f37') groups.positive += cats[k];
    else if (color === '#c0392b') groups.negative += cats[k];
    else groups.neutral += cats[k];
  });

  const widthPx = 220;
  const posPx = Math.round((groups.positive / total) * widthPx);
  const negPx = Math.round((groups.negative / total) * widthPx);
  const neuPx = widthPx - posPx - negPx; // remainder, so rounding never leaves a visible gap
  const pct = n => Math.round((n / total) * 100);

  const segment = (px, color) => px > 0
    ? '<div style="background:' + color + '; width:' + px + 'px; height:12px; display:inline-block;"></div>'
    : '';

  return (
    '<div style="margin:6px 0 12px 0;">' +
      '<div style="width:' + widthPx + 'px; height:12px; border-radius:3px; overflow:hidden; white-space:nowrap;">' +
        segment(posPx, '#1a7f37') + segment(negPx, '#c0392b') + segment(neuPx, '#888888') +
      '</div>' +
      '<div style="font-size:12px; color:#555555; margin-top:3px;">' +
        '<span style="color:#1a7f37; font-weight:bold;">' + groups.positive + ' interested (' + pct(groups.positive) + '%)</span> &nbsp; ' +
        '<span style="color:#c0392b; font-weight:bold;">' + groups.negative + ' declined (' + pct(groups.negative) + '%)</span>' +
        (groups.neutral > 0 ? ' &nbsp; <span style="color:#888888;">' + groups.neutral + ' other (' + pct(groups.neutral) + '%)</span>' : '') +
      '</div>' +
    '</div>'
  );
}

// A single two-segment bar (edited vs. sent-as-is) rather than a per-category
// list -- this is a proportion of ONE whole, not a set of independent counts,
// so one bar reads faster than a bar-per-value table would.
function editedStackedBarHtml_(edited, sentAsIs) {
  const total = edited + sentAsIs;
  const widthPx = 160;
  if (total === 0) return '<div style="color:#888; font-size:12px;">no reviewed drafts yet</div>';
  const editedPx = Math.round((edited / total) * widthPx);
  const sentPx = widthPx - editedPx;
  return (
    '<div style="width:' + widthPx + 'px; height:10px; border-radius:3px; overflow:hidden; white-space:nowrap;">' +
      (editedPx > 0 ? '<div style="background:#e08e0b; width:' + editedPx + 'px; height:10px; display:inline-block;"></div>' : '') +
      (sentPx > 0 ? '<div style="background:#1a7f37; width:' + sentPx + 'px; height:10px; display:inline-block;"></div>' : '') +
    '</div>' +
    '<div style="font-size:11px; color:#888888; margin-top:2px;">' +
      '<span style="color:#e08e0b;">&#9632;</span> edited &nbsp; ' +
      '<span style="color:#1a7f37;">&#9632;</span> sent as-is' +
    '</div>'
  );
}

// KIMI vs ANTHROPIC get a fixed, distinct color each so the split-test bars
// below are scannable without reading the row label every time.
function providerColor_(provider) {
  return provider === 'kimi' ? '#6c3fc5' : '#d35400';
}

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
  // FIX (27 Aug 2026, real risk found in review): todayStart is LOCAL
  // midnight, but these offsets were fixed UTC milliseconds -- stepping
  // back 24h from local midnight is not the same as stepping back one
  // CALENDAR day whenever a DST transition falls in between. Verified: on
  // the spring-forward date, yesterdayStart lands an hour before local
  // midnight of the day before (a 25-hour "yesterday" window); on the
  // fall-back date it lands an hour AFTER local midnight (a 23-hour window
  // that drops drafts logged in that missing hour from every bucket).
  // Stepping calendar days via the Date constructor's own month/day
  // rollover instead of raw millisecond math sidesteps this entirely.
  const dayBefore_ = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() - n);
  const yesterdayStart = dayBefore_(todayStart, 1);
  const sevenDaysAgo = dayBefore_(todayStart, 7);
  const thirtyDaysAgo = dayBefore_(todayStart, 30);

  // ADDED (3 Sep 2026, per Tomás's feedback on this report -- "I would leave
  // the 7-day breakdown just every week, and the 30-day breakdown just on a
  // monthly basis. Less information, easier to read, easier to reach
  // conclusions"): the report itself still sends daily, as he separately
  // asked to keep -- only the LAST 7 DAYS / LAST 30 DAYS sections (and the
  // Kimi-vs-Anthropic split test, which he also flagged as "not really
  // useful for a daily update") are gated to their own slower cadence now.
  // Monday for weekly (matches runStalledBookingsAudit's existing Monday
  // cadence), the 1st of the calendar month for monthly.
  const isWeeklyReportDay = now.getDay() === 1; // Monday
  const isMonthlyReportDay = now.getDate() === 1;

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

  // SPLIT (3 Sep 2026, per Tomás's feedback on this report -- "penciled time
  // or handed to Sean/Bens are two completely different things, this should
  // be separated"): these used to be one combined "booked" number. A
  // penciled time is a call Joana herself confirmed; a handoff is just a
  // routing decision -- Sean/Bens still have to actually reach the lead and
  // get them on a call. Conflating them answered a question nobody asked
  // ("how many either of these two very different things happened") instead
  // of the two real questions: how many calls are actually locked in, and
  // how many leads are sitting in the handoff queue.
  function penciledCount(rows) {
    return rows.filter(r => r[4] === 'yes_penciled').length;
  }
  function handoffCount(rows) {
    return rows.filter(r => r[5] === true).length;
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

  // ADDED (3 Sep 2026, per Tomás's feedback -- "it seems it is only tracking
  // drafts, not sends? Could it track replies? Reply rate and booking rate
  // are what would be best to track"): editStatsArg.total already IS a real
  // sent-confirmation count (learning_loop.gs's findSentReplyAfterDraft()
  // only logs a Learning Log row once it has independently verified Joana
  // actually sent something to the lead, not just that a draft exists) --
  // it just wasn't being read as "how many replies actually went out." Reply
  // rate = that count over how many were drafted. NOTE: the Learning Log is
  // populated by the WEEKLY learning loop, so this lags -- a TODAY/YESTERDAY
  // window's rate will read artificially low right after a run and is not a
  // reliable signal that recently, only over the slower windows where the
  // weekly loop has had time to catch up (see the reply-rate note appended
  // to the email body/htmlBody below).
  function replyRateLine_(rowsLength, editStatsArg) {
    if (rowsLength === 0) return 'no drafts yet';
    return editStatsArg.total + ' of ' + rowsLength + ' (' + Math.round((editStatsArg.total / rowsLength) * 100) + '%)';
  }

  function formatSection(label, rows, editStatsArg) {
    const cats = categoryBreakdown(rows);
    const penciled = penciledCount(rows);
    const handoff = handoffCount(rows);
    const bookingRate = rows.length > 0 ? Math.round(((penciled + handoff) / rows.length) * 100) : 0;
    const catLines = Object.keys(cats).map(c => '    ' + c + ': ' + cats[c]).join('\n');
    return (
      label + ':\n' +
      '  Drafted by Claude: ' + rows.length + '\n' +
      '  Replied (confirmed actually sent): ' + replyRateLine_(rows.length, editStatsArg) + '\n' +
      '  Penciled a specific call time: ' + penciled + '\n' +
      '  Handed to a teammate (Sean/Bens): ' + handoff + '\n' +
      '  Booking rate (penciled + handed off, of drafted): ' + bookingRate + '%\n' +
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
    const penciled = penciledCount(rows);
    const handoff = handoffCount(rows);
    const bookingRate = rows.length > 0 ? Math.round(((penciled + handoff) / rows.length) * 100) : 0;
    const editPct = editStatsArg.total > 0 ? Math.round((editStatsArg.edited / editStatsArg.total) * 100) : 0;
    return (
      '<div style="margin:0 0 14px 0; padding:10px 14px; border:1px solid #e0e0e0; border-left:4px solid #1a2b4c; border-radius:6px;">' +
        '<div style="font-weight:bold; color:#1a2b4c; font-size:15px; margin-bottom:6px;">' + escapeHtml(label) + '</div>' +
        '<div style="line-height:1.7;">' +
          '<b>Drafted by Claude:</b> <span style="color:#1a2b4c; font-weight:bold;">' + rows.length + '</span><br>' +
          '<b>Replied</b> (confirmed actually sent): ' + escapeHtml(replyRateLine_(rows.length, editStatsArg)) + '<br>' +
          '<b>Penciled a specific call time:</b> ' + penciled + ' &nbsp; <b>Handed to a teammate</b> (Sean/Bens): ' + handoff +
            ' &nbsp; <b>Booking rate:</b> <span style="color:#1a7f37; font-weight:bold;">' + bookingRate + '%</span><br>' +
          '<b>Edited by Joana before sending:</b> ' + editStatsArg.edited + ' of ' + editStatsArg.total + ' sent (' + editPct + '%)<br>' +
          editedStackedBarHtml_(editStatsArg.edited, editStatsArg.sentAsIs) +
          '<b>By category:</b>' + categorySummaryBarHtml_(cats) + categoryBarsHtml_(cats) +
        '</div>' +
      '</div>'
    );
  }

  // REORDERED AGAIN (3 Sep 2026, per Tomás's feedback -- "this is sending
  // the daily Sat 29 update at my 6am, so it's when midnight passes... needs
  // to be from the PREVIOUS day, as there is information it will be able to
  // pull up. The 'TODAY (partial -- only since midnight)' makes no sense"):
  // the 28 Aug reorder put TODAY first per a different, now-superseded
  // request. At the report's actual send time (~7 AM), TODAY is a few
  // hours old and nearly empty -- YESTERDAY is the complete, meaningful
  // number and belongs first. TODAY stays in the report (still useful if
  // read later in the day) but no longer leads.
  const periodicSections =
    (isWeeklyReportDay ? formatSection('LAST 7 DAYS', drafts7d, edit7d) + '\n\n' : '') +
    (isMonthlyReportDay ? formatSection('LAST 30 DAYS', drafts30d, edit30d) + '\n\n' : '');

  // MOVED OFF DAILY (3 Sep 2026, per Tomás's feedback -- "the price matching
  // between Kimi and Anthropic is not really useful for a daily update"):
  // now only included in Monday's weekly report, as one LAST 7 DAYS
  // comparison instead of three overlapping YESTERDAY/TODAY/LAST-7-DAYS
  // blocks -- the daily fluctuation was exactly the noise he meant.
  const splitTestSection = isWeeklyReportDay
    ? 'KIMI vs ANTHROPIC SPLIT TEST (price and quality; ' +
        (LLM_COST_TEST_MODE ? 'test ACTIVE -- providers alternate 50/50 by call' : 'test OFF -- Kimi first always') + ')\n' +
      buildSplitTestSection_(ss, draftsData, learningData, rowsSince, sevenDaysAgo, 'LAST 7 DAYS') + '\n\n' +
      'Reading this: cost-per-draft is the price answer. Edit rate and % surviving\n' +
      'are the quality answer -- lower edit rate and higher % surviving is better.\n' +
      'A cheap provider that gets rewritten every time is not actually cheaper.\n\n'
    : 'KIMI vs ANTHROPIC SPLIT TEST: included in the weekly report (Mondays) instead of every day.\n\n';

  const body =
    'This email was written by Claude.\n\n' +
    'DAILY REPORT -- ' + now.toDateString() + '\n\n' +
    'New leads received today (raw inbound count): ' + leadsReceivedToday + '\n\n' +
    formatSection('YESTERDAY', draftsYesterday, editYesterday) + '\n\n' +
    formatSection('TODAY' + (now.getHours() < 12 ? ' (partial -- only since midnight)' : ''), draftsToday, editToday) + '\n\n' +
    periodicSections +
    formatSection('ALL TIME', draftsAllTime, editAllTime) + '\n\n' +
    'Averages:\n' +
    '  Per day (last 7 days): ' + (drafts7d.length / 7).toFixed(1) + ' drafted\n' +
    '  Per day (last 30 days): ' + (drafts30d.length / 30).toFixed(1) + ' drafted\n\n' +
    // ADDED (22 Aug 2026, per direct request): surface the self-tracked
    // Gmail quota counter (see quota_guard_and_alerting.gs) so someone
    // actually sees it day to day, instead of it only mattering silently
    // behind the scenes.
    'Gmail quota usage today (self-tracked, approximate): ' + getGmailQuotaUsageToday_() + ' / ' + GMAIL_CALL_REAL_LIMIT_ESTIMATE + ' estimated daily limit\n\n' +
    splitTestSection +
    'Full detail is always available in the "AI Drafts Log" and "Learning Log" tabs: ' +
    'https://docs.google.com/spreadsheets/d/' + CONFIG.SPREADSHEET_ID + '/edit';

  const periodicSectionsHtml =
    (isWeeklyReportDay ? formatSectionHtml('LAST 7 DAYS', drafts7d, edit7d) : '') +
    (isMonthlyReportDay ? formatSectionHtml('LAST 30 DAYS', drafts30d, edit30d) : '');

  const splitTestSectionHtml = isWeeklyReportDay
    ? '<h2 style="margin:0 0 8px 0; font-size:17px; color:#1a2b4c;">Kimi vs Anthropic split test</h2>' +
      '<p style="color:#555;">(price and quality; ' +
        (LLM_COST_TEST_MODE ? 'test ACTIVE -- providers alternate 50/50 by call' : 'test OFF -- Kimi first always') + ')</p>' +
      buildSplitTestSectionHtml_(ss, draftsData, learningData, rowsSince, sevenDaysAgo, 'LAST 7 DAYS') +
      '<p style="color:#555;">Reading this: cost-per-draft is the price answer. Edit rate and % surviving are ' +
        'the quality answer &mdash; lower edit rate and higher % surviving is better. A cheap provider that gets ' +
        'rewritten every time is not actually cheaper.</p>'
    : '<p style="color:#888; font-size:13px;">Kimi vs Anthropic split test: included in the weekly report (Mondays) instead of every day.</p>';

  const htmlBody =
    '<div style="font-family:Arial,sans-serif; font-size:14px; color:#222;">' +
      '<p>This email was written by Claude.</p>' +
      '<h2 style="margin:0 0 4px 0; font-size:17px; color:#1a2b4c;">Daily Report &mdash; ' + escapeHtml(now.toDateString()) + '</h2>' +
      '<p><b>New leads received today</b> (raw inbound count): ' + leadsReceivedToday + '</p>' +
      '<hr style="border:none; border-top:1px solid #ccc; margin:16px 0;">' +
      formatSectionHtml('YESTERDAY', draftsYesterday, editYesterday) +
      formatSectionHtml('TODAY' + (now.getHours() < 12 ? ' (partial -- only since midnight)' : ''), draftsToday, editToday) +
      periodicSectionsHtml +
      formatSectionHtml('ALL TIME', draftsAllTime, editAllTime) +
      '<p><b>Averages:</b><br>' +
        'Per day (last 7 days): ' + (drafts7d.length / 7).toFixed(1) + ' drafted<br>' +
        'Per day (last 30 days): ' + (drafts30d.length / 30).toFixed(1) + ' drafted</p>' +
      '<p><b>Gmail quota usage today</b> (self-tracked, approximate): ' + getGmailQuotaUsageToday_() + ' / ' + GMAIL_CALL_REAL_LIMIT_ESTIMATE + ' estimated daily limit</p>' +
      '<hr style="border:none; border-top:1px solid #ccc; margin:16px 0;">' +
      splitTestSectionHtml +
      '<hr style="border:none; border-top:1px solid #ccc; margin:16px 0;">' +
      '<p style="color:#555;">Full detail is always available in the "AI Drafts Log" and "Learning Log" tabs: ' +
        '<a href="https://docs.google.com/spreadsheets/d/' + CONFIG.SPREADSHEET_ID + '/edit">open the sheet</a></p>' +
    '</div>';

  MailApp.sendEmail({
    to: 'kris@iconsofrealestate.com',
    cc: 'tomas@iconsofrealestate.com,joana@iconsofrealestate.com',
    // RENAMED (27 Aug 2026, per direct request): matches the "SPAM DRAFT --"
    // prefix convention Joana wants on this project's automated mail so it's
    // recognizable in the inbox list without opening it.
    subject: 'SPAM DRAFT - Daily Report -- ' + now.toDateString(),
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
    // FIX (27 Aug 2026, real risk found in review): Number('') is 0, not
    // NaN, so a blank similarity cell used to survive the isNaN filter as a
    // real 0% and drag the reported average down -- indistinguishable from
    // a row that genuinely scored 0. Excluded before the Number() coercion
    // instead of after.
    const similarities = judged.filter(r => r[10] !== '' && r[10] !== null && r[10] !== undefined).map(r => Number(r[10])).filter(n => !isNaN(n));
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

// Three side-by-side bar rows (spend, cost/draft, quality) so the two
// providers can be compared at a glance before reading the detailed cards
// below. Bar width is relative to the larger of the two providers' values
// for that metric, not to any fixed scale -- these are a head-to-head
// comparison, not an absolute measurement.
// ADDED (30 Aug 2026, per direct request -- "the cost also needs to have
// what it did... if one was $10 for 10 drafts and the other was $20 for
// 1000 drafts, which do you think I would prefer?"): the bars used to show
// Spend and Cost per draft as two separate rows, which technically implies
// volume but never states it -- a reader has to do spend/cost-per-draft
// arithmetic in their head to recover it, and the raw Spend bar on its own
// reads as "which provider cost more" rather than "which provider did
// more." Drafts produced is now its own bar, first, so volume is read
// before spend rather than inferred after it.
function splitTestBarsHtml_(stats) {
  const draftVals = stats.map(s => s.draftCount);
  const draftMax = Math.max(draftVals[0], draftVals[1]);
  const spendMax = Math.max(stats[0].spend, stats[1].spend);
  const costVals = stats.map(s => s.costPerDraft || 0);
  const costMax = Math.max(costVals[0], costVals[1]);
  const qualityVals = stats.map(s => s.avgSimilarity || 0);
  const qualityMax = Math.max(qualityVals[0], qualityVals[1], 100);

  const barGroup = (metricLabel, values, maxValue, formatter) => (
    '<div style="margin:0 0 8px 0;">' +
      '<div style="font-size:12px; color:#555555; font-weight:bold; margin-bottom:2px;">' + escapeHtml(metricLabel) + '</div>' +
      '<table style="border-collapse:collapse;">' +
        stats.map((s, i) => barRowHtml_(s.provider.toUpperCase(), values[i], maxValue, providerColor_(s.provider), 140, formatter(values[i], s))).join('') +
      '</table>' +
    '</div>'
  );

  return (
    barGroup('Drafts produced', draftVals, draftMax, v => String(v)) +
    barGroup('Spend', stats.map(s => s.spend), spendMax, v => '$' + v.toFixed(4)) +
    barGroup('Cost per draft', costVals, costMax, (v, s) => s.costPerDraft !== null ? '$' + v.toFixed(4) : 'n/a') +
    barGroup('Draft survival into sent', qualityVals, qualityMax, (v, s) => s.avgSimilarity !== null ? v + '%' : 'n/a')
  );
}

// HTML twin of buildSplitTestSection_ -- same computeSplitTestStats_ data,
// bold labels + a bordered card per provider instead of an indented text
// block. Used only by runDailyReport's htmlBody; logSplitTestSummary() still
// uses the plain-text version above since Logger.log has no HTML rendering.
function buildSplitTestSectionHtml_(ss, draftsData, learningData, rowsSince, sinceDate, label, untilDate) {
  const stats = computeSplitTestStats_(ss, draftsData, learningData, rowsSince, sinceDate, untilDate);
  if (!stats) return '<h4 style="margin:18px 0 8px 0; font-size:14px; color:#1a2b4c;">' + escapeHtml(label) + '</h4><p>(no "LLM Cost Log" tab yet -- nothing recorded)</p>';

  const cards = stats.map(s => (
    '<div style="margin:0 0 14px 0; padding:10px 14px; border:1px solid #e0e0e0; border-left:4px solid ' + providerColor_(s.provider) + '; border-radius:6px;">' +
      '<div style="font-weight:bold; color:' + providerColor_(s.provider) + '; margin-bottom:6px;">' + escapeHtml(s.provider.toUpperCase()) + '</div>' +
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

  return '<h4 style="margin:18px 0 8px 0; font-size:14px; color:#1a2b4c;">' + escapeHtml(label) + '</h4>' + splitTestBarsHtml_(stats) + cards;
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
  // FIX (27 Aug 2026, real risk found in review): same DST bug as
  // runDailyReport's identical windows above -- see that fix's comment.
  const yesterdayStart = new Date(todayStart.getFullYear(), todayStart.getMonth(), todayStart.getDate() - 1);
  const lastHour = new Date(now.getTime() - 60 * 60 * 1000);

  Logger.log('=== KIMI vs ANTHROPIC -- ' + (LLM_COST_TEST_MODE
    ? 'test ACTIVE (providers alternate 50/50 by call)'
    : 'test OFF (Kimi first always)') + ' ===');
  Logger.log(buildSplitTestSection_(ss, draftsData, learningData, rowsSince, lastHour, 'LAST HOUR'));
  Logger.log(buildSplitTestSection_(ss, draftsData, learningData, rowsSince, todayStart, 'TODAY'));
  Logger.log(buildSplitTestSection_(ss, draftsData, learningData, rowsSince, yesterdayStart, 'YESTERDAY', todayStart));
  Logger.log('Quality figures stay empty until runLearningLoop() has compared drafts against what was actually sent. That trigger is WEEKLY (Saturday) -- run runLearningLoop() by hand once Joana has sent a few of these drafts if you want the quality numbers before then.');
}
