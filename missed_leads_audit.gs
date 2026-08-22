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
 *   - Add a trigger: runMissedLeadsAudit -> Time-driven -> Day timer -> daily,
 *     for ongoing coverage (uses the 14-day default lookback).
 */

const NON_HUMAN_SENDER_PATTERNS = /\b(no-?reply|donotreply|do-not-reply|mailer-daemon|postmaster|catch-all|catchall|automated|autoreply)\b/i;

function isNonHumanSender(email) {
  return NON_HUMAN_SENDER_PATTERNS.test(email);
}

// Kept in sync with AUTOREPLY_PATTERNS in Code.gs (extended 17 Aug 2026 to
// also catch a real person saying "this email is no longer used" -- same
// suppression intent as a true bounce/auto-reply, since nobody reads a reply
// sent to an address they've said they don't check).
const BOUNCE_OR_AUTOREPLY_PATTERNS = /(mailbox that is not actively monitored|does not correspond to a valid address|delivery (has |)failed|undeliverable|out of (the |)office|automatic reply|auto-reply|this is an automated|(this |my |the )?email( address)?( is| has been|'s)? no longer (used|valid|active|in use|monitored)|do not (send|reply|use) to this email|please use (my |the |a )?(new|updated) email)/i;

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
  const lookback = daysBack || 14;

  // ADDED (20 Aug 2026, real incident): this calls GmailApp.search() but
  // never checked the quota circuit breaker -- only runReplyDrafter did.
  // Same gap as runLearningLoop; see that fix for the full incident.
  if (isGmailQuotaExhausted()) {
    Logger.log('Skipping runMissedLeadsAudit -- Gmail quota already known exhausted today.');
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

    const messages = thread.getMessages();
    const last = messages[messages.length - 1];

    if (!isCcdToNetworkGroup(last)) return;

    const lastSender = extractEmail(last.getFrom());
    if (isInternal(lastSender)) return;
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

  MailApp.sendEmail({
    to: 'kris@iconsofrealestate.com',
    cc: 'joana@iconsofrealestate.com',
    subject: subject,
    body: body
  });
}
