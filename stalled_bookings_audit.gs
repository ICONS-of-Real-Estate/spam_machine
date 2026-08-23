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
 * keep treating the thread as stalled. Partially addressed (23 Aug 2026,
 * per direct request): the audit tab has a Status column a human sets
 * (dead / booked_elsewhere / following_up) -- see STATUS_COL_HEADER below.
 * Nothing in code reads this back yet; it's Joana's own tracking for now,
 * not (yet) a machine-read suppression flag.
 *
 * Findings go to a "Stalled Bookings Audit" tab (auto-created), grouped in
 * the email by whether the lead-followup-sequences.gs Podcast Sales queue
 * already has a follow-up drafted/pending for it, or nothing at all (every
 * yes_penciled lead -- that cadence only covers yes_general handed to a
 * teammate). Emails Kris + Joana + Tomas ONLY when something NEW is found
 * -- no daily "all clear."
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

  // ADDED (23 Aug 2026, per direct request -- "Needs more logging"):
  // confirmed live that a manual run went completely silent between the
  // opening assertRunningAsJoana() log line and "Execution cancelled" 21
  // seconds later, with nothing in between to show what it was doing --
  // this loop does a live GmailApp.getThreadById() + getMessages() call
  // per matching row, so a large "AI Drafts Log" with many penciled/routed
  // rows can spend real time here with zero visibility. Logging every
  // stage now so a slow or stuck run actually shows where it is.
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const draftsTab = ss.getSheetByName('AI Drafts Log');
  if (!draftsTab) {
    Logger.log('runStalledBookingsAudit -- "AI Drafts Log" tab not found, nothing to audit yet.');
    return;
  }

  // ADDED (23 Aug 2026, per direct request -- "How can Joana mark them as a
  // dead lead?"): a Status column a human sets, exactly as anticipated in
  // this file's own header comment above. Blank = unreviewed; Joana types
  // 'dead', 'booked_elsewhere', or 'following_up' directly into this
  // column on the row for that lead. Nothing in code currently reads this
  // back (see note on emailStalledBookingsAlert for why: this audit only
  // ever flags a given thread ONCE, ever, via alreadyFlagged below, so
  // there's no recurring nag to suppress -- this column is Joana's own
  // tracking, not a machine-read flag yet).
  const STATUS_COL_HEADER = 'Status (dead / booked_elsewhere / following_up / blank = unreviewed)';

  let auditTab = ss.getSheetByName(STALLED_BOOKINGS_TAB);
  if (!auditTab) {
    auditTab = ss.insertSheet(STALLED_BOOKINGS_TAB);
    auditTab.appendRow(['Flagged At', 'Thread ID', 'Prospect Email', 'Subject', 'Category', 'Needs Teammate Routing', 'Last Activity Date', 'Days Stalled', 'Thread Link', STATUS_COL_HEADER]);
    Logger.log('runStalledBookingsAudit -- created "' + STALLED_BOOKINGS_TAB + '" tab (first run).');
  } else if (auditTab.getLastColumn() < 10 || String(auditTab.getRange(1, 10).getValue()).indexOf('Status') !== 0) {
    // MIGRATION: tab already existed from before this column was added.
    auditTab.getRange(1, 10).setValue(STATUS_COL_HEADER);
    Logger.log('runStalledBookingsAudit -- added missing Status column to existing "' + STALLED_BOOKINGS_TAB + '" tab.');
  }

  const alreadyFlagged = new Set(
    auditTab.getDataRange().getValues().slice(1).map(row => row[1]) // Thread ID column
  );
  Logger.log('runStalledBookingsAudit -- ' + alreadyFlagged.size + ' thread(s) already flagged in a previous run, will be skipped.');

  // ADDED (23 Aug 2026, per direct request -- separate "draft waiting for
  // send" from "draft pending"): cross-reference each stalled thread
  // against the Podcast Sales Follow-Up Queue (lead_followup_sequences.gs)
  // by Thread ID, so the email can tell Joana which of these already have
  // an automated follow-up in flight vs. which have NONE at all (every
  // yes_penciled lead -- that cadence only covers yes_general handed to a
  // teammate; see this file's header comment).
  const followUpQueueStatusByThreadId = {};
  const salesQueueTab = ss.getSheetByName(PODCAST_SALES_QUEUE_TAB);
  if (salesQueueTab) {
    salesQueueTab.getDataRange().getValues().slice(1).forEach(r => {
      if (r[0]) followUpQueueStatusByThreadId[r[0]] = String(r[6] || '');
    });
    Logger.log('runStalledBookingsAudit -- loaded ' + Object.keys(followUpQueueStatusByThreadId).length + ' row(s) from "' + PODCAST_SALES_QUEUE_TAB + '" for cross-reference.');
  } else {
    Logger.log('runStalledBookingsAudit -- "' + PODCAST_SALES_QUEUE_TAB + '" tab not found, cannot cross-reference follow-up status.');
  }

  // Maps a queue Status value (or its absence) to a human bucket for the
  // email. See lead_followup_sequences.gs for the Status values this
  // queue actually uses (AWAITING_STEP_N_APPROVAL, AWAITING_STEP_N_SCHEDULE,
  // HELD, STOPPED, COMPLETE).
  function classifyFollowUpBucket_(queueStatus) {
    if (!queueStatus) return 'NO_AUTOMATED_FOLLOWUP';
    if (queueStatus.indexOf('_APPROVAL') !== -1) return 'DRAFT_WAITING_FOR_SEND';
    if (queueStatus.indexOf('_SCHEDULE') !== -1 || queueStatus === 'HELD') return 'DRAFT_PENDING';
    if (queueStatus === 'STOPPED' || queueStatus === 'COMPLETE') return 'FOLLOWUP_STOPPED_OR_COMPLETE';
    return 'NO_AUTOMATED_FOLLOWUP';
  }

  const rows = draftsTab.getDataRange().getValues();
  const headers = rows[0];
  const threadIdCol = headers.indexOf('Thread ID');
  const subjectCol = headers.indexOf('Subject');
  const emailCol = headers.indexOf('Prospect Email');
  const categoryCol = headers.indexOf('Category');
  const routingCol = headers.indexOf('Needs Teammate Routing');

  Logger.log('runStalledBookingsAudit -- scanning ' + (rows.length - 1) + ' row(s) in "AI Drafts Log" for penciled/routed leads, threshold ' + threshold + ' days.');

  const stalled = [];
  let candidateCount = 0;
  let threadFetchFailures = 0;

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const threadId = row[threadIdCol];
    if (!threadId || alreadyFlagged.has(threadId)) continue;

    const category = row[categoryCol];
    const needsRouting = row[routingCol] === true || String(row[routingCol]).toLowerCase() === 'true';
    const looksLikeABooking = category === 'yes_penciled' || needsRouting;
    if (!looksLikeABooking) continue;

    candidateCount++;
    // Progress marker every 20 live Gmail lookups -- this is the part that
    // actually makes network calls, so it's the part that can go quiet.
    if (candidateCount % 20 === 0) {
      Logger.log('runStalledBookingsAudit -- still checking Gmail threads: ' + candidateCount + ' candidate(s) looked up so far (row ' + (i + 1) + ' of ' + rows.length + ').');
    }

    let thread;
    try {
      thread = GmailApp.getThreadById(threadId);
    } catch (e) {
      threadFetchFailures++;
      Logger.log('runStalledBookingsAudit -- could not load thread ' + threadId + ' (' + row[emailCol] + ') -- likely deleted, skipping: ' + e);
      continue;
    }
    if (!thread) {
      threadFetchFailures++;
      Logger.log('runStalledBookingsAudit -- thread ' + threadId + ' (' + row[emailCol] + ') returned null, skipping.');
      continue;
    }

    const messages = thread.getMessages();
    const lastReal = lastNonDraftMessage_(messages) || messages[messages.length - 1];
    const daysSinceLastActivity = Math.floor((Date.now() - lastReal.getDate().getTime()) / (1000 * 60 * 60 * 24));

    if (daysSinceLastActivity < threshold) continue;

    // FIXED (23 Aug 2026, real incident): confirmed live -- this was
    // displaying row[emailCol] (the stored "Prospect Email" column)
    // directly, which CLAUDE.md already documents as ~27% poisoned. Real
    // output: dozens of rows showed 'network@ardorseo.com' (the internal
    // routing alias, not a lead) as the "prospect", and several showed
    // spoofed lookalike domains impersonating Joana/Kris (dronezilla.site,
    // iconsrealestatepro.com/.site, iconsofrealestateadmin.com). Every
    // other Gmail-touching file in this project re-derives the real lead
    // email via extractForwardedLeadInfo() instead of trusting that
    // column -- this one didn't. Same fallback pattern as
    // learning_loop.gs: log if it couldn't be resolved rather than reject
    // the row outright (a booking that's genuinely stalled is still worth
    // flagging even if the email itself can't be re-derived cleanly).
    let realEmail = row[emailCol];
    try {
      const forwardInfo = extractForwardedLeadInfo(messages[0]);
      if (forwardInfo && forwardInfo.email) {
        if (forwardInfo.email !== String(row[emailCol]).toLowerCase()) {
          Logger.log('runStalledBookingsAudit -- ' + threadId + ': stored Prospect Email (' + row[emailCol] + ') differs from re-derived lead email (' + forwardInfo.email + ') -- using the re-derived one.');
        }
        realEmail = forwardInfo.email;
      } else {
        Logger.log('runStalledBookingsAudit -- ' + threadId + ': could not re-derive lead email, falling back to stored Prospect Email (' + row[emailCol] + ') -- may be poisoned.');
      }
    } catch (e) {
      Logger.log('runStalledBookingsAudit -- ' + threadId + ': extractForwardedLeadInfo() threw, falling back to stored Prospect Email (' + row[emailCol] + '): ' + e);
    }

    const followUpBucket = classifyFollowUpBucket_(followUpQueueStatusByThreadId[threadId]);

    Logger.log('runStalledBookingsAudit -- FLAGGING ' + threadId + ' (' + realEmail + '): ' + daysSinceLastActivity + ' days since last activity, category=' + category + (needsRouting ? ', handed to teammate' : '') + ', follow-up bucket=' + followUpBucket);

    stalled.push({
      threadId: threadId,
      email: realEmail,
      subject: row[subjectCol],
      category: category,
      needsRouting: needsRouting,
      lastActivityDate: lastReal.getDate(),
      daysStalled: daysSinceLastActivity,
      link: 'https://mail.google.com/mail/u/0/#all/' + threadId,
      followUpBucket: followUpBucket
    });

    // FIXED (23 Aug 2026, real incident): confirmed live -- "AI Drafts Log"
    // has multiple rows referencing the same thread (an original reply row
    // plus follow-up rows pointing at the same Gmail thread), and
    // alreadyFlagged was only ever populated from PAST runs' audit rows, so
    // the same thread got pushed into `stalled` -- and would have been
    // written as duplicate audit rows and duplicate lines in the alert
    // email -- every time it recurred later in THIS SAME run. Mark it
    // flagged immediately so a later duplicate row for the same thread in
    // this run is skipped by the existing alreadyFlagged.has() check above.
    alreadyFlagged.add(threadId);
  }

  Logger.log('runStalledBookingsAudit -- finished scanning. ' + candidateCount + ' candidate(s) checked (' + threadFetchFailures + ' thread lookup failure(s)), ' + stalled.length + ' newly stalled.');

  stalled.forEach(s => {
    // Status column left blank -- Joana fills it in manually (see
    // STATUS_COL_HEADER above) to mark a lead dead/booked elsewhere/etc.
    auditTab.appendRow([new Date(), s.threadId, s.email, s.subject, s.category, s.needsRouting, s.lastActivityDate, s.daysStalled, s.link, '']);
  });

  if (stalled.length > 0) {
    Logger.log('runStalledBookingsAudit -- sending alert email for ' + stalled.length + ' newly stalled lead(s).');
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
// CHANGED (23 Aug 2026, per direct request -- "This is poorly formatted"):
// this was a single run-on plain-text paragraph with no visual separation
// between leads, confirmed live to be hard to read in Gmail. Sends real
// HTML now (bold labels, spacing, a clear block per lead) with a plain-text
// fallback for any client that can't render HTML. Also sorted worst-first
// (most days stalled) so the most overdue leads are the first thing seen.
// CHANGED (23 Aug 2026, per direct request -- separate "draft waiting for
// send" from "draft pending"): groups the leads into sections by
// followUpBucket_ (set in runStalledBookingsAudit()) instead of one flat
// list, so it's immediately clear which ones just need Joana to send an
// already-drafted follow-up vs. which have nothing automated in flight at
// all and need a real manual look.
const FOLLOWUP_BUCKET_ORDER = ['NO_AUTOMATED_FOLLOWUP', 'DRAFT_WAITING_FOR_SEND', 'DRAFT_PENDING', 'FOLLOWUP_STOPPED_OR_COMPLETE'];
const FOLLOWUP_BUCKET_LABELS = {
  NO_AUTOMATED_FOLLOWUP: 'No automated follow-up in flight -- needs a manual look (every yes_penciled lead falls here; that cadence only covers yes_general handed to a teammate)',
  DRAFT_WAITING_FOR_SEND: 'Draft waiting for send -- a follow-up has already been drafted, just needs review + send',
  DRAFT_PENDING: 'Draft pending -- registered in the follow-up queue, not drafted yet (queued/held)',
  FOLLOWUP_STOPPED_OR_COMPLETE: 'Follow-up already stopped/complete -- worth double-checking why this is still showing as stalled'
};

function emailStalledBookingsAlert(stalled, threshold) {
  const subject = '[Written by Claude] ' + stalled.length + ' potential booking' + (stalled.length === 1 ? '' : 's') + ' gone quiet (' + threshold + '+ days)';

  const byBucket = {};
  stalled.forEach(s => {
    const bucket = s.followUpBucket || 'NO_AUTOMATED_FOLLOWUP';
    (byBucket[bucket] = byBucket[bucket] || []).push(s);
  });
  const orderedBuckets = FOLLOWUP_BUCKET_ORDER.filter(b => byBucket[b] && byBucket[b].length > 0);

  const markDeadInstructions =
    'To mark a lead dead (no longer pursuing) or note what happened, open the "' + STALLED_BOOKINGS_TAB +
    '" tab and type into the Status column for that row -- e.g. "dead", "booked_elsewhere", or "following_up". ' +
    'That column is for your own tracking; nothing in the code reads it back yet.';

  const plainSections = orderedBuckets.map(bucket => {
    const items = byBucket[bucket].slice().sort((a, b) => b.daysStalled - a.daysStalled);
    const lines = items
      .map(s => '- "' + s.subject + '" (' + s.email + ') -- category: ' + s.category + (s.needsRouting ? ', handed to teammate' : '') + ', ' + s.daysStalled + ' days since last activity: ' + s.link)
      .join('\n');
    return FOLLOWUP_BUCKET_LABELS[bucket] + ' (' + items.length + '):\n' + lines;
  });
  const plainBody =
    'This email was written by Claude.\n\n' +
    'Found ' + stalled.length + ' lead(s) that got as far as penciling in a call or being handed to a teammate, but have gone quiet for ' + threshold + '+ days:\n\n' +
    plainSections.join('\n\n') +
    '\n\n' + markDeadInstructions;

  const htmlSections = orderedBuckets.map(bucket => {
    const items = byBucket[bucket].slice().sort((a, b) => b.daysStalled - a.daysStalled);
    const blocks = items.map(s =>
      '<div style="margin:0 0 18px 0; padding:0 0 14px 0; border-bottom:1px solid #e0e0e0;">' +
        '<div style="font-size:14px; font-weight:bold; margin-bottom:6px;">' + escapeHtml(s.subject) + '</div>' +
        '<div style="line-height:1.6;">' +
          '<b>Email:</b> ' + escapeHtml(s.email) + '<br>' +
          '<b>Category:</b> ' + escapeHtml(String(s.category)) + (s.needsRouting ? ' (handed to teammate)' : '') + '<br>' +
          '<b>Days since last activity:</b> ' + s.daysStalled + '<br>' +
          '<a href="' + s.link + '">Open thread in Gmail</a>' +
        '</div>' +
      '</div>'
    ).join('');
    return (
      '<h3 style="margin:24px 0 10px 0; font-size:15px;">' + escapeHtml(FOLLOWUP_BUCKET_LABELS[bucket]) + ' (' + items.length + ')</h3>' +
      blocks
    );
  }).join('');

  const htmlBody =
    '<div style="font-family:Arial,sans-serif; font-size:14px; color:#222;">' +
      '<p>This email was written by Claude.</p>' +
      '<p>Found <b>' + stalled.length + '</b> lead(s) that got as far as penciling in a call or being handed to a teammate, but have gone quiet for <b>' + threshold + '+ days</b>, grouped by what (if anything) is already in flight:</p>' +
      '<hr style="border:none; border-top:1px solid #ccc; margin:16px 0;">' +
      htmlSections +
      '<hr style="border:none; border-top:1px solid #ccc; margin:16px 0;">' +
      '<p style="color:#555;">These are logged in the "' + STALLED_BOOKINGS_TAB + '" tab. ' + markDeadInstructions + '</p>' +
    '</div>';

  MailApp.sendEmail({
    to: 'kris@iconsofrealestate.com',
    cc: 'joana@iconsofrealestate.com,tomas@iconsofrealestate.com',
    subject: subject,
    body: plainBody,
    htmlBody: htmlBody
  });
}
