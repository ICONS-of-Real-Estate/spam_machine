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
 * NOTE ON API USAGE: CONFIG.MODEL calls run against Kris's own Anthropic
 * API key (ANTHROPIC_API_KEY in Script Properties) -- every draft this
 * generates uses his API credit, not a shared/team budget. Worth keeping
 * in mind if volume ramps up.
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
  LABEL_PRIORITY: '0. PRIORITY - Reply First', // ADDED 13 Aug 2026 -- label already exists in Gmail

  // Only ever act on threads CC'd to the network group -- this is the
  // actual scope boundary. Both addresses included since one is an alias
  // of the other, and forwarded copies have shown up under either.
  REQUIRED_CC_ADDRESSES: ['network@iconsofrealestate.com', 'network@ardorseo.com'],

  // Known constant links the model can reference by token rather than
  // typing out (and risking a typo in) the raw URL itself.
  HUB_LINK_URL: 'https://hub.iconsofrealestate.com/',

  // Joana's standing Zoom room -- confirmed via her own sent replies, same
  // link reused consistently across months (Amina, Heather, Yvette, Rachel,
  // Jermaine, and others). Replaces the BOOKING_LINK placeholder that was
  // previously left unfilled in every draft.
  BOOKING_LINK_URL: 'https://zoom.us/j/2268364546?pwd=EosrIzrbJ3uMp1MrGG8tIgFGAcppmZ.1',

  // Paste the ID from the Sheet's URL: https://docs.google.com/spreadsheets/d/THIS_PART/edit
  SPREADSHEET_ID: '1uDrt3WAPZR90iaPgM6wZcfN9rOXzkkuFHJ6tg_XMHHs',

  // CC'd on every reply the script drafts, per Kris's direction (25 Jul 2026).
  NETWORK_CC_ON_REPLY: 'network@iconsofrealestate.com',

  // NEW in v5 -- the live SOP Doc and the state->show lookup Sheet.
  SOP_DOC_ID: '15SwaYCEXGshe_8eZ2ZzADa0fk_SkdcvuDgjgajPEhag',
  STATE_DIRECTORY_SHEET_ID: '1ULIpgYPJEhK68OespSm7yO8fzSP0OU8Y_cStb4sUHKM',

  MAX_THREADS_PER_RUN: 50,

  // ADDED (17 Aug 2026, real incident): after Montell/Mariann/Mumu got
  // genuinely-interested replies drafted as declines (classifyAndDraft()
  // sometimes disagreeing with the SOP's own no_decline guidance on
  // ambiguous replies), Kris asked to cap draft creation at 5 per run so
  // each small batch can get reviewed before more go out. This bounds
  // actual DRAFTS CREATED, separate from MAX_THREADS_PER_RUN above (which
  // just bounds how many threads get scanned/considered).
  MAX_DRAFTS_PER_RUN: 5,
  MODEL: 'claude-sonnet-5', // switched from claude-sonnet-4-6 (25 Jul 2026) -- same tier fit for
  // this task (classification + template-following drafts), currently cheaper at $2/$10 per
  // MTok vs 4.6's $3/$15, during intro pricing through 31 Aug 2026. Reverts to $3/$15 after
  // that, matching 4.6 exactly -- no downside, only savings until then.
};

const OPT_OUT_PATTERNS = /\b(stop|unsubscribe|remove me|take me off|do not (contact|email) me)\b/i;

// Same pattern already proven in missed_leads_audit.gs -- common phrasing in
// genuine bounce-backs and out-of-office auto-replies. Checked against the
// prospect's fresh reply text only (same isolation as OPT_OUT_PATTERNS),
// not the full quoted history, for the same reason: avoids false positives
// from boilerplate elsewhere in the thread.
const AUTOREPLY_PATTERNS = /(mailbox that is not actively monitored|does not correspond to a valid address|delivery (has |)failed|undeliverable|out of (the |)office|automatic reply|auto-reply|this is an automated|heavy volume of emails|currently unavailable and will respond)/i;

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

  [CONFIG.LABEL_AI_DRAFTED, CONFIG.LABEL_NEEDS_ROUTING].forEach(name => {
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
    draftsTab.appendRow(['Timestamp', 'Thread ID', 'Subject', 'Prospect Email', 'Category', 'Needs Teammate Routing', 'Draft Text', 'Draft Link']);
  }

  let learningTab = ss.getSheetByName('Learning Log');
  if (!learningTab) {
    learningTab = ss.insertSheet('Learning Log');
    learningTab.appendRow(['Compared At', 'Thread ID', 'Subject', 'Category', 'Original AI Draft', 'Final Sent Text', 'Was Edited', 'Reviewed For SOP']);
  }

  let suggestionsTab = ss.getSheetByName('SOP Suggestions');
  if (!suggestionsTab) {
    suggestionsTab = ss.insertSheet('SOP Suggestions');
    suggestionsTab.appendRow(['Generated At', 'Based On N Edits', 'Suggested Change', 'Status (pending/approved/rejected)']);
  }
}

// ---------- MAIN ENTRY POINT ----------

function runReplyDrafter() {
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
  const props = PropertiesService.getScriptProperties();
  const apiKey = props.getProperty('ANTHROPIC_API_KEY');
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY not set in Script Properties.');
  }

  const labelYes = getOrWarnLabel(CONFIG.LABEL_YES);
  const labelYesPenciled = getOrWarnLabel(CONFIG.LABEL_YES_PENCILED);
  const labelNo = getOrWarnLabel(CONFIG.LABEL_NO);
  const labelStop = getOrWarnLabel(CONFIG.LABEL_STOP);
  const labelDrafted = GmailApp.getUserLabelByName(CONFIG.LABEL_AI_DRAFTED);
  const labelNeedsRouting = GmailApp.getUserLabelByName(CONFIG.LABEL_NEEDS_ROUTING);

  const systemPrompt = buildSystemPrompt();
  const stateDirectory = loadStateDirectory();

  const addressClauses = CONFIG.REQUIRED_CC_ADDRESSES
    .map(addr => 'to:"' + addr + '" OR cc:"' + addr + '"')
    .join(' OR ');
  const searchQuery = '(' + addressClauses + ') newer_than:3d -label:"' + CONFIG.LABEL_AI_DRAFTED + '" -label:"' + CONFIG.LABEL_STOP + '"';
  const threads = GmailApp.search(searchQuery, 0, 200);

  Logger.log('DIAGNOSTIC -- search query: ' + searchQuery);
  Logger.log('DIAGNOSTIC -- threads found: ' + threads.length);

  let processed = 0;
  let draftsCreated = 0;

  // FIX (13 Aug 2026): GmailApp.getDraftMessages() can lag behind drafts
  // created earlier in this SAME execution (a propagation gap in Apps
  // Script's Gmail service), so draftAlreadyExistsFor() alone isn't
  // reliable within one run. Confirmed via a real duplicate: two separate
  // Gmail threads for the same lead (gaderealty007@gmail.com, identical
  // "I'm not interested" reply) both got drafted 21 seconds apart in the
  // same run. This in-memory set catches that immediately; the Gmail scan
  // stays in place as the cross-run backup.
  const draftedThisRun = new Set();

  for (const thread of threads) {
    if (processed >= CONFIG.MAX_THREADS_PER_RUN) break;
    if (draftsCreated >= CONFIG.MAX_DRAFTS_PER_RUN) {
      Logger.log('Reached MAX_DRAFTS_PER_RUN (' + CONFIG.MAX_DRAFTS_PER_RUN + ') -- stopping this run so the batch can be reviewed. Remaining threads will be picked up on the next run.');
      break;
    }

    const messages = thread.getMessages();
    const lastMsg = messages[messages.length - 1];
    const subject = thread.getFirstMessageSubject();

    if (!CONFIG.SUBJECT_PATTERN.test(subject)) {
      Logger.log('DIAGNOSTIC -- skipped (subject pattern): ' + subject);
      continue;
    }

    if (!isCcdToNetworkGroup(lastMsg)) {
      Logger.log('DIAGNOSTIC -- skipped (not CC-d to network on last message): ' + subject);
      continue;
    }

    const lastSenderEmail = extractEmail(lastMsg.getFrom());
    if (isRealTeamReply(lastSenderEmail)) {
      Logger.log('DIAGNOSTIC -- skipped (already answered by ' + lastSenderEmail + '): ' + subject);
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
        Logger.log('Could not parse forwarded lead info for: ' + subject + ' -- skipping rather than guessing.');
        continue;
      }
      leadEmail = forwardInfo.email;
      originalSubjectFromForward = forwardInfo.originalSubject;
    }

    if (draftedThisRun.has(leadEmail.toLowerCase()) || draftAlreadyExistsFor(leadEmail)) {
      Logger.log('DIAGNOSTIC -- skipped (draft already exists for ' + leadEmail + '): ' + subject);
      continue;
    }

    const replyBody = extractProspectFreshReplyText(lastMsg);

    const alreadyLabeledStop = threadHasLabel(thread, CONFIG.LABEL_STOP);
    if (alreadyLabeledStop || OPT_OUT_PATTERNS.test(replyBody)) {
      if (labelStop && !alreadyLabeledStop) thread.addLabel(labelStop);
      thread.addLabel(labelDrafted);
      Logger.log('Suppressed (opt-out): ' + subject + ' <' + leadEmail + '>');
      processed++;
      continue;
    }

    if (AUTOREPLY_PATTERNS.test(replyBody)) {
      thread.addLabel(labelDrafted);
      Logger.log('Suppressed (auto-reply/OOO, not a real reply): ' + subject + ' <' + leadEmail + '>');
      processed++;
      continue;
    }

    const state = extractStateFromSubject(subject);
    const matchedShow = state ? stateDirectory[normalizeState(state)] : null;

    const context = buildThreadContext(messages);
    const result = classifyAndDraft(apiKey, systemPrompt, subject, context, leadEmail, state, matchedShow);

    if (!result) {
      Logger.log('Classification/draft failed for: ' + subject);
      continue;
    }

    if (result.category === 'no_decline' && matchedShow) {
      commitNoDeclineVariation(result.candidateVariationIndex);
    }

    try {
      const aiReplyPlain = sanitizeEmojiForGmail(markdownLinksToPlain(result.draftBody));
      const historyPlain = stripForwardHeaderKeepHistory(lastMsg.getPlainBody());
      const fullPlainBody = aiReplyPlain + '\n\n' + historyPlain;

      const aiReplyHtml = emojiToHtmlEntities(sanitizeEmojiForGmail(markdownLinksToHtml(result.draftBody)));
      const historyHtml = emojiToHtmlEntities(escapeHtml(historyPlain).replace(/\n/g, '<br>'));
      const fullHtmlBody = aiReplyHtml + '<br><br>' + historyHtml;

      const cleanSubject = (originalSubjectFromForward || subject).replace(/^(fwd:\s*)+/i, '').trim();
      const createdDraft = GmailApp.createDraft(leadEmail, cleanSubject, fullPlainBody, {
        htmlBody: fullHtmlBody,
        cc: CONFIG.NETWORK_CC_ON_REPLY
      });
      var draftLink = 'https://mail.google.com/mail/u/0/#all/' + createdDraft.getMessage().getId();
      draftedThisRun.add(leadEmail.toLowerCase());
      draftsCreated++;
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

    logDraftToSheet(thread.getId(), subject, leadEmail, result.category, result.needsTeammateRouting, result.draftBody, draftLink);

    processed++;
  }

  Logger.log('Run complete. Threads processed: ' + processed + ', drafts created: ' + draftsCreated);
}

function logDraftToSheet(threadId, subject, prospectEmail, category, needsRouting, draftText, draftLink) {
  if (!CONFIG.SPREADSHEET_ID || CONFIG.SPREADSHEET_ID === 'PASTE_YOUR_SHEET_ID_HERE') return;
  try {
    const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    const tab = ss.getSheetByName('AI Drafts Log');
    if (!tab) return;
    tab.appendRow([new Date(), threadId, subject, prospectEmail, category, !!needsRouting, draftText, draftLink || '']);
  } catch (e) {
    Logger.log('Failed to log draft to sheet: ' + e);
  }
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

function classifyAndDraft(apiKey, systemPrompt, subject, threadContext, prospectEmail, state, matchedShow) {
  const candidateVariation = peekNoDeclineVariation();

  const matchedShowBlock = matchedShow
    ? `MATCHED SHOW FOR THIS PROSPECT'S STATE (${state}): "${matchedShow.showName}" hosted by ${matchedShow.host} -- ${matchedShow.link}\nIf this reply is a no_decline, close with EXACTLY this text (verbatim, only substituting {{name}}, {{show}}, {{state}} with the real values -- do not rephrase, shorten, or improvise a different version): "${candidateVariation.text}" -- then add the link on its own, formatted per the SOP's link rules.`
    : `MATCHED SHOW FOR THIS PROSPECT'S STATE: none available${state ? ' (state detected as ' + state + ' but no confirmed show yet in the Directory)' : ' (could not determine state from subject line)'}.\nIf this reply is a no_decline, fall back to the generic guest-network invite per the SOP (the rotation above only applies when a real show match exists).`;

  const userPrompt = `EMAIL SUBJECT: ${subject}
PROSPECT EMAIL: ${prospectEmail}

${matchedShowBlock}

THREAD (oldest to newest):
${threadContext}

Return ONLY a JSON object, no markdown fences, no preamble, with this exact shape:
{
  "category": "yes_general | yes_has_own_podcast | yes_penciled | yes_reschedule | no_decline | no_data_error | other",
  "needs_teammate_routing": true or false,
  "priority": true or false,
  "reasoning": "one sentence on why you classified it this way",
  "draft_body": "the full plain-text email reply, in Joana's real voice per the SOP -- no subject line, just the body, no formal sign-off block"
}

Set needs_teammate_routing to true only when the reply is a strong YES that should be handed off to Sean or Bens for a qualification call (per the SOP's handoff pattern) -- the script will flag it for Joana to assign rather than guessing which teammate. Otherwise false.

Set "priority" to true ONLY when the prospect shows clear, immediate buying intent -- e.g. explicitly asking to book a call, saying yes and asking "when," giving their phone number/availability unprompted, or otherwise acting ready to move now rather than just curious. A soft or ambiguous "maybe, tell me more" is NOT priority. This is independent of needs_teammate_routing -- a reply can be high-priority without needing a teammate handoff, or vice versa.`;

  const payload = {
    model: CONFIG.MODEL,
    max_tokens: 2000,
    system: [
      {
        type: 'text',
        text: systemPrompt,
        cache_control: { type: 'ephemeral' }
      }
    ],
    messages: [{ role: 'user', content: userPrompt }],
  };

  const response = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });

  if (response.getResponseCode() !== 200) {
    Logger.log('Claude API error: ' + response.getContentText());
    return null;
  }

  const data = JSON.parse(response.getContentText('UTF-8'));

  if (data.usage) {
    Logger.log(
      'Cache check -- read: ' + (data.usage.cache_read_input_tokens || 0) +
      ', created: ' + (data.usage.cache_creation_input_tokens || 0) +
      ', uncached input: ' + (data.usage.input_tokens || 0)
    );
  }

  const textBlock = data.content.find(c => c.type === 'text');
  if (!textBlock) {
    Logger.log('No text block in Claude response -- stop_reason: ' + data.stop_reason + ', content types: ' + JSON.stringify((data.content || []).map(c => c.type)));
    return null;
  }

  let parsed;
  try {
    const cleanedText = textBlock.text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    parsed = JSON.parse(cleanedText);
  } catch (e) {
    Logger.log('Failed to parse Claude JSON response: ' + textBlock.text);
    return null;
  }

  return {
    category: parsed.category,
    needsTeammateRouting: !!parsed.needs_teammate_routing,
    priority: !!parsed.priority,
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