/**
 * ICONS OF REAL ESTATE — Missed Leads Audit (companion file, same project as
 * podcast_reply_drafter.gs and learning_loop.gs -- shares their CONFIG object,
 * so all three files must live in one Apps Script project)
 * ---------------------------------------------------------------------------
 * Answers one question, on demand and on a schedule: is there any thread,
 * past or present, where a prospect replied to the podcast outreach and
 * NOBODY on the team ever responded?
 *
 * runMissedLeadsAudit(daysBack) -- pass nothing for the normal daily check
 * (looks back 14 days). Pass a large number once for a one-time historical
 * sweep, e.g. runMissedLeadsAudit(730) for two years back.
 *
 * Logic: pull every thread CC'd to the network address within the lookback
 * window. For each one, find the actual last message. If that message is
 * from a prospect (external sender) AND the thread has none of our tracking
 * labels (meaning nobody -- human or script -- ever dealt with it) AND it's
 * not a bare opt-out (which just means "pending the next runReplyDrafter
 * pass," not "missed"), it's logged as a genuine miss.
 *
 * KNOWN LIMITATION, worth knowing about rather than discovering later: if a
 * thread already carries one of the business labels (1. Spam YES/NO/STOP)
 * from an OLDER message, but the prospect replied again more recently and
 * that newer reply was never answered, this will NOT catch it -- it treats
 * any tracking label as "handled," full stop. Fine for a first version,
 * but if that scenario turns out to matter, the label check needs to become
 * time-aware (was the label applied before or after the last message).
 *
 * Findings go to a "Missed Leads Audit" tab (auto-created) in the same
 * "Icons Podcast Reply Drafter -- Logs" spreadsheet, and an email goes to
 * Kris + Joana ONLY if something new is found -- no daily "all clear" spam.
 *
 * SCHEDULING:
 *   - Run runMissedLeadsAudit(730) manually, once, for the historical sweep.
 *   - Add a trigger: runMissedLeadsAudit -> Time-driven -> Weekly (Sunday),
 *     for ongoing coverage (uses the 14-day default lookback, so a weekly
 *     cadence still leaves no gap). MOVED off daily (22 Aug 2026, per direct
 *     request) -- maildoso outreach only sends weekdays, so this was burning
 *     Gmail quota daily competing with runReplyDrafter/runLeadFollowUpCycle
 *     for the same account-wide budget with no daily-outreach reason to.
 *     Its own dedup (alreadyLogged, by Thread ID) already makes runs
 *     cumulative, so nothing is lost by checking weekly instead of daily.
 */

// FIX (27 Aug 2026, real risk found in review, verified by execution): \b
// only creates a boundary against non-word characters. Two failure
// directions confirmed live: `no-?reply` requires a literal hyphen or
// nothing at all, so `no_reply@x.com` and `no.reply@x.com` (both real
// separator conventions) slipped through as human; and \b fails between a
// letter and a following digit (both are word characters), so
// `noreply2@x.com` also slipped through. In the other direction,
// `dan.hunnicutt+noreply@compass.com` -- a real human's OWN plus-tag, not an
// automated mailbox -- matched and was dropped as a bot.
//
// Fixed by testing only the CANONICAL local part (before any `+tag`, since
// a plus-tag is the sender's own routing label and shouldn't affect
// classification of the underlying mailbox) and widening the separator
// class to `[-._]` with no reliance on \b at all.
function isNonHumanSender(email) {
  const raw = String(email || '').toLowerCase();
  const at = raw.indexOf('@');
  const localPart = at === -1 ? raw : raw.slice(0, at);
  const canonical = localPart.split('+')[0];
  return NON_HUMAN_SENDER_PATTERNS.test(canonical);
}

const NON_HUMAN_SENDER_PATTERNS = /(^|[^a-z0-9])(no[-._]?reply|do[-._]?not[-._]?reply|mailer[-._]?daemon|postmaster|catch[-._]?all|automated|autoreply|bounces?)/i;

// FIX (27 Aug 2026): this used to be its own copy of Code.gs's
// AUTOREPLY_PATTERNS, tested against the full quoted body (see the fix at
// the call site below) -- both problems Code.gs's looksLikeAutoReplyBody_
// was written to fix are shared, so reuse that function directly instead of
// keeping a second, drifting copy of the same regex in sync by hand.

// WEEKEND DEEP AUDIT (11 Aug 2026): same tested logic and dedup as above,
// just with a months-long lookback instead of the daily 14-day one. Shares
// the same "Missed Leads Audit" tab and the same alreadyLogged dedup Set --
// meaning anything the daily check already caught and logged will NOT be
// re-flagged here, and anything this catches won't be re-flagged by the
// daily check either. This only exists to reach further back (up to 6
// months) than the daily job ever gets a chance to look, on a weekly
// schedule instead of daily, since deep history scans are heavier.
function runWeekendDeepMissedLeadsAudit() {
  runMissedLeadsAudit(180);
}

function runMissedLeadsAudit(daysBack) {
  // ADDED (17 Aug 2026, real incident): confirmed live that a different
  // account than Joana's has its own trigger firing this function -- see
  // assertRunningAsJoana() in lead_followup_sequences.gs. Also covers
  // runWeekendDeepMissedLeadsAudit, which just calls this with a longer
  // lookback.
  if (!assertRunningAsJoana('runMissedLeadsAudit')) return;

  const lookback = daysBack || 14;

  // ADDED (20 Aug 2026, real incident): this calls GmailApp.search() but
  // never checked the quota circuit breaker -- only runReplyDrafter did.
  // Same gap as runLearningLoop; see that fix for the full incident.
  if (isGmailQuotaExhausted()) {
    Logger.log('Skipping runMissedLeadsAudit -- Gmail quota already known exhausted today, ' + timeUntilQuotaResetDescription_() + '.');
    return;
  }

  try {
  if (!CONFIG.SPREADSHEET_ID || CONFIG.SPREADSHEET_ID === 'PASTE_YOUR_SHEET_ID_HERE') {
    Logger.log('CONFIG.SPREADSHEET_ID not set -- skipping missed leads audit.');
    return;
  }

  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  let auditTab = ss.getSheetByName('Missed Leads Audit');
  if (!auditTab) {
    auditTab = ss.insertSheet('Missed Leads Audit');
    auditTab.appendRow(['Found At', 'Thread ID', 'Subject', 'Prospect Email', 'Last Message Date', 'Days Unanswered', 'Thread Link']);
  }

  const alreadyLogged = new Set(
    auditTab.getDataRange().getValues().slice(1).map(row => row[1])
  );

  const addressClauses = CONFIG.REQUIRED_CC_ADDRESSES
    .map(addr => 'to:"' + addr + '" OR cc:"' + addr + '"')
    .join(' OR ');
  const query = '(' + addressClauses + ') newer_than:' + lookback + 'd';

  // FIX (30 Aug 2026, real incident -- the 500-ceiling warning below fired
  // for real): a single GmailApp.search(query, 0, 500) call was a hard
  // 500-thread ceiling with no pagination, so the 180-day deep audit
  // silently never examined anything past the first 500. Now paginates the
  // same way Code.gs's runReplyDrafterInner does -- keep pulling pages via
  // the search start offset until a page comes back short (the real end of
  // results) or a wall-clock budget is hit, bounded so a run that legitimately
  // needs many pages stops cleanly instead of getting killed mid-run by
  // Apps Script's 6-minute hard limit. Read-only audit, so there's no
  // draft-cap-style reason to stop early otherwise -- pages just accumulate.
  const AUDIT_RUNTIME_BUDGET_MS = 5 * 60 * 1000; // 5 min, leaving a 1-min buffer before the 6-min hard limit
  const auditRunStartTime = Date.now();
  const AUDIT_PAGE_SIZE = 500; // GmailApp.search's own hard per-call max
  const threads = [];
  let auditPageStart = 0;
  let truncated = false;
  while (true) {
    const page = GmailApp.search(query, auditPageStart, AUDIT_PAGE_SIZE);
    Logger.log('DIAGNOSTIC -- missed leads audit fetched page starting at ' + auditPageStart + ': ' + page.length + ' threads');
    threads.push.apply(threads, page);
    if (page.length < AUDIT_PAGE_SIZE) break; // short page -- reached the real end of results
    auditPageStart += AUDIT_PAGE_SIZE;
    if (Date.now() - auditRunStartTime > AUDIT_RUNTIME_BUDGET_MS) {
      Logger.log('Missed leads audit approaching Apps Script\'s execution time limit -- stopping pagination early so this run completes cleanly. Older threads within the ' + lookback + '-day window were NOT examined this run.');
      truncated = true;
      break;
    }
  }
  if (truncated) {
    sendOpsAlert('Missed leads audit stopped early (time budget)',
      'runMissedLeadsAudit(' + lookback + ') paginated through ' + threads.length + ' thread(s) but hit its ' + (AUDIT_RUNTIME_BUDGET_MS / 60000) + '-minute time budget before finishing the ' + lookback + '-day window. Older threads were not examined this run -- if this recurs, the lookback window may need to be split into more frequent, shorter runs.');
  }

  // FIX (30 Aug 2026, real risk found in code review): this list had drifted
  // from Code.gs's actual permanent-skip label set (SELF_OWNED_TRACKING_LABELS /
  // the labels list at line ~553), missing LABEL_NEEDS_ROUTING,
  // LABEL_ALREADY_ANSWERED_BY_TEAM, LABEL_SUBJECT_MISMATCH,
  // LABEL_ALREADY_REPLIED_ONCE, and LABEL_SUPPRESSED_NO_DRAFT. Any thread
  // carrying one of those was NOT recognized as already-tracked here, so it
  // fell through to the expensive recordGmailQuotaUsage_(1) + getMessages()
  // path on every single audit run (now daily, plus the 180-day weekend deep
  // audit) forever -- burning the same self-tracked Gmail quota budget this
  // project has had real exhaustion incidents around, for zero benefit since
  // these threads are correctly re-classified as opt-out/auto-reply/etc and
  // never logged anyway.
  const trackingLabels = [
    CONFIG.LABEL_AI_DRAFTED,
    CONFIG.LABEL_YES,
    CONFIG.LABEL_YES_PENCILED,
    CONFIG.LABEL_NO,
    CONFIG.LABEL_STOP,
    CONFIG.LABEL_NEEDS_ROUTING,
    CONFIG.LABEL_ALREADY_ANSWERED_BY_TEAM,
    CONFIG.LABEL_SUBJECT_MISMATCH,
    CONFIG.LABEL_ALREADY_REPLIED_ONCE,
    CONFIG.LABEL_SUPPRESSED_NO_DRAFT
  ];

  const missed = [];
  let skippedTracked = 0, skippedNoCc = 0, skippedInternal = 0, skippedNonHuman = 0, skippedOptOut = 0, skippedAutoReply = 0;

  threads.forEach(thread => {
    const threadId = thread.getId();
    if (alreadyLogged.has(threadId)) return;

    const hasTrackingLabel = thread.getLabels().some(l => trackingLabels.indexOf(l.getName()) !== -1);
    if (hasTrackingLabel) {
      Logger.log('DIAGNOSTIC -- audit skipped ' + threadId + ' (already carries a tracking label)');
      skippedTracked++;
      return;
    }

    // SELF-TRACKED QUOTA COUNTER (22 Aug 2026, per direct request): see the
    // fuller comment in quota_guard_and_alerting.gs.
    recordGmailQuotaUsage_(1);
    const messages = thread.getMessages();
    const last = messages[messages.length - 1];

    // FIX (26 Aug 2026, same real incident as Code.gs's runReplyDrafterInner):
    // checking only the LAST message for the network CC missed most real
    // threads, since a lead's own reply (or a later message from Joana not
    // routed back through the network@ mailing-list address) won't
    // individually carry it. Checking the whole thread still excludes
    // anything network@ never touched at all.
    if (!isCcdToNetworkGroupAnywhereInThread(messages)) {
      Logger.log('DIAGNOSTIC -- audit skipped ' + threadId + ' (network never CC-d anywhere in this thread)');
      skippedNoCc++;
      return;
    }

    let lastSender = extractEmail(last.getFrom());
    if (isInternal(lastSender)) {
      Logger.log('DIAGNOSTIC -- audit skipped ' + threadId + ' (last sender ' + lastSender + ' is internal -- already answered)');
      skippedInternal++;
      return;
    }

    // FIX (27 Aug 2026, same incident as Code.gs's FORWARDING_ALIAS_DOMAINS):
    // on a Maildoso-forwarded thread the last message's From is the sending
    // alias, not the lead. This audit was reporting the alias as the
    // "Prospect Email" -- an address nobody can act on, and one that already
    // caused a real bounce when a teammate replied to it. Resolve the real
    // lead out of the forwarded body instead. A thread we can't resolve is
    // still a genuine miss (a lead replied and nobody answered), so it is
    // reported rather than dropped -- just flagged so the row is actionable.
    if (isForwardingAlias(lastSender)) {
      const forwardInfo = extractForwardedLeadInfo(last);
      lastSender = (forwardInfo && forwardInfo.email) ? forwardInfo.email : lastSender + ' (UNRESOLVED -- forwarding alias, real lead is inside the thread)';
    }

    if (isNonHumanSender(lastSender)) {
      Logger.log('DIAGNOSTIC -- audit skipped ' + threadId + ' (last sender ' + lastSender + ' looks like a bounce/system address)');
      skippedNonHuman++;
      return;
    }

    // FIX (27 Aug 2026, real risk found in review): this used to test
    // last.getPlainBody() -- the WHOLE message including every quoted layer
    // beneath the lead's reply, i.e. the entire cold-outreach chain. Every
    // other consumer of these patterns tests extractProspectFreshReplyText()
    // instead, specifically to avoid matching boilerplate elsewhere in the
    // thread -- this audit, whose entire job is proving nothing was missed,
    // was the one place that didn't, so a lead replying "Sure, what's
    // involved?" to an outreach email whose OWN footer said "reply STOP to
    // unsubscribe" was silently and permanently dropped from the audit.
    const freshReply = extractProspectFreshReplyText(last);
    if (OPT_OUT_PATTERNS.test(freshReply)) {
      Logger.log('DIAGNOSTIC -- audit skipped ' + threadId + ' (opt-out language in fresh reply)');
      skippedOptOut++;
      return;
    }
    if (looksLikeAutoReplyBody_(freshReply) || AUTOREPLY_SUBJECT_PATTERNS.test(last.getSubject())) {
      Logger.log('DIAGNOSTIC -- audit skipped ' + threadId + ' (bounce/auto-reply language)');
      skippedAutoReply++;
      return;
    }

    const daysUnanswered = Math.floor((Date.now() - last.getDate().getTime()) / (1000 * 60 * 60 * 24));

    missed.push({
      threadId: threadId,
      subject: thread.getFirstMessageSubject(),
      prospectEmail: lastSender,
      lastMessageDate: last.getDate(),
      daysUnanswered: daysUnanswered,
      link: 'https://mail.google.com/mail/u/0/#all/' + threadId
    });
  });

  missed.forEach(m => {
    auditTab.appendRow([new Date(), m.threadId, m.subject, m.prospectEmail, m.lastMessageDate, m.daysUnanswered, m.link]);
  });

  if (missed.length > 0) {
    emailMissedLeadsAlert(missed);
  }

  Logger.log('Missed leads audit complete. Lookback: ' + lookback + ' days. New misses found: ' + missed.length +
    '. Skipped -- already tracked: ' + skippedTracked + ', no network CC: ' + skippedNoCc +
    ', already answered (internal): ' + skippedInternal + ', non-human sender: ' + skippedNonHuman +
    ', opt-out: ' + skippedOptOut + ', auto-reply/bounce: ' + skippedAutoReply +
    ', already logged (dedup): ' + (threads.length - skippedTracked - skippedNoCc - skippedInternal - skippedNonHuman - skippedOptOut - skippedAutoReply - missed.length) + '.');
  } catch (e) {
    // FIX (27 Aug 2026, real risk found in review): no path here could ever
    // trip the Gmail quota circuit breaker -- see handleGmailJobError_.
    handleGmailJobError_('runMissedLeadsAudit', e);
  }
}

function emailMissedLeadsAlert(missed) {
  const subject = '[Written by Claude] ' + missed.length + ' podcast outreach ' + (missed.length === 1 ? 'reply' : 'replies') + ' with no response yet';
  const lines = missed
    .map(m => '- "' + m.subject + '" (' + m.prospectEmail + ') -- ' + m.daysUnanswered + ' days unanswered: ' + m.link)
    .join('\n');
  const body =
    'This email was written by Claude.\n\n' +
    'Found ' + missed.length + ' thread(s) where a prospect replied to the podcast outreach and nobody on the team has responded to yet:\n\n' +
    lines +
    '\n\nThese are logged in the "Missed Leads Audit" tab in the "Icons Podcast Reply Drafter -- Logs" spreadsheet.\n\n' +
    'Worth a manual look -- these are old enough or unusual enough that they fell outside the automatic drafting flow.';

  // ADDED (27 Aug 2026, per direct request -- "fix all emails"): same
  // treatment as bounce_audit.gs's htmlBody -- a bordered card per lead
  // instead of a plain dash-list, the thread link made actually clickable,
  // and days-unanswered color-coded so the oldest, most overdue ones stand
  // out at a glance instead of requiring reading every line to find them.
  const severityColor = days => days >= 7 ? '#c0392b' : (days >= 3 ? '#e08e0b' : '#555555');
  const htmlCards = missed.map(m =>
    '<div style="margin:0 0 12px 0; padding:12px 16px; border:1px solid #e0e0e0; border-left:4px solid ' + severityColor(m.daysUnanswered) + '; border-radius:6px;">' +
      '<div style="font-weight:bold; margin-bottom:6px;">' + escapeHtml(m.subject) + '</div>' +
      '<div style="line-height:1.8;">' +
        '<b>Lead:</b> <a href="mailto:' + escapeHtml(m.prospectEmail) + '">' + escapeHtml(m.prospectEmail) + '</a><br>' +
        '<b>Unanswered:</b> <span style="color:' + severityColor(m.daysUnanswered) + '; font-weight:bold;">' + m.daysUnanswered + ' day' + (m.daysUnanswered === 1 ? '' : 's') + '</span><br>' +
        '<b>Thread:</b> <a href="' + m.link + '" style="color:#2E74B5;">Open thread</a>' +
      '</div>' +
    '</div>'
  ).join('');

  const htmlBody =
    '<div style="font-family:Arial,sans-serif; font-size:14px; color:#222;">' +
      '<p>This email was written by Claude.</p>' +
      '<h2 style="margin:0 0 10px 0; font-size:18px; color:#1a2b4c;">' +
        missed.length + ' podcast outreach ' + (missed.length === 1 ? 'reply' : 'replies') + ' with no response yet' +
      '</h2>' +
      '<p>Found ' + missed.length + ' thread(s) where a prospect replied to the podcast outreach and nobody on the team has responded to yet:</p>' +
      '<hr style="border:none; border-top:1px solid #ccc; margin:16px 0;">' +
      htmlCards +
      '<hr style="border:none; border-top:1px solid #ccc; margin:16px 0;">' +
      '<p style="color:#555555; font-size:13px;">These are logged in the &ldquo;Missed Leads Audit&rdquo; tab in the ' +
        '<a href="https://docs.google.com/spreadsheets/d/' + CONFIG.SPREADSHEET_ID + '/edit">Icons Podcast Reply Drafter &mdash; Logs</a> spreadsheet.</p>' +
      '<p style="color:#555555; font-size:13px;">Worth a manual look &mdash; these are old enough or unusual enough that they fell outside the automatic drafting flow.</p>' +
    '</div>';

  // CHANGED (23 Aug 2026, per direct request -- "all emails need to be CC
  // kris & Tomas"): added Tomas to cc.
  MailApp.sendEmail({
    to: 'kris@iconsofrealestate.com',
    cc: 'joana@iconsofrealestate.com,tomas@iconsofrealestate.com',
    subject: subject,
    body: body,
    htmlBody: htmlBody
  });
}
