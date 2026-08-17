/**
 * ICONS OF REAL ESTATE — Stalled Bookings Audit (companion file, same
 * project as Code.gs/lead_followup_sequences.gs/missed_leads_audit.gs --
 * shares CONFIG and helper functions)
 * ---------------------------------------------------------------------------
 * Task 2 from the original handoff. Answers: is there a lead who got as far
 * as "penciled in a call time" or "handed off to Sean/Bens for a
 * qualification call," but then just went quiet with nobody following up?
 *
 * SOURCE: "AI Drafts Log" rows where category = 'yes_penciled' OR
 * needsTeammateRouting = true. The "Bens Call List" tab is deliberately NOT
 * used as a source here -- it's only populated by advanceHubGuestFollowUps()
 * in lead_followup_sequences.gs, which is currently paused
 * (HUB_GUEST_FOLLOWUPS_ENABLED = false), so it isn't a reliable signal of
 * what's actually in flight right now.
 *
 * "Stalled" = the underlying Gmail thread's actual last real message
 * (ignoring unsent drafts, via lastNonDraftMessage_() in Code.gs) is older
 * than STALLED_DAYS_THRESHOLD days. Dedup by Thread ID against the audit
 * tab itself, same pattern as missed_leads_audit.gs, so a flagged lead
 * doesn't get re-logged (or re-emailed) every time this runs.
 *
 * KNOWN LIMITATION (same shape as missed_leads_audit.gs's own documented
 * one): if the booking actually happened through a channel outside Gmail
 * (phone call, Zoom chat, in person), this has no way to know that and will
 * keep treating the thread as stalled. Not silently worked around here --
 * if that turns out to matter in practice, the fix is a manual way to mark
 * a specific row resolved (e.g. a Status column a human sets), not
 * something to guess at without seeing how often it actually happens.
 *
 * Findings go to a "Stalled Bookings Audit" tab (auto-created). Emails
 * Kris + Joana ONLY when something NEW is found -- no daily "all clear."
 *
 * NOT WIRED TO A TRIGGER. Run manually (runStalledBookingsAudit()) for now
 * -- add to setupAllTriggers() once draft quality is proven out.
 */

const STALLED_BOOKINGS_TAB = 'Stalled Bookings Audit';
const STALLED_DAYS_THRESHOLD = 7;

function runStalledBookingsAudit(daysThresholdOverride) {
  if (!assertRunningAsJoana('runStalledBookingsAudit')) return;

  const threshold = daysThresholdOverride || STALLED_DAYS_THRESHOLD;

  if (!CONFIG.SPREADSHEET_ID || CONFIG.SPREADSHEET_ID === 'PASTE_YOUR_SHEET_ID_HERE') {
    Logger.log('CONFIG.SPREADSHEET_ID not set -- skipping stalled bookings audit.');
    return;
  }

  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const draftsTab = ss.getSheetByName('AI Drafts Log');
  if (!draftsTab) {
    Logger.log('runStalledBookingsAudit -- "AI Drafts Log" tab not found, nothing to audit yet.');
    return;
  }

  let auditTab = ss.getSheetByName(STALLED_BOOKINGS_TAB);
  if (!auditTab) {
    auditTab = ss.insertSheet(STALLED_BOOKINGS_TAB);
    auditTab.appendRow(['Flagged At', 'Thread ID', 'Prospect Email', 'Subject', 'Category', 'Needs Teammate Routing', 'Last Activity Date', 'Days Stalled', 'Thread Link']);
  }

  const alreadyFlagged = new Set(
    auditTab.getDataRange().getValues().slice(1).map(row => row[1]) // Thread ID column
  );

  const rows = draftsTab.getDataRange().getValues();
  const headers = rows[0];
  const threadIdCol = headers.indexOf('Thread ID');
  const subjectCol = headers.indexOf('Subject');
  const emailCol = headers.indexOf('Prospect Email');
  const categoryCol = headers.indexOf('Category');
  const routingCol = headers.indexOf('Needs Teammate Routing');

  const stalled = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const threadId = row[threadIdCol];
    if (!threadId || alreadyFlagged.has(threadId)) continue;

    const category = row[categoryCol];
    const needsRouting = row[routingCol] === true || String(row[routingCol]).toLowerCase() === 'true';
    const looksLikeABooking = category === 'yes_penciled' || needsRouting;
    if (!looksLikeABooking) continue;

    let thread;
    try {
      thread = GmailApp.getThreadById(threadId);
    } catch (e) {
      continue; // thread may have been deleted
    }
    if (!thread) continue;

    const messages = thread.getMessages();
    const lastReal = lastNonDraftMessage_(messages) || messages[messages.length - 1];
    const daysSinceLastActivity = Math.floor((Date.now() - lastReal.getDate().getTime()) / (1000 * 60 * 60 * 24));

    if (daysSinceLastActivity < threshold) continue;

    stalled.push({
      threadId: threadId,
      email: row[emailCol],
      subject: row[subjectCol],
      category: category,
      needsRouting: needsRouting,
      lastActivityDate: lastReal.getDate(),
      daysStalled: daysSinceLastActivity,
      link: 'https://mail.google.com/mail/u/0/#all/' + threadId
    });
  }

  stalled.forEach(s => {
    auditTab.appendRow([new Date(), s.threadId, s.email, s.subject, s.category, s.needsRouting, s.lastActivityDate, s.daysStalled, s.link]);
  });

  if (stalled.length > 0) {
    emailStalledBookingsAlert(stalled, threshold);
  }

  Logger.log('Stalled bookings audit complete. Threshold: ' + threshold + ' days. New stalls found: ' + stalled.length);
}

// Direct MailApp.sendEmail (not sendOpsAlert) -- same choice
// missed_leads_audit.gs's emailMissedLeadsAlert() makes, and for the same
// reason: dedup already happens at the data layer (alreadyFlagged, checked
// against the audit tab itself), so a second rate-limit keyed on the
// subject line -- which includes a variable count and would basically
// never repeat verbatim -- wouldn't actually rate-limit anything
// meaningful, just add an inconsistent extra layer.
function emailStalledBookingsAlert(stalled, threshold) {
  const subject = '[Written by Claude] ' + stalled.length + ' potential booking' + (stalled.length === 1 ? '' : 's') + ' gone quiet (' + threshold + '+ days)';
  const lines = stalled
    .map(s => '- "' + s.subject + '" (' + s.email + ') -- category: ' + s.category + (s.needsRouting ? ', handed to teammate' : '') + ', ' + s.daysStalled + ' days since last activity: ' + s.link)
    .join('\n');
  const body =
    'This email was written by Claude.\n\n' +
    'Found ' + stalled.length + ' lead(s) that got as far as penciling in a call or being handed to a teammate, but have gone quiet for ' + threshold + '+ days:\n\n' +
    lines +
    '\n\nThese are logged in the "' + STALLED_BOOKINGS_TAB + '" tab. Worth a manual check -- these might just be waiting on a call that already happened outside email, or might genuinely need a nudge.';

  MailApp.sendEmail({
    to: 'kris@iconsofrealestate.com',
    cc: 'joana@iconsofrealestate.com',
    subject: subject,
    body: body
  });
}
