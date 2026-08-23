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
function callLlmWithFallback(systemPrompt, userPrompt, maxTokens, callerLabel) {
  const props = PropertiesService.getScriptProperties();
  const kimiKey = props.getProperty('KIMI_API_KEY');
  const anthropicKey = props.getProperty('ANTHROPIC_API_KEY');

  if (kimiKey) {
    const kimiResult = attemptLlmCall_(
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
    );
    if (kimiResult.ok) return kimiResult.data;
    Logger.log(callerLabel + ' -- Kimi call failed, falling back to Anthropic: ' + kimiResult.error);
  } else {
    Logger.log(callerLabel + ' -- KIMI_API_KEY not set in Script Properties, going straight to Anthropic fallback.');
  }

  if (anthropicKey) {
    const anthropicResult = attemptLlmCall_(
      'https://api.anthropic.com/v1/messages',
      { 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
      CONFIG.ANTHROPIC_FALLBACK_MODEL,
      systemPrompt, userPrompt, maxTokens
    );
    if (anthropicResult.ok) return anthropicResult.data;
    Logger.log(callerLabel + ' -- Anthropic fallback ALSO failed: ' + anthropicResult.error);
  } else {
    Logger.log(callerLabel + ' -- ANTHROPIC_API_KEY not set in Script Properties, no fallback available.');
  }

  sendOpsAlert(
    'Both Kimi and Anthropic API calls failed',
    callerLabel + ' could not get a usable response from either LLM provider. This run has been stopped rather than continuing to fail silently for every remaining item. Check both KIMI_API_KEY and ANTHROPIC_API_KEY (credit balance / validity) in Script Properties, fix whichever is broken, then re-run manually.'
  );
  throw new Error(callerLabel + ': both Kimi and Anthropic calls failed -- see execution log and the ops alert email for details.');
}

function attemptLlmCall_(url, headers, model, systemPrompt, userPrompt, maxTokens, extraPayloadFields) {
  try {
    // PROMPT CACHING (22 Aug 2026, per direct request -- see the false-comment
    // fix earlier this same day for how this gap was found): systemPrompt is
    // Code.gs's full SOP text plus one of exactly two stable append blocks
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