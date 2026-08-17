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
const NEEDS_CLASSIFICATION_REVIEW_TAB = 'Needs Classification Review';

// SAFETY NET (17 Aug 2026, real incident): classifyAndDraft() in Code.gs
// sometimes assigns no_decline to a reply that's actually a scheduling
// constraint or an info request -- exactly the mistake that caused
// Montell/Mariann/Mumu to get drafted as declines. The system prompt now
// reinforces the SOP's own distinction more forcefully, but an LLM
// judgment call can still be wrong on a given reply, so this is a
// deterministic second check specifically gating what's allowed to enter
// the automated Hub Guest follow-up cadence: if a no_decline reply
// contains one of these signal phrases, don't trust the classification --
// route it to a human instead of silently enrolling it. This does not
// touch classifyAndDraft() itself or the direct reply already drafted;
// it only gates whether THIS cadence acts on that category automatically.
const AMBIGUOUS_NO_DECLINE_SIGNALS = /(send (me |)(the |)(info|information|framework|details|samples)|tell me more|know more about|what('s| is) involved|how (does|would) (this|it) work|not (right now|available) (this week|today|right now)\b|maybe (later|next|in a) (week|month)|can we (talk|chat|discuss) (later|next)|too (busy|swamped) (this|right now)|out of (town|office) (this week|until)|reach (me|out) (again|later)|circle back|touch base (later|next))/i;
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
const FOLLOWUP_DRAFT_CAP = 5;

// DAILY CREATION CAP (15 Aug 2026, per Kris): in addition to the total
// pending-approval ceiling above, cap how many NEW follow-up drafts get
// created per Pacific day across both cadences -- so Goodness gets a
// processable batch of ~100 each day rather than an unbounded flood. The
// counter lives in Script Properties and self-resets each Pacific day.
// Adjust here, same as the total cap.
//
// TEMPORARILY DROPPED TO 5 (17 Aug 2026): a live audit found Hub Guest
// follow-up drafts being generated for leads whose ORIGINAL reply was a
// clear expression of interest (e.g. "Sure, I'd like to hear more",
// "Yes, you can call") but got classified no_decline upstream in
// classifyAndDraft(), so the follow-up cadence treated them as a decline
// and pushed a guest-invite nudge instead. Both caps dropped to 5 so
// Goodness can review a small batch and confirm quality before this
// reopens to its normal ~100/day volume -- raise both back once
// confirmed good.
const FOLLOWUP_DAILY_DRAFT_CAP = 5;

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

// ---------- CONTEXT-AWARE FOLLOW-UP DRAFTING (15 Aug 2026) ----------
//
// Replaces the static HUB_GUEST_TEMPLATES strings, which Joana was rewriting
// from scratch on nearly every send (7/7 real examples in Goodness's feedback
// doc). Root cause: a fixed template has zero awareness of WHY the lead
// declined, so it re-pitched people who had said "not for me," ignored stated
// reasons (income, admin role, retiring), and never hyperlinked the show.
//
// classifyAndDraftFollowUp() mirrors the classifyAndDraft() pattern in
// Code.gs: one Claude call that both classifies the lead's situation and
// drafts the appropriate reply for it. The system prompt comes from the
// "## FOLLOW-UP DRAFTING" section of the same live SOP Doc the main drafter
// reads (editable there, version history included), with a hardcoded
// fallback below if that section is ever missing. Uses the existing
// callLlmWithFallback() (Kimi primary, Anthropic fallback -- see
// quota_guard_and_alerting.gs) -- no new infrastructure.
//
// Hub Guest only for now. Podcast Sales stays on PODCAST_SALES_TEMPLATES
// until the Follow-Up Learning Log shows whether Joana rewrites those too.

function buildFollowUpSystemPrompt() {
  try {
    const doc = DocumentApp.openById(CONFIG.SOP_DOC_ID);
    const fullText = doc.getBody().getText();
    // Match the heading even if it has trailing parenthetical text, matching
    // the Doc's real style (e.g. "## Tone (confirmed from real usage)"). The
    // heading still must START with exactly "## FOLLOW-UP DRAFTING".
    const marker = fullText.match(/^##\s*FOLLOW-UP DRAFTING\b[^\n]*$/im);
    if (marker) {
      const rest = fullText.slice(fullText.indexOf(marker[0]) + marker[0].length);
      const nextHeading = rest.search(/^##\s+\S/m);
      const section = (nextHeading === -1 ? rest : rest.slice(0, nextHeading)).trim();
      if (section.length > 200) {
        Logger.log('Follow-up SOP: loaded "## FOLLOW-UP DRAFTING" section from Doc (' + section.length + ' chars).');
        return section;
      }
      Logger.log('WARNING: "## FOLLOW-UP DRAFTING" SOP section suspiciously short (' + section.length + ' chars). Using fallback prompt.');
    } else {
      Logger.log('WARNING: no "## FOLLOW-UP DRAFTING" section found in SOP Doc. Using fallback prompt.');
    }
  } catch (e) {
    Logger.log('WARNING: could not read SOP Doc for follow-up prompt, using fallback: ' + e);
  }

  return `You are drafting follow-up emails for Joana Peixe, Podcast Network Manager at Icons of Real Estate. She invited a real estate agent to be a guest on a state-specific podcast; you are writing the follow-up a few working days later. Never mention you are an AI. Warm, brief, first-name only, low-pressure. Plain text only -- no markdown; paste any link as a raw URL.

The one thing you must NEVER do is send a generic "just following up, can we book you?" nudge to a lead who already told you why they passed. Read what they actually said and respond to that:
- Reason with a real counter ("not for me", "too new"): counter ONCE, warmly and substantively, then close low-pressure.
- Wrong fit for the offer (e.g. administrative role): thank them, agree it doesn't fit, ask for a referral to the right person.
- Life/business hardship (e.g. income): pure empathy, no pitch at all, door left open.
- Leaving the industry: pivot to the affiliate/referral program instead of the guest pitch.
- Never replied at all: a gentle "floating this back to the top of your inbox, no pressure" bump with the show link.
- Clear hard decline / told you to stop: do not draft (return action "stop").
When referencing the show, ALWAYS include the exact show URL given to you, verbatim, as a raw URL. STEP 2 is always the final message: short, gracious, the invite stands, no new asks.`;
}

// One Claude call per follow-up draft. Classifies the lead's situation from
// the actual thread, then drafts the right shape of reply for it -- counter,
// referral-ask, empathy close, affiliate pivot, gentle bump, or nothing at all.
// Returns { action: 'draft'|'stop', leadState, draftBody } or null on failure
// (caller leaves the row at _SCHEDULE so it retries on the next daily run).
function classifyAndDraftFollowUp(systemPrompt, ctx) {
  // ctx: { name, email, state, showName, showLink, step, thread }
  const messages = ctx.thread.getMessages();
  const threadContext = buildThreadContext(messages);

  // Isolate the lead's own most recent words -- that is what the draft must
  // respond to. Null means they never replied (pure bump case).
  let lastLeadText = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const sender = extractEmail(messages[i].getFrom());
    if (!isInternal(sender)) {
      lastLeadText = extractProspectFreshReplyText(messages[i]).slice(0, 1500);
      break;
    }
  }

  const stepBlock = ctx.step === 1
    ? 'This is STEP 1 of 2 -- the first follow-up after the guest invite.'
    : 'This is STEP 2 of 2 -- the FINAL message this lead will ever receive in this cadence. Regardless of their situation: short, gracious, no new asks, the invite stands. The only exception is a hard decline, which gets action "stop" instead.';

  const userPrompt = `LEAD FIRST NAME: ${ctx.name || 'there'}
SHOW NAME: ${ctx.showName}
SHOW URL (use verbatim, as a raw URL, whenever you reference the show or guest spot): ${ctx.showLink}
LEAD'S STATE: ${ctx.state || 'unknown'}
JOANA'S ZOOM LINK (only if a quick call is the natural next step, e.g. countering an objection from an engaged lead): ${CONFIG.BOOKING_LINK_URL}

${stepBlock}

LEAD'S MOST RECENT MESSAGE:
${lastLeadText ? lastLeadText : '(the lead has never replied -- this is a no-response bump)'}

FULL THREAD (oldest to newest):
${threadContext}

Return ONLY a JSON object, no markdown fences, no preamble, with this exact shape:
{
  "lead_state": "objection_counter | wrong_fit | life_circumstance | leaving_industry | guest_ok | no_response | hard_decline",
  "action": "draft | stop",
  "reasoning": "one sentence",
  "draft_body": "the full plain-text follow-up in Joana's voice -- no subject line, no markdown, links as raw URLs, one warm closing line"
}

Set action to "stop" ONLY for a clear hard decline or an explicit request to stop contacting them (draft_body can be empty in that case). Everything else gets action "draft".`;

  const data = callLlmWithFallback(systemPrompt, userPrompt, 2000, 'classifyAndDraftFollowUp');
  const textBlock = data.content.find(c => c.type === 'text');
  if (!textBlock) {
    Logger.log('classifyAndDraftFollowUp -- no text block in response, stop_reason: ' + data.stop_reason);
    return null;
  }

  let parsed;
  try {
    const cleaned = textBlock.text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    parsed = JSON.parse(cleaned);
  } catch (e) {
    Logger.log('classifyAndDraftFollowUp -- failed to parse JSON: ' + textBlock.text);
    return null;
  }

  return {
    action: parsed.action === 'stop' ? 'stop' : 'draft',
    leadState: parsed.lead_state || 'unknown',
    draftBody: (parsed.draft_body || '').trim(),
  };
}

// ---------- MANUAL TEST HELPER (no draft created, safe to run anytime) ----------
// Paste a real thread ID from the Hub Guest queue to see exactly what Claude
// would draft for it (classification + body) WITHOUT touching Gmail. Use this
// to sanity-check prompt edits before letting runLeadFollowUpCycle() draft
// for real.
function testFollowUpDraftForThread(threadId, step) {
  const thread = GmailApp.getThreadById(threadId);
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const row = ss.getSheetByName(HUB_GUEST_QUEUE_TAB).getDataRange().getValues()
    .find(r => r[0] === threadId);
  if (!row) { Logger.log('Thread ' + threadId + ' not found in Hub Guest queue.'); return; }
  const result = classifyAndDraftFollowUp(buildFollowUpSystemPrompt(), {
    name: row[1], email: row[2], state: row[3], showName: row[4], showLink: row[5],
    step: step || 1, thread: thread,
  });
  Logger.log('TEST RESULT for ' + row[1] + ' <' + row[2] + '>:');
  Logger.log(JSON.stringify(result, null, 2));
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

// REMOVED (15 Aug 2026): HUB_GUEST_TEMPLATES deleted. The Hub Guest cadence no
// longer uses static {{name}}/{{show}} strings -- Joana was rewriting nearly
// every one from scratch (7/7 real examples in Goodness's feedback doc) because
// a fixed template has zero awareness of WHY the lead declined. Hub Guest
// follow-up bodies are now drafted per-lead by classifyAndDraftFollowUp()
// below. Podcast Sales keeps its static template for now.

// ---------- MAIN ENTRY POINT ----------

// ---------- WRONG-ACCOUNT GUARD (15 Aug 2026, real incident) ----------
// Kris accidentally ran a follow-up function under his own account
// (kris@iconsofrealestate.com) instead of Joana's. The whole system is bound
// to Joana's inbox -- drafts must be created in HER Gmail, against HER
// threads -- so running as anyone else silently reads/drafts the wrong
// mailbox. This is the exact "wrong account" trap the migration handoff
// warned about. Guard: entry points call assertRunningAsJoana() first and
// bail out (with a clear log of which account was actually detected) when it
// isn't her. getActiveUser() can return blank for privacy reasons, so we fall
// back to getEffectiveUser() (the account the script runs as).
const EXPECTED_RUN_ACCOUNT = 'joana@iconsofrealestate.com';

function getRunningAccountEmail() {
  try {
    const active = Session.getActiveUser().getEmail();
    if (active) return active.toLowerCase();
  } catch (e) { /* fall through to effective user */ }
  try {
    return (Session.getEffectiveUser().getEmail() || '').toLowerCase();
  } catch (e) {
    return '';
  }
}

// Returns true if running as Joana. Otherwise (UPGRADED 17 Aug 2026, real
// incident): the original version just logged a line and returned false --
// which meant a wrong-account trigger firing showed up as a perfectly normal
// "completed" execution in the Executions view, indistinguishable from a
// real successful run unless someone happened to open that specific row's
// log. That's exactly how the "Other user" triggers went unnoticed. Now it
// throws (so the execution shows red/Failed, visible at a glance in the
// Executions list) AND emails Kris via sendOpsAlert (rate-limited to once
// per callerName per day, so a trigger firing every 5 minutes doesn't spam).
// Existing call sites written as `if (!assertRunningAsJoana(...)) return;`
// still work unchanged -- the throw interrupts before that check is ever
// evaluated false.
function assertRunningAsJoana(callerName) {
  const account = getRunningAccountEmail();
  if (account === EXPECTED_RUN_ACCOUNT) return true;

  const message = callerName + ' fired under the wrong account ("' + (account || 'UNKNOWN') +
    '" instead of ' + EXPECTED_RUN_ACCOUNT + '"). No action was taken. This means a trigger for ' +
    callerName + ' exists under a different Google account -- see deleteAllMyTriggers() in ' +
    'setup_all_triggers.gs (that account has to run it themselves; this account cannot see or ' +
    'delete another user\'s triggers).';
  Logger.log('ABORT (' + callerName + '): ' + message);
  sendOpsAlert('Wrong-account trigger fired: ' + callerName, message);
  throw new Error(message);
}

// PAUSED (17 Aug 2026, real incident): classifyAndDraft() in Code.gs has
// been caught mislabeling genuinely-interested replies (e.g. "Sure, I'd
// like to hear more", "Yes, you can call") as no_decline. This cadence
// correctly trusts that recorded category and re-derives the email
// correctly -- the poison is upstream, not here -- but that means it keeps
// drafting wrong "sorry that's not for you, want to be a guest?" nudges to
// leads who never declined. Pausing DRAFT CREATION for this cadence only
// until the upstream classification issue is actually fixed. Registration
// still runs (harmless bookkeeping, no drafts). Flip back to true once the
// classification fix is confirmed good.
const HUB_GUEST_FOLLOWUPS_ENABLED = false;

function runLeadFollowUpCycle() {
  if (!assertRunningAsJoana('runLeadFollowUpCycle')) return;
  ensureFollowUpTabsExistV2();
  // SELF-HEAL (15 Aug 2026): reconcile BEFORE registering/advancing, so any
  // row stuck at "_APPROVAL" whose draft was deleted (manually or via a wipe)
  // resets to "_SCHEDULE" and gets redrafted this same cycle instead of
  // waiting forever. Closes the phantom-row gap the handoff flagged -- a
  // deleted draft used to leave its queue row permanently stuck. Runs every
  // cycle now, not just by hand.
  reconcileFollowUpDrafts();
  registerNewPodcastSalesLeads();
  registerNewHubGuestInvites();
  advancePodcastSalesFollowUps();
  if (HUB_GUEST_FOLLOWUPS_ENABLED) {
    advanceHubGuestFollowUps();
  } else {
    Logger.log('Hub Guest follow-up drafting SKIPPED -- HUB_GUEST_FOLLOWUPS_ENABLED is false pending a fix to the upstream no_decline misclassification. Registration still ran; no new drafts created for this cadence.');
  }
  Logger.log('Lead follow-up cycle complete (Podcast Sales active, Hub Guest paused).');
}

function runFollowUpDeepDiveBackfill() {
  if (!assertRunningAsJoana('runFollowUpDeepDiveBackfill')) return;
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
  const ambiguousFlags = []; // accumulated for ONE batched alert at the end, not one email per lead

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

    const originalReplyMsg = messages[0];

    // SAFETY NET (17 Aug 2026, real incident): re-scan the prospect's ACTUAL
    // original reply text (not the AI's drafted reply) before trusting a
    // no_decline classification enough to auto-enroll it. See
    // AMBIGUOUS_NO_DECLINE_SIGNALS above for why.
    const prospectReplyText = extractProspectFreshReplyText(originalReplyMsg);
    if (AMBIGUOUS_NO_DECLINE_SIGNALS.test(prospectReplyText)) {
      Logger.log('registerNewHubGuestInvites -- SKIPPED (ambiguous no_decline, looks like a scheduling constraint or info request -- flagged for human review instead): ' + threadId + ' -- "' + prospectReplyText.slice(0, 200) + '"');
      const wasNew = flagAmbiguousNoDeclineForReview(threadId, subject, realEmail, prospectReplyText);
      if (wasNew) ambiguousFlags.push({ threadId: threadId, subject: subject, email: realEmail, excerpt: prospectReplyText.slice(0, 200) });
      return;
    }

    const name = extractNameFromSubject(subject) || 'there';
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

  Logger.log('registerNewHubGuestInvites complete. Enrolled ' + enrolled + ' new lead(s), flagged ' + ambiguousFlags.length + ' ambiguous no_decline(s) for review.');

  if (ambiguousFlags.length > 0) {
    const lines = ambiguousFlags
      .map(f => '- "' + f.subject + '" (' + f.email + '): "' + f.excerpt + '" -- https://mail.google.com/mail/u/0/#all/' + f.threadId)
      .join('\n');
    sendOpsAlert(
      ambiguousFlags.length + ' ambiguous no_decline(s) need a human look',
      'classifyAndDraft() categorized these as no_decline, but the prospect\'s actual reply looks like it might be a ' +
      'scheduling constraint or info request instead of a real decline -- exactly the pattern that caused ' +
      'Montell/Mariann/Mumu to get drafted as declines earlier. Registration into the Hub Guest follow-up queue was ' +
      'skipped for all of these; logged in the "' + NEEDS_CLASSIFICATION_REVIEW_TAB + '" tab for a manual check:\n\n' + lines
    );
  }
}

// Logs an ambiguous no_decline to the review tab, deduped by Thread ID.
// Returns true if this was a NEW flag (caller batches these into one
// summary alert rather than emailing per-lead), false if already logged.
function flagAmbiguousNoDeclineForReview(threadId, subject, email, replyExcerpt) {
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  let tab = ss.getSheetByName(NEEDS_CLASSIFICATION_REVIEW_TAB);
  if (!tab) {
    tab = ss.insertSheet(NEEDS_CLASSIFICATION_REVIEW_TAB);
    tab.appendRow(['Flagged At', 'Thread ID', 'Subject', 'Prospect Email', 'Prospect Reply Excerpt', 'Thread Link', 'Status (pending/confirmed_decline/actually_interested)']);
  }

  const alreadyFlagged = new Set(
    tab.getDataRange().getValues().slice(1).map(row => row[1])
  );
  if (alreadyFlagged.has(threadId)) return false;

  tab.appendRow([
    new Date(), threadId, subject, email, replyExcerpt.slice(0, 500),
    'https://mail.google.com/mail/u/0/#all/' + threadId, 'pending'
  ]);
  return true;
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

// ---------- DAILY DRAFT-CREATION CAP (15 Aug 2026) ----------

// The daily cap is anchored to the timezone Goodness actually works in, NOT
// the quota-guard's Pacific day. Goodness processes drafts on a European
// workday, so "100 per day" should mean "100 per European day" -- otherwise
// the counter rolls over mid-afternoon her time (midnight Pacific = ~8-9 AM
// Europe) and the daily batch logic drifts off her real workday.
function todayFollowUpDateString() {
  return Utilities.formatDate(new Date(), 'Europe/Paris', 'yyyy-MM-dd');
}

// How many follow-up drafts have already been created today (Europe/Paris).
// Self-resets: if the stored date isn't today, the count is effectively 0.
function getFollowUpDraftsCreatedToday() {
  const props = PropertiesService.getScriptProperties();
  const storedDate = props.getProperty('FOLLOWUP_DRAFTS_CREATED_DATE');
  if (storedDate !== todayFollowUpDateString()) return 0;
  return parseInt(props.getProperty('FOLLOWUP_DRAFTS_CREATED_COUNT') || '0', 10);
}

function incrementFollowUpDraftsCreatedToday() {
  const props = PropertiesService.getScriptProperties();
  props.setProperty('FOLLOWUP_DRAFTS_CREATED_DATE', todayFollowUpDateString());
  props.setProperty('FOLLOWUP_DRAFTS_CREATED_COUNT', String(getFollowUpDraftsCreatedToday() + 1));
}

// ---------- ONE-OFF WIPE + REDRAFT (15 Aug 2026, per Kris) ----------
// Deletes the ~450 bad follow-up drafts (static-template era) sitting in
// Goodness's Drafts folder, so they can be redrafted fresh by the new
// context-aware classifyAndDraftFollowUp(). DESTRUCTIVE and irreversible.
//
// Safety:
//   - DRY-RUN BY DEFAULT: with applyDeletions=false (the default) it only
//     LOGS what it would delete, deleting nothing. Run that first, read the
//     log, then run with true to actually delete.
//   - ONLY touches a Gmail draft if its recipient matches a lead currently
//     sitting at an "_APPROVAL" status in one of the two follow-up queues.
//     Any other draft in her folder is left alone.
//   - After deleting, calls reconcileFollowUpDrafts() so every affected row
//     resets from "_APPROVAL" back to "_SCHEDULE" (due now) and redrafts on
//     the next runLeadFollowUpCycle() -- respecting both FOLLOWUP_DRAFT_CAP
//     and FOLLOWUP_DAILY_DRAFT_CAP, so the refill is ~100/day, not 450 at once.
function wipeFollowUpQueueDrafts(applyDeletions) {
  if (!assertRunningAsJoana('wipeFollowUpQueueDrafts')) return;
  const apply = applyDeletions === true;
  Logger.log('wipeFollowUpQueueDrafts -- mode: ' + (apply ? 'APPLY (will delete)' : 'DRY RUN (nothing deleted)'));

  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);

  // Collect the set of lead emails that have a live follow-up draft pending.
  const queueEmails = new Set();
  [
    { tabName: PODCAST_SALES_QUEUE_TAB, statusCol: 7, emailCol: 3 },
    { tabName: HUB_GUEST_QUEUE_TAB, statusCol: 10, emailCol: 3 }
  ].forEach(cfg => {
    const tab = ss.getSheetByName(cfg.tabName);
    if (!tab) return;
    const data = tab.getDataRange().getValues();
    for (let r = 1; r < data.length; r++) {
      const status = data[r][cfg.statusCol - 1];
      if (status && String(status).indexOf('_APPROVAL') > -1) {
        const email = String(data[r][cfg.emailCol - 1] || '').toLowerCase().trim();
        if (email) queueEmails.add(email);
      }
    }
  });
  Logger.log('wipeFollowUpQueueDrafts -- ' + queueEmails.size + ' unique lead email(s) pending approval across both queues.');

  // BATCHED + RESUMABLE (15 Aug 2026): the first version tried to delete all
  // ~276 drafts in one Apps Script execution and blew past the ~6-minute
  // runtime limit ("Lost connection to the server"). Now it deletes at most
  // WIPE_BATCH_SIZE drafts per run and stops well before the time limit, so
  // you just run it repeatedly until the log says 0 remaining. Each run is
  // independent and idempotent -- already-deleted drafts simply aren't found.
  const WIPE_BATCH_SIZE = 100;
  const MAX_RUNTIME_MS = 4.5 * 60 * 1000; // bail before the ~6-min limit
  const startMs = Date.now();

  let matched = 0;
  let deleted = 0;
  let failed = 0;
  let remaining = 0;
  const drafts = GmailApp.getDrafts();
  Logger.log('wipeFollowUpQueueDrafts -- got ' + drafts.length + ' total draft(s). Now scanning each recipient against the queue lead list...');
  for (let i = 0; i < drafts.length; i++) {
    // Heartbeat every 25 SCANNED (not just matched) so a long scan shows
    // constant movement instead of looking frozen.
    if (i > 0 && i % 25 === 0) {
      const elapsedSec = Math.round((Date.now() - startMs) / 1000);
      Logger.log('wipeFollowUpQueueDrafts -- scanned ' + i + '/' + drafts.length + ' drafts, ' + elapsedSec + 's elapsed, matched ' + matched + ' so far, deleted ' + deleted + '...');
    }

    const d = drafts[i];
    let msg;
    try { msg = d.getMessage(); } catch (e) { continue; } // draft being edited/deleted concurrently
    const to = (msg.getTo() || '').toLowerCase();
    let isQueueDraft = false;
    queueEmails.forEach(email => { if (to.indexOf(email) !== -1) isQueueDraft = true; });
    if (!isQueueDraft) continue;

    matched++;

    if (!apply) {
      Logger.log('wipeFollowUpQueueDrafts -- [DRY RUN] would delete draft to: ' + to);
      continue;
    }

    // Stop deleting once we hit the batch cap or the time budget; count the
    // rest as remaining so the log tells you to re-run.
    if (deleted >= WIPE_BATCH_SIZE || (Date.now() - startMs) > MAX_RUNTIME_MS) {
      remaining++;
      continue;
    }

    try {
      d.deleteDraft();
      deleted++;
      Logger.log('wipeFollowUpQueueDrafts -- DELETED draft to: ' + to + ' (' + deleted + ' this run)');
    } catch (e) {
      failed++;
      Logger.log('wipeFollowUpQueueDrafts -- FAILED to delete draft to ' + to + ': ' + e);
    }
  }

  Logger.log('wipeFollowUpQueueDrafts -- scan complete: ' + drafts.length + ' drafts scanned.');
  Logger.log('wipeFollowUpQueueDrafts -- matched ' + matched + ' queue draft(s) in Gmail. ' +
    (apply
      ? ('Deleted ' + deleted + ' this run, failed ' + failed + ', still remaining ' + remaining + '. ' +
         (remaining > 0 ? 'RE-RUN wipeFollowUpQueueDrafts(true) to delete the next batch.' : 'All matched drafts deleted.'))
      : 'DRY RUN -- nothing deleted. Re-run wipeFollowUpQueueDrafts(true) to actually delete.'));

  // Only reconcile once everything matched is gone; reconciling early would
  // reset rows whose drafts still exist (reconcileFollowUpDrafts leaves those
  // alone anyway, so this is just avoiding wasted work).
  if (apply && remaining === 0) {
    reconcileFollowUpDrafts();
    Logger.log('wipeFollowUpQueueDrafts -- queues reconciled. Affected rows reset to _SCHEDULE (due now) and will redraft on the next runLeadFollowUpCycle(), capped at ' + FOLLOWUP_DAILY_DRAFT_CAP + '/day and ' + FOLLOWUP_DRAFT_CAP + ' total pending.');
  }
}

// ---------- WIPE ALL SCRIPT-MADE DRAFTS (15 Aug 2026, per Kris) ----------
// Kris's requirement: delete EVERY draft the script created, but leave any
// draft Joana wrote by hand strictly alone. Queue membership is the WRONG
// signal for this -- it misses script drafts whose queue row already moved
// past _APPROVAL, and it could catch a manual draft Joana happened to address
// to a lead. The reliable discriminator is the scheduling note that
// buildSchedulingNote() prepends to every script-made follow-up draft:
//   "[SCHEDULING NOTE FOR JOANA -- DELETE THIS LINE BEFORE SENDING:"
// Joana's hand-written drafts never contain that line. So this wipes by BODY
// SIGNATURE, not queue membership.
//
// DESTRUCTIVE + irreversible. DRY-RUN BY DEFAULT (applyDeletions=false logs
// only). Batched + resumable like the queue wipe. Run under Joana's account.
const SCHEDULING_NOTE_SIGNATURE = '[SCHEDULING NOTE FOR JOANA';

function wipeScriptMadeDrafts(applyDeletions) {
  if (!assertRunningAsJoana('wipeScriptMadeDrafts')) return;
  const apply = applyDeletions === true;
  Logger.log('wipeScriptMadeDrafts -- mode: ' + (apply ? 'APPLY (will delete)' : 'DRY RUN (nothing deleted)') + '. Matching drafts by body signature "' + SCHEDULING_NOTE_SIGNATURE + '", NOT by queue membership. Joana-written drafts (no signature) are left alone.');

  const WIPE_BATCH_SIZE = 100;
  const MAX_RUNTIME_MS = 4.5 * 60 * 1000; // bail before the ~6-min limit
  const startMs = Date.now();

  let matched = 0;
  let deleted = 0;
  let failed = 0;
  let remaining = 0;

  Logger.log('wipeScriptMadeDrafts -- fetching draft list from Gmail (this can take a moment on a full folder)...');
  const drafts = GmailApp.getDrafts();
  Logger.log('wipeScriptMadeDrafts -- got ' + drafts.length + ' total draft(s). Now scanning each one\'s body for the script signature...');

  for (let i = 0; i < drafts.length; i++) {
    // Heartbeat every 25 SCANNED (not just matched) so a long scan shows
    // constant movement instead of looking frozen.
    if (i > 0 && i % 25 === 0) {
      const elapsedSec = Math.round((Date.now() - startMs) / 1000);
      Logger.log('wipeScriptMadeDrafts -- scanned ' + i + '/' + drafts.length + ' drafts, ' + elapsedSec + 's elapsed, matched ' + matched + ' script-made so far, deleted ' + deleted + '...');
    }

    const d = drafts[i];
    let msg;
    try { msg = d.getMessage(); } catch (e) { continue; } // being edited/deleted concurrently

    let body = '';
    try { body = msg.getPlainBody() || ''; } catch (e) { continue; }
    if (body.indexOf(SCHEDULING_NOTE_SIGNATURE) === -1) continue; // not script-made -- leave it (this is what protects Joana's drafts)

    matched++;

    if (!apply) {
      Logger.log('wipeScriptMadeDrafts -- [DRY RUN] MATCH script-made draft to: ' + (msg.getTo() || '').toLowerCase());
      continue;
    }

    if (deleted >= WIPE_BATCH_SIZE || (Date.now() - startMs) > MAX_RUNTIME_MS) {
      remaining++;
      continue;
    }

    try {
      d.deleteDraft();
      deleted++;
      Logger.log('wipeScriptMadeDrafts -- DELETED draft to: ' + (msg.getTo() || '').toLowerCase() + ' (' + deleted + ' deleted this run)');
    } catch (e) {
      failed++;
      Logger.log('wipeScriptMadeDrafts -- FAILED to delete draft: ' + e);
    }
  }

  const totalSec = Math.round((Date.now() - startMs) / 1000);
  Logger.log('wipeScriptMadeDrafts -- scan complete: ' + drafts.length + ' drafts scanned in ' + totalSec + 's.');

  Logger.log('wipeScriptMadeDrafts -- matched ' + matched + ' script-made draft(s). ' +
    (apply
      ? ('Deleted ' + deleted + ' this run, failed ' + failed + ', still remaining ' + remaining + '. ' +
         (remaining > 0 ? 'RE-RUN wipeScriptMadeDrafts(true) for the next batch.' : 'All script-made drafts deleted.'))
      : 'DRY RUN -- nothing deleted. Re-run wipeScriptMadeDrafts(true) to actually delete.'));

  // Reconcile queues once nothing script-made is left, so affected rows reset
  // to _SCHEDULE and redraft with the new code.
  if (apply && remaining === 0) {
    reconcileFollowUpDrafts();
    Logger.log('wipeScriptMadeDrafts -- queues reconciled (rows reset to _SCHEDULE, redraft on next cycle, capped at ' + FOLLOWUP_DAILY_DRAFT_CAP + '/day).');
  }
}

// ---------- FOLLOW-UP LEARNING DIGEST (15 Aug 2026, per Kris) ----------
// The follow-up system's equivalent of learning_loop.gs's
// generateSopSuggestions(), but reading the FOLLOW-UP LEARNING LOG (which the
// main reply-drafter's learning loop never touches) and targeting the SOP's
// "## FOLLOW-UP DRAFTING" section specifically.
//
// Goodness processes each day's batch of follow-up drafts; whenever she edits
// one before sending, logFollowUpLearning() has already recorded the drafted
// vs. sent text with Was Edited = true. This function batches those edited
// examples, asks Claude to find the repeated patterns in what she changed,
// and writes SPECIFIC proposed edits to the FOLLOW-UP DRAFTING section into
// the shared "SOP Suggestions" tab -- as PROPOSALS ONLY, never auto-applied.
// Kris reviews and merges the real ones into the live SOP Doc by hand (and
// then runs clearSopCache() so the next run picks the edit up immediately).
// Deliberately unsupervised-rewrite-free, same as the main learning loop.
//
// Run daily (e.g. after Goodness finishes her batch). Safe to re-run:
// reviewed rows are marked so they aren't re-batched.
function summarizeFollowUpLearning() {
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const logTab = ss.getSheetByName(FOLLOWUP_LEARNING_LOG_TAB);
  let suggestionsTab = ss.getSheetByName('SOP Suggestions');
  if (!logTab) {
    Logger.log('summarizeFollowUpLearning -- "' + FOLLOWUP_LEARNING_LOG_TAB + '" tab not found, nothing to review yet.');
    return;
  }
  if (!suggestionsTab) {
    suggestionsTab = ss.insertSheet('SOP Suggestions');
    suggestionsTab.appendRow(['Generated At', 'Based On N Edits', 'Suggested Change', 'Status (pending/approved/rejected)']);
  }

  const rows = logTab.getDataRange().getValues();
  if (rows.length <= 1) {
    Logger.log('summarizeFollowUpLearning -- Learning Log has no data rows yet.');
    return;
  }
  const headers = rows[0];
  const wasEditedCol = headers.indexOf('Was Edited');
  const cadenceCol = headers.indexOf('Cadence');
  const stepCol = headers.indexOf('Step');
  const draftedCol = headers.indexOf('Drafted Text');
  const sentCol = headers.indexOf('Sent Text');
  const reviewedCol = headers.indexOf('Reviewed For SOP'); // may not exist yet on this tab

  const edits = [];
  const rowIndexesToMark = [];
  for (let i = 1; i < rows.length; i++) {
    const wasEdited = rows[i][wasEditedCol] === true || String(rows[i][wasEditedCol]).toLowerCase() === 'true';
    const alreadyReviewed = reviewedCol !== -1 && (rows[i][reviewedCol] === true || String(rows[i][reviewedCol]).toLowerCase() === 'true');
    if (!wasEdited || alreadyReviewed) continue;
    edits.push({
      cadence: rows[i][cadenceCol],
      step: rows[i][stepCol],
      drafted: rows[i][draftedCol],
      sent: rows[i][sentCol]
    });
    rowIndexesToMark.push(i + 1); // 1-indexed sheet row, plus header
  }

  if (edits.length === 0) {
    Logger.log('summarizeFollowUpLearning -- no new edited follow-up examples to review.');
    return;
  }

  // CAPPED (17 Aug 2026, real incident): same fix as generateSopSuggestions()
  // in learning_loop.gs -- dumping ALL unreviewed edits into one LLM call
  // has no ceiling and will eventually exceed any provider's context window
  // (confirmed there: 74 edits at once produced a 1.2M-token request against
  // Kimi's 262K limit). Bounding the batch here too, before this cadence
  // ever accumulates a large enough backlog to hit the same wall.
  const SOP_SUGGESTIONS_BATCH_SIZE = 15;
  const deferredCount = Math.max(0, edits.length - SOP_SUGGESTIONS_BATCH_SIZE);
  const batchEdits = edits.slice(0, SOP_SUGGESTIONS_BATCH_SIZE);
  const batchRowIndexes = rowIndexesToMark.slice(0, SOP_SUGGESTIONS_BATCH_SIZE);
  if (deferredCount > 0) {
    Logger.log('summarizeFollowUpLearning -- ' + edits.length + ' unreviewed edits found; processing ' + batchEdits.length + ' this run, deferring ' + deferredCount + ' to the next run(s).');
  }

  const examplesText = batchEdits
    .map((e, idx) => `EXAMPLE ${idx + 1} (cadence: ${e.cadence}, step: ${e.step})\n--- AI DRAFTED ---\n${e.drafted}\n--- GOODNESS ACTUALLY SENT ---\n${e.sent}`)
    .join('\n\n');

  const systemPrompt = `You review edited email follow-up drafts to find patterns in how a human editor changes AI-drafted follow-up emails, and propose specific, concrete updates to the "## FOLLOW-UP DRAFTING" section of the SOP that produced them. You are NOT rewriting the SOP yourself -- you propose changes for a human to review and approve. Be specific: quote the actual phrasing pattern repeated across edits, don't generalize vaguely. If the edits show no clear repeated pattern (all one-off stylistic tweaks with no common thread), say so plainly rather than inventing a pattern.`;

  const userPrompt = `Here are ${batchEdits.length} examples of AI-drafted follow-up emails versus what the human editor actually sent:\n\n${examplesText}\n\nReturn ONLY a JSON array, no markdown fences, no preamble, of specific suggested changes to the FOLLOW-UP DRAFTING section. Each item: {"pattern_observed": "...", "suggested_change": "...", "confidence": "high | medium | low"}. If there's truly no pattern worth acting on, return an empty array.`;

  const data = callLlmWithFallback(systemPrompt, userPrompt, 2000, 'summarizeFollowUpLearning');
  const textBlock = data.content.find(c => c.type === 'text');
  if (!textBlock) {
    Logger.log('summarizeFollowUpLearning -- no text block in LLM response.');
    return;
  }

  let suggestions;
  try {
    suggestions = JSON.parse(textBlock.text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim());
  } catch (e) {
    Logger.log('summarizeFollowUpLearning -- failed to parse suggestions JSON: ' + textBlock.text);
    return;
  }

  suggestions.forEach(s => {
    suggestionsTab.appendRow([
      new Date(),
      batchEdits.length,
      '[FOLLOW-UP][' + s.confidence + '] ' + s.pattern_observed + ' -> ' + s.suggested_change,
      'pending'
    ]);
  });

  // Mark these rows reviewed so they don't get re-batched. Add the column if
  // the Follow-Up Learning Log doesn't have it yet.
  let reviewedColIndex = reviewedCol;
  if (reviewedColIndex === -1) {
    logTab.getRange(1, headers.length + 1).setValue('Reviewed For SOP');
    reviewedColIndex = headers.length;
  }
  batchRowIndexes.forEach(rowNum => {
    logTab.getRange(rowNum, reviewedColIndex + 1).setValue(true);
  });

  Logger.log('summarizeFollowUpLearning -- generated ' + suggestions.length + ' FOLLOW-UP SOP suggestion(s) from ' + batchEdits.length + ' edited example(s)' + (deferredCount > 0 ? ' (' + deferredCount + ' more deferred to next run)' : '') + '. Review them in the "SOP Suggestions" tab.');
}

// Quick read-only status check: how many drafts in THIS Gmail account belong
// to queued leads, and how many total drafts the account has. Run this under
// Joana's account to watch the wipe progress between batches. If "total
// drafts" is ~0, you're on the wrong account (the 450 are in Joana's).
function countFollowUpDraftsRemaining() {  const account = getRunningAccountEmail();
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const queueEmails = new Set();
  [
    { tabName: PODCAST_SALES_QUEUE_TAB, statusCol: 7, emailCol: 3 },
    { tabName: HUB_GUEST_QUEUE_TAB, statusCol: 10, emailCol: 3 }
  ].forEach(cfg => {
    const tab = ss.getSheetByName(cfg.tabName);
    if (!tab) return;
    const data = tab.getDataRange().getValues();
    for (let r = 1; r < data.length; r++) {
      const status = data[r][cfg.statusCol - 1];
      if (status && String(status).indexOf('_APPROVAL') > -1) {
        const email = String(data[r][cfg.emailCol - 1] || '').toLowerCase().trim();
        if (email) queueEmails.add(email);
      }
    }
  });

  const drafts = GmailApp.getDrafts();
  let matched = 0;
  drafts.forEach(d => {
    let msg;
    try { msg = d.getMessage(); } catch (e) { return; }
    const to = (msg.getTo() || '').toLowerCase();
    let isQueueDraft = false;
    queueEmails.forEach(email => { if (to.indexOf(email) !== -1) isQueueDraft = true; });
    if (isQueueDraft) matched++;
  });

  Logger.log('countFollowUpDraftsRemaining -- running as "' + (account || 'UNKNOWN') + '". This account has ' + drafts.length + ' total draft(s); ' + matched + ' of them belong to follow-up queue leads and would be wiped.');
  if (drafts.length === 0) {
    Logger.log('countFollowUpDraftsRemaining -- 0 total drafts means you are very likely NOT on Joana\'s account. The 450 drafts live in joana@iconsofrealestate.com\'s Gmail. Switch accounts and re-run.');
  }
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
  const data = queueTab.getDataRange().getValues();
  let advanced = 0;
  let completed = 0;
  let stopped = 0;
  let capSkipped = 0;
  let declineStopped = 0;
  let currentDraftCount = countActiveApprovalDrafts(); // live running count, checked before every new draft
  let dailyCreated = getFollowUpDraftsCreatedToday(); // per-Pacific-day creation counter, checked alongside the total cap

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

      if (dailyCreated >= FOLLOWUP_DAILY_DRAFT_CAP) {
        Logger.log('advancePodcastSalesFollowUps -- DAILY CAP REACHED (' + FOLLOWUP_DAILY_DRAFT_CAP + ' drafts created today) -- skipping ' + threadId + ' (' + name + '), left at _SCHEDULE, drafts tomorrow.');
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
        // FIXED (17 Aug 2026, real incident): this used to hardcode "Totally
        // understand if starting your own show isn't the right fit" for
        // EVERY step-2 lead, unconditionally assuming a decline -- but
        // threadContainsDecline() above already stops the cadence for any
        // real decline before this point is reached, so every lead who
        // makes it here simply hasn't responded yet, not declined. That
        // false assumption directly contradicted what several real leads
        // had actually said (e.g. asking for more info, not declining).
        // Replaced with the SOP's own "THEY NEVER REPLIED AT ALL" pattern:
        // a gentle bump, no decline assumed, no guest-invite pivot (guest
        // invites are the Hub Guest cadence's job, not this one).
        body = 'Hi ' + (name || 'there') + ', Just floating this back to the top of your inbox in case it got buried! No pressure at all -- but if hosting your own podcast is still something you\'d be interested in, happy to find a time that works: [book a 15-minute Zoom Call here](BOOKING_LINK). Either way, wishing you continued success!';
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
      dailyCreated++;
      incrementFollowUpDraftsCreatedToday();
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
  const followUpSystemPrompt = buildFollowUpSystemPrompt();
  const data = queueTab.getDataRange().getValues();
  let advanced = 0;
  let completed = 0;
  let stopped = 0;
  let capSkipped = 0;
  let currentDraftCount = countActiveApprovalDrafts(); // shared cap counted across BOTH cadences
  let dailyCreated = getFollowUpDraftsCreatedToday(); // per-Pacific-day creation counter, shared across both cadences

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

      if (dailyCreated >= FOLLOWUP_DAILY_DRAFT_CAP) {
        Logger.log('advanceHubGuestFollowUps -- DAILY CAP REACHED (' + FOLLOWUP_DAILY_DRAFT_CAP + ' drafts created today) -- skipping ' + threadId + ' (' + name + '), left at _SCHEDULE, drafts tomorrow.');
        capSkipped++;
        continue;
      }

      const nextStep = currentStep + 1;
      if (nextStep > 2) continue;

      const followUp = classifyAndDraftFollowUp(followUpSystemPrompt, {
        name: name, email: email, state: state, showName: showName, showLink: showLink,
        step: nextStep, thread: thread
      });

      if (!followUp) {
        Logger.log('advanceHubGuestFollowUps -- LLM drafting failed for ' + threadId + ' (' + name + ') -- left at _SCHEDULE, will retry on the next run.');
        continue;
      }

      if (followUp.action === 'stop') {
        queueTab.getRange(r + 1, 10).setValue('STOPPED');
        Logger.log('advanceHubGuestFollowUps -- STOPPED (LLM read the thread as a hard decline, lead_state=' + followUp.leadState + '): ' + threadId + ' (' + name + ', ' + email + '). No follow-up drafted.');
        stopped++;
        continue;
      }

      Logger.log('advanceHubGuestFollowUps -- LLM drafted for ' + threadId + ' (' + name + '), lead_state=' + followUp.leadState + ', step ' + nextStep);

      const note = buildSchedulingNote(new Date(originalReplyTime));
      const plainBody = followUp.draftBody;
      const fullDraftText = note + plainBody + buildQuotedHistoryForReply(thread);

      GmailApp.createDraft(email, thread.getFirstMessageSubject().replace(/^(fwd:\s*)+/i, '').trim(), fullDraftText, { cc: CONFIG.NETWORK_CC_ON_REPLY });

      queueTab.getRange(r + 1, 8).setValue(nextStep);
      queueTab.getRange(r + 1, 9).setValue(new Date());
      queueTab.getRange(r + 1, 10).setValue('AWAITING_STEP_' + nextStep + '_APPROVAL');
      queueTab.getRange(r + 1, 12).setValue(plainBody);
      Logger.log('advanceHubGuestFollowUps -- ADVANCED: ' + threadId + ' (' + name + ', ' + email + ') Step ' + currentStep + ' -> ' + nextStep + ', draft created, now AWAITING_STEP_' + nextStep + '_APPROVAL');
      advanced++;
      currentDraftCount++;
      dailyCreated++;
      incrementFollowUpDraftsCreatedToday();
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