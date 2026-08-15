/**
 * ICONS OF REAL ESTATE — Guest Booking Follow-Up Sequence (companion file,
 * same project as Code.gs / learning_loop.gs / missed_leads_audit.gs --
 * shares their CONFIG object and helper functions, so this must live in the
 * same Apps Script project.)
 * ---------------------------------------------------------------------------
 * When a no_decline lead gets sent the state-specific guest invite (see
 * Code.gs's no_decline handling) and Joana actually SENDS it, this starts a
 * 2-step nudge sequence, 2 days apart, each one drafted only -- never sent
 * automatically. If she sends step N, this drafts step N+1 two days later.
 * After step 2 is sent, the lead moves to a "Bens Call List" tab for Bens to
 * call directly. If the lead replies at any point, the sequence stops on
 * that thread -- a real reply always outranks the scripted nudge.
 *
 * ASSUMPTION MADE EXPLICIT: the first follow-up is scheduled 2 days after
 * the initial invite is sent, same spacing as the rest of the sequence.
 * This wasn't fully specified -- if a different gap is wanted before the
 * first nudge, change FIRST_FOLLOWUP_DELAY_DAYS below.
 *
 * HOW "SHE APPROVED IT" IS DETECTED: there's no separate approve button --
 * approval IS sending the draft. So this checks whether the thread's last
 * message is now a SENT message from Joana/Tomas dated after the draft was
 * created. That's the same signal the rest of this project already uses.
 *
 * MAIN ENTRY POINT: runGuestBookingFollowUpCycle() -- run daily.
 *   1. Finds newly-drafted no_decline invites (from Code.gs) with a matched
 *      state show, and registers them in the "Guest Follow-Up Queue" tab.
 *   2. For every tracked lead awaiting approval of its current step, checks
 *      if it was actually sent; if so, schedules/drafts the next step.
 *   3. Any lead whose thread got a NEW prospect reply gets marked STOPPED
 *      and is left alone from here on.
 *   4. Any lead that completes step 2 moves to the "Bens Call List" tab.
 */

const FOLLOWUP_QUEUE_TAB = 'Guest Follow-Up Queue';
const BENS_CALL_LIST_TAB = 'Bens Call List';
const FIRST_FOLLOWUP_DELAY_DAYS = 2;
const FOLLOWUP_DELAY_DAYS = 2;

const FOLLOWUP_TEMPLATES = {
  1: "Hi {{name}}, Just following up on my last note -- are we able to book you as a guest on {{show}}? Would love to get something on the calendar whenever works for you!",
  2: "Hi {{name}}, Last note from me on this -- can we create your profile and get you booked on {{show}}?"
};

function runGuestBookingFollowUpCycle() {
  ensureFollowUpTabsExist();
  registerNewGuestInvites();
  advanceExistingFollowUps();
  Logger.log('Guest booking follow-up cycle complete.');
}

function ensureFollowUpTabsExist() {
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);

  let queueTab = ss.getSheetByName(FOLLOWUP_QUEUE_TAB);
  if (!queueTab) {
    queueTab = ss.insertSheet(FOLLOWUP_QUEUE_TAB);
    queueTab.appendRow([
      'Thread ID', 'Name', 'Email', 'State', 'Show Name', 'Show Link',
      'Current Step', 'Step Draft Created At', 'Status', 'Next Action Due'
    ]);
  }

  let bensTab = ss.getSheetByName(BENS_CALL_LIST_TAB);
  if (!bensTab) {
    bensTab = ss.insertSheet(BENS_CALL_LIST_TAB);
    bensTab.appendRow(['Added At', 'Name', 'Email', 'State', 'Show Name', 'Thread Link']);
  }
}

function registerNewGuestInvites() {
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const queueTab = ss.getSheetByName(FOLLOWUP_QUEUE_TAB);
  const existing = new Set(
    queueTab.getDataRange().getValues().slice(1).map(row => row[0])
  );

  const addressClauses = CONFIG.REQUIRED_CC_ADDRESSES
    .map(addr => 'to:"' + addr + '" OR cc:"' + addr + '"')
    .join(' OR ');
  const threads = GmailApp.search(
    '(' + addressClauses + ') label:"' + CONFIG.LABEL_NO + '" newer_than:30d',
    0, 200
  );

  const stateDirectory = loadStateDirectory();

  threads.forEach(thread => {
    const threadId = thread.getId();
    if (existing.has(threadId)) return;

    const subject = thread.getFirstMessageSubject();
    const state = extractStateFromSubject(subject);
    const matchedShow = state ? stateDirectory[normalizeState(state)] : null;
    if (!matchedShow) return;

    const messages = thread.getMessages();
    const inviteMsg = messages.slice().reverse().find(m => isInternal(extractEmail(m.getFrom())));
    if (!inviteMsg) return;

    const prospectMsg = messages.find(m => !isInternal(extractEmail(m.getFrom())));
    const name = prospectMsg ? guessNameFromEmail(prospectMsg) : '';
    const email = prospectMsg ? extractEmail(prospectMsg.getFrom()) : '';

    queueTab.appendRow([
      threadId, name, email, state, matchedShow.showName, matchedShow.link,
      0,
      inviteMsg.getDate(),
      'AWAITING_STEP_1_SCHEDULE',
      new Date(inviteMsg.getDate().getTime() + FIRST_FOLLOWUP_DELAY_DAYS * 24 * 60 * 60 * 1000)
    ]);
  });
}

function guessNameFromEmail(message) {
  const from = message.getFrom();
  const nameMatch = from.match(/^"?([^"<]+)"?\s*</);
  return nameMatch ? nameMatch[1].trim() : '';
}

function advanceExistingFollowUps() {
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const queueTab = ss.getSheetByName(FOLLOWUP_QUEUE_TAB);
  const bensTab = ss.getSheetByName(BENS_CALL_LIST_TAB);
  const data = queueTab.getDataRange().getValues();

  for (let r = 1; r < data.length; r++) {
    const row = data[r];
    const [threadId, name, email, state, showName, showLink, currentStep, , status, nextDue] = row;

    if (status === 'STOPPED' || status === 'COMPLETE') continue;

    let thread;
    try {
      thread = GmailApp.getThreadById(threadId);
    } catch (e) {
      continue;
    }
    if (!thread) continue;

    const messages = thread.getMessages();
    const last = messages[messages.length - 1];
    const lastSenderEmail = extractEmail(last.getFrom());

    if (!isInternal(lastSenderEmail) && currentStep > 0) {
      queueTab.getRange(r + 1, 9).setValue('STOPPED');
      continue;
    }

    if (status.indexOf('AWAITING_STEP_') === 0 && status.indexOf('_SCHEDULE') > -1) {
      if (new Date() < new Date(nextDue)) continue;

      const nextStep = currentStep + 1;
      if (nextStep > 2) continue;

      const template = FOLLOWUP_TEMPLATES[nextStep];
      const body = template.replace('{{name}}', name || 'there').replace(/{{show}}/g, showName);

      thread.createDraftReply(body);

      queueTab.getRange(r + 1, 7).setValue(nextStep);
      queueTab.getRange(r + 1, 8).setValue(new Date());
      queueTab.getRange(r + 1, 9).setValue('AWAITING_STEP_' + nextStep + '_APPROVAL');
      continue;
    }

    if (status.indexOf('AWAITING_STEP_') === 0 && status.indexOf('_APPROVAL') > -1) {
      const draftCreatedAt = new Date(row[7]);
      if (isInternal(lastSenderEmail) && last.getDate() > draftCreatedAt) {
        if (currentStep >= 2) {
          bensTab.appendRow([new Date(), name, email, state, showName, 'https://mail.google.com/mail/u/0/#all/' + threadId]);
          queueTab.getRange(r + 1, 9).setValue('COMPLETE');
        } else {
          const due = new Date(last.getDate().getTime() + FOLLOWUP_DELAY_DAYS * 24 * 60 * 60 * 1000);
          queueTab.getRange(r + 1, 9).setValue('AWAITING_STEP_' + (currentStep + 1) + '_SCHEDULE');
          queueTab.getRange(r + 1, 10).setValue(due);
        }
      }
    }
  }
}
