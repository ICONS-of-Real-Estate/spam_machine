/**
 * QUOTA GUARD + ALERTING -- foundational longevity infrastructure.
 *
 * PROBLEM THIS SOLVES: today, once the Gmail "premium gmail" daily
 * quota was exhausted, runReplyDrafter (every 5 min) kept firing and
 * kept throwing the same error over and over, all day, with nobody
 * notified. Separately, the AI Drafts Log shows the last real entry
 * was 6 days ago (Aug 6) -- meaning this exact failure mode has
 * probably been happening silently, on and off, for a while, which is
 * consistent with runReplyDrafter's 41.86% error rate shown on the
 * Triggers dashboard.
 *
 * WHAT THIS FILE ADDS:
 * 1. isGmailQuotaExhausted() / markGmailQuotaExhausted() -- a simple
 *    circuit breaker using Script Properties. The moment ANY function
 *    catches the quota error, it calls markGmailQuotaExhausted(),
 *    which records today's Pacific-Time date. Every entry point then
 *    checks isGmailQuotaExhausted() FIRST, before touching Gmail at
 *    all, and exits immediately if it's already known to be dead for
 *    today -- no more repeated identical failures every 5 minutes.
 * 2. sendOpsAlert(subject, body) -- uses MailApp, not GmailApp. This
 *    is a SEPARATE quota from the one that just got exhausted, so
 *    alerts can still go out even when Gmail access itself is dead.
 *    Deliberately rate-limited to once per (subject + day) so it
 *    can't spam you every time something checks in.
 * 3. recordGmailQuotaUsage_() / getGmailQuotaUsageToday_() (ADDED 22 Aug
 *    2026, per direct request) -- a SELF-TRACKED running count of Gmail
 *    operations today, since Google gives no API to ask "how much quota is
 *    left." Every heavy Gmail-touching loop (runReplyDrafterInner,
 *    runLearningLoopInner, runMissedLeadsAudit, reconcileMissingDrafts)
 *    calls this once per thread/row processed. Crossing GMAIL_CALL_SOFT_CAP
 *    proactively calls markGmailQuotaExhausted() -- stopping BEFORE Google's
 *    real limit throws, not just reacting after. See the fuller comment
 *    above that constant for why this is a conservative proxy, not an exact
 *    count.
 *
 * HOW TO WIRE THIS INTO EXISTING FUNCTIONS:
 * At the very top of runReplyDrafterInner(), runLeadFollowUpCycle(),
 * runMissedLeadsAudit(), and any other
 * Gmail-touching entry point, add:
 *
 *   if (isGmailQuotaExhausted()) {
 *     Logger.log('Skipping -- Gmail quota already exhausted today.');
 *     return;
 *   }
 *
 * And wrap the Gmail-touching part of the body in try/catch, adding
 * this to each catch block:
 *
 *   if (isQuotaExceededError(e)) {
 *     markGmailQuotaExhausted();
 *     sendOpsAlert('Gmail quota exhausted', 'Hit today in ' + <function name> + '. All Gmail-touching triggers will skip themselves until tomorrow.');
 *     return;
 *   }
 *
 * I'll help wire this into each specific file one at a time rather
 * than rewriting files wholesale -- safer, and each one gets verified
 * individually.
 */

// FIX (27 Aug 2026, real risk found in review): a bare English substring had
// three failure modes. (1) Apps Script renders thrown errors in the RUNNING
// ACCOUNT'S language, so under any non-English locale a genuine daily quota
// error never contains this exact English phrase -- the breaker silently
// never trips, and runReplyDrafter's catch alerts "failed (not quota) --
// the usual wait-for-tomorrow fix does not apply", which is backwards. (2)
// The short-window limit ("Service invoked too many times in a short time")
// doesn't contain "for one day" either, so it's correctly NOT classified as
// daily exhaustion -- but nothing in this project backs off or retries on
// it, so it's silently retried at full speed next firing. (3) The same
// English phrase appears for OTHER services too -- "too many times for one
// day: urlfetch" or ": drive" -- which would wrongly call
// markGmailQuotaExhausted() and shut down every Gmail-touching trigger for
// a Gmail quota that was never actually hit.
const QUOTA_ERROR_PATTERNS = [
  /too many times for one day/i,
];
const GMAIL_SERVICE_HINT = /gmail/i;
const QUOTA_EXHAUSTED_PROPERTY_KEY = 'GMAIL_QUOTA_EXHAUSTED_DATE_PACIFIC';

// FIX (27 Aug 2026): read e.message first -- String(e) on a thrown
// non-Error value (or certain host exceptions) can stringify to
// "[object Object]", silently defeating every check below it.
function errorText_(e) {
  return String((e && e.message) || e || '');
}

function isQuotaExceededError(e) {
  const text = errorText_(e);
  return QUOTA_ERROR_PATTERNS.some(p => p.test(text));
}

// FIX (27 Aug 2026, real risk found in review): isQuotaExceededError alone
// doesn't say WHICH service hit its daily cap -- a urlfetch or Drive quota
// error contains the identical English phrase. Callers that are about to
// call markGmailQuotaExhausted() (which shuts down every Gmail-touching
// trigger for the rest of the day) should use this, not the bare check.
function isGmailSpecificQuotaError(e) {
  const text = errorText_(e);
  return isQuotaExceededError(e) && GMAIL_SERVICE_HINT.test(text);
}

// FIX (27 Aug 2026, real risk found in review): only runReplyDrafter (and
// one manual cleanup) could ever call markGmailQuotaExhausted() -- every
// other Gmail-touching entry point CHECKED isGmailQuotaExhausted() at the
// top but had no catch that could ever SET it. runLeadFollowUpCycle is the
// project's other draft-creating entry point; when IT exhausts the quota,
// the flag stayed clear and every other job kept firing into a dead API for
// the rest of the day. Shared handler so each entry point's own try/catch
// gets the same classification and alerting runReplyDrafter already has,
// without seven copies of the same block.
function handleGmailJobError_(jobName, e) {
  if (isGmailSpecificQuotaError(e)) {
    markGmailQuotaExhausted();
    sendOpsAlert(
      'Gmail quota exhausted -- ' + jobName + ' stopped',
      jobName + ' hit the Gmail daily quota. Every Gmail-touching trigger in this project checks isGmailQuotaExhausted() and will now skip itself for the rest of today (Pacific time). This should resolve automatically tomorrow. Raw error: ' + e
    );
    return;
  }
  Logger.log(jobName + ' failed with a non-quota error -- this needs a real look: ' + e);
  sendOpsAlert(
    jobName + ' failed (not quota)',
    jobName + ' threw an error that is NOT the Gmail quota message, so the usual "wait for tomorrow" fix does not apply here. Raw error: ' + e
  );
}

function todayPacificDateString() {
  return Utilities.formatDate(new Date(), 'America/Los_Angeles', 'yyyy-MM-dd');
}

// Human-readable "time left until our own exhausted-flag ages out" -- the
// flag is keyed to todayPacificDateString(), so it clears the moment that
// rolls over, i.e. at midnight Pacific. Used only for logging/alert text;
// NOT a claim about when Google's real quota recovers (that's a rolling
// 24h window from first use, a different mechanism -- see the comments
// above isGmailQuotaExhausted()).
function timeUntilQuotaResetDescription_() {
  const nowPacificStr = Utilities.formatDate(new Date(), 'America/Los_Angeles', "yyyy-MM-dd'T'HH:mm:ss");
  const nowPacific = new Date(nowPacificStr);
  const midnight = new Date(nowPacific.getFullYear(), nowPacific.getMonth(), nowPacific.getDate() + 1, 0, 0, 0);
  const msLeft = midnight - nowPacific;
  const totalMinutes = Math.max(0, Math.round(msLeft / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return 'resets at midnight Pacific (~' + hours + 'h ' + minutes + 'm from now)';
}

// ---------- SELF-TRACKED CALL COUNTER (22 Aug 2026, per direct request) ----------
//
// PROBLEM THIS ADDS TO THE ABOVE: until now, the circuit breaker only ever
// tripped AFTER Google had already thrown "too many times for one day" --
// reactive, not preventive. Apps Script exposes no API to ask Google "how
// much of today's Gmail read/write quota is left" (MailApp.getRemainingDailyQuota()
// is a DIFFERENT quota -- send recipients, not read/write), so there's no way
// to ask Google directly. The next best thing: track our OWN running count of
// Gmail-touching operations across every job today, in Script Properties (the
// same account-wide, resets-at-Pacific-midnight mechanism the exhausted-flag
// above already uses), and self-stop BEFORE reaching Google's real 50,000/day
// Workspace ceiling -- see CONFIG or the constant below for the actual number.
//
// THIS IS A PROXY, NOT AN EXACT COUNT: Google doesn't bill quota "per thread"
// or "per function call" -- each thread.getMessages(), message.getFrom(),
// label operation, etc. is its own call under the hood, and this project
// doesn't wrap every single one. recordGmailQuotaUsage_() is called once per
// THREAD (or per row, in learning_loop.gs) processed in each job's main loop
// as a deliberately conservative stand-in for "some number of real API calls
// just happened." Treat the soft cap below as a safety margin, not a precise
// budget -- the reactive circuit breaker above is still the real backstop if
// this undercounts.
//
// FIXED (25 Aug 2026, per direct request -- "why would you store anything in
// properties, that isn't what it's for"): this used to be a NEW Script
// Property per Pacific day (GMAIL_CALL_COUNT_<date>), and Script Properties
// are never cleaned up automatically -- every day left one behind forever
// (confirmed live: GMAIL_CALL_COUNT_2026-08-22 through -25 already sitting
// there). Rewritten to the same fixed-key-plus-stored-date pattern
// lead_followup_sequences.gs's FOLLOWUP_DRAFTS_CREATED_DATE/_COUNT already
// gets right: exactly 2 keys, ever, the count self-resets when the stored
// date goes stale. Deliberately NOT moved to a Sheet -- this gets called once
// per THREAD in the hot loop (unlike the ops-alert log, which is rare), and
// adding a Sheet read/write there would just trade one quota problem for
// another. Old per-date property keys are left in place for now; run
// cleanupLegacyDateSuffixedProperties() manually if you want them gone
// (they're inert, just clutter).
const GMAIL_CALL_COUNT_DATE_PROPERTY_KEY = 'GMAIL_CALL_COUNT_DATE_PACIFIC';
const GMAIL_CALL_COUNT_PROPERTY_KEY = 'GMAIL_CALL_COUNT';
const GMAIL_CALL_LAST_ALERT_TIER_PROPERTY_KEY = 'GMAIL_CALL_LAST_ALERT_TIER';

// CONFIRMED (25 Aug 2026, Kris found the real published figure): a paid
// Google Workspace account's "Email Read/Write Operations" quota (GmailApp
// search/fetch/label/draft calls -- exactly what this project does) is
// 50,000/day. Briefly dropped to 20,000 pending confirmation; restored now
// that it's actually verified, not guessed.
//
// ONE REAL NUANCE from what Kris found, worth knowing even though it
// doesn't change this code: Apps Script's own services (this one included)
// run on a ROLLING 24-hour window -- the limit starts restoring 24 hours
// after the FIRST request of the high-volume cycle that exhausted it, NOT
// a fixed midnight-Pacific reset. Separate Google Cloud Workspace API
// counters (different services) DO hard-reset at midnight Pacific. This
// project's OWN circuit breaker (isGmailQuotaExhausted/
// markGmailQuotaExhausted, above) is unaffected either way -- it's a
// self-imposed flag on OUR side that always clears at Pacific midnight by
// design, regardless of Google's actual mechanics. Worst case if Google's
// real quota hasn't actually recovered yet when our flag clears: the next
// attempt just throws the same quota error again and re-marks exhausted
// for another day -- self-correcting, not a bug, just means recovery could
// occasionally take a bit longer in wall-clock time than our flag implies.
const GMAIL_CALL_REAL_LIMIT_ESTIMATE = 50000;

// ADDED (25 Aug 2026, per direct request -- "send an email every 20% to
// Kris to alert about the quota"): one ops alert per 20% threshold crossed
// today, not just a single all-or-nothing cap. Reaching 100% still
// proactively halts everything via markGmailQuotaExhausted(), same as the
// old single soft-cap did -- the 20/40/60/80% tiers are early warnings,
// not stops.
const GMAIL_CALL_ALERT_THRESHOLDS_PCT = [20, 40, 60, 80, 100];

function recordGmailQuotaUsage_(count) {
  const props = PropertiesService.getScriptProperties();
  const today = todayPacificDateString();
  const isFreshDay = props.getProperty(GMAIL_CALL_COUNT_DATE_PROPERTY_KEY) !== today;
  const current = isFreshDay ? 0 : Number(props.getProperty(GMAIL_CALL_COUNT_PROPERTY_KEY) || 0);
  const updated = current + (count || 1);
  props.setProperty(GMAIL_CALL_COUNT_DATE_PROPERTY_KEY, today);
  props.setProperty(GMAIL_CALL_COUNT_PROPERTY_KEY, String(updated));

  const lastAlertedTier = isFreshDay ? 0 : Number(props.getProperty(GMAIL_CALL_LAST_ALERT_TIER_PROPERTY_KEY) || 0);
  const pct = (updated / GMAIL_CALL_REAL_LIMIT_ESTIMATE) * 100;
  const crossedTiers = GMAIL_CALL_ALERT_THRESHOLDS_PCT.filter(t => t > lastAlertedTier && pct >= t);

  if (crossedTiers.length > 0) {
    const newTier = crossedTiers[crossedTiers.length - 1];
    props.setProperty(GMAIL_CALL_LAST_ALERT_TIER_PROPERTY_KEY, String(newTier));

    if (newTier >= 100) {
      Logger.log('SELF-IMPOSED GMAIL QUOTA LIMIT (100% of ' + GMAIL_CALL_REAL_LIMIT_ESTIMATE + ') reached for ' + today + ' -- marking exhausted proactively, before Google\'s real limit throws.');
      markGmailQuotaExhausted();
      sendOpsAlert(
        'Gmail quota at 100% (self-tracked) -- stopping for today',
        'Today\'s self-tracked Gmail operation count (' + updated + ') reached the full estimated daily limit (' + GMAIL_CALL_REAL_LIMIT_ESTIMATE + ', our own conservative estimate, not an exact Google count). All Gmail-touching triggers will now skip themselves for the rest of today, same as if Google had thrown the real quota error -- this is meant to happen BEFORE that, not after.'
      );
    } else {
      sendOpsAlert(
        'Gmail quota at ' + newTier + '% (self-tracked)',
        'Today\'s self-tracked Gmail operation count is ' + updated + ' of an estimated ' + GMAIL_CALL_REAL_LIMIT_ESTIMATE + '/day (~' + Math.round(pct) + '%). This is our own conservative estimate, not an exact Google count. Nothing has stopped yet -- this is a heads-up so a busy day doesn\'t go from fine to fully exhausted with no warning in between.'
      );
    }
  }

  return updated;
}

function getGmailQuotaUsageToday_() {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty(GMAIL_CALL_COUNT_DATE_PROPERTY_KEY) !== todayPacificDateString()) return 0;
  return Number(props.getProperty(GMAIL_CALL_COUNT_PROPERTY_KEY) || 0);
}

function isGmailQuotaExhausted() {
  const props = PropertiesService.getScriptProperties();
  const markedDate = props.getProperty(QUOTA_EXHAUSTED_PROPERTY_KEY);
  return markedDate === todayPacificDateString();
}

function markGmailQuotaExhausted() {
  const props = PropertiesService.getScriptProperties();
  const today = todayPacificDateString();
  const alreadyMarkedToday = props.getProperty(QUOTA_EXHAUSTED_PROPERTY_KEY) === today;
  props.setProperty(QUOTA_EXHAUSTED_PROPERTY_KEY, today);
  if (!alreadyMarkedToday) {
    Logger.log('GMAIL QUOTA MARKED EXHAUSTED for ' + today + ' (Pacific). All Gmail-touching triggers will now skip themselves until tomorrow.');
  }
}

/**
 * Clears the quota-exhausted flag. Only call this manually if you
 * have a real reason to believe the quota reset early or was marked
 * incorrectly -- normally this should just age out naturally when
 * todayPacificDateString() rolls over.
 */
function clearGmailQuotaExhaustedFlag() {
  const props = PropertiesService.getScriptProperties();
  props.deleteProperty(QUOTA_EXHAUSTED_PROPERTY_KEY);
  // Also reset today's self-tracked counter -- otherwise the very next
  // recordGmailQuotaUsage_() call just re-trips the soft cap immediately and
  // undoes this manual clear.
  props.deleteProperty(GMAIL_CALL_COUNT_DATE_PROPERTY_KEY);
  props.deleteProperty(GMAIL_CALL_COUNT_PROPERTY_KEY);
  props.deleteProperty(GMAIL_CALL_LAST_ALERT_TIER_PROPERTY_KEY);
  Logger.log('Quota-exhausted flag cleared manually (and today\'s self-tracked call counter + alert tier reset).');
}

// ---------- LLM PROVIDER FALLBACK CHAIN (17 Aug 2026) ----------
//
// PROBLEM THIS SOLVES: Kris's Anthropic API key ran out of credit mid-run,
// silently killing every draft for the rest of that run -- each thread just
// logged "Classification/draft failed" and got skipped, with nothing
// surfaced until a human happened to notice zero drafts got made. The team
// also runs on Moonshot's Kimi day-to-day. This makes Kimi the PRIMARY
// provider, Anthropic an automatic fallback if Kimi errors, and -- if BOTH
// fail -- treats that as a real systemic problem (not a one-off): alerts
// Kris by email, then throws. Nothing in this project catches that throw,
// so it stops the whole run instead of silently repeating the same double
// failure for every remaining item in the batch.
//
// Every LLM call site in this project (Code.gs's classifyAndDraft,
// learning_loop.gs's generateSopSuggestions, and
// lead_followup_sequences.gs's classifyAndDraftFollowUp /
// summarizeFollowUpLearning) goes through this one function, so there is
// exactly one place that knows about both providers and both keys.
//
// Returns the parsed response body on success (same shape from either
// provider -- Moonshot's /anthropic endpoint returns Anthropic-shaped
// responses, so callers' existing data.content.find(...) parsing needs no
// changes). Throws on total failure -- let it propagate.
// ---------- COST TEST (24 Aug 2026, per direct request) ----------
//
// Kris put $20 on both Kimi and Anthropic specifically to find out which is
// actually cheaper per real draft, not just per-MTok list price -- token
// counts per call differ by provider (different tokenizers, and Kimi
// auto-caches while Anthropic needs the cache_control block added today).
// Kimi has been the sole PRIMARY since 17 Aug, so a straight A/B needs this
// flag: while true, callLlmWithFallback() alternates which provider goes
// FIRST on every call (a persistent Script Properties counter, not a
// per-thread hash, so the split stays an exact 50/50 by call count) --
// whichever isn't first is still the fallback if the first one fails. Every
// successful call, from either provider, gets its real token usage and
// computed cost logged to the "LLM Cost Log" tab regardless of this flag,
// so turning it off later doesn't lose visibility into ongoing spend.
//
// TO END THE TEST: once $20 is close to spent on one/both sides (check the
// LLM Cost Log tab, or each provider's own billing page), set this back to
// false -- callLlmWithFallback() reverts to the exact pre-test behavior,
// Kimi always first.
const LLM_COST_TEST_MODE = true;

const LLM_TEST_COUNTER_PROPERTY_KEY = 'LLM_COST_TEST_CALL_COUNTER';

function nextTestPrimaryProvider_() {
  const props = PropertiesService.getScriptProperties();
  const count = Number(props.getProperty(LLM_TEST_COUNTER_PROPERTY_KEY) || '0') + 1;
  props.setProperty(LLM_TEST_COUNTER_PROPERTY_KEY, String(count));
  return (count % 2 === 0) ? 'kimi' : 'anthropic';
}

// Anthropic pricing confirmed via the claude-api skill (cached 2026-06-24,
// checked live 24 Aug 2026): Sonnet 5 is $2.00/$10.00 per MTok in/out under
// the introductory rate through 2026-08-31, reverting to $3.00/$15.00 after.
// Cache economics are fixed regardless of the intro rate: reads cost 0.1x
// the input price, 5-minute-TTL writes cost 1.25x (see shared/prompt-caching.md).
// Kimi (Moonshot) pricing confirmed via web search 24 Aug 2026 (developer.puter.com,
// openrouter.ai): kimi-k2.6 is $0.95/$4.00 per MTok in/out, with automatic
// context caching billing cached input at $0.16/MTok -- Moonshot caches
// automatically server-side, no cache_control needed on their endpoint,
// which is why "Cache check" log lines have shown nonzero reads even though
// this code never requested caching from Kimi specifically.
// UPDATE THIS after 2026-08-31 (Sonnet reverts to $3/$15) or if either
// provider changes pricing -- these are USD per million tokens.
const LLM_PRICING_PER_MTOK = {
  kimi: { input: 0.95, output: 4.00, cacheRead: 0.16 },
  // CORRECTED (24 Aug 2026): cacheWrite was 2.50, i.e. 1.25x the input rate --
  // but 1.25x is the FIVE-MINUTE TTL write price. attemptLlmCall_() requests
  // ttl: "1h", and one-hour writes cost 2x, so this was understating every
  // Anthropic cache write by 60% -- in a split test whose entire purpose is
  // deciding which provider is cheaper, biased in Anthropic's favour.
  // (Verified against the prompt-caching reference, 24 Aug 2026. Reads stay
  // at 0.1x regardless of TTL. Break-even also shifts with the longer TTL:
  // a 5-minute cache pays for itself after 2 requests, a 1-hour one needs 3.)
  anthropic: { input: 2.00, output: 10.00, cacheRead: 0.20, cacheWrite: 4.00 },
};

// ADDED (24 Aug 2026, per direct request -- "cost per draft"): callers that
// want per-draft cost attribution (not just the aggregate LLM Cost Log)
// need to know which provider actually served a given classifyAndDraft()
// call. callLlmWithFallback()'s return value is unchanged (still the raw
// API response body, so every existing call site keeps working with no
// changes) -- but that raw body's own `model` field already says which
// model responded, so a caller can derive the provider from `data.model`
// directly instead of needing a new return shape.
// HARDENED (24 Aug 2026, found in review): this used to be
// `model === CONFIG.MODEL ? 'kimi' : 'anthropic'` -- an exact string match
// against the model we ASKED for, applied to the model string the provider
// ECHOED BACK. Those are not the same thing: providers routinely return a
// decorated or pinned variant of the requested id (`kimi-k2.6-0824`,
// `claude-sonnet-5-20260501`). Any such variance silently fell through the
// ternary's else branch and got priced as Anthropic -- which, on a split test
// whose entire purpose is comparing the two providers' costs, would corrupt
// the exact number being measured, in the exact direction that hides it
// (Kimi's spend being attributed to Anthropic). Match on the model family
// instead, and return null rather than guessing when it's neither, so bad
// data shows up as blank in the log instead of masquerading as a real figure.
function providerFromModel_(model) {
  const m = String(model || '').toLowerCase();
  if (m.indexOf('kimi') !== -1 || m.indexOf('moonshot') !== -1) return 'kimi';
  if (m.indexOf('claude') !== -1) return 'anthropic';
  Logger.log('providerFromModel_ -- unrecognized model string "' + model + '", cannot attribute provider. Returning null rather than guessing.');
  return null;
}

function estimateCallCostUsd_(provider, usage) {
  const p = LLM_PRICING_PER_MTOK[provider];
  if (!p || !usage) return null;
  const inputTokens = usage.input_tokens || 0;
  const outputTokens = usage.output_tokens || 0;
  const cacheReadTokens = usage.cache_read_input_tokens || 0;
  const cacheCreationTokens = usage.cache_creation_input_tokens || 0;
  const cost =
    (inputTokens / 1e6) * p.input +
    (outputTokens / 1e6) * p.output +
    (cacheReadTokens / 1e6) * p.cacheRead +
    (cacheCreationTokens / 1e6) * (p.cacheWrite || 0);
  return Math.round(cost * 1e6) / 1e6; // round to 6 decimals -- these are fractions of a cent per call
}

const LLM_COST_LOG_HEADERS = [
  'Timestamp', 'Caller', 'Provider', 'Model',
  'Input Tokens', 'Output Tokens', 'Cache Read Tokens', 'Cache Creation Tokens',
  'Estimated Cost USD',
  // ADDED (24 Aug 2026): see logLlmCallCost_ below -- a provider bills for a
  // call that came back unusable just the same as one that worked, so the log
  // has to record both or it under-reports real spend.
  'Outcome', 'Error',
];

function ensureLlmCostLogTabExists_(ss) {
  let tab = ss.getSheetByName('LLM Cost Log');
  if (!tab) {
    tab = ss.insertSheet('LLM Cost Log');
    tab.appendRow(LLM_COST_LOG_HEADERS);
    Logger.log('ensureLlmCostLogTabExists_ -- created tab: LLM Cost Log');
    return tab;
  }

  // MIGRATION (24 Aug 2026): the tab was created earlier today with 9
  // columns; Outcome/Error are new. Extend the header in place rather than
  // requiring a human to type them -- unlike the 'AI Drafts Log' (275+ rows
  // of history and a header humans may have customized, hence its
  // hands-off treatment), this tab is code-generated, hours old, and has a
  // header nobody has touched. Existing rows read blank in the new columns,
  // which is accurate: they predate the distinction.
  try {
    const width = tab.getLastColumn();
    const existing = width > 0 ? tab.getRange(1, 1, 1, width).getValues()[0] : [];
    if (existing.indexOf('Outcome') === -1) {
      tab.getRange(1, 1, 1, LLM_COST_LOG_HEADERS.length).setValues([LLM_COST_LOG_HEADERS]);
      Logger.log('ensureLlmCostLogTabExists_ -- migrated LLM Cost Log header to include Outcome/Error.');
    }
  } catch (e) {
    Logger.log('ensureLlmCostLogTabExists_ -- header migration failed (non-fatal, continuing): ' + e);
  }
  return tab;
}

// REWRITTEN (24 Aug 2026, real incident -- the split test's own numbers were
// wrong): this used to `return` immediately when `usage` was absent, and was
// only ever called on the SUCCESS path of callLlmWithFallback(). Both of
// those hid real money.
//
// The failure that matters: attemptLlmCall_() treats an HTTP 200 carrying no
// text block as a FAILURE (correctly -- see the thinking-mode bug documented
// there, where kimi-k2.6 spends its entire max_tokens budget reasoning and
// never writes an answer). But the provider still BILLED that call. Output
// tokens at Kimi's $4.00/MTok are charged whether the tokens were an answer
// or abandoned chain-of-thought. So every one of those burned real credit,
// fell back to Anthropic, and appeared NOWHERE in this log -- the sheet said
// Kimi was cheap while the Moonshot dashboard said otherwise. On a split test
// whose whole output is "which provider costs less," a cost log that only
// counts the calls that worked is not measuring the thing.
//
// Now every attempt is logged with an outcome:
//   ok                  -- usable response, this is the one that did the work
//   billed_no_output    -- HTTP 200, provider billed it, no usable text came back
//   failed              -- transport/HTTP error; typically not billed, logged
//                          anyway so failure RATE per provider is measurable
//                          (that is a quality signal, not just a cost one)
function logLlmCallCost_(callerLabel, provider, model, usage, outcome, errorText) {
  const costUsd = usage ? estimateCallCostUsd_(provider, usage) : 0;
  try {
    const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    const tab = ensureLlmCostLogTabExists_(ss);
    tab.appendRow([
      new Date(), callerLabel, provider, model,
      usage ? (usage.input_tokens || 0) : 0,
      usage ? (usage.output_tokens || 0) : 0,
      usage ? (usage.cache_read_input_tokens || 0) : 0,
      usage ? (usage.cache_creation_input_tokens || 0) : 0,
      costUsd,
      outcome || 'ok',
      errorText ? String(errorText).slice(0, 500) : '',
    ]);
  } catch (e) {
    Logger.log('logLlmCallCost_ -- failed to log (non-fatal, continuing): ' + e);
  }
  return costUsd;
}

function callLlmWithFallback(systemPrompt, userPrompt, maxTokens, callerLabel) {
  const props = PropertiesService.getScriptProperties();
  const kimiKey = props.getProperty('KIMI_API_KEY');
  const anthropicKey = props.getProperty('ANTHROPIC_API_KEY');

  const providers = {
    kimi: kimiKey ? {
      name: 'kimi',
      model: CONFIG.MODEL,
      call: () => attemptLlmCall_(
        'https://api.moonshot.ai/anthropic/v1/messages',
        { 'Authorization': 'Bearer ' + kimiKey },
        CONFIG.MODEL,
        systemPrompt, userPrompt, maxTokens,
        // kimi-k2.6 defaults to "Thinking" mode -- visible chain-of-thought that
        // counts against max_tokens. Confirmed in production (17 Aug 2026): every
        // call came back stop_reason: max_tokens, content types: ["thinking"],
        // with NO text block at all -- the model spent the entire budget
        // reasoning and never got to write the actual answer. This task only
        // needs the direct JSON output, so thinking mode is switched off.
        { thinking: { type: 'disabled' } }
      ),
    } : null,
    anthropic: anthropicKey ? {
      name: 'anthropic',
      model: CONFIG.ANTHROPIC_FALLBACK_MODEL,
      call: () => attemptLlmCall_(
        'https://api.anthropic.com/v1/messages',
        { 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
        CONFIG.ANTHROPIC_FALLBACK_MODEL,
        systemPrompt, userPrompt, maxTokens,
        // ADDED (25 Aug 2026, real incident -- confirmed live via the LLM
        // Cost Log's Outcome column, which only started existing today):
        // this call never disabled thinking, unlike Kimi's just above --
        // and Claude Sonnet 5 runs ADAPTIVE THINKING ON BY DEFAULT when the
        // thinking param is omitted entirely (unlike Opus 4.8/4.7, where
        // omitting it means no thinking). That's the exact same failure
        // class Kimi hit on 17 Aug: the model spends part of the shared
        // max_tokens budget reasoning before it ever gets to write the JSON
        // response, and on a harder classification can run out of room
        // before producing any text block at all -- billed in full, no
        // usable output. Confirmed today: 4 of 40 Anthropic calls, $0.1667
        // wasted, exactly this signature. classifyAndDraft() defines no
        // tools, so the Opus-5-specific "tool call leaks into visible text"
        // disabled-thinking pitfall doesn't apply here structurally: there's
        // no tool_use for anything to leak out of.
        { thinking: { type: 'disabled' } }
      ),
    } : null,
  };

  // Order: normally Kimi first (unchanged pre-test behavior). During the
  // cost test, alternate which one goes first so both get real, comparable
  // first-attempt volume rather than Anthropic only ever seeing Kimi's
  // failures.
  const firstName = LLM_COST_TEST_MODE ? nextTestPrimaryProvider_() : 'kimi';
  const order = firstName === 'kimi' ? ['kimi', 'anthropic'] : ['anthropic', 'kimi'];

  for (const name of order) {
    const provider = providers[name];
    if (!provider) {
      Logger.log(callerLabel + ' -- ' + (name === 'kimi' ? 'KIMI_API_KEY' : 'ANTHROPIC_API_KEY') + ' not set in Script Properties, skipping ' + name + '.');
      continue;
    }
    const attemptedFirst = (name === order[0]);
    const result = provider.call();

    if (result.ok) {
      const costUsd = logLlmCallCost_(callerLabel, provider.name, provider.model, result.data.usage, 'ok', '');
      // ADDED (24 Aug 2026, per direct request -- split test must measure
      // both price and quality): stamp WHICH provider actually served this
      // call, and what it cost, directly onto the returned object. Callers
      // previously re-derived the provider from data.model themselves, which
      // meant two independent derivations of the same fact that could
      // disagree (and one of them, providerFromModel_, was doing an exact
      // string match -- see its comment). This is the authoritative one: we
      // know which branch we called. The return value is still the same raw
      // API response object every existing call site already handles, just
      // with two extra fields hanging off it, so nothing downstream breaks.
      // Underscore-prefixed to make clear these are ours, not the provider's.
      result.data._servedByProvider = provider.name;
      result.data._estimatedCostUsd = costUsd;
      result.data._servedOnFirstAttempt = attemptedFirst;
      return result.data;
    }

    // A 200 response with no usable content was still billed -- log the
    // spend under its own outcome so the sheet reconciles against the
    // provider's real dashboard. A transport/HTTP error generally wasn't
    // billed, but gets logged too so per-provider failure rate is visible.
    logLlmCallCost_(
      callerLabel, provider.name, provider.model,
      result.data ? result.data.usage : null,
      result.billed ? 'billed_no_output' : 'failed',
      result.error
    );
    Logger.log(callerLabel + ' -- ' + name + ' call failed' + (attemptedFirst ? ', trying ' + order[1] + ': ' : ' (both attempted): ') + result.error);
  }

  sendOpsAlert(
    'Both Kimi and Anthropic API calls failed',
    callerLabel + ' could not get a usable response from either LLM provider. This run has been stopped rather than continuing to fail silently for every remaining item. Check both KIMI_API_KEY and ANTHROPIC_API_KEY (credit balance / validity) in Script Properties, fix whichever is broken, then re-run manually.'
  );
  throw new Error(callerLabel + ': both Kimi and Anthropic calls failed -- see execution log and the ops alert email for details.');
}

function attemptLlmCall_(url, headers, model, systemPrompt, userPrompt, maxTokens, extraPayloadFields) {
  try {
    // PROMPT CACHING (22 Aug 2026, per direct request; re-verified working
    // 24 Aug 2026 after an earlier version of this comment falsely claimed
    // caching was already active while system was still being sent as a
    // plain string -- the Anthropic Console's Caching page showed zero
    // activity, and daily spend had been climbing ($0.47 -> $43.74 over a
    // week) as the SOP text grew (27k -> 35k chars) and got resent in full
    // on every single classification call). systemPrompt is Code.gs's full
    // SOP text plus one of exactly two stable append blocks
    // (buildSystemPromptForMode's "joana" or "hormozi" variant) -- large
    // (thousands of words, well above every model's cacheable minimum) and
    // byte-identical across every classifyAndDraft call in a given mode until
    // Kris edits the SOP Doc or the 6h CacheService TTL expires. Per-thread
    // dynamic content (today's date, subject, lead email, thread text) lives
    // entirely in userPrompt, never here -- so this reshape is safe: it
    // doesn't move anything that changes per-call into the cached prefix.
    //
    // ttl: "1h" chosen over the 5-min default specifically because
    // runReplyDrafter fires every 5 minutes -- the default TTL would often
    // lapse in the exact gap between runs and never get reused across runs,
    // only (at best) across threads within the same run. A 1-hour TTL survives
    // that gap and gets reused across many runs before the SOP doc's own 6h
    // cache would force a rewrite anyway.
    //
    // NOT YET CONFIRMED to actually cache on Kimi (the primary provider) --
    // Moonshot's Anthropic-compatible endpoint may or may not honor
    // cache_control. Harmless either way (worst case it's silently ignored),
    // but check the "Cache check" log line classifyAndDraft() already prints
    // (cache_read_input_tokens / cache_creation_input_tokens) after deploying
    // to see which provider is actually returning cache hits.
    const payload = Object.assign({
      model: model,
      max_tokens: maxTokens,
      system: [{
        type: 'text',
        text: systemPrompt,
        cache_control: { type: 'ephemeral', ttl: '1h' },
      }],
      messages: [{ role: 'user', content: userPrompt }],
    }, extraPayloadFields || {});

    const response = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      headers: headers,
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
    });

    if (response.getResponseCode() !== 200) {
      return { ok: false, error: 'HTTP ' + response.getResponseCode() + ': ' + response.getContentText() };
    }

    const data = JSON.parse(response.getContentText('UTF-8'));

    // FIX (17 Aug 2026): a 200 response is not the same as a USABLE response --
    // this is exactly how the thinking-mode bug above slipped past the fallback
    // entirely last time. A response with no text content block (e.g. it hit
    // max_tokens mid-"thinking" and never wrote an answer) must count as a
    // failure here so the caller actually falls back to the other provider,
    // instead of handing back content-free "success" that only fails later,
    // downstream, after the fallback chance is already gone.
    const hasTextBlock = (data.content || []).some(c => c.type === 'text');
    if (!hasTextBlock) {
      return {
        ok: false,
        // ADDED (24 Aug 2026): hand the response body back even though this
        // counts as a failure. The provider billed this call -- `data.usage`
        // is the only record of how much -- and callLlmWithFallback() needs
        // it to log the spend. Returning only an error string here is what
        // made these calls invisible to the cost log; see logLlmCallCost_.
        data: data,
        billed: true,
        error: 'no usable text block in response (stop_reason: ' + data.stop_reason +
          ', content types: ' + JSON.stringify((data.content || []).map(c => c.type)) + ')'
      };
    }

    return { ok: true, data: data };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// ADDED (25 Aug 2026, per direct request -- "why is it storing here, just
// put it in a log"): the alert-dedup flag used to be its own permanent
// Script Property per (subject, day) -- ALERT_SENT_<subject>_<date> --
// and Script Properties are never cleaned up automatically, so every
// distinct alert type left one behind forever, cluttering Project Settings
// and slowly working toward Apps Script's own property-count/storage
// ceiling. This tab replaces that: same dedup behavior, but as a real,
// readable history (WHEN each alert fired and what it said) instead of a
// bare boolean with no context -- matching every other log in this project.
function ensureOpsAlertLogTabExists_(ss) {
  let tab = ss.getSheetByName('Ops Alert Log');
  if (!tab) {
    tab = ss.insertSheet('Ops Alert Log');
    tab.appendRow(['Timestamp', 'Pacific Date', 'Subject', 'Body']);
    Logger.log('ensureOpsAlertLogTabExists_ -- created tab: Ops Alert Log');
  }
  return tab;
}

/**
 * Sends an alert via MailApp (NOT GmailApp) -- a separate quota, so
 * this keeps working even when Gmail access itself is dead. Rate
 * limited to once per unique subject per Pacific day, so a repeated
 * failure condition doesn't spam your inbox every time it's checked.
 *
 * The dedup check and the send are deliberately independent of each other's
 * failure: if the Sheet can't be read (rare, but this file exists precisely
 * for "what if something's down"), fail OPEN and send anyway -- a duplicate
 * alert is a minor annoyance, a missing one is the exact failure mode this
 * whole file exists to prevent. If the Sheet write after a successful send
 * fails, that's logged but does not affect the alert that already went out.
 */
function sendOpsAlert(subject, body) {
  const today = todayPacificDateString();

  let alreadySentToday = false;
  let tab = null;
  try {
    const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    tab = ensureOpsAlertLogTabExists_(ss);
    const rows = tab.getDataRange().getValues().slice(1);
    // FIX (27 Aug 2026, real risk found in review): `today` is a bare
    // 'yyyy-MM-dd' string. appendRow() below writes it into a General-
    // formatted cell, and Sheets can auto-recognize a string shaped like a
    // date and store it as an actual date value on write -- in which case
    // it reads back here as a Date object, and String(dateObj) (e.g. "Wed
    // Aug 26 2026 00:00:00 GMT+0200") never equals the plain 'today'
    // string. If that's happening on this sheet, this dedup silently never
    // matches, and the "once per subject per Pacific day" rate limit never
    // engages -- worth checking directly (open the Ops Alert Log tab and
    // see whether column B renders as a date or as plain text), but
    // normalizing on read costs nothing either way and is correct for both
    // cases.
    const asPacificDay_ = v => (v instanceof Date)
      ? Utilities.formatDate(v, 'America/Los_Angeles', 'yyyy-MM-dd')
      : String(v).trim();
    alreadySentToday = rows.some(r => asPacificDay_(r[1]) === today && String(r[2]) === subject);
  } catch (e) {
    Logger.log('sendOpsAlert -- could not check the Ops Alert Log tab for dedup (failing open, sending anyway): ' + e);
  }

  if (alreadySentToday) {
    Logger.log('Alert suppressed (already sent today for this subject): ' + subject);
    return;
  }

  try {
    // CHANGED (25 Aug 2026, per direct request after the "Gmail Advanced
    // Service missing" alert -- "This only needs to get sent to Kris,
    // others don't know how to fix"): reverses the 23 Aug change that had
    // added Tomas to cc here under a blanket "all emails CC Kris & Tomas"
    // instruction. sendOpsAlert() specifically carries infra/code failures
    // (wrong-account triggers, missing Advanced Services, quota exhaustion)
    // that only Kris can act on -- CCing Tomas just adds noise he can't do
    // anything with. This does NOT change cc on the other outbound emails
    // (daily_report.gs, missed_leads_audit.gs, stalled_bookings_audit.gs,
    // learning_loop.gs) -- those stay CC'd to both per the 23 Aug policy.
    MailApp.sendEmail({
      to: 'kris@iconsofrealestate.com',
      subject: '[Icons Ops Alert] ' + subject,
      body: body + '\n\n(This alert was sent automatically by the Apps Script ops monitoring. Written with Claude\'s help.)'
    });
    Logger.log('Ops alert sent: ' + subject);
  } catch (e) {
    Logger.log('FAILED TO SEND OPS ALERT (this is bad -- MailApp itself is failing): ' + e);
    return; // nothing actually sent -- don't record a row claiming it did
  }

  try {
    (tab || ensureOpsAlertLogTabExists_(SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID)))
      .appendRow([new Date(), today, subject, body]);
  } catch (e) {
    Logger.log('sendOpsAlert -- alert email sent, but failed to record it in the Ops Alert Log tab (dedup may not work next time for this subject): ' + e);
  }
}

// ONE-OFF (25 Aug 2026): run this once from the editor to remove the stray
// per-day properties that accumulated under the old designs above --
// ALERT_SENT_<subject>_<date> and GMAIL_CALL_COUNT_<date>. Safe to run any
// time: only deletes keys matching those exact legacy shapes, and is
// careful not to touch the new fixed keys (GMAIL_CALL_COUNT,
// GMAIL_CALL_COUNT_DATE_PACIFIC) that replaced the second one.
function cleanupLegacyDateSuffixedProperties() {
  const props = PropertiesService.getScriptProperties();
  const all = props.getProperties();
  const legacyGmailCountPattern = /^GMAIL_CALL_COUNT_\d{4}-\d{2}-\d{2}$/;
  let removed = 0;
  Object.keys(all).forEach(key => {
    if (key.indexOf('ALERT_SENT_') === 0 || legacyGmailCountPattern.test(key)) {
      props.deleteProperty(key);
      removed++;
    }
  });
  Logger.log('cleanupLegacyDateSuffixedProperties -- removed ' + removed + ' stray propert' + (removed === 1 ? 'y' : 'ies') + '.');
}

// ONE-OFF (25 Aug 2026, per direct request -- "we need to log and save that
// information"): backfills the one real quota-exhaustion event from last
// night into the Ops Alert Log tab. It happened before that tab existed
// (added later the same day), so nothing captured it durably -- only the
// Apps Script execution log has it, pasted manually into chat, and
// execution logs don't retain forever. Safe to run once; re-running just
// appends a duplicate row (delete the extra by hand if that happens).
function backfillYesterdaysQuotaExhaustionLog() {
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const tab = ensureOpsAlertLogTabExists_(ss);
  // Exact timestamp from the real execution log (Europe/Paris, this
  // project's timezone): 25 Aug 2026, 10:25:09 PM.
  const timestamp = new Date(2026, 7, 25, 22, 25, 9);
  tab.appendRow([
    timestamp,
    '2026-08-25',
    'Gmail quota exhausted -- runReplyDrafter stopped',
    'Backfilled 25 Aug 2026 from the real Apps Script execution log -- the Ops Alert Log tab did not exist yet when this actually happened. Real Google error: "Service invoked too many times for one day: premium gmail", first appearing around 10:23 PM after repeated "Skipped a draft while checking for duplicates" failures from draftAlreadyExistsFor() (root cause: it re-fetched the entire Drafts folder per candidate thread instead of once per run -- fixed the same day). markGmailQuotaExhausted() fired at 10:25:09 PM; all Gmail-touching triggers skipped themselves until the flag cleared.'
  ]);
  Logger.log('backfillYesterdaysQuotaExhaustionLog -- appended historical row for 2026-08-25 22:25:09.');
}