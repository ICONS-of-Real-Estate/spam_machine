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

const NON_HUMAN_SENDER_PATTERNS = /\b(no-?reply|donotreply|do-not-reply|mailer-daemon|postmaster|catch-all|catchall|automated|autoreply)\b/i;

function isNonHumanSender(email) {
  return NON_HUMAN_SENDER_PATTERNS.test(email);
}

// Kept in sync with AUTOREPLY_PATTERNS in Code.gs (extended 17 Aug 2026 to
// also catch a real person saying their email is no longer used/reachable --
// same suppression intent as a true bounce/auto-reply, since nobody reads a
// reply sent to an address they've said they don't check. Broadened same-day
// from an order-specific phrase to a general "no longer
// reached/used/valid/active/monitored/using" match after "I can no longer be
// reached at this email" slipped through the narrower version.)
const BOUNCE_OR_AUTOREPLY_PATTERNS = /(mailbox that is not actively monitored|does not correspond to a valid address|delivery (has |)failed|undeliverable|out of (the |)office|automatic reply|auto-reply|this is an automated|no longer (be |)(reach(ed|able)|used?|valid|active|monitored|using)|do not (send|reply|use) to this email|please use (my |the |a )?(new|updated) email)/i;

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
  const threads = GmailApp.search(query, 0, 500);

  const trackingLabels = [
    CONFIG.LABEL_AI_DRAFTED,
    CONFIG.LABEL_YES,
    CONFIG.LABEL_YES_PENCILED,
    CONFIG.LABEL_NO,
    CONFIG.LABEL_STOP
  ];

  const missed = [];

  threads.forEach(thread => {
    const threadId = thread.getId();
    if (alreadyLogged.has(threadId)) return;

    const hasTrackingLabel = thread.getLabels().some(l => trackingLabels.indexOf(l.getName()) !== -1);
    if (hasTrackingLabel) return;

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
    if (!isCcdToNetworkGroupAnywhereInThread(messages)) return;

    let lastSender = extractEmail(last.getFrom());
    if (isInternal(lastSender)) return;

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

    if (isNonHumanSender(lastSender)) return;

    const body = last.getPlainBody();
    if (OPT_OUT_PATTERNS.test(body)) return;
    if (BOUNCE_OR_AUTOREPLY_PATTERNS.test(body)) return;

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

  Logger.log('Missed leads audit complete. Lookback: ' + lookback + ' days. New misses found: ' + missed.length);
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

  // CHANGED (23 Aug 2026, per direct request -- "all emails need to be CC
  // kris & Tomas"): added Tomas to cc.
  MailApp.sendEmail({
    to: 'kris@iconsofrealestate.com',
    cc: 'joana@iconsofrealestate.com,tomas@iconsofrealestate.com',
    subject: subject,
    body: body
  });
}
