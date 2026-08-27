/**
 * ICONS OF REAL ESTATE — Bounce Audit (companion file, same Apps Script
 * project as Code.gs / missed_leads_audit.gs / learning_loop.gs — shares
 * their global CONFIG and helpers, so all of them must live in one project)
 * ---------------------------------------------------------------------------
 * Answers one question every time a delivery failure lands: was that message
 * even addressed to the right person?
 *
 * WHY THIS EXISTS (27 Aug 2026, per direct request from Kris — "anytime we
 * get one, check back that it was sent to correct email of the lead, if not
 * alert Joana and CC me"). A live sweep of Joana's mailbox that day found
 * FIVE replies that had been sent to one of our own Maildoso sending aliases
 * instead of to the lead, every one of them bouncing, every one of them a
 * lead who received nothing and nobody noticing:
 *
 *   a.palmer@topaustinseo.site            25 Aug  (Jennifer -- real lead was
 *                                                  officerjenny77@gmail.com)
 *   joana-peixe@scalingflowly.com         21 Aug  (Michael)
 *   joana_peixe@iconsrealestatenet.com    21 Aug  (Kathy)
 *   joana@scaleflowly.com                 25 May  (Cameron)
 *   joana@iconsofrealestatepodcasts.com   21 Aug  (twice)
 *
 * The root cause in the drafter is fixed (see CONFIG.FORWARDING_ALIAS_DOMAINS
 * and isForwardedFromSendingAlias_ in Code.gs). This file is the safety net
 * for it: bounces are the one signal that proves, after the fact and from
 * outside the drafter's own logic, that a message went somewhere useless. If
 * the misaddressing ever recurs -- through a new Maildoso domain, a hand-typed
 * address, or a bug nobody has found yet -- this catches it within a day
 * instead of in three months' worth of accumulated silence.
 *
 * WHAT IT CLASSIFIES. Every bounce falls into one of two buckets, and the
 * distinction is the entire point:
 *
 *   MISDIRECTED  -- the failed recipient is one of OUR OWN addresses (team,
 *                   sending alias, or the network list). This is a real
 *                   incident: a lead is sitting there unanswered and thinks
 *                   we ignored them. The alert names the real lead address
 *                   so somebody can just go reply.
 *
 *   DEAD ADDRESS -- the failed recipient is a genuine outside address that
 *                   no longer accepts mail (closed mailbox, typo'd domain in
 *                   the source data, e.g. cathy@gwaltneygrouo.com for
 *                   gwaltneygroup.com). Worth knowing, not an incident. These
 *                   are logged to the sheet but do NOT trigger an email --
 *                   there is nothing to fix and a daily list of dead leads is
 *                   the kind of alert people learn to ignore, which would
 *                   blunt the MISDIRECTED ones that actually matter.
 *
 * NEVER SENDS ANYTHING TO A LEAD. Consistent with this project's core
 * invariant, this file only ever reads Gmail and emails the internal team.
 *
 * SCHEDULING: runBounceAudit -> Time-driven -> Daily, 10 AM Europe/Paris
 * (wired up in setup_all_triggers.gs). Dedup is by bounce message ID against
 * its own tab, so runs are cumulative and re-running is harmless.
 */

// Caps and thresholds, per project convention -- named consts at the top of
// the file rather than magic numbers scattered through it.
const BOUNCE_AUDIT_TAB = 'Bounce Audit';
const BOUNCE_AUDIT_LOOKBACK_DAYS = 3;      // daily trigger; 3d overlap absorbs a missed run
const BOUNCE_AUDIT_MAX_THREADS = 150;
const BOUNCE_AUDIT_RUNTIME_BUDGET_MS = 4 * 60 * 1000; // 4 min, inside the ~6 min hard limit

// Gmail words its delivery failures a few different ways. Ordered most
// specific first: the DSN header is authoritative when present, the prose
// forms cover the friendlier "Address not found" / "Delivery incomplete"
// cards Gmail renders for Workspace users.
const BOUNCE_RECIPIENT_PATTERNS = [
  /Final-Recipient:\s*rfc822;\s*([^\s<>]+@[^\s<>,;]+)/i,
  // Gmail's own boilerplate consistently uses a straight apostrophe here,
  // but tolerate a curly one (U+2019) too -- cheap, and consistent with the
  // same fix applied to lead-authored text elsewhere in this project.
  /(?:wasn['’]?t|was not) delivered to\s+([^\s<>]+@[^\s<>,;]+)/i,
  /delivering your message to\s+([^\s<>]+@[^\s<>,;]+)/i,
  /Your message to\s+([^\s<>]+@[^\s<>,;]+)\s+has been blocked/i,
  /message to\s+([^\s<>]+@[^\s<>,;]+)\s+(?:has been|could not be)/i
];

function runBounceAudit() {
  // Same guard every Gmail-touching entry point in this project carries --
  // see assertRunningAsJoana() in lead_followup_sequences.gs for the real
  // incident behind it (a different account's trigger firing this project).
  if (!assertRunningAsJoana('runBounceAudit')) return;

  if (isGmailQuotaExhausted()) {
    Logger.log('Skipping runBounceAudit -- Gmail quota already known exhausted today, ' + timeUntilQuotaResetDescription_() + '.');
    return;
  }

  if (!CONFIG.SPREADSHEET_ID || CONFIG.SPREADSHEET_ID === 'PASTE_YOUR_SHEET_ID_HERE') {
    Logger.log('CONFIG.SPREADSHEET_ID not set -- skipping bounce audit.');
    return;
  }

  try {
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  let tab = ss.getSheetByName(BOUNCE_AUDIT_TAB);
  if (!tab) {
    tab = ss.insertSheet(BOUNCE_AUDIT_TAB);
    tab.appendRow(['Found At', 'Verdict', 'Bounce Message ID', 'Bounced To', 'Real Lead Address', 'Subject', 'Bounce Date', 'Thread Link']);
    Logger.log('Created "' + BOUNCE_AUDIT_TAB + '" tab.');
  }

  // Dedup by the BOUNCE message's own ID rather than the thread's: one thread
  // can legitimately accumulate several bounces over time (Gmail sends a
  // "Delay" notice and then a "Failure" notice for the same send), and each
  // is a separate fact worth recording once.
  const alreadyLogged = new Set(
    tab.getDataRange().getValues().slice(1).map(row => String(row[2]))
  );
  Logger.log('Bounce audit starting. ' + alreadyLogged.size + ' bounce(s) already logged from previous runs.');

  const query = 'from:mailer-daemon newer_than:' + BOUNCE_AUDIT_LOOKBACK_DAYS + 'd';
  Logger.log('DIAGNOSTIC -- bounce search query: ' + query);
  const threads = GmailApp.search(query, 0, BOUNCE_AUDIT_MAX_THREADS);
  Logger.log('DIAGNOSTIC -- ' + threads.length + ' thread(s) containing a delivery failure in the last ' + BOUNCE_AUDIT_LOOKBACK_DAYS + ' days.');

  const misdirected = [];
  let deadAddressCount = 0;
  let unparseableCount = 0;
  const runStartTime = Date.now();

  for (const thread of threads) {
    if (Date.now() - runStartTime > BOUNCE_AUDIT_RUNTIME_BUDGET_MS) {
      Logger.log('Approaching the execution time limit -- stopping cleanly. Remaining bounces will be picked up on the next run (dedup makes this safe).');
      break;
    }

    recordGmailQuotaUsage_(1);
    const messages = thread.getMessages();

    // Resolve the thread's real lead ONCE, from the whole thread, not from
    // the bounce message (whose body is Gmail's boilerplate, not the lead's
    // mail). Done before the per-bounce loop so several bounces on one thread
    // don't each re-walk it.
    const realLead = findRealLeadInThread_(messages);

    for (const message of messages) {
      const sender = extractEmail(message.getFrom());
      if (!isNonHumanSender(sender)) continue;      // not a bounce notification
      if (!/mailer-daemon|postmaster/i.test(sender)) continue;

      const bounceId = message.getId();
      if (alreadyLogged.has(bounceId)) continue;

      const bouncedTo = extractBouncedRecipient_(message);
      if (!bouncedTo) {
        unparseableCount++;
        Logger.log('DIAGNOSTIC -- could not parse the failed recipient out of bounce ' + bounceId + ' ("' + message.getSubject() + '") -- logging nothing rather than guessing.');
        continue;
      }

      const subject = thread.getFirstMessageSubject();
      const link = 'https://mail.google.com/mail/u/0/#all/' + thread.getId();

      // THE ACTUAL CHECK: was this addressed to one of our own addresses
      // instead of the lead's? isUnmailableAsLead_ (Code.gs) covers team
      // domains, every known Maildoso sending alias, and the network list.
      if (isUnmailableAsLead_(bouncedTo)) {
        Logger.log('DIAGNOSTIC -- MISDIRECTED: a reply on "' + subject + '" was sent to our own address ' + bouncedTo + ' and bounced. Real lead appears to be: ' + (realLead || 'UNRESOLVED') + '.');
        misdirected.push({
          bounceId: bounceId,
          bouncedTo: bouncedTo,
          realLead: realLead,
          subject: subject,
          bounceDate: message.getDate(),
          link: link
        });
        tab.appendRow([new Date(), 'MISDIRECTED', bounceId, bouncedTo, realLead || '(unresolved)', subject, message.getDate(), link]);
      } else {
        deadAddressCount++;
        Logger.log('DIAGNOSTIC -- dead address (not an incident): ' + bouncedTo + ' on "' + subject + '" no longer accepts mail.');
        tab.appendRow([new Date(), 'DEAD ADDRESS', bounceId, bouncedTo, bouncedTo, subject, message.getDate(), link]);
      }

      alreadyLogged.add(bounceId);
    }
  }

  Logger.log('Bounce audit complete. Misdirected (real incidents): ' + misdirected.length +
    '. Dead lead addresses (logged, no alert): ' + deadAddressCount +
    '. Unparseable bounces: ' + unparseableCount + '.');

  // Email ONLY on misdirected bounces. A dead outside address is not
  // actionable and a daily digest of them would train everyone to ignore
  // this alert, which is exactly when the misdirected one gets missed.
  if (misdirected.length > 0) {
    emailMisdirectedBounceAlert_(misdirected);
  } else {
    Logger.log('No misdirected bounces found -- no email sent (deliberately no "all clear" mail).');
  }
  } catch (e) {
    // FIX (27 Aug 2026, real risk found in review): no path here could ever
    // trip the Gmail quota circuit breaker -- see handleGmailJobError_.
    handleGmailJobError_('runBounceAudit', e);
  }
}

/**
 * Walk a thread for the real outside lead. Prefers a parsed forward block
 * (the Maildoso shape: the alias forwards the lead's mail into network@),
 * then falls back to any external participant. Returns null rather than
 * guessing, so the alert can say "unresolved" honestly instead of naming
 * the wrong person.
 */
function findRealLeadInThread_(messages) {
  // Newest first: if a thread has several forwards, the most recent one
  // describes the current state of the conversation.
  for (let i = messages.length - 1; i >= 0; i--) {
    const info = extractForwardedLeadInfo(messages[i]);
    if (info && info.email && !isUnmailableAsLead_(info.email)) return info.email;
  }

  // Fallback: any sender or recipient on the thread that is a real outsider.
  for (let i = messages.length - 1; i >= 0; i--) {
    const candidates = [extractEmail(messages[i].getFrom())]
      .concat(String(messages[i].getTo() || '').split(','))
      .concat(String(messages[i].getCc() || '').split(','));

    for (const raw of candidates) {
      const candidate = extractEmail(String(raw).trim());
      if (!candidate || candidate.indexOf('@') === -1) continue;
      if (isNonHumanSender(candidate)) continue;
      if (isUnmailableAsLead_(candidate)) continue;
      return candidate;
    }
  }

  return null;
}

/**
 * Pull the failed recipient out of a bounce notification. Returns null when
 * none of the known shapes match -- the caller logs that and moves on rather
 * than recording a guess, since a wrong address here would send somebody
 * chasing the wrong lead.
 */
function extractBouncedRecipient_(message) {
  const body = message.getPlainBody() || '';
  for (const pattern of BOUNCE_RECIPIENT_PATTERNS) {
    const match = body.match(pattern);
    if (match && match[1]) {
      // Trailing punctuation is common ("...to a.palmer@topaustinseo.site.")
      // and would corrupt the domain comparison downstream.
      return match[1].toLowerCase().replace(/[.,;:>)\]]+$/, '').trim();
    }
  }
  return null;
}

function emailMisdirectedBounceAlert_(misdirected) {
  const subject = '[Written by Claude] ' + misdirected.length + ' repl' + (misdirected.length === 1 ? 'y was' : 'ies were') +
    ' sent to the wrong address and bounced';

  const lines = misdirected.map(m =>
    '- "' + m.subject + '"\n' +
    '    Sent to:        ' + m.bouncedTo + '   <-- this is one of OUR addresses, not the lead\n' +
    '    Real lead:      ' + (m.realLead || 'could not be determined -- open the thread and check') + '\n' +
    '    Bounced:        ' + m.bounceDate + '\n' +
    '    Thread:         ' + m.link
  ).join('\n\n');

  const body =
    'This email was written by Claude.\n\n' +
    'A delivery failure came back for ' + misdirected.length + ' repl' + (misdirected.length === 1 ? 'y' : 'ies') +
    ' that ' + (misdirected.length === 1 ? 'was' : 'were') + ' addressed to one of our own addresses -- a Maildoso sending alias, ' +
    'a team address, or the network list -- instead of to the lead.\n\n' +
    'That means the lead below received NOTHING and is most likely sitting there ' +
    'thinking we ignored them. Each one can be fixed by replying directly to the ' +
    'real lead address shown.\n\n' +
    lines + '\n\n' +
    '---\n\n' +
    'Why this check exists: on 27 Aug 2026 a sweep found five of these going back to May, ' +
    'none of which anyone had noticed. The drafter bug that caused them is fixed ' +
    '(see FORWARDING_ALIAS_DOMAINS and isForwardedFromSendingAlias_ in Code.gs); ' +
    'this audit is the safety net that catches it if it ever comes back through a ' +
    'new sending domain or a hand-typed address.\n\n' +
    'Everything found, including outside addresses that are simply dead (not an ' +
    'incident, no email sent for those), is logged in the "' + BOUNCE_AUDIT_TAB + '" tab of the ' +
    '"Icons Podcast Reply Drafter -- Logs" spreadsheet.';

  // ADDED (27 Aug 2026, per direct request -- "you learnt nothing about
  // formatting emails nicely? hyperlink the links, use bold, use colour, use
  // better spacing"): this alert only ever had a plain-text body, unlike
  // daily_report.gs's htmlBody twin added the same day. The Thread link
  // rendered as a bare URL nobody could click without copy-pasting, and the
  // one actionable fact per bounce -- the real lead's address -- had no
  // visual weight to separate it from the wrong address right next to it.
  const htmlCards = misdirected.map(m => {
    const realLeadHtml = m.realLead
      ? '<a href="mailto:' + escapeHtml(m.realLead) + '" style="color:#1a7f37; font-weight:bold; text-decoration:none;">' + escapeHtml(m.realLead) + '</a>'
      : '<span style="color:#c0392b; font-weight:bold;">could not be determined -- open the thread and check</span>';
    return (
      '<div style="margin:0 0 14px 0; padding:12px 16px; border:1px solid #e0e0e0; border-left:4px solid #c0392b; border-radius:6px;">' +
        '<div style="font-weight:bold; margin-bottom:8px;">' + escapeHtml(m.subject) + '</div>' +
        '<div style="line-height:1.9;">' +
          '<b>Sent to:</b> <span style="color:#c0392b; font-weight:bold;">' + escapeHtml(m.bouncedTo) + '</span> ' +
            '<span style="color:#888888; font-size:12px;">(one of OUR addresses, not the lead)</span><br>' +
          '<b>Real lead (reply here to fix it):</b> ' + realLeadHtml + '<br>' +
          '<b>Bounced:</b> ' + escapeHtml(m.bounceDate) + '<br>' +
          '<b>Thread:</b> <a href="' + m.link + '" style="color:#2E74B5;">Open thread</a>' +
        '</div>' +
      '</div>'
    );
  }).join('');

  const htmlBody =
    '<div style="font-family:Arial,sans-serif; font-size:14px; color:#222;">' +
      '<p>This email was written by Claude.</p>' +
      '<h2 style="margin:0 0 10px 0; font-size:18px; color:#c0392b;">' +
        misdirected.length + ' repl' + (misdirected.length === 1 ? 'y was' : 'ies were') + ' sent to the wrong address and bounced' +
      '</h2>' +
      '<p>A delivery failure came back for ' + misdirected.length + ' repl' + (misdirected.length === 1 ? 'y' : 'ies') +
        ' addressed to one of our own addresses &mdash; a Maildoso sending alias, a team address, or the network list &mdash; instead of to the lead.</p>' +
      '<p><b>That means the lead below received NOTHING</b> and is most likely sitting there thinking we ignored them. ' +
        'Each one can be fixed by replying directly to the real lead address shown below.</p>' +
      '<hr style="border:none; border-top:1px solid #ccc; margin:16px 0;">' +
      htmlCards +
      '<hr style="border:none; border-top:1px solid #ccc; margin:16px 0;">' +
      '<p style="color:#555555; font-size:13px;">Why this check exists: on 27 Aug 2026 a sweep found five of these going back to May, ' +
        'none of which anyone had noticed. The drafter bug that caused them is fixed (see <b>FORWARDING_ALIAS_DOMAINS</b> and ' +
        '<b>isForwardedFromSendingAlias_</b> in Code.gs); this audit is the safety net that catches it if it ever comes back ' +
        'through a new sending domain or a hand-typed address.</p>' +
      '<p style="color:#555555; font-size:13px;">Everything found, including outside addresses that are simply dead (not an incident, ' +
        'no email sent for those), is logged in the &ldquo;' + escapeHtml(BOUNCE_AUDIT_TAB) + '&rdquo; tab of the ' +
        '<a href="https://docs.google.com/spreadsheets/d/' + CONFIG.SPREADSHEET_ID + '/edit">Icons Podcast Reply Drafter &mdash; Logs</a> spreadsheet.</p>' +
    '</div>';

  // Addressed to Joana, cc Kris, per the 27 Aug request ("alert Joana and CC
  // me"). Tomas is included to stay consistent with the standing 23 Aug rule
  // that team alerts cc Kris and Tomas -- drop him here if that is not wanted
  // for this particular alert.
  MailApp.sendEmail({
    to: 'joana@iconsofrealestate.com',
    cc: 'kris@iconsofrealestate.com,tomas@iconsofrealestate.com',
    subject: subject,
    body: body,
    htmlBody: htmlBody
  });

  Logger.log('Sent misdirected-bounce alert to Joana (cc Kris, Tomas) covering ' + misdirected.length + ' bounce(s).');
}
