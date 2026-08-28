/**
 * ICONS OF REAL ESTATE — Sean's manual call tracker (28 Aug 2026, per direct
 * request -- closing the loop on "Sean gets 2-3 days, then falls back into
 * the cycle" for the Podcast Sales follow-up cadence).
 *
 * WHY THIS EXISTS: Tomás confirmed leads routed to Sean (needsRouting=true
 * in the AI Drafts Log -> registerNewPodcastSalesLeads -> the Podcast Sales
 * Follow-Up Queue) get called by phone, with no reliable Gmail trace. Without
 * a check here, advancePodcastSalesFollowUps() would draft an automated
 * follow-up on schedule regardless of whether Sean already reached the lead
 * -- risking a lead getting both a phone call AND a redundant "just floating
 * this back up" email on the same day.
 *
 * GHL WAS CONSIDERED AND DEFERRED (see ghl_contact_sync.gs): as of 28 Aug
 * 2026 there is no "SPAM" pipeline in GHL for these leads to live in, so
 * stage-based detection isn't buildable yet. Sean already keeps a manual
 * spreadsheet tracker with real per-lead data (real Call Output text, keyed
 * by email) -- simpler, and it exists today. ghl_contact_sync.gs's probes
 * stay in the repo for whenever a GHL pipeline does get built for this.
 *
 * NO NEW CLOCK NEEDED: the "2-3 day window" already exists --
 * FOLLOWUP_WORKING_DAYS_GAP (lead_followup_sequences.gs) is exactly that,
 * computed from the same event (the lead's own reply arriving) that puts
 * Sean onto this lead in the first place. This file doesn't compute timing
 * at all -- it only answers "as of right now, has Sean actually reached this
 * lead," checked at the moment the existing schedule says a follow-up is due.
 *
 * "REACHED" VS. "ATTEMPTED" (per direct request, confirmed against real
 * tracker rows): Call Output = Callback / Not Interested / QC Booked means
 * Sean actually got the lead on the phone -- automation should stay off
 * that lead. Call Output = Can't Reach, or blank (Dial 1/2 not yet TRUE),
 * means he dialed and got no answer, or hasn't tried yet -- that lead
 * SHOULD still fall back into the automated cadence rather than sit
 * blocked forever on a call that never connected.
 *
 * FAILS CLOSED: if the tracker can't be read at all (permissions, a renamed
 * column, the sheet moved), this does NOT default to "assume no contact and
 * draft anyway" -- that's exactly backwards, since a read failure means we
 * have no information, and drafting on no information risks the double-
 * contact this whole check exists to prevent. See loadSeanContactTracker_'s
 * `ok: false` path and how advancePodcastSalesFollowUps uses it below.
 */

const SEAN_TRACKER_SPREADSHEET_ID = '1WyGPsTc5vOtWNOim_3pHU5sMDbO1mIzPmQ5WW05TMAs';

const SEAN_REAL_CONTACT_OUTPUTS = ['Callback', 'Not Interested', 'QC Booked'];

/**
 * Reads Sean's tracker once and returns { ok, map }. map is keyed by
 * lowercased email -> { callOutput, comment, dateJoanaEmail }. `ok: false`
 * means the read failed or the tracker's structure isn't what's expected
 * (columns renamed, sheet moved) -- callers must NOT treat that the same as
 * "no lead found" (see this file's header comment on failing closed).
 */
function loadSeanContactTracker_() {
  try {
    const ss = SpreadsheetApp.openById(SEAN_TRACKER_SPREADSHEET_ID);
    const sheet = ss.getSheets()[0];
    const rows = sheet.getDataRange().getValues();
    if (rows.length === 0) {
      Logger.log('loadSeanContactTracker_ -- tracker sheet is completely empty (no header row even).');
      return { ok: false, map: {} };
    }

    const headers = rows[0];
    const emailCol = headers.indexOf('Email');
    const callOutputCol = headers.indexOf('Call Output');
    const commentCol = headers.indexOf('Comment');
    const dateCol = headers.indexOf('Date Joana\'s Email');

    if (emailCol === -1 || callOutputCol === -1) {
      Logger.log('loadSeanContactTracker_ -- expected columns "Email"/"Call Output" not found. ' +
        'Actual headers: [' + headers.join(', ') + ']. Tracker may have been restructured -- fix the ' +
        'column names here or in the tracker, then re-run.');
      return { ok: false, map: {} };
    }

    const map = {};
    for (let i = 1; i < rows.length; i++) {
      const email = String(rows[i][emailCol] || '').trim().toLowerCase();
      if (!email) continue;
      map[email] = {
        callOutput: String(rows[i][callOutputCol] || '').trim(),
        comment: commentCol !== -1 ? String(rows[i][commentCol] || '').trim() : '',
        dateJoanaEmail: dateCol !== -1 ? rows[i][dateCol] : null,
      };
    }
    Logger.log('loadSeanContactTracker_ -- loaded ' + Object.keys(map).length + ' lead(s) from Sean\'s call tracker.');
    return { ok: true, map: map };
  } catch (e) {
    Logger.log('loadSeanContactTracker_ -- FAILED to open/read the tracker (' + SEAN_TRACKER_SPREADSHEET_ID + '): ' + e);
    return { ok: false, map: {} };
  }
}

/**
 * Returns { contacted, reason } for one lead email against an already-loaded
 * tracker map (from loadSeanContactTracker_'s `map`). `contacted: true`
 * means Sean actually reached this lead -- the automated cadence should NOT
 * draft a follow-up. Not found in the tracker at all reads as `contacted:
 * false` -- Sean hasn't gotten to this lead yet, so the automated fallback
 * should proceed on schedule, same as if he'd dialed and missed.
 */
function hasSeanMadeRealContact_(trackerMap, leadEmail) {
  const key = String(leadEmail || '').trim().toLowerCase();
  const row = trackerMap[key];
  if (!row) return { contacted: false, reason: 'not in Sean\'s tracker yet' };

  const output = row.callOutput;
  const isRealContact = SEAN_REAL_CONTACT_OUTPUTS.some(v => v.toLowerCase() === output.toLowerCase());
  if (isRealContact) {
    return {
      contacted: true,
      reason: 'Call Output = "' + output + '"' + (row.comment ? ' -- "' + row.comment + '"' : ''),
    };
  }
  return {
    contacted: false,
    reason: output ? ('Call Output = "' + output + '" (attempted, not reached)') : 'no Call Output recorded yet',
  };
}
