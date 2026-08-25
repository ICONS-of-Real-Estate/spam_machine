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

const QUOTA_ERROR_SUBSTRING_GLOBAL = 'too many times for one day';
const QUOTA_EXHAUSTED_PROPERTY_KEY = 'GMAIL_QUOTA_EXHAUSTED_DATE_PACIFIC';
const ALERT_SENT_PROPERTY_PREFIX = 'ALERT_SENT_';

function isQuotaExceededError(e) {
  return String(e).indexOf(QUOTA_ERROR_SUBSTRING_GLOBAL) !== -1;
}

function todayPacificDateString() {
  return Utilities.formatDate(new Date(), 'America/Los_Angeles', 'yyyy-MM-dd');
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
const GMAIL_CALL_COUNT_PROPERTY_PREFIX = 'GMAIL_CALL_COUNT_';
const GMAIL_CALL_SOFT_CAP = 40000; // ~80% of the real 50,000/day Workspace ceiling, leaving headroom for jobs/manual use this counter doesn't see

function recordGmailQuotaUsage_(count) {
  const props = PropertiesService.getScriptProperties();
  const key = GMAIL_CALL_COUNT_PROPERTY_PREFIX + todayPacificDateString();
  const current = Number(props.getProperty(key) || 0);
  const updated = current + (count || 1);
  props.setProperty(key, String(updated));
  if (updated >= GMAIL_CALL_SOFT_CAP && current < GMAIL_CALL_SOFT_CAP) {
    Logger.log('SELF-IMPOSED GMAIL QUOTA SOFT CAP (' + GMAIL_CALL_SOFT_CAP + ') reached for ' + todayPacificDateString() + ' -- marking exhausted proactively, before Google\'s real limit throws.');
    markGmailQuotaExhausted();
    sendOpsAlert(
      'Gmail quota soft cap reached (self-tracked)',
      'Today\'s self-tracked Gmail operation count crossed ' + GMAIL_CALL_SOFT_CAP + ' (our own conservative estimate, not an exact Google count). All Gmail-touching triggers will now skip themselves for the rest of today, same as if Google had thrown the real quota error -- this is meant to happen BEFORE that, not after.'
    );
  }
  return updated;
}

function getGmailQuotaUsageToday_() {
  const props = PropertiesService.getScriptProperties();
  return Number(props.getProperty(GMAIL_CALL_COUNT_PROPERTY_PREFIX + todayPacificDateString()) || 0);
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
  props.deleteProperty(GMAIL_CALL_COUNT_PROPERTY_PREFIX + todayPacificDateString());
  Logger.log('Quota-exhausted flag cleared manually (and today\'s self-tracked call counter reset).');
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

/**
 * Sends an alert via MailApp (NOT GmailApp) -- a separate quota, so
 * this keeps working even when Gmail access itself is dead. Rate
 * limited to once per unique subject per Pacific day, so a repeated
 * failure condition doesn't spam your inbox every time it's checked.
 */
function sendOpsAlert(subject, body) {
  const props = PropertiesService.getScriptProperties();
  const key = ALERT_SENT_PROPERTY_PREFIX + subject.replace(/[^a-zA-Z0-9]/g, '_') + '_' + todayPacificDateString();

  if (props.getProperty(key) === 'true') {
    Logger.log('Alert suppressed (already sent today for this subject): ' + subject);
    return;
  }

  try {
    // CHANGED (23 Aug 2026, per direct request -- "all emails need to be
    // CC kris & Tomas"): this reverses an earlier same-day change that had
    // dropped Tomas from cc on the reasoning that ops alerts are
    // infra/code issues only Kris can act on. That reasoning still holds,
    // but the later, more explicit instruction was a blanket "all emails"
    // rule, so Tomas is back on cc here too.
    MailApp.sendEmail({
      to: 'kris@iconsofrealestate.com',
      cc: 'tomas@iconsofrealestate.com',
      subject: '[Icons Ops Alert] ' + subject,
      body: body + '\n\n(This alert was sent automatically by the Apps Script ops monitoring. Written with Claude\'s help.)'
    });
    props.setProperty(key, 'true');
    Logger.log('Ops alert sent: ' + subject);
  } catch (e) {
    Logger.log('FAILED TO SEND OPS ALERT (this is bad -- MailApp itself is failing): ' + e);
  }
}