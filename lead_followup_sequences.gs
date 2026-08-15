/**
 * ICONS OF REAL ESTATE — Lead Follow-Up Sequences (v4)
 * ---------------------------------------------------------------------------
 * v4 changes (14 Aug 2026):
 *   1. FIXED A REAL BUG: registerNewHubGuestInvites() was defined TWICE in
 *      the v3 file. JavaScript silently uses the LAST definition, so the
 *      correctly-fixed first version (which re-derives the real email from
 *      the thread via extractForwardedLeadInfo) was dead code the whole
 *      time -- the version that actually ran just used the raw, often
 *      poisoned AI Drafts Log email column directly, with no isInternal
 *      safety check either. This is very likely a real contributor to the
 *      ~27% email-poisoning rate found in the Hub Guest queue. The
 *      duplicate/broken definition has been removed entirely.
 *   2. FIXED: the in-memory `existing` Set (used to prevent re-enrolling a
 *      thread already in the queue) was built ONCE at the start of each
 *      registration function and never updated as new rows were appended
 *      during that same run. A thread with multiple AI Drafts Log entries
 *      (confirmed on Ray's thread -- 7 entries) got re-enrolled once per
 *      entry, in the same execution. Fixed by adding existing.add(threadId)
 *      immediately after each appendRow.
 *   3. ADDED wipeFollowUpQueuesClean() -- a one-off function to clear both
 *      queue tabs completely (run once, manually). Used instead of trying
 *      to salvage the existing broken/duplicated backlog, since zero leads
 *      had been successfully processed through either cadence yet.
 *   4. Per Kris's request: added generous per-row/per-decision logging
 *      throughout, not just summary counts, to make future debugging
 *      faster.
 * ---------------------------------------------------------------------------
 * ORIGINAL v3 HEADER (unchanged, still accurate):
 *
 * REAL BUG THIS FIXES (v2): the old version enrolled leads into the "guest
 * invite" follow-up sequence by searching Gmail for a stale label
 * (2. Spam NO), without re-confirming the thread's actual current status.
 * A real case (Angie) was a HOSTING SALES lead but got the wrong cadence
 * applied. This version checks the "AI Drafts Log" tab directly for the
 * real, current category Claude assigned, which doesn't go stale.
 *
 * ALSO FIXED (v2): names were coming through blank ("Hi there") because
 * the old code parsed a display name off the email's From header, which
 * is usually empty. Names are now pulled from the subject line instead.
 *
 * TWO SEPARATE CADENCES, per Kris's direction (12 Aug 2026):
 *
 * 1. PODCAST SALES cadence -- for yes_general leads who got the hosting
 *    sales pitch + Zoom link, but never actually booked a call:
 *      Initial (already sent) -> +2 working days -> Follow-up 1 (nudge to
 *      book) -> +2 working days -> Follow-up 2 / FINAL (pivots to the
 *      lesser ask: invite them to guest on their state's show instead).
 *
 * 2. HUB GUEST cadence -- for no_decline leads who got the state-specific
 *    guest invite:
 *      Initial (already sent) -> +2 working days -> Follow-up 1 (nudge to
 *      book as a guest) -> +2 working days -> Follow-up 2 / FINAL (a real
 *      breakup email) -> moves to Bens Call List.
 *
 * SPACING IS IN WORKING DAYS -- skips weekends.
 *
 * SCHEDULING NOTE: since this only creates drafts, every drafted follow-up
 * gets a bracketed note at the top telling Joana what time the lead
 * originally replied, so she can manually time the send to match.
 *
 * TEST-BATCH CAPPING (v3, 12 Aug 2026): the deep-dive backfill enrolled 384
 * leads at once. Rather than let all of them start drafting simultaneously,
 * capFollowUpQueuesToTestBatch() limits how many are ACTIVE at a time --
 * everything beyond the cap is set to HELD and completely ignored by the
 * advance functions until explicitly released via releaseNextFollowUpBatch().
 *
 * EDIT-TRACKING (v3): every drafted follow-up's text gets logged in its
 * queue row. Once Joana sends it, the actual sent text is compared against
 * what was drafted, and the result (edited or sent as-is, plus both texts)
 * is recorded in a new "Follow-Up Learning Log" tab -- so you can actually
 * see what she changes before deciding to scale up to the full 384.
 *
 * MAIN SCHEDULED ENTRY POINT: runLeadFollowUpCycle() -- run daily.
 */

// ---------- CONFIG for this file ----------

const PODCAST_SALES_QUEUE_TAB = 'Podcast Sales Follow-Up Queue';
const HUB_GUEST_QUEUE_TAB = 'Hub Guest Follow-Up Queue';
const BENS_CALL_LIST_TAB_V2 = 'Bens Call List';
const FOLLOWUP_LEARNING_LOG_TAB = 'Follow-Up Learning Log';
const FOLLOWUP_WORKING_DAYS_GAP = 2;
const FOLLOWUP_DEEP_DIVE_LOOKBACK_DAYS = 270;

// CAP (14 Aug 2026): hard ceiling on how many follow-up drafts can be
// sitting in "awaiting approval" at once, combined across BOTH queues.
// Once this is hit, advancePodcastSalesFollowUps()/advanceHubGuestFollowUps()
// stop creating new drafts (existing _SCHEDULE rows just wait their turn)
// until Joana sends enough of the current batch to drop back under the cap.
// This is deliberately a single easy-to-change number -- adjust here, not
// scattered through the code.
const FOLLOWUP_DRAFT_CAP = 100;

// SAFETY NET (14 Aug 2026, real incident): a lead (Treye Bird) who clearly
// declined ("I'm sorry i haven't responded earlier. I'm not interested,
// but thank you for reaching out.") still got a Podcast Sales follow-up
// nudge drafted. Root cause: the existing OPT_OUT_PATTERNS regex only
// matches "stop/unsubscribe/remove me" -- it does NOT match "not
// interested," probably the single most common polite decline phrase.
// Separately, the advance functions only checked whether the thread's
// LAST message was internal/external, not whether a decline exists
// ANYWHERE in the thread's history. This broader pattern plus the
// threadContainsDecline() helper below scan every message already fetched
// (no extra Gmail quota cost) and immediately stop the cadence if a
// decline is found anywhere, not just in the most recent message.
const DECLINE_PATTERNS = /\b(not interested|no longer interested|not a good fit|no thank you|not right now|not for me|going to pass|i'll pass|not something (i'm|i am) interested in)\b/i;

// Scans every message in the thread that came from the external lead (not
// our own team), checking their fresh reply text against both the broad
// opt-out pattern and the new decline pattern. Returns true the moment
// ANY message anywhere in the thread looks like a decline -- this is
// deliberately thorough rather than only checking the most recent message,
// since that's exactly the gap that let Treye Bird's case slip through.
function threadContainsDecline(thread) {
  const messages = thread.getMessages();
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const senderEmail = extractEmail(msg.getFrom());
    if (isInternal(senderEmail)) continue; // only checking what the LEAD actually said

    const freshText = extractProspectFreshReplyText(msg);
    if (OPT_OUT_PATTERNS.test(freshText) || DECLINE_PATTERNS.test(freshText)) {
      return true;
    }
  }
  return false;
}

// ---------- ONE-OFF CLEANUP (14 Aug 2026) ----------

// Wipes both follow-up queue tabs completely clean, keeping only the header
// row. Safe to run because zero leads have been successfully processed
// through either cadence yet -- every row currently in these tabs is either
// a duplicate, a permanently-stuck blank-status row, or mid-cadence junk
// from the broken registration logic (now fixed). Nothing real is lost.
// After running this, the NEXT runLeadFollowUpCycle() will re-enroll
// everything fresh, using the fixed registration functions below, so no
// duplicates this time. Run ONCE, manually. Not a scheduled trigger.
function wipeFollowUpQueuesClean() {
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);

  [PODCAST_SALES_QUEUE_TAB, HUB_GUEST_QUEUE_TAB].forEach(tabName => {
    const tab = ss.getSheetByName(tabName);
    if (!tab) {
      Logger.log('wipeFollowUpQueuesClean -- tab not found, skipping: ' + tabName);
      return;
    }

    const lastRow = tab.getLastRow();
    const lastCol = tab.getLastColumn();

    if (lastRow <= 1) {
      Logger.log('wipeFollowUpQueuesClean -- ' + tabName + ' already has no data rows (only header, or empty). Nothing to do.');
      return;
    }

    const rowsToDelete = lastRow - 1; // everything except the header
    tab.getRange(2, 1, rowsToDelete, lastCol).clearContent();

    Logger.log('wipeFollowUpQueuesClean -- ' + tabName + ': cleared ' + rowsToDelete + ' data row(s), header row kept intact.');
  });

  Logger.log('wipeFollowUpQueuesClean COMPLETE. Both queues are now empty and ready for a clean re-enrollment on the next runLeadFollowUpCycle().');
}

// ---------- TEST-BATCH CAPPING ----------

function capFollowUpQueuesToTestBatch(countPerQueue) {
  const n = countPerQueue || 10;
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);

  [PODCAST_SALES_QUEUE_TAB, HUB_GUEST_QUEUE_TAB].forEach(tabName => {
    const tab = ss.getSheetByName(tabName);
    if (!tab) return;
    const statusCol = tabName === PODCAST_SALES_QUEUE_TAB ? 7 : 10;
    const data = tab.getDataRange().getValues();

    let activeCount = 0;
    for (let r = 1; r < data.length; r++) {
      const currentStatus = data[r][statusCol - 1];
      if (currentStatus === 'AWAITING_STEP_1_SCHEDULE') {
        if (activeCount < n) {
          activeCount++;
        } else {
          tab.getRange(r + 1, statusCol).setValue('HELD');
          Logger.log('capFollowUpQueuesToTestBatch -- ' + tabName + ' row ' + (r + 1) + ' (thread ' + data[r][0] + ') set to HELD, over the cap of ' + n + '.');
        }
      }
    }
    Logger.log(tabName + ': kept ' + activeCount + ' active, held the rest.');
  });
}

function releaseNextFollowUpBatch(countPerQueue) {
  const n = countPerQueue || 10;
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);

  [PODCAST_SALES_QUEUE_TAB, HUB_GUEST_QUEUE_TAB].forEach(tabName => {
    const tab = ss.getSheetByName(tabName);
    if (!tab) return;
    const statusCol = tabName === PODCAST_SALES_QUEUE_TAB ? 7 : 10;
    const data = tab.getDataRange().getValues();

    let releasedCount = 0;
    for (let r = 1; r < data.length; r++) {
      if (releasedCount >= n) break;
      if (data[r][statusCol - 1] === 'HELD') {
        tab.getRange(r + 1, statusCol).setValue('AWAITING_STEP_1_SCHEDULE');
        Logger.log('releaseNextFollowUpBatch -- ' + tabName + ' row ' + (r + 1) + ' (thread ' + data[r][0] + ') released from HELD.');
        releasedCount++;
      }
    }
    Logger.log(tabName + ': released ' + releasedCount + ' more into the active batch.');
  });
}

// FIXED (12 Aug 2026, real gap found while fixing the missing-history bug):
// rows waiting at "_APPROVAL" only advance when the thread's last message
// changes to a real sent reply from Joana/Tomas. Deleting a draft doesn't
// touch the thread at all, so those rows would sit stuck at "_APPROVAL"
// forever with no path forward -- the exact same "phantom" problem the
// main system hit earlier today (reconcile_missing_drafts.gs), just not
// yet fixed for this newer follow-up system. Run this BEFORE deleting any
// follow-up drafts: for every row still at "_APPROVAL", checks whether a
// live draft actually exists for that lead; if not, resets the row back
// to "_SCHEDULE" with today's date as the due date, so the next cycle
// redrafts it fresh (this time correctly including quoted history).
function reconcileFollowUpDrafts() {
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  let reconciled = 0;
  let leftAlone = 0;

  [
    { tabName: PODCAST_SALES_QUEUE_TAB, statusCol: 7, emailCol: 3 },
    { tabName: HUB_GUEST_QUEUE_TAB, statusCol: 10, emailCol: 3 }
  ].forEach(cfg => {
    const tab = ss.getSheetByName(cfg.tabName);
    if (!tab) return;
    const data = tab.getDataRange().getValues();

    for (let r = 1; r < data.length; r++) {
      const status = data[r][cfg.statusCol - 1];
      if (!status || String(status).indexOf('_APPROVAL') === -1) continue;

      const email = data[r][cfg.emailCol - 1];
      const hasLiveDraft = draftAlreadyExistsFor(email);

      if (hasLiveDraft) {
        Logger.log('reconcileFollowUpDrafts -- left alone (live draft confirmed): row ' + (r + 1) + ' in ' + cfg.tabName + ', ' + email);
        leftAlone++;
        continue; // real draft still exists -- correctly waiting, don't touch
      }

      // No live draft for this lead's current step -- the draft was
      // deleted. Reset to _SCHEDULE with today's date so it redrafts on
      // the next cycle instead of sitting stuck forever.
      const currentStep = data[r][cfg.statusCol - 3]; // Current Step column, 2 before status
      tab.getRange(r + 1, cfg.statusCol).setValue('AWAITING_STEP_' + currentStep + '_SCHEDULE');
      tab.getRange(r + 1, cfg.statusCol + 1).setValue(new Date()); // Next Action Due = now, so it redrafts on the next run
      Logger.log('reconcileFollowUpDrafts -- RESET (no live draft found): row ' + (r + 1) + ' in ' + cfg.tabName + ', ' + email + ', Step ' + currentStep + ' -> AWAITING_STEP_' + currentStep + '_SCHEDULE');
      reconciled++;
    }
  });

  Logger.log('Follow-up draft reconciliation complete. ' + reconciled + ' stuck row(s) reset to redraft. ' + leftAlone + ' left alone (real draft confirmed to still exist).');
}

// ---------- NAME EXTRACTION ----------

// FIXED (12 Aug 2026, real bug found by Kris): thread.createDraftReply()
// correctly threads the draft into the same conversation (which is why it
// shows up nested under the right subject), but Apps Script does NOT
// automatically inject the quoted previous message into the draft's
// actual content the way Gmail's own "Reply" button does for a human.
// Without this, the draft was just the new nudge line floating with zero
// reference to what came before -- confusing for the lead to receive.
// This builds a standard "On [date], [sender] wrote:" quoted block from
// the thread's last message, same convention Gmail itself uses.
function buildQuotedHistoryForReply(thread) {
  const messages = thread.getMessages();
  const last = messages[messages.length - 1];
  const senderName = last.getFrom();
  const dateStr = last.getDate().toLocaleString();
  const quotedLines = last.getPlainBody().split('\n').map(line => '> ' + line).join('\n');
  return '\n\nOn ' + dateStr + ', ' + senderName + ' wrote:\n' + quotedLines;
}

function extractNameFromSubject(subject) {
  const cleaned = subject.replace(/^(fwd:\s*|re:\s*)+/gi, '').trim();
  const match = cleaned.match(/^([A-Za-z]+)\s*,/);
  return match ? match[1] : null;
}

// ---------- WORKING DAY MATH ----------

function addWorkingDays(date, numDays) {
  const result = new Date(date.getTime());
  let added = 0;
  while (added < numDays) {
    result.setDate(result.getDate() + 1);
    const day = result.getDay();
    if (day !== 0 && day !== 6) added++;
  }
  return result;
}

// ---------- SCHEDULING NOTE ----------

function buildSchedulingNote(originalMessageDate) {
  const hours = originalMessageDate.getHours();
  const minutes = originalMessageDate.getMinutes();
  const ampm = hours >= 12 ? 'PM' : 'AM';
  const displayHour = (hours % 12) || 12;
  const displayMinutes = minutes < 10 ? '0' + minutes : String(minutes);
  return '[SCHEDULING NOTE FOR JOANA -- DELETE THIS LINE BEFORE SENDING: ' +
    'this lead originally replied around ' + displayHour + ':' + displayMinutes + ' ' + ampm +
    '. Consider timing this send to land around the same time of day rather than sending immediately.]\n\n';
}

// ---------- EDIT-TRACKING ----------

function logFollowUpLearning(cadence, name, email, step, draftedText, sentText) {
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  let logTab = ss.getSheetByName(FOLLOWUP_LEARNING_LOG_TAB);
  if (!logTab) {
    logTab = ss.insertSheet(FOLLOWUP_LEARNING_LOG_TAB);
    logTab.appendRow(['Logged At', 'Cadence', 'Name', 'Email', 'Step', 'Drafted Text', 'Sent Text', 'Was Edited']);
  }
  const normalize = t => (t || '').replace(/\s+/g, ' ').trim();
  const wasEdited = normalize(draftedText) !== normalize(sentText);
  logTab.appendRow([new Date(), cadence, name, email, step, draftedText, sentText, wasEdited]);
  Logger.log('logFollowUpLearning -- ' + cadence + ' step ' + step + ', ' + email + ', wasEdited=' + wasEdited);
}

// ---------- TEMPLATES ----------

const PODCAST_SALES_TEMPLATES = {
  1: "Hi {{name}}, Just wanted to follow up on my last note -- were you able to take a look at hosting your own podcast? Happy to jump on a quick call whenever works for you: [book a 15-minute Zoom Call here](BOOKING_LINK)"
};

const HUB_GUEST_TEMPLATES = {
  1: "Hi {{name}}, Just following up on my last note -- are we able to book you as a guest on {{show}}? Would love to get something on the calendar whenever works for you!",
  2: "Hi {{name}}, I don't want to keep bugging you about this, so this will be my last note -- if being a guest on {{show}} ever sounds interesting down the road, the invite always stands. Wishing you continued success!"
};

// ---------- MAIN ENTRY POINT ----------

function runLeadFollowUpCycle() {
  ensureFollowUpTabsExistV2();
  registerNewPodcastSalesLeads();
  registerNewHubGuestInvites();
  advancePodcastSalesFollowUps();
  advanceHubGuestFollowUps();
  Logger.log('Lead follow-up cycle complete (both cadences).');
}

function runFollowUpDeepDiveBackfill() {
  ensureFollowUpTabsExistV2();
  registerNewPodcastSalesLeads(FOLLOWUP_DEEP_DIVE_LOOKBACK_DAYS);
  registerNewHubGuestInvites(FOLLOWUP_DEEP_DIVE_LOOKBACK_DAYS);
  Logger.log('Deep dive backfill complete -- run capFollowUpQueuesToTestBatch(10) next to limit what actually goes active, before running runLeadFollowUpCycle.');
}

function ensureFollowUpTabsExistV2() {
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);

  let salesQueueTab = ss.getSheetByName(PODCAST_SALES_QUEUE_TAB);
  if (!salesQueueTab) {
    salesQueueTab = ss.insertSheet(PODCAST_SALES_QUEUE_TAB);
    salesQueueTab.appendRow([
      'Thread ID', 'Name', 'Email', 'Original Reply Time', 'Current Step',
      'Step Draft Created At', 'Status', 'Next Action Due', 'Drafted Text'
    ]);
    Logger.log('ensureFollowUpTabsExistV2 -- created tab: ' + PODCAST_SALES_QUEUE_TAB);
  }

  let hubQueueTab = ss.getSheetByName(HUB_GUEST_QUEUE_TAB);
  if (!hubQueueTab) {
    hubQueueTab = ss.insertSheet(HUB_GUEST_QUEUE_TAB);
    hubQueueTab.appendRow([
      'Thread ID', 'Name', 'Email', 'State', 'Show Name', 'Show Link',
      'Original Reply Time', 'Current Step', 'Step Draft Created At', 'Status', 'Next Action Due', 'Drafted Text'
    ]);
    Logger.log('ensureFollowUpTabsExistV2 -- created tab: ' + HUB_GUEST_QUEUE_TAB);
  }

  let bensTab = ss.getSheetByName(BENS_CALL_LIST_TAB_V2);
  if (!bensTab) {
    bensTab = ss.insertSheet(BENS_CALL_LIST_TAB_V2);
    bensTab.appendRow(['Added At', 'Name', 'Email', 'State', 'Show Name', 'Thread Link']);
    Logger.log('ensureFollowUpTabsExistV2 -- created tab: ' + BENS_CALL_LIST_TAB_V2);
  }
}

// ---------- REGISTRATION ----------

function registerNewPodcastSalesLeads(lookbackDaysOverride) {
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const draftsLogTab = ss.getSheetByName('AI Drafts Log');
  const queueTab = ss.getSheetByName(PODCAST_SALES_QUEUE_TAB);
  if (!draftsLogTab || !queueTab) {
    Logger.log('registerNewPodcastSalesLeads -- required tab missing, aborting.');
    return;
  }

  const existing = new Set(
    queueTab.getDataRange().getValues().slice(1).map(row => row[0])
  );

  const cutoff = lookbackDaysOverride
    ? new Date(Date.now() - lookbackDaysOverride * 24 * 60 * 60 * 1000)
    : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const draftsData = draftsLogTab.getDataRange().getValues().slice(1);
  let enrolled = 0;

  draftsData.forEach(row => {
    const [timestamp, threadId, subject, loggedEmail, category, needsRouting] = row;
    if (!(timestamp instanceof Date) || timestamp < cutoff) return;
    if (existing.has(threadId)) return;

    if (category !== 'yes_general' || needsRouting !== true) return;

    let thread;
    try {
      thread = GmailApp.getThreadById(threadId);
    } catch (e) {
      Logger.log('registerNewPodcastSalesLeads -- could not open thread ' + threadId + ': ' + e);
      return;
    }
    if (!thread) return;

    const messages = thread.getMessages();
    const lastMsg = messages[messages.length - 1];
    const lastSenderEmail = extractEmail(lastMsg.getFrom());
    if (!isInternal(lastSenderEmail)) return;

    // RE-DERIVED FROM THE THREAD ITSELF -- never trust the AI Drafts Log's
    // stored "Prospect Email" column. Historical rows (pre-fix) logged the
    // network alias instead of the real lead for reasons not fully traced;
    // re-parsing the forwarded block directly from the thread every time is
    // the only reliable source of truth.
    const forwardInfo = extractForwardedLeadInfo(lastMsg);
    if (!forwardInfo) {
      Logger.log('registerNewPodcastSalesLeads -- SKIPPED (could not re-derive real lead email from thread ' + threadId + '): ' + subject);
      return;
    }
    const realEmail = forwardInfo.email;

    // Defense in depth: never enroll a "lead" whose email is actually one
    // of our own addresses.
    if (isInternal(realEmail) || CONFIG.REQUIRED_CC_ADDRESSES.some(a => a.toLowerCase() === realEmail)) {
      Logger.log('registerNewPodcastSalesLeads -- SKIPPED (re-derived email is internal/alias, not a real lead): ' + threadId + ' -> ' + realEmail);
      return;
    }

    const name = extractNameFromSubject(subject) || 'there';
    const originalReplyMsg = messages[0];
    const originalReplyTime = originalReplyMsg.getDate();

    queueTab.appendRow([
      threadId, name, realEmail, originalReplyTime,
      0, lastMsg.getDate(), 'AWAITING_STEP_1_SCHEDULE',
      addWorkingDays(lastMsg.getDate(), FOLLOWUP_WORKING_DAYS_GAP)
    ]);
    existing.add(threadId); // FIX (14 Aug 2026): prevents re-enrolling this same thread again later in this same run if it has multiple AI Drafts Log entries.
    Logger.log('registerNewPodcastSalesLeads -- enrolled: ' + threadId + ' (' + name + ', ' + realEmail + ')');
    enrolled++;
  });

  Logger.log('registerNewPodcastSalesLeads complete. Enrolled ' + enrolled + ' new lead(s).');
}

function registerNewHubGuestInvites(lookbackDaysOverride) {
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const draftsLogTab = ss.getSheetByName('AI Drafts Log');
  const queueTab = ss.getSheetByName(HUB_GUEST_QUEUE_TAB);
  if (!draftsLogTab || !queueTab) {
    Logger.log('registerNewHubGuestInvites -- required tab missing, aborting.');
    return;
  }

  const existing = new Set(
    queueTab.getDataRange().getValues().slice(1).map(row => row[0])
  );

  const cutoff = lookbackDaysOverride
    ? new Date(Date.now() - lookbackDaysOverride * 24 * 60 * 60 * 1000)
    : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const draftsData = draftsLogTab.getDataRange().getValues().slice(1);
  const stateDirectory = loadStateDirectory();
  let enrolled = 0;

  draftsData.forEach(row => {
    const [timestamp, threadId, subject] = row;
    const category = row[4];
    if (!(timestamp instanceof Date) || timestamp < cutoff) return;
    if (existing.has(threadId)) return;
    if (category !== 'no_decline') return;

    const state = extractStateFromSubject(subject);
    const matchedShow = state ? stateDirectory[normalizeState(state)] : null;
    if (!matchedShow) return;

    let thread;
    try {
      thread = GmailApp.getThreadById(threadId);
    } catch (e) {
      Logger.log('registerNewHubGuestInvites -- could not open thread ' + threadId + ': ' + e);
      return;
    }
    if (!thread) return;

    const messages = thread.getMessages();
    const lastMsg = messages[messages.length - 1];
    const lastSenderEmail = extractEmail(lastMsg.getFrom());
    if (!isInternal(lastSenderEmail)) return;

    // FIX (14 Aug 2026): this function used to be defined TWICE in the
    // file -- the second, broken definition silently won (JS uses the
    // last definition of a duplicate function name), and it skipped this
    // re-derivation step entirely, just trusting row[3] (the AI Drafts Log
    // email column) directly with no internal-address guard. That is very
    // likely a real contributor to the email-poisoning found in this
    // queue. Removed the duplicate; this is now the only definition, and
    // it always re-derives from the thread itself, same as the Sales cadence.
    const forwardInfo = extractForwardedLeadInfo(lastMsg);
    if (!forwardInfo) {
      Logger.log('registerNewHubGuestInvites -- SKIPPED (could not re-derive real lead email from thread ' + threadId + '): ' + subject);
      return;
    }
    const realEmail = forwardInfo.email;

    if (isInternal(realEmail) || CONFIG.REQUIRED_CC_ADDRESSES.some(a => a.toLowerCase() === realEmail)) {
      Logger.log('registerNewHubGuestInvites -- SKIPPED (re-derived email is internal/alias, not a real lead): ' + threadId + ' -> ' + realEmail);
      return;
    }

    const name = extractNameFromSubject(subject) || 'there';
    const originalReplyMsg = messages[0];
    const originalReplyTime = originalReplyMsg.getDate();

    queueTab.appendRow([
      threadId, name, realEmail, state, matchedShow.showName, matchedShow.link,
      originalReplyTime, 0, lastMsg.getDate(), 'AWAITING_STEP_1_SCHEDULE',
      addWorkingDays(lastMsg.getDate(), FOLLOWUP_WORKING_DAYS_GAP)
    ]);
    existing.add(threadId); // FIX (14 Aug 2026): same dedup-staleness fix as the Sales cadence.
    Logger.log('registerNewHubGuestInvites -- enrolled: ' + threadId + ' (' + name + ', ' + realEmail + ', show: ' + matchedShow.showName + ')');
    enrolled++;
  });

  Logger.log('registerNewHubGuestInvites complete. Enrolled ' + enrolled + ' new lead(s).');
}

// ---------- DRAFT CAP HELPER ----------

// Counts how many rows are currently sitting at any "_APPROVAL" status
// across BOTH queues -- i.e. real drafts already created and waiting on
// Joana to review/send. This is the live number checked against
// FOLLOWUP_DRAFT_CAP before creating any new draft.
function countActiveApprovalDrafts() {
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  let count = 0;

  [
    { tabName: PODCAST_SALES_QUEUE_TAB, statusCol: 7 },
    { tabName: HUB_GUEST_QUEUE_TAB, statusCol: 10 }
  ].forEach(cfg => {
    const tab = ss.getSheetByName(cfg.tabName);
    if (!tab) return;
    const data = tab.getDataRange().getValues();
    for (let r = 1; r < data.length; r++) {
      const status = data[r][cfg.statusCol - 1];
      if (status && String(status).indexOf('_APPROVAL') > -1) count++;
    }
  });

  return count;
}

// ---------- FIND ALL LEADS (registration only, never drafts) ----------

// Run this to see the TRUE full scale of leads needing follow-up, without
// creating a single new draft. registerNewPodcastSalesLeads() and
// registerNewHubGuestInvites() only ever APPEND rows to the queue sheets
// with status AWAITING_STEP_1_SCHEDULE -- they never touch Gmail or call
// GmailApp.createDraft(). Only the advance*() functions draft anything,
// and this function deliberately does NOT call them. Safe to run anytime
// you want a full accounting without affecting Joana's Drafts folder at all.
function findAllLeadsNeedingFollowUp(lookbackDaysOverride) {
  const lookback = lookbackDaysOverride || 730; // ~2 years, matches the missed-leads audit's own historical window
  ensureFollowUpTabsExistV2();
  Logger.log('findAllLeadsNeedingFollowUp -- scanning back ' + lookback + ' days. This only enrolls leads into the queue tabs; it will NOT create any drafts.');
  registerNewPodcastSalesLeads(lookback);
  registerNewHubGuestInvites(lookback);
  Logger.log('findAllLeadsNeedingFollowUp COMPLETE. Check the queue tabs for the full count. No drafts were created by this run -- run runLeadFollowUpCycle() separately (respecting the ' + FOLLOWUP_DRAFT_CAP + '-draft cap) when ready to actually start drafting.');
}

// ---------- AUDIT EXISTING DRAFTS FOR THE DECLINE BUG (one-off, 14 Aug 2026) ----------

// The Treye Bird incident (a lead who clearly declined still got a Podcast
// Sales follow-up nudge drafted) means some of the ~215 drafts already
// sitting in the Sales queue from earlier today may have the SAME problem.
// This does NOT delete anything automatically -- it re-checks every row
// currently at an "_APPROVAL" status in the Sales queue against
// threadContainsDecline(), and clearly logs which ones need a human to go
// delete the bad draft from Gmail. Deliberately conservative: flagging and
// stopping the cadence is safe to automate, but deleting an already-sent
// Gmail draft is not something this function does on its own.
function auditActiveSalesDraftsForDeclines() {
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const queueTab = ss.getSheetByName(PODCAST_SALES_QUEUE_TAB);
  const data = queueTab.getDataRange().getValues();
  let checked = 0;
  let flagged = 0;

  for (let r = 1; r < data.length; r++) {
    const row = data[r];
    const threadId = row[0];
    const name = row[1];
    const email = row[2];
    const status = row[6];

    if (!status || String(status).indexOf('_APPROVAL') === -1) continue; // only checking rows with a live draft already created

    checked++;
    let thread;
    try {
      thread = GmailApp.getThreadById(threadId);
    } catch (e) {
      Logger.log('auditActiveSalesDraftsForDeclines -- could not open thread ' + threadId + ': ' + e);
      continue;
    }
    if (!thread) continue;

    if (threadContainsDecline(thread)) {
      queueTab.getRange(r + 1, 7).setValue('STOPPED');
      Logger.log('auditActiveSalesDraftsForDeclines -- FLAGGED FOR MANUAL DELETION: ' + threadId + ' (' + name + ', ' + email + ') -- decline language found in this thread. A follow-up draft likely already exists in Joana\'s Drafts folder for this lead and should be deleted by hand. Thread link: https://mail.google.com/mail/u/0/#all/' + threadId);
      flagged++;
    }
  }

  Logger.log('auditActiveSalesDraftsForDeclines COMPLETE. Checked ' + checked + ' active draft(s). Flagged ' + flagged + ' for manual review/deletion (see lines above for direct thread links). All flagged rows set to STOPPED so the cadence will not continue past them, but the existing Gmail draft itself must be deleted by hand.');
}

// ---------- ADVANCING ----------

function advancePodcastSalesFollowUps() {
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const queueTab = ss.getSheetByName(PODCAST_SALES_QUEUE_TAB);
  const stateDirectory = loadStateDirectory();
  const data = queueTab.getDataRange().getValues();
  let advanced = 0;
  let completed = 0;
  let stopped = 0;
  let capSkipped = 0;
  let declineStopped = 0;
  let currentDraftCount = countActiveApprovalDrafts(); // live running count, checked before every new draft

  for (let r = 1; r < data.length; r++) {
    const row = data[r];
    const [threadId, name, email, originalReplyTime, currentStep, , status, nextDue, draftedText] = row;
    if (status === 'STOPPED' || status === 'COMPLETE' || status === 'HELD') continue;

    let thread;
    try {
      thread = GmailApp.getThreadById(threadId);
    } catch (e) {
      Logger.log('advancePodcastSalesFollowUps -- could not open thread ' + threadId + ': ' + e);
      continue;
    }
    if (!thread) continue;

    const messages = thread.getMessages();
    const last = messages[messages.length - 1];
    const lastSenderEmail = extractEmail(last.getFrom());

    if (!isInternal(lastSenderEmail) && currentStep > 0) {
      queueTab.getRange(r + 1, 7).setValue('STOPPED');
      Logger.log('advancePodcastSalesFollowUps -- STOPPED: ' + threadId + ' (' + name + ') -- lead replied again before we followed up, treating as active conversation, not automating further.');
      stopped++;
      continue;
    }

    if (threadContainsDecline(thread)) {
      queueTab.getRange(r + 1, 7).setValue('STOPPED');
      Logger.log('advancePodcastSalesFollowUps -- STOPPED (DECLINE DETECTED): ' + threadId + ' (' + name + ', ' + email + ') -- found decline language somewhere in this thread. NOT drafting a follow-up. If this thread already has a live draft from a previous run, it should be manually reviewed/deleted.');
      declineStopped++;
      continue;
    }

    if (String(status).indexOf('_SCHEDULE') > -1) {
      if (new Date() < new Date(nextDue)) continue;

      if (currentDraftCount >= FOLLOWUP_DRAFT_CAP) {
        Logger.log('advancePodcastSalesFollowUps -- CAP REACHED (' + FOLLOWUP_DRAFT_CAP + ' active drafts) -- skipping draft for ' + threadId + ' (' + name + '), left at _SCHEDULE, will draft on a future run once room opens.');
        capSkipped++;
        continue;
      }

      const nextStep = currentStep + 1;
      if (nextStep > 2) continue;

      const note = buildSchedulingNote(new Date(originalReplyTime));
      let body;


      if (nextStep === 1) {
        body = PODCAST_SALES_TEMPLATES[1].replace('{{name}}', name || 'there');
      } else {
        const subject = thread.getFirstMessageSubject();
        const state = extractStateFromSubject(subject);
        const matchedShow = state ? stateDirectory[normalizeState(state)] : null;
        if (matchedShow) {
          body = 'Hi ' + (name || 'there') + ', Totally understand if starting your own show isn\'t the right fit right now -- in the meantime, have you checked out "' +
            matchedShow.showName + '," in ' + state + '? If being a guest ever sounds interesting, we\'d love to have you on! ' + matchedShow.link;
        } else {
          body = 'Hi ' + (name || 'there') + ', Totally understand if starting your own show isn\'t the right fit right now -- if being a guest on a podcast within our network ever sounds interesting, we\'ve got a huge network you can tap into: [our guest network](HUB_LINK)';
        }
      }
      body = substituteLinkTokens(body);
      const plainBody = markdownLinksToPlain(body);
      const fullDraftText = note + plainBody + buildQuotedHistoryForReply(thread);

      GmailApp.createDraft(email, thread.getFirstMessageSubject().replace(/^(fwd:\s*)+/i, '').trim(), fullDraftText, { cc: CONFIG.NETWORK_CC_ON_REPLY });

      queueTab.getRange(r + 1, 5).setValue(nextStep);
      queueTab.getRange(r + 1, 6).setValue(new Date());
      queueTab.getRange(r + 1, 7).setValue('AWAITING_STEP_' + nextStep + '_APPROVAL');
      queueTab.getRange(r + 1, 9).setValue(plainBody);
      Logger.log('advancePodcastSalesFollowUps -- ADVANCED: ' + threadId + ' (' + name + ', ' + email + ') Step ' + currentStep + ' -> ' + nextStep + ', draft created, now AWAITING_STEP_' + nextStep + '_APPROVAL');
      advanced++;
      currentDraftCount++;
      continue;
    }

    if (String(status).indexOf('_APPROVAL') > -1) {
      const draftCreatedAt = new Date(row[5]);
      if (isInternal(lastSenderEmail) && last.getDate() > draftCreatedAt) {
        logFollowUpLearning('Podcast Sales', name, email, currentStep, draftedText, last.getPlainBody());
        if (currentStep >= 2) {
          queueTab.getRange(r + 1, 7).setValue('COMPLETE');
          Logger.log('advancePodcastSalesFollowUps -- COMPLETE: ' + threadId + ' (' + name + ') finished both follow-up steps.');
          completed++;
        } else {
          const due = addWorkingDays(last.getDate(), FOLLOWUP_WORKING_DAYS_GAP);
          queueTab.getRange(r + 1, 7).setValue('AWAITING_STEP_' + (currentStep + 1) + '_SCHEDULE');
          queueTab.getRange(r + 1, 8).setValue(due);
          Logger.log('advancePodcastSalesFollowUps -- draft was sent for ' + threadId + ' (' + name + '), Step ' + currentStep + ' -> next due ' + due);
        }
      }
    }
  }

  Logger.log('advancePodcastSalesFollowUps complete. Advanced ' + advanced + ', completed ' + completed + ', stopped ' + stopped + ', STOPPED FOR DECLINE ' + declineStopped + ', skipped due to cap ' + capSkipped + '. Live draft count now ~' + currentDraftCount + '/' + FOLLOWUP_DRAFT_CAP + '.');
}

function advanceHubGuestFollowUps() {
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const queueTab = ss.getSheetByName(HUB_GUEST_QUEUE_TAB);
  const bensTab = ss.getSheetByName(BENS_CALL_LIST_TAB_V2);
  const data = queueTab.getDataRange().getValues();
  let advanced = 0;
  let completed = 0;
  let stopped = 0;
  let capSkipped = 0;
  let currentDraftCount = countActiveApprovalDrafts(); // shared cap counted across BOTH cadences

  for (let r = 1; r < data.length; r++) {
    const row = data[r];
    const [threadId, name, email, state, showName, showLink, originalReplyTime, currentStep, , status, nextDue, draftedText] = row;
    if (status === 'STOPPED' || status === 'COMPLETE' || status === 'HELD') continue;

    let thread;
    try {
      thread = GmailApp.getThreadById(threadId);
    } catch (e) {
      Logger.log('advanceHubGuestFollowUps -- could not open thread ' + threadId + ': ' + e);
      continue;
    }
    if (!thread) continue;

    const messages = thread.getMessages();
    const last = messages[messages.length - 1];
    const lastSenderEmail = extractEmail(last.getFrom());

    if (!isInternal(lastSenderEmail) && currentStep > 0) {
      queueTab.getRange(r + 1, 10).setValue('STOPPED');
      Logger.log('advanceHubGuestFollowUps -- STOPPED: ' + threadId + ' (' + name + ') -- lead replied again, treating as active conversation.');
      stopped++;
      continue;
    }

    if (String(status).indexOf('_SCHEDULE') > -1) {
      if (new Date() < new Date(nextDue)) continue;

      if (currentDraftCount >= FOLLOWUP_DRAFT_CAP) {
        Logger.log('advanceHubGuestFollowUps -- CAP REACHED (' + FOLLOWUP_DRAFT_CAP + ' active drafts) -- skipping draft for ' + threadId + ' (' + name + '), left at _SCHEDULE, will draft on a future run once room opens.');
        capSkipped++;
        continue;
      }

      const nextStep = currentStep + 1;
      if (nextStep > 2) continue;

      const note = buildSchedulingNote(new Date(originalReplyTime));
      const template = HUB_GUEST_TEMPLATES[nextStep];
      const plainBody = template.replace('{{name}}', name || 'there').replace(/{{show}}/g, showName);
      const fullDraftText = note + plainBody + buildQuotedHistoryForReply(thread);

      GmailApp.createDraft(email, thread.getFirstMessageSubject().replace(/^(fwd:\s*)+/i, '').trim(), fullDraftText, { cc: CONFIG.NETWORK_CC_ON_REPLY });

      queueTab.getRange(r + 1, 8).setValue(nextStep);
      queueTab.getRange(r + 1, 9).setValue(new Date());
      queueTab.getRange(r + 1, 10).setValue('AWAITING_STEP_' + nextStep + '_APPROVAL');
      queueTab.getRange(r + 1, 12).setValue(plainBody);
      Logger.log('advanceHubGuestFollowUps -- ADVANCED: ' + threadId + ' (' + name + ', ' + email + ') Step ' + currentStep + ' -> ' + nextStep + ', draft created, now AWAITING_STEP_' + nextStep + '_APPROVAL');
      advanced++;
      currentDraftCount++;
      continue;
    }

    if (String(status).indexOf('_APPROVAL') > -1) {
      const draftCreatedAt = new Date(row[8]);
      if (isInternal(lastSenderEmail) && last.getDate() > draftCreatedAt) {
        logFollowUpLearning('Hub Guest', name, email, currentStep, draftedText, last.getPlainBody());
        if (currentStep >= 2) {
          bensTab.appendRow([new Date(), name, email, state, showName, 'https://mail.google.com/mail/u/0/#all/' + threadId]);
          queueTab.getRange(r + 1, 10).setValue('COMPLETE');
          Logger.log('advanceHubGuestFollowUps -- COMPLETE, moved to Bens Call List: ' + threadId + ' (' + name + ')');
          completed++;
        } else {
          const due = addWorkingDays(last.getDate(), FOLLOWUP_WORKING_DAYS_GAP);
          queueTab.getRange(r + 1, 10).setValue('AWAITING_STEP_' + (currentStep + 1) + '_SCHEDULE');
          queueTab.getRange(r + 1, 11).setValue(due);
          Logger.log('advanceHubGuestFollowUps -- draft was sent for ' + threadId + ' (' + name + '), Step ' + currentStep + ' -> next due ' + due);
        }
      }
    }
  }

  Logger.log('advanceHubGuestFollowUps complete. Advanced ' + advanced + ', completed ' + completed + ', stopped ' + stopped + ', skipped due to cap ' + capSkipped + '. Live draft count now ~' + currentDraftCount + '/' + FOLLOWUP_DRAFT_CAP + '.');
}