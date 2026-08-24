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
 *
 * HOW TO WIRE THIS INTO EXISTING FUNCTIONS:
 * At the very top of runReplyDrafterInner(), runLeadFollowUpCycle(),
 * runMissedLeadsAudit(), runStalledBookingsAudit(), and any other
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
  PropertiesService.getScriptProperties().deleteProperty(QUOTA_EXHAUSTED_PROPERTY_KEY);
  Logger.log('Quota-exhausted flag cleared manually.');
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
    // FIX (24 Aug 2026, real incident): system was sent as a plain string,
    // so cache_control was never actually applied despite the SOP comment
    // above claiming it was -- the Anthropic Console's Caching page showed
    // zero activity, and daily spend had been climbing ($0.47 -> $43.74
    // over a week) as the SOP text grew (27k -> 35k chars) and got resent
    // in full on every single classification call. Wrapping system in the
    // content-block array form with cache_control lets the provider cache
    // that large repeated block instead of billing it at full price every
    // call -- Anthropic's ephemeral cache is ~90% cheaper on a hit than a
    // fresh read. Not yet confirmed whether Kimi's Anthropic-compatible
    // endpoint honors this the same way; worth checking its own billing
    // page after this has been live a day.
    const payload = Object.assign({
      model: model,
      max_tokens: maxTokens,
      system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
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