/**
 * ICONS OF REAL ESTATE — GHL (GoHighLevel) contact-lookup, read-only probes
 * (28 Aug 2026, per direct request -- building the "Sean gets 2-3 days,
 * then falls back into the cycle" logic for the follow-up cadences in
 * lead_followup_sequences.gs).
 *
 * WHY THIS EXISTS: neither follow-up cadence (Podcast Sales, Hub Guest) has
 * any way to tell whether Sean/Bens already contacted a lead outside of
 * Gmail (Tomás: "not always with an email... but the system can check if
 * Sean made a contact through the CRM. Every time Sean calls a lead it is
 * attached to their contact on the CRM"). The fallback cadence needs to
 * check that before drafting a follow-up, or it risks re-contacting a lead
 * Sean already reached by phone.
 *
 * PATTERN COPIED FROM A SIBLING PROJECT (per direct request -- "here's how
 * this project connects to GHL, so you can replicate it"): that project's
 * `Phase9_GhlSync.gs` already solved real-integration/auth/probe-before-build
 * for GHL against a DIFFERENT spreadsheet and pipeline set. Two things are
 * intentionally different here, not copy-paste:
 *   1. MATCH BY EMAIL, not name. The sibling project resorts to fuzzy
 *      name-matching because its own Prospect Email column is legacy-blank.
 *      This project's follow-up queues already carry a real, re-derived
 *      lead email for every row (extractForwardedLeadInfo -- see
 *      lead_followup_sequences.gs) -- an exact match, so there is no reason
 *      to accept name-matching's ambiguity here.
 *   2. DIFFERENT PIPELINE. Per the 27 Aug 2026 decision, this project's
 *      leads get their own "SPAM" pipeline in GHL, separate from the six
 *      sales pipelines the sibling project maps in its GHL_PIPELINE_MAP.md.
 *      That pipeline's actual stage names are NOT YET KNOWN here --
 *      previewGhlConnection() below exists specifically to find out, same
 *      as the sibling project's own first probe did for its pipelines.
 *
 * CURRENT STATE: READ-ONLY. Nothing in this file writes to GHL, writes to
 * any sheet, or drafts anything. There is no ENABLED flag yet because there
 * is nothing gated by one -- the actual "has Sean contacted this lead"
 * check (and wiring it into the follow-up cadences' fallback timer) is
 * NOT YET BUILT, and deliberately won't be until previewGhlConnection()'s
 * output identifies the real SPAM-pipeline stage(s) that mean "contacted."
 * Guessing that from a stage NAME the way ghlStageToOutcomeDisposition_
 * does in the sibling project is exactly the kind of guess this project's
 * own FUTURE_FEATURES.md already warned against for GHL ("don't guess API
 * shape, verify first").
 *
 * SETUP (one-time, in the Apps Script editor -- NOT in this repo):
 *   Project Settings (gear icon) -> Script Properties -> Add:
 *     GHL_API_KEY      = the Private Integration token (Settings ->
 *                         Private Integrations in GHL, per-location)
 *     GHL_LOCATION_ID  = the sub-account's Location ID
 *   Same names as the sibling project's Script Properties -- if this
 *   project's leads live in the SAME GHL sub-account, the same two values
 *   can be pasted in here too; if it's a different sub-account/location,
 *   use that location's own token and ID instead. Either way these are
 *   runtime storage, not code -- `clasp push` never touches them, matching
 *   KIMI_API_KEY/ANTHROPIC_API_KEY's existing treatment in this project
 *   (see quota_guard_and_alerting.gs).
 *
 * THEN, in order:
 *   1. previewGhlConnection() -- proves the credentials work and dumps
 *      every pipeline + stage with its ID. Find the "SPAM" pipeline in the
 *      output (or whatever it's actually named) and paste the whole log
 *      back -- that's what decides how "Sean contacted" gets detected.
 *   2. previewGhlLeadMatching() -- samples a few real leads from this
 *      project's own follow-up queues and reports whether searching GHL by
 *      email finds a real contact. Paste that log back too.
 * Both are read-only, safe to re-run, and send nothing.
 */

var GHL_CONFIG = {
  API_KEY_PROPERTY: 'GHL_API_KEY',
  LOCATION_ID_PROPERTY: 'GHL_LOCATION_ID',

  // GHL API v2 (LeadConnector). Confirmed live by the sibling project's own
  // probe run (28 Aug 2026) -- reusing its verified base/version rather
  // than re-guessing.
  API_BASE: 'https://services.leadconnectorhq.com',
  API_VERSION: '2021-07-28',
};

/**
 * GET against the GHL API. Returns { status, json, body, url } rather than
 * throwing on a non-2xx, so callers can report the real error instead of a
 * generic exception -- same self-diagnosing contract as this project's own
 * callLlmWithFallback/attemptLlmCall_ pattern for a third-party API, and
 * the same contract the sibling project's ghlApiGet_ uses.
 */
function ghlApiGet_(path) {
  const token = PropertiesService.getScriptProperties().getProperty(GHL_CONFIG.API_KEY_PROPERTY);
  const url = GHL_CONFIG.API_BASE + path;
  const resp = UrlFetchApp.fetch(url, {
    method: 'get',
    muteHttpExceptions: true, // see a 401/404/422 directly rather than throwing on it
    headers: {
      Authorization: 'Bearer ' + token,
      Version: GHL_CONFIG.API_VERSION,
      Accept: 'application/json',
    },
  });
  const status = resp.getResponseCode();
  const body = resp.getContentText();
  let json = null;
  try {
    json = JSON.parse(body);
  } catch (e) {
    // leave json null -- caller logs the raw body, which is what's needed
    // when the response is an HTML error page rather than JSON.
  }
  return { status: status, json: json, body: body, url: url };
}

/**
 * Confirms both Script Properties exist before any GHL call, throwing a
 * clear message rather than letting every entry point fail on a different
 * obscure error later.
 */
function ghlCheckSetup_() {
  const props = PropertiesService.getScriptProperties();
  const locationId = props.getProperty(GHL_CONFIG.LOCATION_ID_PROPERTY);
  const apiKey = props.getProperty(GHL_CONFIG.API_KEY_PROPERTY);
  if (!locationId || !apiKey) {
    throw new Error('Missing ' + GHL_CONFIG.LOCATION_ID_PROPERTY + ' and/or ' + GHL_CONFIG.API_KEY_PROPERTY +
      ' in Script Properties. Set both under Project Settings -> Script Properties, then re-run. See this file\'s header.');
  }
  return locationId;
}

/**
 * Fetches every pipeline + stage from the live API. Returns null (not [])
 * on any failure, after logging the full diagnostic -- a caller that can't
 * tell "API failed" from "genuinely no pipelines" would silently treat a
 * transient outage as "nothing here," same reasoning as every other
 * distinguish-failure-from-empty helper in this project (e.g.
 * loadStateDirectory in Code.gs).
 */
function fetchGhlPipelines_(locationId) {
  const path = '/opportunities/pipelines?locationId=' + encodeURIComponent(locationId);
  const res = ghlApiGet_(path);

  if (res.status !== 200) {
    Logger.log('GHL API returned HTTP ' + res.status + ' for ' + res.url);
    Logger.log('Response body (first 1000 chars): ' + String(res.body).slice(0, 1000));
    Logger.log('Interpretation guide:');
    Logger.log('  401/403 -> the token is wrong, expired, or lacks the Opportunities read scope.');
    Logger.log('  404     -> the endpoint path or API_BASE in GHL_CONFIG is wrong for this account.');
    Logger.log('  422     -> locationId is malformed or does not match the token\'s sub-account.');
    Logger.log('Paste this log back to Claude and the config will be corrected.');
    return null;
  }

  const pipelines = (res.json && (res.json.pipelines || res.json.data)) || [];
  if (!pipelines.length) {
    Logger.log('Connected OK (HTTP 200) but no pipelines came back. Raw body (first 1000 chars): ' +
      String(res.body).slice(0, 1000));
    return null;
  }
  return pipelines;
}

/** Apps Script's "Select function" dropdown hides trailing-underscore functions -- this is the runnable entry point. */
function previewGhlConnection() {
  return previewGhlConnection_();
}

/**
 * Read-only probe. Proves the credential works and dumps every pipeline
 * and stage with its ID. Stage IDs (not names) are the durable keys any
 * later "what stage means contacted" mapping must be built against -- names
 * get renamed, IDs don't.
 *
 * Writes nothing, sends nothing, safe to re-run.
 */
function previewGhlConnection_() {
  Logger.log('PREVIEW MODE -- read-only GHL probe. Nothing will be written or sent.');

  let locationId;
  try {
    locationId = ghlCheckSetup_();
  } catch (e) {
    Logger.log('SETUP INCOMPLETE: ' + e);
    return;
  }

  const pipelines = fetchGhlPipelines_(locationId);
  if (!pipelines) return; // fetchGhlPipelines_ already logged why

  Logger.log('Connected OK -- ' + pipelines.length + ' pipeline(s) found.');
  Logger.log('Looking for the "SPAM" pipeline (or whatever this project\'s leads pipeline is actually ' +
    'named) in the list below -- that pipeline\'s stage names are what decide how "Sean contacted this ' +
    'lead" gets detected.');

  pipelines.forEach(p => {
    const stages = p.stages || [];
    Logger.log('');
    Logger.log('PIPELINE: "' + p.name + '"  id=' + p.id + '  (' + stages.length + ' stage(s))');
    stages.forEach((s, i) => {
      Logger.log('   ' + (i + 1) + '. "' + s.name + '"  id=' + s.id);
    });
  });

  Logger.log('');
  Logger.log('Next: paste this whole log back to Claude.');
}

// ---------------------------------------------------------------------------
// Matching: does a follow-up queue row's real lead email resolve to an
// actual GHL contact? Unlike the sibling project (forced into fuzzy NAME
// matching because its own Prospect Email column is legacy-blank), this
// project's PODCAST_SALES_QUEUE_TAB / HUB_GUEST_QUEUE_TAB rows already
// carry a real, re-derived lead email (column C -- see
// registerNewPodcastSalesLeads/registerNewHubGuestInvites in
// lead_followup_sequences.gs) -- an exact join key, no fuzzy matching
// needed.
// ---------------------------------------------------------------------------

/**
 * Searches GHL contacts by email. Endpoint/param name is a best-effort
 * guess (GHL's own docs were unreachable from the sibling project's
 * sandbox too -- see that project's ghlSearchContactByName_ for the same
 * caveat) -- same self-diagnosing contract as ghlApiGet_: a non-200 or an
 * unrecognized response shape reports the raw body instead of silently
 * returning nothing, so a wrong param name is a one-line fix from the log,
 * not a mystery.
 */
function ghlSearchContactByEmail_(locationId, email) {
  const path = '/contacts/?locationId=' + encodeURIComponent(locationId) +
    '&query=' + encodeURIComponent(email) + '&limit=5';
  const res = ghlApiGet_(path);
  if (res.status !== 200) {
    return { ok: false, status: res.status, body: res.body, url: res.url, contacts: [] };
  }
  const contacts = (res.json && (res.json.contacts || res.json.data)) || [];
  return { ok: true, contacts: contacts };
}

/**
 * True only if the contact's own email field actually matches (case-
 * insensitive) the email searched for. Modeled on the sibling project's
 * contactNameLooksLikeQuery_ -- confirmed live there (28 Aug 2026) that
 * GHL's /contacts query param can return contacts with NO real relation to
 * the query at all, so the raw search result is never trusted as-is.
 * Email is an exact field, so this check is stricter (and simpler) than
 * the name-token overlap the sibling project needed.
 */
function contactEmailMatches_(contact, queryEmail) {
  const contactEmail = String(contact.email || '').trim().toLowerCase();
  const target = String(queryEmail || '').trim().toLowerCase();
  return !!contactEmail && !!target && contactEmail === target;
}

/**
 * Up to `perTab` rows from each follow-up queue tab (Podcast Sales, Hub
 * Guest), each row's real lead email (column C in both -- see
 * lead_followup_sequences.gs's queueTab.appendRow calls) paired with its
 * name and source tab, for previewGhlLeadMatching_ to sample against GHL.
 */
function sampleFollowUpQueueLeads_(perTab) {
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const sample = [];
  [PODCAST_SALES_QUEUE_TAB, HUB_GUEST_QUEUE_TAB].forEach(tabName => {
    const tab = ss.getSheetByName(tabName);
    if (!tab) { Logger.log('sampleFollowUpQueueLeads_ -- no "' + tabName + '" tab found, skipping.'); return; }
    const rows = tab.getDataRange().getValues().slice(1);
    rows.slice(0, perTab).forEach(row => {
      const email = String(row[2] || '').trim();
      if (!email) return;
      sample.push({ sourceTab: tabName, threadId: row[0], name: row[1], email: email });
    });
  });
  return sample;
}

/** Apps Script's "Select function" dropdown hides trailing-underscore functions -- this is the runnable entry point. */
function previewGhlLeadMatching() {
  return previewGhlLeadMatching_(8); // 8 per queue tab -- enough to judge match quality without a long run
}

/**
 * Read-only. For a sample of real follow-up-queue leads, searches GHL by
 * email and reports: no match / one confident match / ambiguous (multiple
 * candidates whose email doesn't cleanly resolve to one -- logged, not
 * guessed at). Writes nothing.
 *
 * The tally at the end answers the actual open question: is this project's
 * lead pool even present in GHL as contacts yet, and does email search find
 * them reliably.
 */
function previewGhlLeadMatching_(perTab) {
  Logger.log('PREVIEW MODE -- read-only GHL lead-matching probe. Nothing will be written or sent.');

  let locationId;
  try {
    locationId = ghlCheckSetup_();
  } catch (e) {
    Logger.log('SETUP INCOMPLETE: ' + e);
    return;
  }

  const sample = sampleFollowUpQueueLeads_(perTab);
  if (!sample.length) { Logger.log('No follow-up queue rows found to sample.'); return; }
  Logger.log('Sampling ' + sample.length + ' lead(s) across the follow-up queue tabs.');

  let noMatch = 0, oneMatch = 0, ambiguous = 0, searchFailed = 0;

  sample.forEach((lead, i) => {
    Logger.log('');
    Logger.log((i + 1) + '/' + sample.length + '  "' + lead.name + '" <' + lead.email + '> (' + lead.sourceTab + ')');

    const search = ghlSearchContactByEmail_(locationId, lead.email);
    if (!search.ok) {
      Logger.log('   SEARCH FAILED: HTTP ' + search.status + '. Body (first 500 chars): ' + String(search.body).slice(0, 500));
      searchFailed++;
      return;
    }
    if (!search.contacts.length) {
      Logger.log('   No GHL contact found for this email.');
      noMatch++;
      return;
    }

    const candidates = search.contacts.filter(c => contactEmailMatches_(c, lead.email));
    if (!candidates.length) {
      Logger.log('   No GHL contact found for this email (' + search.contacts.length +
        ' raw result(s) returned but none had a matching email address).');
      noMatch++;
      return;
    }
    if (candidates.length > 1) {
      // Same email on more than one GHL contact would itself be worth a
      // human's attention -- reported, not resolved by guessing which one.
      Logger.log('   AMBIGUOUS -- ' + candidates.length + ' contact(s) share this exact email, not guessing:');
      candidates.forEach(c => {
        Logger.log('     - ' + (c.name || ((c.firstName || '') + ' ' + (c.lastName || ''))) + '  id=' + c.id);
      });
      ambiguous++;
      return;
    }

    const contact = candidates[0];
    Logger.log('   Matched contact id=' + contact.id + '  name=' + (contact.name || ((contact.firstName || '') + ' ' + (contact.lastName || ''))));
    oneMatch++;

    Utilities.sleep(200); // polite pacing between rows, not a rate-limit workaround for a single call
  });

  Logger.log('');
  Logger.log('Tally: ' + oneMatch + ' confident match(es), ' + ambiguous + ' ambiguous, ' +
    noMatch + ' no match, ' + searchFailed + ' search failure(s), of ' + sample.length + ' sampled.');
  Logger.log('Paste this whole log back to Claude -- it decides whether email-matching finds this ' +
    'project\'s leads in GHL at all, before any real "has Sean contacted this lead" check gets built.');
}
