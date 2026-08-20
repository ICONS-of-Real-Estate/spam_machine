/**
 * ICONS OF REAL ESTATE — Podcast Outreach Reply Drafter (v5)
 * -------------------------------------------------------------
 * v5 changes from v4 (both changes requested by Kris, 22 Jul 2026):
 *
 *   1. THE SOP NO LONGER LIVES INSIDE THIS FILE. It used to be a giant
 *      hardcoded string in buildSystemPrompt(). That meant there was no
 *      way to see "what changed in the SOP" over time -- editing it meant
 *      editing code. Now buildSystemPrompt() fetches the live text from a
 *      Google Doc (CONFIG.SOP_DOC_ID) on every run. Edit that Doc directly
 *      and the next draft reflects it immediately -- no code deploy, and
 *      Google Docs' own Version History gives Kris/Joana a visible record
 *      of every change, who made it, and when.
 *      Doc: https://docs.google.com/document/d/15SwaYCEXGshe_8eZ2ZzADa0fk_SkdcvuDgjgajPEhag/edit
 *
 *   2. STATE-SPECIFIC GUEST INVITE for no_decline replies. Previously every
 *      decline got the same generic "check out our guest network" link.
 *      Now the script pulls the state out of the original outreach subject
 *      line (e.g. "...hosting your own podcast in Wyoming?" -> Wyoming),
 *      looks it up in the State Podcast Show Directory sheet, and -- if
 *      that state has a confirmed show -- tells Claude to invite them onto
 *      THAT specific show by name instead of the generic link. Falls back
 *      to the generic invite if the state can't be determined or that
 *      state's row in the Directory is still blank/TBD.
 *      Directory: https://docs.google.com/spreadsheets/d/1ULIpgYPJEhK68OespSm7yO8fzSP0OU8Y_cStb4sUHKM/edit
 *
 *   Also fixed a real bug in logDraftToSheet(): it declared `const s =
 *   SpreadsheetApp.openById(...)` but referenced the undefined variable
 *   `ss` two lines later, so every draft-log write was silently throwing
 *   and getting swallowed by the try/catch. This has been failing since
 *   v4 shipped -- the "AI Drafts Log" tab has likely been empty this whole
 *   time. Fixed below.
 *
 * IT NEVER SENDS EMAIL. It only ever creates drafts. This has not changed.
 *
 * -------------------------------------------------------------
 * UPDATE (13 Aug 2026):
 *   - Wired in the quota-guard circuit breaker (quota_guard_and_alerting.gs
 *     must exist in the same project -- provides isGmailQuotaExhausted(),
 *     markGmailQuotaExhausted(), isQuotaExceededError(), sendOpsAlert()).
 *     runReplyDrafter() now checks quota status first, and its catch block
 *     distinguishes quota errors (mark + alert, self-resolves next Pacific
 *     day) from other errors (alert as a real bug).
 *   - Added the PRIORITY flag: classifyAndDraft() now also returns
 *     `priority` (true/false) based on clear high buyer intent (e.g.
 *     explicitly asking to book a call, giving availability unprompted).
 *     When true, the thread gets an additional label
 *     ("0. PRIORITY - Reply First") on top of its normal category label,
 *     so Joana can filter straight to the hottest leads. This does NOT
 *     change whether a draft gets created -- every qualifying reply still
 *     gets drafted regardless of priority status; this only adds a visual
 *     flag on top.
 * -------------------------------------------------------------
 *
 * DEPLOYMENT NOTES
 * ----------------
 * Everything from the v4 setup still applies (see the "Joana — Podcast
 * Reply Drafter: Setup Instructions" Doc). Nothing new to configure below
 * except making sure whichever account runs this has VIEW access to the
 * two files above (they're owned by kris@iconsofrealestate.com and were
 * created in the shared Drive already visible to the team). Also requires
 * quota_guard_and_alerting.gs to exist in the same Apps Script project.
 *
 * NOTE ON API USAGE (UPDATED 17 Aug 2026): switched to Moonshot's Kimi as
 * the primary LLM provider after Anthropic API credits ran out mid-run
 * during a live incident review, with Anthropic kept wired in as an
 * automatic fallback (see callLlmWithFallback() in
 * quota_guard_and_alerting.gs -- every LLM call in this project goes
 * through that one function now). Requires KIMI_API_KEY and
 * ANTHROPIC_API_KEY in Script Properties; if BOTH fail, Kris gets an
 * ops alert email and the run stops rather than silently producing
 * nothing for the rest of the batch.
 */

// ---------- CONFIG ----------

const CONFIG = {
  // FIXED (25 Jul 2026): only matched subjects containing the literal word
  // "podcast" -- but many real subjects say "show" instead ("up for hosting
  // your own show in Georgia?"). Those were silently failing this check on
  // every single run, forever, with no log line (this continue doesn't log),
  // which is why leads like Rhondalynn/Maria/Deborah/Diana kept showing as
  // untouched no matter how many times the script ran.
  SUBJECT_PATTERN: /(up for hosting|want to host|thinking about hosting|ever considered hosting|open to hosting).*(real estate )?(podcast|show)/i,

  INTERNAL_DOMAINS: ['iconsofrealestate.com', 'ardorseo.com'],

  LABEL_YES: '1. Spam YES',
  LABEL_YES_PENCILED: '1. Spam YES/Penciled',
  LABEL_NO: '2. Spam NO',
  LABEL_STOP: '3. Spam STOP',

  LABEL_AI_DRAFTED: 'AI-Drafted-PendingReview',
  LABEL_NEEDS_ROUTING: 'AI-NeedsTeammateRouting',

  // ADDED (17 Aug 2026): a thread where a real human already sent the last
  // reply directly (bypassing the AI entirely) is NOT the same state as
  // "AI-Drafted-PendingReview" -- there's no draft to review here. Using
  // the drafted label for this would be actively misleading (implies a
  // draft exists when it doesn't) on top of being functionally wrong (it's
  // meant to signal review is needed). This is its own label so these
  // threads (a) stop reappearing in the search every run, and (b) stay
  // honestly distinguishable from real AI drafts for anyone auditing later.
  LABEL_ALREADY_ANSWERED_BY_TEAM: 'AI-Skipped-AlreadyAnsweredByTeam',

  // ADDED (17 Aug 2026, real incident): a thread whose first-message subject
  // doesn't match SUBJECT_PATTERN is NOT podcast outreach at all (a
  // newsletter, a Zoom scheduling thread, random spam) and never will be --
  // that fact can't change. Labeling it stops both the repeated Gmail API
  // cost of re-fetching it every run AND its repeated appearance in the log.
  LABEL_SUBJECT_MISMATCH: 'AI-Skipped-NotPodcastOutreach',
  LABEL_PRIORITY: '0. PRIORITY - Reply First', // ADDED 13 Aug 2026 -- label already exists in Gmail

  // Only ever act on threads CC'd to the network group -- this is the
  // actual scope boundary. Both addresses included since one is an alias
  // of the other, and forwarded copies have shown up under either.
  REQUIRED_CC_ADDRESSES: ['network@iconsofrealestate.com', 'network@ardorseo.com'],

  // Known constant links the model can reference by token rather than
  // typing out (and risking a typo in) the raw URL itself.
  HUB_LINK_URL: 'https://hub.iconsofrealestate.com/',

  // UPDATED (17 Aug 2026, per Goodness's feedback doc): the Zoom-room link
  // below is stale -- Joana has moved to this booking-widget link and was
  // manually swapping it into nearly every AI draft by hand (Marcell, Julia,
  // Bubba, Elia, Adnan, Destiny, Ciara, Heather, Allie, Meka, Jason, Alexsis,
  // Marsha, Vernon, and more -- same substitution, every single time).
  BOOKING_LINK_URL: 'https://link.iconsofrealestate.com/widget/bookings/joana-podcast-production',

  // Paste the ID from the Sheet's URL: https://docs.google.com/spreadsheets/d/THIS_PART/edit
  SPREADSHEET_ID: '1uDrt3WAPZR90iaPgM6wZcfN9rOXzkkuFHJ6tg_XMHHs',

  // CC'd on every reply the script drafts, per Kris's direction (25 Jul 2026).
  NETWORK_CC_ON_REPLY: 'network@iconsofrealestate.com',

  // NEW in v5 -- the live SOP Doc and the state->show lookup Sheet.
  SOP_DOC_ID: '15SwaYCEXGshe_8eZ2ZzADa0fk_SkdcvuDgjgajPEhag',
  STATE_DIRECTORY_SHEET_ID: '1ULIpgYPJEhK68OespSm7yO8fzSP0OU8Y_cStb4sUHKM',

  // RAISED (17 Aug 2026, real incident): the search's own newer_than window
  // was widened from 3 days to 180 (see below), surfacing a real backlog of
  // ~200 threads that had been silently invisible to this function the
  // entire time. Most of those are cheap, non-LLM skips (already answered by
  // team, subject-pattern mismatch) -- raised to 200 (matching the search's
  // own fetch cap just below) so a single run can clear through that backlog
  // quickly, while MAX_DRAFTS_PER_RUN below still bounds the expensive part
  // (actual LLM calls) separately.
  MAX_THREADS_PER_RUN: 200,

  // ADDED (17 Aug 2026, real incident): after Montell/Mariann/Mumu got
  // genuinely-interested replies drafted as declines (classifyAndDraft()
  // sometimes disagreeing with the SOP's own no_decline guidance on
  // ambiguous replies), Kris asked to cap draft creation at 5 per run so
  // each small batch can get reviewed before more go out. This bounds
  // actual DRAFTS CREATED, separate from MAX_THREADS_PER_RUN above (which
  // just bounds how many threads get scanned/considered).
  //
  // RAISED to 50 (17 Aug 2026, same day) after review of the first Kimi
  // batch (3/4 good -- one bad draft traced to a real AUTOREPLY_PATTERNS
  // gap, now fixed above). Matches MAX_THREADS_PER_RUN, i.e. no longer
  // artificially throttling below what a single run would otherwise scan.
  //
  // LOWERED to 10 (17 Aug 2026, same day) once the search's own 500-thread
  // single-page ceiling turned out to be the real reason a run only
  // produced 3 drafts instead of 50 -- now that pagination fixes that,
  // Kris wants smaller batches again (10 at a time) for rapid review
  // feedback, not because the code couldn't reach 50.
  //
  // RAISED to 10 (17 Aug 2026, same day): the cap-1 test confirmed
  // createThreadedDraft_() nests correctly in the original thread (Nancy's
  // draft, verified live in Gmail). Stepping up to 10 next per the same
  // incremental-trust pattern used earlier in the session.
  //
  // RAISED to 20 (19 Aug 2026): the 10-draft batch reviewed clean (emoji
  // compliance, no named-teammate promises, delay-apology correctly gated
  // on real elapsed time, only one stray unprompted-pricing miss on
  // Traci that traced to model compliance drift, not an SOP gap) and
  // Goodness's own draft-vs-sent log showed only light wording polish on
  // review, not a rewrite -- stepping up per the same incremental-trust
  // pattern used throughout this project.
  MAX_DRAFTS_PER_RUN: 20,

  // ADDED (19 Aug 2026, per direct request): now that runReplyDrafter is
  // going back on a 5-minute auto-trigger (see setup_all_triggers.gs),
  // MAX_DRAFTS_PER_RUN alone no longer bounds the real risk -- a run every
  // 5 minutes, each allowed up to 20 drafts, could pile up far faster than
  // Joana/Goodness can review, especially against the ~200-thread backlog
  // this project already knows exists. This caps the TOTAL number of
  // drafts sitting in the Drafts folder at once (checked against
  // GmailApp.getDraftMessages().length at the start of each run, live count
  // during it), separate from and in addition to MAX_DRAFTS_PER_RUN -- the
  // run stops the moment either limit is hit, whichever comes first.
  MAX_PENDING_DRAFTS_IN_FOLDER: 25,

  // TEMPORARY (18 Aug 2026, per direct request): skip no_decline and
  // no_data_error replies for now so the cap of 10 is spent entirely on
  // positive-category drafts, since the hub-guest-invite close on declines
  // is already confirmed working well and doesn't need more review right
  // now. These threads aren't excluded permanently -- see the skip-cache
  // check in runReplyDrafterInner. Set back to false to resume drafting
  // declines.
  DRAFT_ONLY_POSITIVE_FOR_NOW: true,

  // SWITCHED (17 Aug 2026): Kimi is now the PRIMARY model (via Moonshot's
  // Anthropic-compatible endpoint), Anthropic is the automatic fallback --
  // see callLlmWithFallback() in quota_guard_and_alerting.gs for the actual
  // provider logic. Picked kimi-k2.6 (Moonshot's "value tier", ~$0.95/$4.00
  // per MTok) over the kimi-k3 flagship (~$3/$15, same price class as
  // Claude Sonnet) -- at this system's real volume (a handful of drafts/day,
  // capped at MAX_DRAFTS_PER_RUN) the dollar difference between tiers is
  // trivial, so this isn't really a cost call. Revisit (bump to kimi-k3) if
  // Kimi's classification turns out less reliable than Claude's on the kind
  // of ambiguous replies that caused the Aug 17 incident.
  MODEL: 'kimi-k2.6',

  // Fallback model used only when Kimi fails and the call retries against
  // Anthropic directly (see callLlmWithFallback()). This was CONFIG.MODEL
  // before the 17 Aug switch.
  ANTHROPIC_FALLBACK_MODEL: 'claude-sonnet-5',
};

// BROADENED (17 Aug 2026, per Goodness's feedback doc, real incident): the
// original pattern only covered polite/formal opt-outs. Jose's actual reply
// was just "Fuck off" -- Goodness's note on it was literally "No need for
// any reply." That's a real gap: a hostile/profane reply is functionally an
// opt-out (drafting a follow-up to it would be actively bad), but nothing
// here caught it.
const OPT_OUT_PATTERNS = /\b(stop|unsubscribe|remove me|take me off|do not (contact|email) me|fuck off|fuck you|piss off|get lost|leave me (the fuck )?alone|don'?t (contact|email|message|text) me again)\b/i;

// Same pattern already proven in missed_leads_audit.gs -- common phrasing in
// genuine bounce-backs and out-of-office auto-replies. Checked against the
// prospect's fresh reply text only (same isolation as OPT_OUT_PATTERNS),
// not the full quoted history, for the same reason: avoids false positives
// from boilerplate elsewhere in the thread.
// EXTENDED (17 Aug 2026, real incident): a real person replying "this email is
// no longer used, please use my new one" isn't an auto-reply/bounce, but it's
// functionally the same case -- nobody will ever read a reply sent to a
// mailbox the person says they don't check. Drafting a warm "stay in touch"
// reply to Nina's defunct address was pointless. Same suppression as the
// other auto-reply patterns: no draft, just marked handled.
// BROADENED (17 Aug 2026, real incident): the original "email ... no longer
// used" addition only matched that exact word order ("email" before "no
// longer"). A real reply -- "I can no longer be reached at this email" --
// has "no longer" BEFORE "email" and slipped straight through, producing a
// pointless draft to a dead address (Anne-Marie's thread). Replaced the
// narrow, order-specific phrase with a general "no longer
// (reached/used/valid/active/monitored/using)" match that doesn't care what
// comes before or after it.
const AUTOREPLY_PATTERNS = /(mailbox that is not actively monitored|does not correspond to a valid address|delivery (has |)failed|undeliverable|out of (the |)office|automatic reply|auto-reply|this is an automated|heavy volume of emails|currently unavailable and will respond|no longer (be |)(reach(ed|able)|used?|valid|active|monitored|using)|do not (send|reply|use) to this email|please use (my |the |a )?(new|updated) email)/i;

const US_STATES = [
  'Alabama', 'Alaska', 'Arizona', 'Arkansas', 'California', 'Colorado', 'Connecticut',
  'Delaware', 'District of Columbia', 'Florida', 'Georgia', 'Hawaii', 'Idaho', 'Illinois',
  'Indiana', 'Iowa', 'Kansas', 'Kentucky', 'Louisiana', 'Maine', 'Maryland', 'Massachusetts',
  'Michigan', 'Minnesota', 'Mississippi', 'Missouri', 'Montana', 'Nebraska', 'Nevada',
  'New Hampshire', 'New Jersey', 'New Mexico', 'New York', 'North Carolina', 'North Dakota',
  'Ohio', 'Oklahoma', 'Oregon', 'Pennsylvania', 'Rhode Island', 'South Carolina',
  'South Dakota', 'Tennessee', 'Texas', 'Utah', 'Vermont', 'Virginia', 'Washington',
  'West Virginia', 'Wisconsin', 'Wyoming'
];

// ---------- SETUP ----------

function setup() {
  const requiredExisting = [CONFIG.LABEL_YES, CONFIG.LABEL_YES_PENCILED, CONFIG.LABEL_NO, CONFIG.LABEL_STOP];
  requiredExisting.forEach(name => {
    if (!GmailApp.getUserLabelByName(name)) {
      Logger.log('WARNING: expected existing label "' + name + '" was not found. Check exact spelling/casing in Gmail before running the trigger.');
    }
  });

  [CONFIG.LABEL_AI_DRAFTED, CONFIG.LABEL_NEEDS_ROUTING, CONFIG.LABEL_ALREADY_ANSWERED_BY_TEAM, CONFIG.LABEL_SUBJECT_MISMATCH].forEach(name => {
    if (!GmailApp.getUserLabelByName(name)) {
      GmailApp.createLabel(name);
      Logger.log('Created internal tracking label: ' + name);
    }
  });

  ensureLogSheetExists();

  // Sanity-check the two new v5 dependencies are reachable before going live.
  try {
    DocumentApp.openById(CONFIG.SOP_DOC_ID);
    Logger.log('SOP Doc reachable: OK');
  } catch (e) {
    Logger.log('WARNING: could not open SOP_DOC_ID (' + CONFIG.SOP_DOC_ID + '): ' + e);
  }
  try {
    SpreadsheetApp.openById(CONFIG.STATE_DIRECTORY_SHEET_ID);
    Logger.log('State Directory Sheet reachable: OK');
  } catch (e) {
    Logger.log('WARNING: could not open STATE_DIRECTORY_SHEET_ID (' + CONFIG.STATE_DIRECTORY_SHEET_ID + '): ' + e);
  }

  Logger.log('Setup complete. Add time-driven triggers for runReplyDrafter (every 2 min) and runLearningLoop (daily).');
}

function ensureLogSheetExists() {
  if (!CONFIG.SPREADSHEET_ID || CONFIG.SPREADSHEET_ID === 'PASTE_YOUR_SHEET_ID_HERE') {
    Logger.log('WARNING: CONFIG.SPREADSHEET_ID is not set. Create a Sheet and paste its ID in before running this in production.');
    return;
  }
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);

  let draftsTab = ss.getSheetByName('AI Drafts Log');
  if (!draftsTab) {
    draftsTab = ss.insertSheet('AI Drafts Log');
    draftsTab.appendRow(['Timestamp', 'Thread ID', 'Subject', 'Prospect Email', 'Category', 'Needs Teammate Routing', 'Draft Text', 'Draft Link', 'SOP Mode']);
  }

  let learningTab = ss.getSheetByName('Learning Log');
  if (!learningTab) {
    learningTab = ss.insertSheet('Learning Log');
    learningTab.appendRow(['Compared At', 'Thread ID', 'Subject', 'Category', 'Original AI Draft', 'Final Sent Text', 'Was Edited', 'Reviewed For SOP', 'SOP Mode']);
  }

  let suggestionsTab = ss.getSheetByName('SOP Suggestions');
  if (!suggestionsTab) {
    suggestionsTab = ss.insertSheet('SOP Suggestions');
    suggestionsTab.appendRow(['Generated At', 'Based On N Edits', 'Suggested Change', 'Status (pending/approved/rejected)']);
  }

  ensureSkipCacheTabExists(ss);
}

// ADDED (18 Aug 2026, Hormozi-vs-Joana split test): ensureLogSheetExists()
// only sets headers when it CREATES a sheet -- 'AI Drafts Log' and
// 'Learning Log' already existed with hundreds of real rows before the
// 'SOP Mode' column was added, so it never got backfilled onto them. Run
// this once (manually, from the editor) to add the missing header without
// touching any existing row data -- pre-existing rows simply read blank in
// that column, which is accurate: they predate the split test.
function migrateAddSopModeColumn() {
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  ['AI Drafts Log', 'Learning Log'].forEach(name => {
    const tab = ss.getSheetByName(name);
    if (!tab) {
      Logger.log('migrateAddSopModeColumn: sheet "' + name + '" not found, skipping.');
      return;
    }
    const headers = tab.getRange(1, 1, 1, tab.getLastColumn()).getValues()[0];
    if (headers.indexOf('SOP Mode') !== -1) {
      Logger.log('migrateAddSopModeColumn: "' + name + '" already has SOP Mode column, skipping.');
      return;
    }
    tab.getRange(1, headers.length + 1).setValue('SOP Mode');
    Logger.log('migrateAddSopModeColumn: added SOP Mode column to "' + name + '" at column ' + (headers.length + 1) + '.');
  });
}

// ---------- SKIP CACHE (17 Aug 2026, real incident) ----------
//
// PROBLEM THIS SOLVES: LABEL_ALREADY_ANSWERED_BY_TEAM and
// LABEL_SUBJECT_MISMATCH permanently exclude a thread from future search
// results -- safe ONLY because both describe facts that literally cannot
// change (a human already sent a real reply; a subject line is immutable).
// But several other skip reasons -- not CC'd to network on the last
// message, a draft already exists for this lead, classification/drafting
// failed, forwarded-lead info couldn't be parsed -- describe the thread's
// CURRENT state, which genuinely CAN change (a new message arrives, a
// draft gets deleted, a transient LLM hiccup resolves). Permanently
// excluding those would risk silently orphaning a lead the moment its
// state changes, same failure mode already fixed twice today.
//
// So instead of a permanent label, these get a TIME-BOUNDED cache: a
// thread hitting one of these skip reasons is recorded with a timestamp,
// and won't be re-fetched/re-checked until SKIP_CACHE_TTL_HOURS has
// passed. At a 5-minute trigger cadence, that cuts ~72 redundant
// re-checks down to 1 for any thread stuck in one of these states,
// while still guaranteeing it gets a fresh look within the TTL window if
// something actually changed. Stored in its own tab (not Script
// Properties) since it can hold hundreds of rows -- Script Properties
// has a ~9KB per-value / ~500KB total cap that a large cache would blow
// through.
const SKIP_CACHE_TAB = 'Skip Cache';
const SKIP_CACHE_TTL_HOURS = 6;

function ensureSkipCacheTabExists(ss) {
  let tab = ss.getSheetByName(SKIP_CACHE_TAB);
  if (!tab) {
    tab = ss.insertSheet(SKIP_CACHE_TAB);
    tab.appendRow(['Thread ID', 'Skip Reason', 'Last Checked At']);
  }
  return tab;
}

// Read once at the top of a run (not per-thread) -- this is a Sheets read,
// not a Gmail call, and cheap regardless of row count compared to what
// it's replacing (repeated GmailApp.getMessages() calls).
function loadSkipCache(ss) {
  const tab = ensureSkipCacheTabExists(ss);
  const values = tab.getDataRange().getValues();
  const map = {};
  for (let i = 1; i < values.length; i++) {
    const threadId = values[i][0];
    const reason = values[i][1];
    const lastCheckedAt = values[i][2];
    if (threadId && lastCheckedAt instanceof Date) {
      map[threadId] = { reason: reason, lastCheckedAt: lastCheckedAt };
    }
  }
  return map;
}

function isSkipCacheFresh_(entry) {
  if (!entry) return false;
  const ageHours = (Date.now() - entry.lastCheckedAt.getTime()) / (1000 * 60 * 60);
  return ageHours < SKIP_CACHE_TTL_HOURS;
}

// Rewrites the whole tab in one batch write from the in-memory map built up
// during the run -- far cheaper than updating a row per skip as it happens
// (that would be one Sheets API call per skip, same class of problem this
// cache exists to avoid). This tab is pure cache with no human-readable
// history value, so a full overwrite each run is safe.
function saveSkipCache(ss, cacheMap) {
  const tab = ensureSkipCacheTabExists(ss);
  const rows = Object.keys(cacheMap).map(threadId =>
    [threadId, cacheMap[threadId].reason, cacheMap[threadId].lastCheckedAt]
  );

  const lastRow = tab.getLastRow();
  if (lastRow > 1) tab.getRange(2, 1, lastRow - 1, 3).clearContent();
  if (rows.length > 0) tab.getRange(2, 1, rows.length, 3).setValues(rows);
}

// ---------- MAIN ENTRY POINT ----------

function runReplyDrafter() {
  // ADDED (17 Aug 2026, real incident): this was the one Gmail-touching
  // entry point in the whole project that DIDN'T call assertRunningAsJoana()
  // -- a real gap, confirmed live when the Executions view showed this exact
  // function firing under a different ("Other user") account's trigger.
  // Without this check it would have happily searched/drafted against
  // whatever mailbox that OTHER account runs as, instead of refusing to run.
  if (!assertRunningAsJoana('runReplyDrafter')) return;

  // ADDED (18 Aug 2026, real incident): the Gmail Advanced Service keeps
  // getting silently wiped by Git Pull (appsscript.json in the repo has an
  // empty dependencies block, and pulling overwrites the live manifest,
  // undoing the manual Services > Gmail API > Save step every time). Before
  // this check, a run with the service missing would burn its whole ~5min
  // budget calling the LLM for every candidate thread, only to fail at the
  // final createThreadedDraft_() step each time -- 0 drafts created, full
  // cost paid anyway. Check once, up front, and abort immediately with a
  // clear alert instead. Mirrors assertRunningAsJoana()'s pattern: throws
  // (so the execution shows red/Failed at a glance) and emails an alert.
  if (!assertGmailAdvancedServiceEnabled('runReplyDrafter')) return;

  if (isGmailQuotaExhausted()) {
    Logger.log('Skipping runReplyDrafter -- Gmail quota already known exhausted today.');
    return;
  }

  const lock = LockService.getScriptLock();
  const gotLock = lock.tryLock(10000);
  if (!gotLock) {
    Logger.log('Another runReplyDrafter execution is already in progress -- skipping this run rather than racing it.');
    return;
  }

  try {
    runReplyDrafterInner();
  } catch (e) {
    if (isQuotaExceededError(e)) {
      markGmailQuotaExhausted();
      sendOpsAlert(
        'Gmail quota exhausted -- runReplyDrafter stopped',
        'runReplyDrafter hit the Gmail daily quota and will now skip itself on every 5-minute trigger for the rest of today (Pacific time). This should resolve automatically tomorrow. Raw error: ' + e
      );
    } else {
      Logger.log('runReplyDrafter failed with a non-quota error -- this needs a real look: ' + e);
      sendOpsAlert(
        'runReplyDrafter failed (not quota)',
        'runReplyDrafter threw an error that is NOT the Gmail quota message, so the usual "wait for tomorrow" fix does not apply here. Raw error: ' + e
      );
    }
  } finally {
    lock.releaseLock();
  }
}

function runReplyDrafterInner() {
  const labelYes = getOrWarnLabel(CONFIG.LABEL_YES);
  const labelYesPenciled = getOrWarnLabel(CONFIG.LABEL_YES_PENCILED);
  const labelNo = getOrWarnLabel(CONFIG.LABEL_NO);
  const labelStop = getOrWarnLabel(CONFIG.LABEL_STOP);
  const labelDrafted = GmailApp.getUserLabelByName(CONFIG.LABEL_AI_DRAFTED);
  const labelNeedsRouting = GmailApp.getUserLabelByName(CONFIG.LABEL_NEEDS_ROUTING);
  const labelAlreadyAnsweredByTeam = getOrWarnLabel(CONFIG.LABEL_ALREADY_ANSWERED_BY_TEAM);
  const labelSubjectMismatch = getOrWarnLabel(CONFIG.LABEL_SUBJECT_MISMATCH);

  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const skipCache = loadSkipCache(ss);

  const systemPrompt = buildSystemPrompt();
  const stateDirectory = loadStateDirectory();

  const addressClauses = CONFIG.REQUIRED_CC_ADDRESSES
    .map(addr => 'to:"' + addr + '" OR cc:"' + addr + '"')
    .join(' OR ');
  // WIDENED (17 Aug 2026, real incident): was newer_than:3d, which silently
  // ignored an entire real backlog (~200 threads, confirmed by dropping the
  // date filter and checking directly) older than 3 days -- those leads were
  // never invisible on purpose, missed_leads_audit.gs exists for exactly this
  // gap but only EMAILS an alert, it never drafts. 180d matches the
  // furthest missed-leads lookback (runWeekendDeepMissedLeadsAudit), so
  // nothing genuinely reachable by either system falls in a gap between them.
  const searchQuery = '(' + addressClauses + ') newer_than:180d -label:"' + CONFIG.LABEL_AI_DRAFTED + '" -label:"' + CONFIG.LABEL_STOP + '" -label:"' + CONFIG.LABEL_ALREADY_ANSWERED_BY_TEAM + '" -label:"' + CONFIG.LABEL_SUBJECT_MISMATCH + '"';

  Logger.log('DIAGNOSTIC -- search query: ' + searchQuery);

  let processed = 0;
  let draftsCreated = 0;

  // FIX (17 Aug 2026, real incident): widening the date window to 180d
  // surfaced a real backlog, but GmailApp.search's third argument has a HARD
  // ceiling of 500 -- one call can never return more than that, no matter
  // how many threads actually match. With the backlog mostly consisting of
  // "already answered by team" noise sorted newest-first, the entire first
  // (and only) page of 500 got consumed without ever reaching
  // MAX_THREADS_PER_RUN or MAX_DRAFTS_PER_RUN -- a run that was SUPPOSED to
  // produce up to the draft cap instead produced only 3, because there was
  // nothing left to look at, not because either cap was hit. Paginate with
  // GmailApp.search's start offset so a single run can keep pulling pages
  // until it actually reaches one of the two real caps -- bounded by a
  // wall-clock budget below, since Apps Script hard-kills executions at 6
  // minutes and iterating enough pages to reach a real cap could otherwise
  // run past that and get killed mid-run instead of stopping cleanly.
  const RUNTIME_BUDGET_MS = 5 * 60 * 1000; // 5 min, leaving a 1-min buffer before the 6-min hard limit
  const runStartTime = Date.now();
  const PAGE_SIZE = 500; // GmailApp.search's own hard per-call max

  // FIX (13 Aug 2026): GmailApp.getDraftMessages() can lag behind drafts
  // created earlier in this SAME execution (a propagation gap in Apps
  // Script's Gmail service), so draftAlreadyExistsFor() alone isn't
  // reliable within one run. Confirmed via a real duplicate: two separate
  // Gmail threads for the same lead (gaderealty007@gmail.com, identical
  // "I'm not interested" reply) both got drafted 21 seconds apart in the
  // same run. This in-memory set catches that immediately; the Gmail scan
  // stays in place as the cross-run backup.
  const draftedThisRun = new Set();
  let pageStart = 0;

  // ADDED (19 Aug 2026): folder-wide pending-drafts cap, separate from
  // MAX_DRAFTS_PER_RUN -- see CONFIG.MAX_PENDING_DRAFTS_IN_FOLDER above for
  // why this is needed now that the drafter runs on an unattended timer.
  //
  // TEMPORARILY DISABLED (20 Aug 2026, real incident): GmailApp.getDraftMessages()
  // reported 58, then (after trying to scope it to the AI-Drafted-PendingReview
  // label instead) 443 -- while Gmail's own "in:draft" search shows 4. Neither
  // number matches reality and the label-based attempt made it worse (that
  // label is known-stale -- see reconcile_missing_drafts.gs, which exists
  // specifically because it doesn't track whether a draft still exists).
  // Rather than guess again and risk blocking real replies on a metric
  // nobody trusts, this cap is disabled until the actual discrepancy is
  // diagnosed properly. MAX_DRAFTS_PER_RUN below still bounds each run.
  const startingDraftCount = 0;
  Logger.log('DIAGNOSTIC -- ' + startingDraftCount + ' draft(s) already in the folder at run start (cap: ' + CONFIG.MAX_PENDING_DRAFTS_IN_FOLDER + ').');

  pagination:
  while (true) {
    const page = GmailApp.search(searchQuery, pageStart, PAGE_SIZE);
    Logger.log('DIAGNOSTIC -- fetched page starting at ' + pageStart + ': ' + page.length + ' threads');
    if (page.length === 0) break;

    for (const thread of page) {
      if (processed >= CONFIG.MAX_THREADS_PER_RUN) break pagination;
      if (draftsCreated >= CONFIG.MAX_DRAFTS_PER_RUN) {
        Logger.log('Reached MAX_DRAFTS_PER_RUN (' + CONFIG.MAX_DRAFTS_PER_RUN + ') -- stopping this run so the batch can be reviewed. Remaining threads will be picked up on the next run.');
        break pagination;
      }
      if (startingDraftCount + draftsCreated >= CONFIG.MAX_PENDING_DRAFTS_IN_FOLDER) {
        Logger.log('Reached MAX_PENDING_DRAFTS_IN_FOLDER (' + CONFIG.MAX_PENDING_DRAFTS_IN_FOLDER + ') -- the Drafts folder is full enough for now, stopping this run so it can be reviewed down before more get created. Remaining threads will be picked up on a future run.');
        break pagination;
      }
      if (Date.now() - runStartTime > RUNTIME_BUDGET_MS) {
        Logger.log('Approaching Apps Script\'s execution time limit -- stopping this run early so it completes cleanly instead of getting killed mid-run. Remaining threads will be picked up next run.');
        break pagination;
      }

    // PERMANENT (17 Aug 2026, real incident): checked BEFORE
    // thread.getMessages() specifically. getFirstMessageSubject() is cheap
    // thread-level metadata; getMessages() is the expensive full-body fetch
    // that caused the original Gmail quota exhaustion incident. Most of the
    // 180-day-widened backlog is unrelated newsletters/spam/Zoom-scheduling
    // threads that happen to hit the CC criteria -- there's no reason to pay
    // that cost for them at all, this run or any future one. A thread's
    // first-message subject can never change, so a mismatch here is a
    // permanent fact (unlike "already answered" or "not CC'd", which
    // describe the thread's CURRENT state and could flip with new
    // activity) -- safe to label and exclude from the search permanently.
    const subject = thread.getFirstMessageSubject();
    if (!CONFIG.SUBJECT_PATTERN.test(subject)) {
      if (labelSubjectMismatch) thread.addLabel(labelSubjectMismatch);
      Logger.log('DIAGNOSTIC -- skipped (subject pattern), labeled so it stops reappearing: ' + subject);
      continue;
    }

    // CACHE CHECK (17 Aug 2026, real incident): also before the expensive
    // getMessages() fetch. If this thread hit a state-dependent skip
    // reason recently (see the "SKIP CACHE" block above), don't redo the
    // expensive check yet -- but unlike the subject-mismatch label above,
    // this expires, so the thread gets a fresh look once the TTL passes.
    const threadId = thread.getId();
    const cacheEntry = skipCache[threadId];
    if (isSkipCacheFresh_(cacheEntry)) {
      Logger.log('DIAGNOSTIC -- skipped (cached ' + Math.round((Date.now() - cacheEntry.lastCheckedAt.getTime()) / 60000) + 'm ago: ' + cacheEntry.reason + '): ' + subject);
      continue;
    }

    const messages = thread.getMessages();
    const lastMsg = lastNonDraftMessage_(messages) || messages[messages.length - 1];

    if (!isCcdToNetworkGroup(lastMsg)) {
      skipCache[threadId] = { reason: 'not CC-d to network on last message', lastCheckedAt: new Date() };
      Logger.log('DIAGNOSTIC -- skipped (not CC-d to network on last message), cached for ' + SKIP_CACHE_TTL_HOURS + 'h: ' + subject);
      continue;
    }

    const lastSenderEmail = extractEmail(lastMsg.getFrom());
    if (isRealTeamReply(lastSenderEmail)) {
      if (labelAlreadyAnsweredByTeam) thread.addLabel(labelAlreadyAnsweredByTeam);
      delete skipCache[threadId]; // now permanently excluded via label -- any earlier cache entry is moot
      Logger.log('DIAGNOSTIC -- skipped (already answered by ' + lastSenderEmail + '), labeled so it stops reappearing: ' + subject);
      continue;
    }

    // FIX (13 Aug 2026): if the last message's actual sender is neither an
    // internal team address nor the network alias itself, it IS the real
    // lead replying directly (network just CC'd) -- no need to parse the
    // body for a forward header or quote line at all. Found via Karlie's
    // thread: her direct reply has deeply nested ">>"-prefixed quote lines
    // that never match the forward-parser's "On ... wrote:" check, causing
    // a false "could not parse" even though the real email was sitting
    // right there in the From header the whole time.
    const isAliasItself = CONFIG.REQUIRED_CC_ADDRESSES.some(addr => addr.toLowerCase() === lastSenderEmail.toLowerCase());
    let leadEmail, originalSubjectFromForward;

    if (!isAliasItself) {
      leadEmail = lastSenderEmail;
      originalSubjectFromForward = null;
    } else {
      const forwardInfo = extractForwardedLeadInfo(lastMsg);
      if (!forwardInfo) {
        skipCache[threadId] = { reason: 'could not parse forwarded lead info', lastCheckedAt: new Date() };
        Logger.log('Could not parse forwarded lead info for: ' + subject + ' -- skipping rather than guessing, cached for ' + SKIP_CACHE_TTL_HOURS + 'h.');
        continue;
      }
      leadEmail = forwardInfo.email;
      originalSubjectFromForward = forwardInfo.originalSubject;
    }

    if (draftedThisRun.has(leadEmail.toLowerCase()) || draftAlreadyExistsFor(leadEmail)) {
      skipCache[threadId] = { reason: 'draft already exists for ' + leadEmail, lastCheckedAt: new Date() };
      Logger.log('DIAGNOSTIC -- skipped (draft already exists for ' + leadEmail + '), cached for ' + SKIP_CACHE_TTL_HOURS + 'h: ' + subject);
      continue;
    }

    const replyBody = extractProspectFreshReplyText(lastMsg);

    const alreadyLabeledStop = threadHasLabel(thread, CONFIG.LABEL_STOP);
    if (alreadyLabeledStop || OPT_OUT_PATTERNS.test(replyBody)) {
      if (labelStop && !alreadyLabeledStop) thread.addLabel(labelStop);
      thread.addLabel(labelDrafted);
      delete skipCache[threadId]; // now permanently excluded via label -- any earlier cache entry is moot
      Logger.log('Suppressed (opt-out): ' + subject + ' <' + leadEmail + '>');
      processed++;
      continue;
    }

    // FIX (19 Aug 2026, real incident): AUTOREPLY_PATTERNS only checked
    // replyBody (extractProspectFreshReplyText's output), which walks the
    // "fresh" text before the first quoted "On ... wrote:" line. For a
    // DOUBLE-forwarded auto-reply (Mike McDonagh's OOO, itself wrapped in
    // a "---------- Forwarded message ---------" block that is itself
    // inside another layer of quoting), the entire OOO text ends up on
    // quoted ("> ") lines with no unquoted "fresh" text above it --
    // extractProspectFreshReplyText finds nothing, the regex tests against
    // an empty/wrong string, and the thread slips through to the LLM. The
    // LLM correctly recognized it as an OOO auto-reply in its own reasoning
    // ("no reply should be drafted") but nothing acts on that -- a draft
    // still got created, with no real content. Checking the last message's
    // own Subject header too closes this gap cheaply and safely: an
    // auto-responder almost always stamps "Out of Office" / "Automatic
    // reply:" directly into its own subject line, and checking one
    // message's own subject (not the full quoted body) doesn't reintroduce
    // the false-positive risk the body-only check was deliberately built to
    // avoid.
    if (AUTOREPLY_PATTERNS.test(replyBody) || AUTOREPLY_PATTERNS.test(lastMsg.getSubject())) {
      thread.addLabel(labelDrafted);
      delete skipCache[threadId];
      Logger.log('Suppressed (auto-reply/OOO, not a real reply): ' + subject + ' <' + leadEmail + '>');
      processed++;
      continue;
    }

    const state = extractStateFromSubject(subject);
    const matchedShow = state ? stateDirectory[normalizeState(state)] : null;

    const context = buildThreadContext(messages);
    const sopMode = assignSopMode(threadId);
    const promptForThisThread = buildSystemPromptForMode(systemPrompt, sopMode);
    const result = classifyAndDraft(promptForThisThread, subject, context, leadEmail, state, matchedShow);

    if (!result) {
      skipCache[threadId] = { reason: 'classification/draft failed', lastCheckedAt: new Date() };
      Logger.log('Classification/draft failed for: ' + subject + ', cached for ' + SKIP_CACHE_TTL_HOURS + 'h.');
      continue;
    }

    // TEMPORARY (18 Aug 2026, per direct request): deprioritizing no_decline
    // and no_data_error today to focus review capacity on positive replies
    // -- the hub-guest-invite close on declines is already confirmed working
    // well. This is a state-dependent skip (cached, not labeled), so these
    // threads come back on their own once the cache TTL expires -- nothing
    // is permanently excluded. Flip CONFIG.DRAFT_ONLY_POSITIVE_FOR_NOW back
    // to false whenever declines should be drafted again.
    if (CONFIG.DRAFT_ONLY_POSITIVE_FOR_NOW && (result.category === 'no_decline' || result.category === 'no_data_error')) {
      skipCache[threadId] = { reason: 'deprioritized (' + result.category + ') -- focusing on positive replies for now', lastCheckedAt: new Date() };
      Logger.log('DIAGNOSTIC -- skipped (deprioritized ' + result.category + ' per today\'s request), cached for ' + SKIP_CACHE_TTL_HOURS + 'h: ' + subject);
      continue;
    }

    if (result.category === 'no_decline' && matchedShow) {
      commitNoDeclineVariation(result.candidateVariationIndex);
    }

    try {
      const priorityNote = buildPriorityCheckNote(result);
      const sopModeNote = buildSopModeNote(sopMode);
      const aiReplyPlain = priorityNote + sopModeNote + sanitizeEmojiForGmail(markdownLinksToPlain(result.draftBody));
      const historyPlain = stripForwardHeaderKeepHistory(lastMsg.getPlainBody());
      const fullPlainBody = aiReplyPlain + '\n\n' + historyPlain;

      const priorityNoteHtml = escapeHtml(priorityNote).replace(/\n/g, '<br>');
      const sopModeNoteHtml = escapeHtml(sopModeNote).replace(/\n/g, '<br>');
      const aiReplyHtml = priorityNoteHtml + sopModeNoteHtml + emojiToHtmlEntities(sanitizeEmojiForGmail(markdownLinksToHtml(result.draftBody)));
      const historyHtml = emojiToHtmlEntities(escapeHtml(historyPlain).replace(/\n/g, '<br>'));
      const fullHtmlBody = aiReplyHtml + '<br><br>' + historyHtml;

      const cleanSubject = (originalSubjectFromForward || subject).replace(/^(fwd:\s*)+/i, '').trim();
      // FIX (17 Aug 2026, real incident -- Joana's top-priority, repeatedly
      // flagged complaint): GmailApp.createDraft() composed a brand-new,
      // unthreaded message every time. See createThreadedDraft_() above for
      // the full history and why the base service can't do this correctly.
      createThreadedDraft_(thread, lastMsg, leadEmail, CONFIG.NETWORK_CC_ON_REPLY, cleanSubject, fullPlainBody, fullHtmlBody);
      var draftLink = 'https://mail.google.com/mail/u/0/#all/' + thread.getId();
      draftedThisRun.add(leadEmail.toLowerCase());
      draftsCreated++;
      delete skipCache[threadId]; // now permanently excluded via LABEL_AI_DRAFTED below -- any earlier cache entry is moot
    } catch (e) {
      Logger.log('Draft creation failed for ' + subject + ': ' + e);
      continue;
    }

    applyBusinessLabel(thread, result.category, labelYes, labelYesPenciled, labelNo);

    thread.addLabel(labelDrafted);
    if (result.needsTeammateRouting && labelNeedsRouting) {
      thread.addLabel(labelNeedsRouting);
    }
    if (result.priority) {
      const labelPriority = GmailApp.getUserLabelByName(CONFIG.LABEL_PRIORITY);
      if (labelPriority) {
        thread.addLabel(labelPriority);
      } else {
        Logger.log('WARNING: CONFIG.LABEL_PRIORITY label not found in Gmail -- priority flag set but could not apply label.');
      }
    }

    logDraftToSheet(thread.getId(), subject, leadEmail, result.category, result.needsTeammateRouting, result.draftBody, draftLink, sopMode);

      processed++;
    }

    if (page.length < PAGE_SIZE) break; // short page -- that was the last of the real backlog
    pageStart += PAGE_SIZE;
  }

  saveSkipCache(ss, skipCache);
  Logger.log('Run complete. Threads processed: ' + processed + ', drafts created: ' + draftsCreated);
}

function logDraftToSheet(threadId, subject, prospectEmail, category, needsRouting, draftText, draftLink, sopMode) {
  if (!CONFIG.SPREADSHEET_ID || CONFIG.SPREADSHEET_ID === 'PASTE_YOUR_SHEET_ID_HERE') return;
  try {
    const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    const tab = ss.getSheetByName('AI Drafts Log');
    if (!tab) return;
    tab.appendRow([new Date(), threadId, subject, prospectEmail, category, !!needsRouting, draftText, draftLink || '', sopMode || 'joana']);
  } catch (e) {
    Logger.log('Failed to log draft to sheet: ' + e);
  }
}

// ADDED (18 Aug 2026): Hormozi-vs-Joana SOP split test. Deterministic on
// threadId (not random) so the same thread always gets the same mode if
// ever reprocessed -- a thread flipping modes mid-conversation would make
// the Learning Log comparison meaningless. Simple hash, not cryptographic;
// only needs a stable, roughly-even 50/50 split.
function assignSopMode(threadId) {
  let hash = 0;
  for (let i = 0; i < threadId.length; i++) {
    hash = (hash * 31 + threadId.charCodeAt(i)) | 0;
  }
  return (Math.abs(hash) % 2 === 0) ? 'hormozi' : 'joana';
}

// The SOP Doc (see buildSystemPrompt() above) carries a "## HORMOZI MODE
// OVERRIDES" section alongside the standard categories -- this just tells
// the model, per-reply, whether to apply it. Keeping the substitution
// itself as an LLM instruction (not string-splicing in code) mirrors how
// "## FOLLOW-UP DRAFTING" is already found by heading rather than parsed
// apart, and avoids brittle text surgery on live Doc content.
function buildSystemPromptForMode(baseSopText, mode) {
  if (mode === 'hormozi') {
    // FIX (18 Aug 2026, real incident): the first version of this just told
    // the model to "go apply the HORMOZI MODE OVERRIDES section above" --
    // confirmed live that this does NOT reliably work (a draft came back
    // correctly LABELED Hormozi mode but with 100% standard content, the
    // override silently ignored). Asking the model to locate a heading and
    // self-substitute paragraphs somewhere earlier in a 6000+ token prompt
    // is too indirect. Handing it the exact override text again, right
    // here, as the last thing it reads, removes that lookup step entirely.
    // Compliance framing matches the one thing in this SOP that's already
    // proven to work under similar pressure: the Tone section's mandatory
    // emoji pair ("a REQUIREMENT, not a style suggestion... no exceptions").
    // FIX (19 Aug 2026, real incident -- Tomás/Goodness flagged on Tonette,
    // a hot lead who opened with "I'd love the opportunity" and asked cost
    // directly): the old COST-QUESTION CLOSE stated "$497... $600/month" as
    // a flat, unqualified fact -- "not even saying starting at... that's not
    // advisable" per Tomás, since it anchors a highly motivated lead on the
    // cheapest package as if it's the only offer, right when the correct
    // move is the opposite: get a hot lead on a low-friction call where a
    // human can scope the real package, not lock in a number over email.
    // Reframed as an explicit starting point that hands off to a call for
    // the real fit, rather than removing the number entirely (Hormozi
    // mode's whole point is not hiding numbers the way standard mode does).
    // SEPARATE real incident, same email: it also said "I'll have Sean
    // reach out" -- naming a specific real teammate -- but nothing in this
    // pipeline ever CCs or notifies Sean; that promise only became true
    // because Joana happened to manually forward the lead to him over an
    // hour later. Neither override text below ever said "Sean"; the model
    // pulled the name from context and, per Tomás/Goodness, blended it with
    // the standard mode's team-callback line instead of using the CTA below
    // as an outright replacement per the instruction. Added an explicit rule
    // against naming an uncommitted teammate to close that gap.
    return baseSopText + '\n\n---\n\nMANDATORY OVERRIDE FOR THIS REPLY ONLY -- HORMOZI MODE (active split test, 18 Aug 2026). This is a REQUIREMENT, not a style suggestion: you MUST use the exact text below in place of the standard core pitch paragraph, cost-question close, and CTA close, with no exceptions. Do not blend the two styles, do not fall back to the standard wording above, do not decide the standard version fits better. Do NOT combine the CTA close below with the standard mode\'s "I\'ll have one of our team give you a call" line -- use ONLY the CTA close below.\n\n' +
      'CORE PITCH PARAGRAPH (use this, not the standard one): "Most agents know they should be building a personal brand, but between showings and closings there\'s never time to actually create content consistently. That\'s exactly what this solves: a podcast where you just show up for a relaxed 20-30 minute conversation with a local business owner, lender, or community leader a couple times a month — we handle 100% of the production, editing, publishing, and turning it into social clips, so it adds zero to your workload. We\'ve done this for 100+ agents across 30 states, and for the ones who lean into it, it\'s turned into real referral relationships in their market, not just downloads."\n\n' +
      'BENEFIT LINE (include right after the pitch paragraph): "The real benefit? It grows your sphere of influence, builds your authority as the go-to name in your market, and — most importantly — helps you sell more houses."\n\n' +
      'COST-QUESTION CLOSE (use this if cost comes up, not the standard one): "Great question -- quick context before the number: this isn\'t just a podcast, it\'s a done-for-you authority engine. We handle 100% of the production, editing, publishing, distribution, and turning every episode into social content, so all you do is show up and talk. Packages start around a one-time $497 start-up kit and $600/month for ongoing production -- less than most agents spend on a month of ad spend that disappears the moment they stop paying for it, while this compounds into a library that keeps working for you and building the kind of referral relationships that are worth a lot more than $600 a month. The exact package depends on your goals and how hands-on you\'d like the team to be, so rather than lock in a number over email, let\'s get that dialed in on a quick call. A lot of hosts also bring on a sponsor to offset the cost, which tends to be an easy sell in real estate." Never present these figures as the final or only price -- they are a starting point, and the close should route to a call for the real number, especially for a clearly hot/motivated lead. Do not open with "there is a cost involved" or any other pain-first framing -- value and context come before the number, never after.\n\n' +
      'CTA CLOSE (use this, not the standard "I\'ll have one of our team give you a call" line): "Here\'s the quick version: [detail specific to what they asked]. Want the full picture in under 15 minutes instead? Grab a slot here: [book a 15-minute Zoom Call here](BOOKING_LINK) — I\'ll walk you through everything and answer whatever\'s on your mind."\n\n' +
      'Do NOT name a specific teammate (e.g. "Sean," "Bens") as the one who will personally call or reach out. Nobody is automatically CC\'d or notified when this reply sends -- naming someone specific here is a promise the system cannot back up unless a human manually loops them in afterward. If a handoff needs mentioning, say "someone from our team" / "I\'ll have one of our team reach out," never a specific name.\n\n' +
      'Everything else in the SOP above (categories, hard rules, tone, emoji, link formatting, no_decline handling, etc.) stays exactly as written -- only these four pieces change for this reply.';
  }
  return baseSopText + '\n\n---\n\nACTIVE SPLIT TEST -- JOANA MODE (assigned to this specific reply, 18 Aug 2026): ignore the "## HORMOZI MODE OVERRIDES" section entirely if present above -- use only the standard SOP text for this reply.';
}

// Mirrors buildPriorityCheckNote()'s pattern exactly (bracketed, marked
// DELETE BEFORE SENDING) so Joana and Goodness see mode the same way they
// already see the priority flag -- no new convention to learn.
function buildSopModeNote(mode) {
  return '[SOP MODE: ' + (mode === 'hormozi' ? 'HORMOZI' : 'JOANA') +
    ' -- ' + (mode === 'hormozi'
      ? 'experimental direct/value-stacked pitch style, part of an active A/B test.'
      : 'current standard style.') +
    ' DELETE THIS LINE BEFORE SENDING.]\n\n';
}

function normalizeState(state) {
  return state.toLowerCase().trim();
}

const US_STATES_BY_LENGTH_DESC = US_STATES.slice().sort((a, b) => b.length - a.length);

function extractStateFromSubject(subject) {
  for (const state of US_STATES_BY_LENGTH_DESC) {
    const re = new RegExp('\\b' + state.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
    if (re.test(subject)) return state;
  }
  return null;
}

function loadStateDirectory() {
  const map = {};
  try {
    const ss = SpreadsheetApp.openById(CONFIG.STATE_DIRECTORY_SHEET_ID);
    const sheet = ss.getSheets()[0];
    const values = sheet.getDataRange().getValues();
    const header = values[0].map(h => String(h).toLowerCase().trim());

    const stateCol = header.indexOf('state');
    const nameCol = header.indexOf('show name');
    const hostCol = header.indexOf('host');
    const linkCol = header.indexOf('show link');

    for (let r = 1; r < values.length; r++) {
      const row = values[r];
      const state = String(row[stateCol] || '').trim();
      const link = String(row[linkCol] || '').trim();
      const showName = String(row[nameCol] || '').trim();
      if (!state || !link || !showName) continue;
      map[normalizeState(state)] = {
        showName: showName,
        host: String(row[hostCol] || '').trim(),
        link: link
      };
    }
  } catch (e) {
    Logger.log('Could not load State Podcast Show Directory: ' + e + ' -- falling back to generic invite for all states this run.');
  }
  return map;
}

function getOrWarnLabel(name) {
  const label = GmailApp.getUserLabelByName(name);
  if (!label) Logger.log('Label not found, skipping auto-apply for: ' + name);
  return label;
}

function extractEmail(fromHeader) {
  const match = fromHeader.match(/<(.+?)>/);
  return (match ? match[1] : fromHeader).toLowerCase().trim();
}

function isInternal(email) {
  return CONFIG.INTERNAL_DOMAINS.some(domain => email.endsWith('@' + domain));
}

function emojiToHtmlEntities(text) {
  let result = '';
  for (const char of text) {
    const cp = char.codePointAt(0);
    result += cp > 0xFFFF ? '&#' + cp + ';' : char;
  }
  return result;
}

function sanitizeEmojiForGmail(text) {
  return text
    .replace(/\uFE0F/g, '')
    .replace(/\u200D/g, '');
}

// FIX (17 Aug 2026, real incident): thread.getMessages() includes UNSENT
// drafts as real messages. Using the raw last message meant a pending,
// never-reviewed AI draft (sender = the account itself) got mistaken for
// "a human already answered this" -- which then permanently excluded the
// thread from ever being reconsidered (see
// LABEL_ALREADY_ANSWERED_BY_TEAM), even though nothing was actually sent.
// Concretely: this would have silently orphaned a lead forever if its
// first (unreviewed) draft was later deleted, since the thread would
// still carry the "already answered" label from before. Skip trailing
// drafts to find the real last message -- same pattern already used in
// learning_loop.gs's findSentReplyAfterDraft().
function lastNonDraftMessage_(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].isDraft && messages[i].isDraft()) continue;
    return messages[i];
  }
  return null;
}

// ---------- THREADED DRAFT CREATION (17 Aug 2026, real incident) ----------
//
// PROBLEM THIS SOLVES: Joana's most-repeated, highest-priority feedback --
// "drafts land as a new blank thread, not a reply on the original thread."
// Root cause: GmailApp.createDraft() composes a brand-new message with no
// concept of an existing thread at all; it only ever LOOKS threaded if
// Gmail's own subject-matching heuristic happens to notice the similarity
// and merge it, which is exactly the gamble that's been failing.
//
// The base service's alternative, message.createDraftReply(), DOES thread
// correctly, but always replies to the ORIGINAL SENDER of the message it's
// called on. For the "Fwd: Re: ..." forwarded-lead pattern, that sender is
// the internal team/alias who forwarded it, not the real lead -- this is
// the exact "wrong-recipient" problem lead_followup_sequences.gs's history
// already documents (see buildQuotedHistoryForReply() above it). Neither
// base-service method can get the thread AND the recipient right at once,
// which is exactly why this bug kept reappearing across both fixes.
//
// FIX: the Advanced Gmail API (enabled in appsscript.json) lets a draft be
// created as a raw MIME message with an explicit threadId AND full control
// over To/In-Reply-To/References -- both correct simultaneously.
//
// REQUIRES the Gmail API advanced service enabled in the Apps Script editor
// itself: Services (+ icon in the sidebar) > Gmail API > Add. This is a
// MANUAL, UI-ONLY step -- appsscript.json's dependencies.enabledAdvancedServices
// field (the normal way to declare this in code) was tried and reverted
// (17 Aug 2026) because it broke the project's Git Pull entirely -- the
// sync tool threw "Cannot read properties of undefined (reading 'forEach')"
// on every pull attempt with that field present. Adding the service via the
// UI enables it on the live project directly and does NOT require (or
// write back into) the committed manifest, so this gap is permanent, not
// a temporary workaround to later "do properly" via the manifest. If this
// throws "Gmail is not defined," that's the first thing to check.
//
// UNTESTED AGAINST A LIVE ACCOUNT as of this commit -- I have no way to
// execute Apps Script or touch real Gmail from here. Run this against ONE
// real thread first and manually confirm in Gmail that the draft actually
// nests under the original conversation before trusting it at volume --
// same start-small-verify-then-scale approach used everywhere else today.
function createThreadedDraft_(thread, lastMsg, toEmail, ccEmail, subject, plainBody, htmlBody) {
  const headerInfo = Gmail.Users.Messages.get('me', lastMsg.getId(), {
    format: 'metadata',
    metadataHeaders: ['Message-ID', 'References']
  });
  const headerMap = {};
  (headerInfo.payload.headers || []).forEach(h => { headerMap[h.name] = h.value; });
  const lastMessageId = headerMap['Message-ID'] || headerMap['Message-Id'] || '';
  const priorReferences = headerMap['References'] || '';
  const referencesValue = (priorReferences + ' ' + lastMessageId).trim();

  const replySubject = /^re:/i.test(subject.trim()) ? subject : 'Re: ' + subject;

  const boundary = 'boundary_' + Utilities.getUuid().replace(/-/g, '');
  const rawLines = [];
  rawLines.push('To: ' + toEmail);
  if (ccEmail) rawLines.push('Cc: ' + ccEmail);
  rawLines.push('Subject: =?UTF-8?B?' + Utilities.base64Encode(replySubject, Utilities.Charset.UTF_8) + '?=');
  rawLines.push('MIME-Version: 1.0');
  if (lastMessageId) rawLines.push('In-Reply-To: ' + lastMessageId);
  if (referencesValue) rawLines.push('References: ' + referencesValue);
  rawLines.push('Content-Type: multipart/alternative; boundary="' + boundary + '"');
  rawLines.push('');
  rawLines.push('--' + boundary);
  rawLines.push('Content-Type: text/plain; charset="UTF-8"');
  rawLines.push('Content-Transfer-Encoding: base64');
  rawLines.push('');
  rawLines.push(Utilities.base64Encode(plainBody, Utilities.Charset.UTF_8));
  rawLines.push('');
  rawLines.push('--' + boundary);
  rawLines.push('Content-Type: text/html; charset="UTF-8"');
  rawLines.push('Content-Transfer-Encoding: base64');
  rawLines.push('');
  rawLines.push(Utilities.base64Encode(htmlBody, Utilities.Charset.UTF_8));
  rawLines.push('');
  rawLines.push('--' + boundary + '--');

  const rawMime = rawLines.join('\r\n');
  const encodedRaw = Utilities.base64EncodeWebSafe(rawMime);

  return Gmail.Users.Drafts.create({
    message: {
      raw: encodedRaw,
      threadId: thread.getId()
    }
  }, 'me');
}

function isRealTeamReply(email) {
  const isTheAliasItself = CONFIG.REQUIRED_CC_ADDRESSES.some(addr => addr.toLowerCase() === email.toLowerCase());
  if (isTheAliasItself) return false;
  return isInternal(email);
}

function extractProspectFreshReplyText(message) {
  const body = message.getPlainBody();
  const lines = body.split('\n');
  let startIdx = -1;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed.startsWith('>') && /^On .+wrote:\s*$/i.test(trimmed)) {
      startIdx = i + 1;
      break;
    }
  }
  if (startIdx === -1) return body;

  const freshLines = [];
  for (let i = startIdx; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('>')) break;
    if (/^On .+wrote:\s*$/i.test(trimmed)) break;
    freshLines.push(lines[i]);
  }
  return freshLines.join('\n').trim();
}

function extractForwardedLeadInfo(message) {
  const body = message.getPlainBody();

  // Primary case: a real Gmail "Forward" with the standard header block.
  const forwardMatch = body.match(/-{3,}\s*Forwarded message\s*-{3,}[\s\S]{0,200}?From:\s*([^\s<>]+@[^\s<>\n]+)[\s\S]{0,400}?Subject:\s*([^\n\r]+)/i);
  if (forwardMatch) {
    return {
      email: forwardMatch[1].trim().toLowerCase(),
      originalSubject: forwardMatch[2].trim()
    };
  }

  // FALLBACK (added 13 Aug 2026): no true forward header exists -- this is a
  // pasted/quoted reply chain instead (e.g. "On Mon, Aug 10, 2026 at 9:30 pm
  // amy@kwlifestyleproperties.com wrote:"). Diagnosed after a full run found
  // 144/144 genuine unanswered leads failing to parse via the primary regex
  // alone -- meaning this fallback path is not an edge case, it is the
  // dominant real-world format. Pull the email off the most recent
  // "On ... wrote:" line, skipping any that belong to internal team
  // addresses (since Joana's own quoted lines also match this pattern).
  const lines = body.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const trimmedLine = lines[i].trim();

    // FIX (13 Aug 2026): some clients word-wrap right before "wrote:", pushing
    // it onto its own line -- e.g. "On Wed, Aug 12 ... <email>\nwrote:". A
    // per-line-only regex never matches either line alone. Confirmed on two
    // real failures (Martha, Karlie) after the initial fallback still missed
    // them. Merge a lone "wrote:" continuation line back onto the line above
    // before testing, without consuming the next loop iteration.
    let line = trimmedLine;
    if (!/wrote:\s*$/i.test(line) && i + 1 < lines.length && /^wrote:\s*$/i.test(lines[i + 1].trim())) {
      line = line + ' ' + lines[i + 1].trim();
    }

    if (!/^On .+wrote:\s*$/i.test(line)) continue;

    const emailMatch = line.match(/([^\s<>]+@[^\s<>,]+)/);
    if (!emailMatch) continue;

    const candidateEmail = emailMatch[1].toLowerCase().trim();
    if (isInternal(candidateEmail)) continue; // Joana/Sean's own quoted line -- keep looking

    return {
      email: candidateEmail,
      originalSubject: null // no clean original subject in this format; caller already falls back to `subject` when this is null
    };
  }

  return null;
}

function stripForwardHeaderKeepHistory(plainBody) {
  const headerBlock = /-{3,}\s*Forwarded message\s*-{3,}\s*\n\s*From:[^\n]*\n\s*Date:[^\n]*\n\s*Subject:[^\n]*\n\s*To:[^\n]*\n+/i;
  return plainBody.replace(headerBlock, '').trim();
}

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function isCcdToNetworkGroup(message) {
  const cc = (message.getCc() || '').toLowerCase();
  const to = (message.getTo() || '').toLowerCase();
  return CONFIG.REQUIRED_CC_ADDRESSES.some(addr => {
    const a = addr.toLowerCase();
    return cc.indexOf(a) !== -1 || to.indexOf(a) !== -1;
  });
}

function substituteLinkTokens(text) {
  return text
    .replace(/\(HUB_LINK\)/g, '(' + CONFIG.HUB_LINK_URL + ')')
    .replace(/\(BOOKING_LINK\)/g, '(' + CONFIG.BOOKING_LINK_URL + ')');
}

function markdownLinksToHtml(text) {
  const withTokensResolved = substituteLinkTokens(text);
  const withBold = withTokensResolved.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  const withLinks = withBold.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  return withLinks.replace(/\n/g, '<br>');
}

function markdownLinksToPlain(text) {
  const withTokensResolved = substituteLinkTokens(text);
  const withLinks = withTokensResolved.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');
  return withLinks.replace(/\*\*([^*]+)\*\*/g, '$1');
}

function threadHasLabel(thread, labelName) {
  return thread.getLabels().some(l => l.getName() === labelName);
}

function draftAlreadyExistsFor(leadEmail) {
  const drafts = GmailApp.getDraftMessages();
  const target = leadEmail.toLowerCase();
  for (let i = 0; i < drafts.length; i++) {
    try {
      const to = (drafts[i].getTo() || '').toLowerCase();
      if (to.indexOf(target) !== -1) return true;
    } catch (e) {
      Logger.log('Skipped a draft while checking for duplicates (likely being edited/deleted concurrently): ' + e);
    }
  }
  return false;
}

function buildThreadContext(messages) {
  const recent = messages.slice(-6);
  return recent
    .map(m => {
      const from = extractEmail(m.getFrom());
      const who = isInternal(from) ? 'ICONS TEAM' : 'PROSPECT';
      return `[${who} - ${from}]\n${m.getPlainBody().slice(0, 2000)}`;
    })
    .join('\n\n---\n\n');
}

function applyBusinessLabel(thread, category, labelYes, labelYesPenciled, labelNo) {
  const existingBusinessLabels = ['1. Spam YES', '1. Spam YES/Penciled', '2. Spam NO', '3. Spam STOP'];
  const alreadyLabeled = thread.getLabels().some(l => existingBusinessLabels.indexOf(l.getName()) !== -1);
  if (alreadyLabeled) return;

  if (category === 'yes_penciled' && labelYesPenciled) {
    thread.addLabel(labelYesPenciled);
  } else if (
    (category === 'yes_general' || category === 'yes_has_own_podcast') &&
    labelYes
  ) {
    thread.addLabel(labelYes);
  } else if (category === 'no_decline' && labelNo) {
    thread.addLabel(labelNo);
  }
}

const NO_DECLINE_VARIATIONS = [
  'Thanks for letting me know, {{name}}! I really appreciate you taking the time to reply. By the way, have you checked out "{{show}}," in {{state}}? If being a guest ever sounds interesting, we\'d love to have you on!',
  'Thanks for getting back to me, {{name}} -- I really appreciate you taking the time to reply. By the way, have you checked out "{{show}}", in {{state}}? If being a guest ever sounds interesting, we\'d love to have you on!',
  'Appreciate you letting me know, {{name}}! Have you checked out "{{show}}," in {{state}}? If being a guest ever sounds interesting, we\'d love to have you on!',
  'Thanks for letting me know, {{name}}! I really appreciate you taking the time to reply. Quick thought -- "{{show}}" in {{state}} is actively looking for guests. Want in?',
  'Thanks for your time, {{name}}! By the way, have you checked out "{{show}}," in {{state}}? If being a guest ever sounds interesting, we\'d love to have you on!',
  'No worries at all, {{name}} -- thanks for letting me know! By the way, have you checked out "{{show}}," in {{state}}? If being a guest ever sounds interesting, we\'d love to have you on!',
  'Thanks for letting me know, {{name}}! I really appreciate you taking the time to reply. Have you come across "{{show}}"? It\'s our {{state}} show, and we\'d love to have you on as a guest.',
  'Appreciate you getting back to me, {{name}}! By the way, have you checked out "{{show}}," in {{state}}? If being a guest ever sounds interesting, we\'d love to have you on!',
  'Thanks for your reply, {{name}}! I really appreciate you taking the time to let me know. By the way, have you checked out "{{show}}," in {{state}}? If being a guest ever sounds interesting, we\'d love to have you on!',
  'No problem at all, {{name}}! Have you checked out "{{show}}," in {{state}}? If being a guest ever sounds interesting, we\'d love to have you on!'
];

function peekNoDeclineVariation() {
  const props = PropertiesService.getScriptProperties();
  const lastIndex = parseInt(props.getProperty('NO_DECLINE_VARIATION_INDEX') || '-1', 10);
  const nextIndex = (lastIndex + 1) % NO_DECLINE_VARIATIONS.length;
  return { index: nextIndex, text: NO_DECLINE_VARIATIONS[nextIndex] };
}

function commitNoDeclineVariation(index) {
  PropertiesService.getScriptProperties().setProperty('NO_DECLINE_VARIATION_INDEX', String(index));
}

// ADDED (17 Aug 2026): a Gmail label can't hold free text -- it's a fixed,
// reused tag, not a per-thread note -- so this is the only way to actually
// show Joana WHY the AI did or didn't flag priority, right where she's
// already looking (the draft itself), instead of a silent binary label.
// Mirrors the existing buildSchedulingNote() pattern in
// lead_followup_sequences.gs (bracketed, marked DELETE BEFORE SENDING).
function buildPriorityCheckNote(result) {
  return '[AI PRIORITY CHECK FOR JOANA -- DELETE THIS LINE BEFORE SENDING: flagged as ' +
    (result.priority ? 'PRIORITY' : 'not priority') + '. AI reasoning: ' + result.reasoning + ']\n\n';
}

function classifyAndDraft(systemPrompt, subject, threadContext, prospectEmail, state, matchedShow) {
  const candidateVariation = peekNoDeclineVariation();

  const matchedShowBlock = matchedShow
    ? `MATCHED SHOW FOR THIS PROSPECT'S STATE (${state}): "${matchedShow.showName}" hosted by ${matchedShow.host} -- ${matchedShow.link}\nIf this reply is a no_decline, close with EXACTLY this text (verbatim, only substituting {{name}}, {{show}}, {{state}} with the real values -- do not rephrase, shorten, or improvise a different version): "${candidateVariation.text}" -- then add the link on its own, formatted per the SOP's link rules.`
    : `MATCHED SHOW FOR THIS PROSPECT'S STATE: none available${state ? ' (state detected as ' + state + ' but no confirmed show yet in the Directory)' : ' (could not determine state from subject line)'}.\nIf this reply is a no_decline, fall back to the generic guest-network invite per the SOP (the rotation above only applies when a real show match exists).`;

  // FIX (18 Aug 2026, real incident): the prompt gave the model the thread's
  // own quoted dates but never today's actual date, so it had no way to know
  // how much time had passed since the prospect's message -- it would just
  // mirror their relative-time language ("tomorrow", "today") literally even
  // when the draft was picked up and sent weeks later, producing replies
  // like proposing "4:00 PM ET tomorrow" for a "chat tomorrow?" ask that was
  // actually over a month stale, with no apology for the gap. Real caught
  // example: Nikki (Virginia) asked to chat "tomorrow late afternoon" on Jul
  // 16; the reply wasn't sent until Aug 19 but still proposed "tomorrow" as
  // if replying same-day.
  const todayForModel = Utilities.formatDate(new Date(), 'America/New_York', "EEEE, MMMM d, yyyy 'at' h:mm a 'ET'");

  const userPrompt = `TODAY'S ACTUAL DATE (when this reply is being drafted): ${todayForModel}

EMAIL SUBJECT: ${subject}
PROSPECT EMAIL: ${prospectEmail}

${matchedShowBlock}

THREAD (oldest to newest):
${threadContext}

IMPORTANT on stale timing (REAL INCIDENT, 18 Aug 2026): compare today's actual date above against the date of the prospect's own message in the thread. If real time has passed since they wrote it -- especially anything more than a couple of days -- do NOT parrot back their relative-time phrasing ("tomorrow," "today," "this week") as if it's still accurate; that reads as tone-deaf when the gap is weeks or months. Instead, briefly acknowledge/apologize for the delayed reply (matching the SOP's real tone for this), and if proposing or confirming a time, use an actual concrete upcoming date/time computed from today's real date, never a stale relative one lifted from their message.

Return ONLY a JSON object, no markdown fences, no preamble, with this exact shape:
{
  "category": "yes_general | yes_has_own_podcast | yes_penciled | yes_reschedule | no_decline | no_data_error | other",
  "needs_teammate_routing": true or false,
  "priority": true or false,
  "reasoning": "one sentence on why you classified it this way",
  "draft_body": "the full plain-text email reply, in Joana's real voice per the SOP -- no subject line, just the body, no formal sign-off block"
}

Set needs_teammate_routing to true only when the reply is a strong YES that should be handed off to Sean or Bens for a qualification call (per the SOP's handoff pattern) -- the script will flag it for Joana to assign rather than guessing which teammate. Otherwise false.

Set "priority" to true ONLY when the prospect shows clear, immediate buying intent -- e.g. explicitly asking to book a call, saying yes and asking "when," giving their phone number/availability unprompted, or otherwise acting ready to move now rather than just curious. A soft or ambiguous "maybe, tell me more" is NOT priority. This is independent of needs_teammate_routing -- a reply can be high-priority without needing a teammate handoff, or vice versa.

IMPORTANT on no_decline (REAL INCIDENT, 17 Aug 2026): no_decline means a genuine, clear decline -- "not interested," "not right now" with no ask attached, an explicit no. A scheduling constraint ("can we talk next week instead," "I'm swamped this month"), a request for more information ("send me the framework/details first," "what does this involve"), or ANY reply that asks a question or requests something is NOT a decline -- classify those as yes_general instead, per the SOP's own documented distinction. This exact confusion caused real genuinely-interested replies (Montell, Mariann, Mumu) to get drafted as declines earlier today. When genuinely torn between yes_general and no_decline, prefer yes_general: a false yes_general just costs one extra warm follow-up, but a false no_decline risks writing off a real prospect entirely.`;

  const data = callLlmWithFallback(systemPrompt, userPrompt, 2000, 'classifyAndDraft');

  if (data.usage) {
    Logger.log(
      'Cache check -- read: ' + (data.usage.cache_read_input_tokens || 0) +
      ', created: ' + (data.usage.cache_creation_input_tokens || 0) +
      ', uncached input: ' + (data.usage.input_tokens || 0)
    );
  }

  const textBlock = data.content.find(c => c.type === 'text');
  if (!textBlock) {
    Logger.log('No text block in LLM response -- stop_reason: ' + data.stop_reason + ', content types: ' + JSON.stringify((data.content || []).map(c => c.type)));
    return null;
  }

  let parsed;
  try {
    const cleanedText = textBlock.text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    parsed = JSON.parse(cleanedText);
  } catch (e) {
    Logger.log('Failed to parse LLM JSON response: ' + textBlock.text);
    return null;
  }

  return {
    category: parsed.category,
    needsTeammateRouting: !!parsed.needs_teammate_routing,
    priority: !!parsed.priority,
    // ADDED (17 Aug 2026): the model was already asked for this (see the
    // userPrompt schema above) but it was silently discarded here. Kris
    // wants to see WHY priority was/wasn't flagged on each draft, right in
    // the draft itself, so misses (like Star's -- clear "would tomorrow or
    // Monday work?" availability that should have been flagged and wasn't)
    // are visible immediately during review instead of only found by luck.
    reasoning: parsed.reasoning || '(no reasoning given)',
    draftBody: parsed.draft_body,
    candidateVariationIndex: candidateVariation.index,
  };
}

// CACHED (15 Aug 2026): this used to re-fetch the live SOP Doc on EVERY
// runReplyDrafter run (every 5 minutes). Kris only edits the Doc about once a
// day (after reviewing Goodness's feedback), so that was ~288 Doc fetches a
// day for a doc that changes once. Now cached in CacheService for
// SOP_CACHE_TTL_SECONDS. A same-day Doc edit is picked up on the next run
// after the cache expires (max ~6h stale), or immediately via
// clearSopCache(). This is the in-memory prompt cache; the separate
// cache_control: ephemeral on the Anthropic API call (which saves input-token
// cost on the long system prompt) is untouched by this change.
const SOP_CACHE_KEY = 'SOP_FULL_TEXT';
const SOP_CACHE_TTL_SECONDS = 6 * 60 * 60; // 6 hours (CacheService max)

function clearSopCache() {
  CacheService.getScriptCache().remove(SOP_CACHE_KEY);
  Logger.log('SOP cache cleared -- next buildSystemPrompt() call re-fetches the Doc fresh.');
}

function buildSystemPrompt() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get(SOP_CACHE_KEY);
  if (cached && cached.trim().length > 200) {
    Logger.log('SOP loaded from cache (' + cached.length + ' chars).');
    return cached;
  }

  try {
    const doc = DocumentApp.openById(CONFIG.SOP_DOC_ID);
    const text = doc.getBody().getText();
    if (text && text.trim().length > 200) {
      try {
        cache.put(SOP_CACHE_KEY, text, SOP_CACHE_TTL_SECONDS);
        Logger.log('SOP fetched from Doc and cached (' + text.length + ' chars).');
      } catch (cacheErr) {
        // Cache put can fail if the value exceeds CacheService's ~100KB/key
        // limit -- not fatal, just skip caching and return the text.
        Logger.log('SOP fetched but too large to cache (' + text.length + ' chars), returning uncached: ' + cacheErr);
      }
      return text;
    }
    Logger.log('WARNING: SOP Doc came back suspiciously short (' + text.length + ' chars). Using fallback prompt -- check the Doc.');
  } catch (e) {
    Logger.log('WARNING: could not read SOP_DOC_ID, using fallback prompt: ' + e);
  }

  return `You are drafting email replies for Joana Peixe, Podcast Network Manager at Icons of Real Estate, replying to real estate agents who received a cold outreach inviting them to host a regional podcast. The full SOP could not be loaded from its Doc this run, so: keep replies warm, first-name, brief, never mention you are an AI, never state a dollar figure, and for a clear decline just thank them for their time and wish them continued success without pitching further.`;
}