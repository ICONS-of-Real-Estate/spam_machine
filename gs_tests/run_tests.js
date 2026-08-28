/**
 * Parsing regression suite for Code.gs -- ADDED 27 Aug 2026.
 *
 * Every case tagged [REAL] is a body shape captured verbatim from a live
 * runReplyDrafter diagnostic log, not an invented example. Those are the
 * regressions; the rest are the client variations we know exist but had no
 * coverage for.
 *
 * Run: node gs_tests/run_tests.js
 */
const { buildContext, fakeMessage, loadAllGsFiles } = require('./harness.js');

const { context } = buildContext();
const {
  extractEmail,
  extractForwardedLeadInfo,
  extractProspectFreshReplyText,
  getEffectivePlainBody_,
  matchesSubjectPattern_,
  parseForwardHeaderBlock_,
  stripQuoteMarkers_,
  isAttributionLine_,
  extractAllEmailsFrom_,
  firstMailableLeadIn_,
  isUnmailableAsLead_,
  isNonHumanSender,
  normalizeMessageBody_,
  escapeHtml,
} = context;

let passed = 0;
const failures = [];

function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) passed++;
  else failures.push(`${name}\n     expected: ${e}\n     actual:   ${a}`);
}

function leadFrom(opts) {
  const info = extractForwardedLeadInfo(fakeMessage(opts));
  return info ? info.email : null;
}

// ---------------------------------------------------------------------------
// 1. [REAL] The threads that drove this week's patch loop
// ---------------------------------------------------------------------------

// Flavia -- alias-to-alias forward. The header's To: is itself a Maildoso
// alias (reachpilotteam.com), so the lead is only in the nested quote chain,
// two levels deep, with a bracketed address and no "On <date>" preamble.
const FLAVIA = [
  '',
  '---------- Forwarded message ---------',
  'From: joana@iconsofrealestate.com',
  'Date: Monday, Apr 20, 2026 at 5:10 pm',
  "Subject: Re: Re: Flavia, up for hosting Illinois's next real estate podcast?",
  'To: anna.wilson@reachpilotteam.com',
  '',
  '',
  'On Monday, Apr 20, 2026 at 5:10 pm joana@iconsofrealestate.com wrote:',
  'Hi Flavia,',
  '',
  'Thanks for letting me know. I appreciate the response.',
  '',
  'Best,',
  '',
  'On Wed, Apr 15, 2026 at 3:35 PM',
  '[anna.wilson@reachpilotteam.com]> wrote:',
  '> Thanks for reaching out.',
  '>',
  '> On Tue, Apr 14, 2026 at 1:00 PM',
  '> [flavia@vestapreferred.com] wrote:',
  '>> Hi, we already have something similar internally.',
].join('\n');
check('[REAL] Flavia: nested bracketed lead two quote levels deep',
  leadFrom({ body: FLAVIA, from: 'Anna Wilson <anna.wilson@reachpilotteam.com>', to: 'network@ardorseo.com' }),
  'flavia@vestapreferred.com');

// Maria -- signaturehound.com signature. The attribution line's leading "O"
// is a Unicode lookalike, not ASCII, which is why it logged as "n Sunday..."
// and failed the old /^On .+wrote:$/ regex.
// NOTE (established by mutation test): NFKC normalization is NOT what rescues
// this case any more -- relaxing the anchor to /wrote:$/ made the leading
// character irrelevant. Removing NFKC leaves this test green. It is still
// load-bearing elsewhere (see the fullwidth-header test below), so the
// normalization stays; this comment exists so nobody "verifies" NFKC by
// pointing at a test that does not actually exercise it.
const MARIA = [
  '\u{1D40E}n Sunday, Jul 12, 2026 at 1:45 am mkozakre@gmail.com wrote:',
  'Hi, you are welcome to share a video with me.',
  '',
  '[https://signaturehound.com/api/v1/file/1ktoky2cxid7]',
  'Maria Kozak',
  'Realtor',
  'NorthGroup Real Estate',
  'mkozakre@gmail.com [mkozakre@gmail.com]',
  '8646437509 [tel:8646437509]',
].join('\n');
check('[REAL] Maria: NFKC lookalike "O" in the attribution line',
  leadFrom({ body: MARIA, from: "'Joana Peixe' via Network <network@ardorseo.com>", to: 'network@ardorseo.com' }),
  'mkozakre@gmail.com');

// Spencer / Roberta / Doug -- clean header, CRLF line endings. The CR broke
// the `(.*)$` field capture, so the whole header block read as empty.
const CRLF_HEADER = [
  '',
  '---------- Forwarded message ---------',
  'From: joana@iconsofrealestate.com',
  'Date: Sunday, Mar 15, 2026 at 9:54 pm',
  'Subject: Re: Spencer, up for hosting a podcast?',
  'To: anita.spencer32@gmail.com',
  '',
  'On Sunday, Mar 15, 2026 at 9:54 pm joana@iconsofrealestate.com wrote:',
  'Hi Spencer,',
].join('\r\n');
check('[REAL] Spencer: CRLF body, lead in the forward header To:',
  leadFrom({ body: CRLF_HEADER, from: 'joana-peixe@scalingflowly.com', to: 'network@ardorseo.com' }),
  'anita.spencer32@gmail.com');

// Jennifer -- genuinely empty body. Documented as a known-unresolvable case:
// there is nothing to parse, and the correct behaviour is null (skip), NOT a
// guess. This test locks that in so a future "make it more aggressive" change
// cannot start inventing a recipient here.
check('[REAL] Jennifer: empty body resolves to null, never a guess',
  leadFrom({ body: '', html: '', from: "'Joana Peixe' via Network <network@ardorseo.com>", to: 'network@ardorseo.com' }),
  null);

// Wendy -- body is ONLY Joana's own quoted reply. No lead-authored line
// exists, so extraction must decline rather than return Joana or the alias.
const WENDY = [
  '',
  'On Friday, Aug 7, 2026 at 9:12 pm joana@iconsofrealestate.com wrote:',
  'Hi Wendy,',
  '',
  'OOPS My apologies for the name mix-up!',
  '',
  'We work with podcast hosts who want to grow.',
].join('\n');
check('[REAL] Wendy: only our own quoted reply -> null, not our own address',
  leadFrom({ body: WENDY, from: "'Joana Peixe' via Network <network@ardorseo.com>", to: 'network@ardorseo.com' }),
  null);

// ---------------------------------------------------------------------------
// 2. Client attribution variants
// ---------------------------------------------------------------------------
const VARIANTS = {
  'Gmail angle-bracket': 'On Mon, Aug 10, 2026 at 9:30 PM Amy Smith <amy@kwlifestyle.com> wrote:',
  'Gmail bare address': 'On Mon, Aug 10, 2026 at 9:30 PM amy@kwlifestyle.com wrote:',
  'Apple Mail': 'On Aug 10, 2026, at 9:30 AM, Amy Smith <amy@kwlifestyle.com> wrote:',
  'Yahoo': 'On Monday, August 10, 2026, 09:30:00 AM EDT, Amy <amy@kwlifestyle.com> wrote:',
  'bracketed, no date preamble': '[amy@kwlifestyle.com] wrote:',
  'bracketed with stray angle': '[amy@kwlifestyle.com]> wrote:',
  'mailto: wrapped': 'On Mon, Aug 10, 2026 Amy <mailto:amy@kwlifestyle.com> wrote:',
  'deep quote depth': '>>> > On Mon, Aug 10, 2026 amy@kwlifestyle.com wrote:',
};
for (const [label, line] of Object.entries(VARIANTS)) {
  check(`attribution variant: ${label}`,
    leadFrom({ body: line + '\nHi there, sounds interesting.', from: "'Joana' via Network <network@ardorseo.com>", to: 'network@ardorseo.com' }),
    'amy@kwlifestyle.com');
}

// Word-wrapped attribution -- both real shapes seen in this mailbox.
check('attribution wrapped: bare "wrote:" continuation',
  leadFrom({ body: 'On Wed, Aug 12, 2026 at 4:00 PM amy@kwlifestyle.com\nwrote:\nHi', from: 'x@ardorseo.com', to: 'network@ardorseo.com' }),
  'amy@kwlifestyle.com');
check('attribution wrapped: address on the continuation line',
  leadFrom({ body: 'On Wed, Apr 15, 2026 at 3:35 PM\n[amy@kwlifestyle.com] wrote:\nHi', from: 'x@ardorseo.com', to: 'network@ardorseo.com' }),
  'amy@kwlifestyle.com');

// ---------------------------------------------------------------------------
// 3. Forward-header variants across clients
// ---------------------------------------------------------------------------
check('forward header: Outlook "-----Original Message-----"',
  leadFrom({
    body: '-----Original Message-----\nFrom: joana@iconsofrealestate.com\nSent: Monday, April 20, 2026 5:10 PM\nTo: buyer@remax.com\nSubject: Re: podcast\n\nHi there,',
    from: 'alias@pixingsproduct.com', to: 'network@ardorseo.com',
  }),
  'buyer@remax.com');

check('forward header: Apple Mail "Begin forwarded message:"',
  leadFrom({
    body: 'Begin forwarded message:\n\nFrom: joana@iconsofrealestate.com\nDate: April 20, 2026\nSubject: Re: podcast\nTo: buyer@remax.com\n\nHi there,',
    from: 'alias@pixingsproduct.com', to: 'network@ardorseo.com',
  }),
  'buyer@remax.com');

check('forward header: lead is the From (inbound reply forwarded to us)',
  leadFrom({
    body: '---------- Forwarded message ---------\nFrom: Katie Beaman <katie@beamanrealty.com>\nTo: anna.wilson@reachpilotteam.com\nSubject: Re: podcast\n\nI am in Arkansas now.',
    from: 'anna.wilson@reachpilotteam.com', to: 'network@ardorseo.com',
  }),
  'katie@beamanrealty.com');

check('forward header: nested inside a quote (quote-marker prefixed)',
  leadFrom({
    body: '> ---------- Forwarded message ---------\n> From: joana@iconsofrealestate.com\n> To: buyer@remax.com\n> Subject: Re: podcast\n>\n> Hi there,',
    from: 'alias@pixingsproduct.com', to: 'network@ardorseo.com',
  }),
  'buyer@remax.com');

check('forward header: lead on Cc rather than To',
  leadFrom({
    body: '---------- Forwarded message ---------\nFrom: joana@iconsofrealestate.com\nTo: network@ardorseo.com\nCc: buyer@remax.com\nSubject: Re: podcast\n\nHi there,',
    from: 'alias@pixingsproduct.com', to: 'network@ardorseo.com',
  }),
  'buyer@remax.com');

check('forward header: multi-recipient To picks the outside human',
  leadFrom({
    body: '---------- Forwarded message ---------\nFrom: joana@iconsofrealestate.com\nTo: network@ardorseo.com, Buyer Person <buyer@remax.com>\nSubject: Re: podcast\n\nHi,',
    from: 'alias@pixingsproduct.com', to: 'network@ardorseo.com',
  }),
  'buyer@remax.com');

// ---------------------------------------------------------------------------
// 4. Safety: our own addresses and robots must never surface as a lead
// ---------------------------------------------------------------------------
const MUST_REJECT = {
  'internal team domain': 'joana@iconsofrealestate.com',
  'internal ardorseo': 'sean@ardorseo.com',
  'network list address': 'network@ardorseo.com',
  'alias reachpilotteam': 'anna.wilson@reachpilotteam.com',
  'alias pixingsproduct': 'joanap@pixingsproduct.com',
  'alias iconsofrealestateteam (added 27 Aug)': 'joanap@iconsofrealestateteam.com',
  'alias topaustinseo (bounced live)': 'a.palmer@topaustinseo.site',
  'near-miss iconsrealestate.com': 'joana@iconsrealestate.com',
};
for (const [label, addr] of Object.entries(MUST_REJECT)) {
  check(`rejects as lead: ${label}`, isUnmailableAsLead_(addr), true);
  check(`never extracted as lead: ${label}`,
    leadFrom({ body: `On Mon, Aug 10, 2026 ${addr} wrote:\nHi`, from: 'x@ardorseo.com', to: 'network@ardorseo.com' }),
    null);
}

const ROBOTS = ['mailer-daemon@googlemail.com', 'noreply@zoom.us', 'no-reply@calendly.com', 'postmaster@x.com', 'bounces@sendgrid.net'];
for (const addr of ROBOTS) {
  check(`flags as non-human: ${addr}`, isNonHumanSender(addr), true);
  check(`never extracted as lead: ${addr}`,
    leadFrom({ body: `On Mon, Aug 10, 2026 ${addr} wrote:\nHi`, from: 'x@ardorseo.com', to: 'network@ardorseo.com' }),
    null);
}

// A real human whose address merely CONTAINS a robot-ish substring must survive.
check('real human with +noreply tag is NOT filtered', isNonHumanSender('dan.hunnicutt+noreply@compass.com'), false);
check('real human with +noreply tag still extractable',
  leadFrom({ body: 'On Mon, Aug 10, 2026 dan.hunnicutt+noreply@compass.com wrote:\nHi', from: 'x@ardorseo.com', to: 'network@ardorseo.com' }),
  'dan.hunnicutt+noreply@compass.com');

// Our own newer quote must not win over the lead's older one.
check('picks the lead, not our own outer quote line',
  leadFrom({
    body: 'On Tue joana@iconsofrealestate.com wrote:\nreply text\n> On Mon buyer@remax.com wrote:\n>> original',
    from: 'x@ardorseo.com', to: 'network@ardorseo.com',
  }),
  'buyer@remax.com');

// SCAN DIRECTION, pinned deliberately. With two DIFFERENT outsiders at
// different quote depths (a referral, or a forwarded colleague), the newest
// -- the one at the top of the chain -- is the person actually corresponding
// with us and therefore the one a reply belongs to. Without this test the
// direction is unpinned: mutation testing showed reversing the loop changed
// no other result, so nothing else would catch a silent flip.
check('scan direction: newest external correspondent wins over an older one',
  leadFrom({
    body: [
      'On Thu, Aug 13 newest@remax.com wrote:',
      'Following up on my colleague\'s note.',
      '> On Mon, Aug 10 older@century21.com wrote:',
      '>> Original enquiry text.',
    ].join('\n'),
    from: 'x@ardorseo.com', to: 'network@ardorseo.com',
  }),
  'newest@remax.com');

// ---------------------------------------------------------------------------
// 5. Primitives
// ---------------------------------------------------------------------------
check('extractEmail: angle brackets', extractEmail('Katie Beaman <katie@beamanrealty.com>'), 'katie@beamanrealty.com');
check('extractEmail: square brackets', extractEmail('[katie@beamanrealty.com]'), 'katie@beamanrealty.com');
check('extractEmail: bare', extractEmail('katie@beamanrealty.com'), 'katie@beamanrealty.com');
check('extractEmail: comma list returns first (was: whole string)', extractEmail('a@b.com, c@d.com'), 'a@b.com');
check('extractEmail: mailto:', extractEmail('<mailto:katie@beamanrealty.com>'), 'katie@beamanrealty.com');
check('extractEmail: uppercase normalized', extractEmail('KATIE@BeamanRealty.COM'), 'katie@beamanrealty.com');
check('extractEmail: no address returns empty string', extractEmail('Katie Beaman'), '');

// REGRESSION GUARD (found in review of this refactor, before it shipped):
// Gmail renders mailing-list senders with the ORIGINAL sender's address
// inside the display name. The bracketed address is the real one; returning
// the display-name address instead would break isNetworkListRelay and quietly
// undo the whole relay-handling path.
check('extractEmail: display name containing an address does not win over <brackets>',
  extractEmail('"joana@iconsofrealestate.com via Network" <network@ardorseo.com>'),
  'network@ardorseo.com');
check('extractEmail: real Gmail list-sender header',
  extractEmail("'Joana Peixe' via Network <network@ardorseo.com>"),
  'network@ardorseo.com');
check('extractEmail: display name address with bracketed lead',
  extractEmail('"Amy via Broker" <amy@kwlifestyle.com>'),
  'amy@kwlifestyle.com');
check('extractEmail: null-safe', extractEmail(null), '');
check('extractEmail: trailing punctuation excluded', extractEmail('from katie@beamanrealty.com, wrote:'), 'katie@beamanrealty.com');

check('stripQuoteMarkers_: single', stripQuoteMarkers_('> hello'), 'hello');
check('stripQuoteMarkers_: multiple', stripQuoteMarkers_('>>> hello'), 'hello');
check('stripQuoteMarkers_: spaced', stripQuoteMarkers_('> > > hello'), 'hello');
check('stripQuoteMarkers_: none', stripQuoteMarkers_('hello'), 'hello');
check('stripQuoteMarkers_: marker only', stripQuoteMarkers_('>'), '');

check('extractAllEmailsFrom_: finds all, in order',
  extractAllEmailsFrom_('a@b.com and <c@d.com> and [e@f.com]'), ['a@b.com', 'c@d.com', 'e@f.com']);
check('extractAllEmailsFrom_: repeated calls are stable (no /g lastIndex bug)',
  [extractAllEmailsFrom_('a@b.com').length, extractAllEmailsFrom_('a@b.com').length], [1, 1]);
check('extractAllEmailsFrom_: null-safe', extractAllEmailsFrom_(null), []);

// LOAD-BEARING NFKC test. The forward separator and the header field names
// must match EXACTLY, so a fullwidth-Latin rendering of either (the same
// compatibility-character class that mangled Maria's attribution line) breaks
// the header parse outright unless the body is NFKC-folded first. Unlike the
// Maria case, no relaxed regex saves this one -- remove the normalization and
// this test goes red, which is the point.
check('NFKC: fullwidth forward header still parses',
  leadFrom({
    body: '---------- Ｆorwarded message ---------\nＦrom: joana@iconsofrealestate.com\nＴo: buyer@remax.com\nSubject: Re: podcast\n\nHi,',
    from: 'alias@pixingsproduct.com', to: 'network@ardorseo.com',
  }),
  'buyer@remax.com');

check('normalizeMessageBody_: CRLF folded', normalizeMessageBody_('a\r\nb'), 'a\nb');
check('normalizeMessageBody_: fullwidth folded to ASCII', normalizeMessageBody_('Ｆrom:'), 'From:');
check('normalizeMessageBody_: emoji/curly quotes untouched',
  normalizeMessageBody_('OOPS \u{1F602} “q” — it’s'), 'OOPS \u{1F602} “q” — it’s');

check('isAttributionLine_: plain', isAttributionLine_('On Mon x@y.com wrote:'), true);
check('isAttributionLine_: no preamble', isAttributionLine_('[x@y.com] wrote:'), true);
check('isAttributionLine_: body text is not', isAttributionLine_('I wrote: a book'), false);
check('isAttributionLine_: display-name-only attribution', isAttributionLine_('On Mon, Aug 10, 2026 Amy Smith wrote:'), true);

// REGRESSION GUARD (found in review of this refactor, before it shipped): a
// bare /wrote:$/ test truncates a prospect who happens to end a sentence that
// way, feeding the LLM half a message. Prose must not read as an attribution.
check('isAttributionLine_: prose ending in "wrote:" is NOT attribution',
  isAttributionLine_("Here's the article I wrote:"), false);
check('freshReply: prose ending in "wrote:" is not truncated',
  extractProspectFreshReplyText(fakeMessage({
    body: "Sounds great. Here's the post I wrote:\nIt covers our market.\n\nOn Mon, Aug 10 amy@x.com wrote:\nolder",
  })),
  "Sounds great. Here's the post I wrote:\nIt covers our market.");

check('firstMailableLeadIn_: skips ours, takes the outsider',
  firstMailableLeadIn_(['joana@iconsofrealestate.com', 'network@ardorseo.com', 'buyer@remax.com']), 'buyer@remax.com');
check('firstMailableLeadIn_: skips robots', firstMailableLeadIn_(['mailer-daemon@googlemail.com', 'buyer@remax.com']), 'buyer@remax.com');
check('firstMailableLeadIn_: none mailable', firstMailableLeadIn_(['joana@iconsofrealestate.com']), null);

check('parseForwardHeaderBlock_: no separator returns null', parseForwardHeaderBlock_('just text'), null);
check('parseForwardHeaderBlock_: Outlook Sent: normalized to date',
  (parseForwardHeaderBlock_('-----Original Message-----\nFrom: a@b.com\nSent: Monday\nTo: c@d.com\n\nbody') || {}).date,
  'Monday');

// ---------------------------------------------------------------------------
// 6. Fresh-reply extraction (what the LLM is handed as the lead's own words)
// ---------------------------------------------------------------------------
check('freshReply: stops at a bracketed attribution line',
  extractProspectFreshReplyText(fakeMessage({ body: 'Yes please send details.\n\n[amy@x.com] wrote:\nolder quoted text' })),
  'Yes please send details.');
check('freshReply: stops at an Outlook banner',
  extractProspectFreshReplyText(fakeMessage({ body: 'Sounds good.\n\n-----Original Message-----\nFrom: x@y.com' })),
  'Sounds good.');
check('freshReply: stops at a quote marker',
  extractProspectFreshReplyText(fakeMessage({ body: 'Interested!\n> old stuff' })),
  'Interested!');

// ---------------------------------------------------------------------------
// 7. Whole-project global-scope integrity
// ---------------------------------------------------------------------------
// CLAUDE.md's hardest rule, checked by machine: all 16 .gs files share one
// global scope, and a name redefined in a second file silently shadows the
// first. This refactor added six new globals, so the check matters more than
// usual -- it loads the entire project into one context and fails on any
// collision.
check('all .gs files load into one shared scope with no global collisions',
  loadAllGsFiles(), null);

// Wrapped-attribution boundary in fresh-reply extraction (regression guard for
// the continuation-join fix: neither half is an attribution on its own).
check('freshReply: stops at a word-wrapped attribution',
  extractProspectFreshReplyText(fakeMessage({
    body: 'Yes, interested.\n\nOn Wed, Aug 12, 2026 at 4:00 PM amy@x.com\nwrote:\nolder quoted text',
  })),
  'Yes, interested.');

// REGRESSION GUARD (28 Aug 2026, real incident -- Lynn/pmlr.com): a bare
// relay with ZERO added commentary starts immediately at the attribution
// line, so the main loop breaks on line one and used to return "" -- every
// caller then read this as "the prospect said nothing," when Lynn's real
// decline was quoted right there. Falls back to the first quoted block when
// its attribution names a real outside lead.
check('freshReply: falls back to the first quoted block for a bare zero-commentary relay',
  extractProspectFreshReplyText(fakeMessage({
    body: 'On Sunday, Aug 23, 2026 at 7:49 am lynn@pmlr.com wrote:\n\nNot interested.\n\nThank you…\n\nFrom: Joana Peixe <joanap@iconsofrealestatehq.com>\nSent: Saturday, August 22, 2026 5:04 AM',
  })),
  'Not interested.\n\nThank you...'); // NFKC-normalized: U+2026 -> "..."
check('freshReply: zero-commentary relay of OUR OWN outreach still returns empty (not misattributed)',
  extractProspectFreshReplyText(fakeMessage({
    body: 'On Sunday, Aug 23, 2026 at 7:49 am joana@iconsofrealestate.com wrote:\n\nJust checking in!',
  })),
  '');

// REGRESSION GUARD (28 Aug 2026, real incident -- 21 of 22 leads reconciled
// by reconcileMissingDrafts this morning were bare "Stop" opt-outs that got
// drafted anyway: the fallback above used to keep collecting past the bare
// word into a mobile sendoff or an inline image placeholder, which defeated
// OPT_OUT_PATTERNS' anchored `^\s*stop[.!]?\s*$` alternative downstream.
// [REAL] shape: Austin/asmluxuryhomes.com's actual thread.
check('freshReply: bare opt-out stops before an inline image placeholder, not the whole blob',
  extractProspectFreshReplyText(fakeMessage({
    body: 'On Wednesday, Aug 26, 2026 at 3:08 pm austin@asmluxuryhomes.com wrote:\nstop\n\n[data:image/png;base64,iVBORw0KGgo...]',
  })),
  'stop');
// [REAL] shape: several of the other 20 (e.g. preti@poundrealtyllc.com,
// bethany@1702realestate.com) -- "Stop" followed immediately by a mobile
// client's sendoff line, no blank line in between.
check('freshReply: bare opt-out stops before a "Sent from my iPhone" mobile sendoff',
  extractProspectFreshReplyText(fakeMessage({
    body: 'On Wednesday, Aug 26, 2026 at 9:00 am preti@poundrealtyllc.com wrote:\nStop\nSent from my iPhone',
  })),
  'Stop');
check('freshReply: a genuine multi-line decline with a mobile sendoff still stops at the sendoff, keeps the real text',
  extractProspectFreshReplyText(fakeMessage({
    body: 'On Wednesday, Aug 26, 2026 at 9:00 am lead@example.com wrote:\nNot interested, please remove me from this list.\nSent from my iPhone',
  })),
  'Not interested, please remove me from this list.');

// ---------------------------------------------------------------------------
// 7b. getEffectivePlainBody_ (real incident -- Krista's thread, 28 Aug 2026):
// getPlainBody() AND getBody() can both come back completely empty for a
// network-list-relay message, with the real content sitting in a text/plain
// (or text/html) attachment instead. Confirmed live via a one-off
// diagnostic (debugKristaBody) before this fix existed -- her genuinely
// interested reply ("sure send a short video...") was invisible to every
// parsing path, and the thread died as "no prior message at all."
// ---------------------------------------------------------------------------
check('getEffectivePlainBody_: returns the direct body when non-empty (no attachment fallback needed)',
  getEffectivePlainBody_(fakeMessage({ body: 'Hi there' })),
  'Hi there');
check('getEffectivePlainBody_: falls back to a text/plain attachment when the body is empty',
  getEffectivePlainBody_(fakeMessage({
    body: '',
    attachments: [{ contentType: 'text/plain', data: 'sure send a short video. i will let you know if interested.' }],
  })),
  'sure send a short video. i will let you know if interested.');
check('getEffectivePlainBody_: falls back to a tag-stripped text/html attachment when no text/plain exists',
  getEffectivePlainBody_(fakeMessage({
    body: '',
    attachments: [{ contentType: 'text/html', data: '<html><body><p>Sure,&nbsp;send it over.</p></body></html>' }],
  })),
  'Sure, send it over.');
check('getEffectivePlainBody_: no body, no attachments -> empty string, not a crash',
  getEffectivePlainBody_(fakeMessage({ body: '' })),
  '');

// REGRESSION GUARD (28 Aug 2026, real incident -- Mandy's thread, flagged
// live: "This one is valid. Why no draft?"): a lead who composes a fresh
// reply instead of hitting Reply starts a new Gmail thread whose "first
// message subject" is whatever they typed -- "Arkansas real estate
// podcast" never matched the hosting-phrase template, so a genuinely
// interested reply got PERMANENTLY labeled AI-Skipped-NotPodcastOutreach.
check('[REAL] Mandy: "Arkansas real estate podcast" matches via the real-estate fallback',
  matchesSubjectPattern_('Arkansas real estate podcast'), true);
check('matchesSubjectPattern_: still matches the primary hosting-phrase pattern',
  matchesSubjectPattern_('Rex, open to hosting your own show in Colorado?'), true);
check('matchesSubjectPattern_: genuine non-outreach subjects still rejected (newsletter)',
  matchesSubjectPattern_('Baby’s first physics lesson'), false);
check('matchesSubjectPattern_: genuine non-outreach subjects still rejected (Zoom scheduling)',
  matchesSubjectPattern_('Bruce Henson + Podcast Qualification Zoom - ICONS of Real Estate'), false);
check('matchesSubjectPattern_: genuine non-outreach subjects still rejected (moderator report)',
  matchesSubjectPattern_('Moderator\'s spam report for network@ardorseo.com'), false);
check('[REAL] Krista: lead resolves correctly once the attachment fallback supplies the real body',
  (context.extractForwardedLeadInfo(fakeMessage({
    body: '',
    from: "'Joana Peixe' via Network <network@ardorseo.com>",
    to: 'network@ardorseo.com',
    attachments: [{
      contentType: 'text/plain',
      data: 'On Wednesday, Aug 26, 2026 at 9:42 pm krista.coyle@bhhscaproperties.com wrote:\nsure send a short video. i will let you know if interested. thank you',
    }],
  })) || {}).email,
  'krista.coyle@bhhscaproperties.com');

// ---------------------------------------------------------------------------
// 8. Blank/signature-only reply detection (feeds the LLM an "empty reply"
// hint -- a false positive here caused a real incident: Lisa asked "Send
// more details" and the AI drafted a joke about receiving dead air, because
// the hint told it the prospect said nothing).
// ---------------------------------------------------------------------------
{
  const looksLikeBlankOrSignatureOnly_ = context.looksLikeBlankOrSignatureOnly_;
  check('[REAL] Lisa: "Send more details" is a real request, not blank', looksLikeBlankOrSignatureOnly_('Send more details'), false);
  check('short request: "Tell me more"', looksLikeBlankOrSignatureOnly_('Tell me more'), false);
  check('short request: "Send info"', looksLikeBlankOrSignatureOnly_('Send info'), false);
  check('short request: "Share more details"', looksLikeBlankOrSignatureOnly_('Share more details'), false);
  check('short request: "What is this about" (no question mark)', looksLikeBlankOrSignatureOnly_('What is this about'), false);
  check('genuinely blank: empty string', looksLikeBlankOrSignatureOnly_(''), true);
  check('genuinely blank: whitespace only', looksLikeBlankOrSignatureOnly_('   '), true);
  check('genuinely blank: signature block only', looksLikeBlankOrSignatureOnly_('Best,\nJohn Smith\n555-1234'), true);
}

// ---------------------------------------------------------------------------
// 9. SOP-suggestion consolidation is SINGLE-PASS (28 Aug 2026, real incident).
//
// A recursive chunk-merge architecture shipped earlier today and hung a live
// execution for 20+ minutes: once the LLM stopped finding duplicates, each
// pass returned exactly what it was handed and the next pass re-split the
// identical list forever, burning an LLM call every 20-40 seconds until a
// human killed it by hand. These tests exist so that architecture cannot come
// back silently -- they assert the invariant structurally (exactly one LLM
// call, no matter what the model returns), not just that today's code happens
// to work.
// ---------------------------------------------------------------------------
{
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'learning_loop.gs'), 'utf8');

  check('merge: MAX_CONSOLIDATION_PASSES is exactly 1',
    /const MAX_CONSOLIDATION_PASSES = 1;/.test(src), true);
  check('merge: the recursive chunk helpers are gone',
    /mergeSuggestionChunk_|SOP_MERGE_CHUNK_SIZE|SOP_MERGE_MAX_DEPTH/.test(src), false);

  // Structural: mergeDuplicateSuggestions_ must not call itself.
  const mergeFnBody = (src.match(/function mergeDuplicateSuggestions_[\s\S]*?\n}/) || [''])[0];
  check('merge: mergeDuplicateSuggestions_ does not call itself (no recursion)',
    /mergeDuplicateSuggestions_\s*\(/.test(mergeFnBody.replace(/^function mergeDuplicateSuggestions_/, '')), false);

  // Functional: build an isolated context, stub the LLM, and count calls.
  // The plateau case is the exact one that hung production -- the model
  // returns the SAME number of items it was given, forever, if asked again.
  function runMergeWithStub(itemCount, stubReturnsCount) {
    const { context: ctx } = buildContext(['learning_loop.gs']);
    let calls = 0;
    ctx.callLlmWithFallback = () => {
      calls++;
      const out = [];
      for (let i = 0; i < stubReturnsCount; i++) {
        out.push({ pattern_observed: 'p' + i, suggested_change: 'c' + i, confidence: 'high' });
      }
      return { content: [{ type: 'text', text: JSON.stringify(out) }] };
    };
    const lines = [];
    for (let i = 0; i < itemCount; i++) lines.push('[high] pattern ' + i + ' -> change ' + i);
    const result = ctx.mergeDuplicateSuggestions_(lines, 'test');
    return { calls, result };
  }

  const plateau = runMergeWithStub(21, 21); // the exact production hang shape
  check('merge: a plateau (21 in, 21 out) makes exactly ONE call, not a loop', plateau.calls, 1);
  check('merge: a plateau still returns a usable list', Array.isArray(plateau.result) && plateau.result.length, 21);

  const shrinks = runMergeWithStub(15, 8);
  check('merge: a normal consolidation makes exactly ONE call', shrinks.calls, 1);
  check('merge: a normal consolidation returns the merged list', shrinks.result.length, 8);

  const oversized = runMergeWithStub(200, 200);
  check('merge: an oversized list is refused without spending a call', oversized.calls, 0);
  check('merge: an oversized list returns null so the caller sends unmerged', oversized.result, null);

  const single = runMergeWithStub(1, 1);
  check('merge: a single-item list makes no call', single.calls, 0);
}

// ---------------------------------------------------------------------------
// 10. Daily Report category summary bar (28 Aug 2026, per direct request --
// "that chart doesn't tell any useful information"). Real numbers from the
// 27 Aug email that prompted this: 132 drafted, split yes_general 73 +
// yes_has_own_podcast 3 (positive), no_decline 50 + no_data_error 3
// (negative), info_request 1 + neutral_acknowledgment 1 + other 1 (neutral).
// ---------------------------------------------------------------------------
{
  const { context: ctx } = buildContext(['daily_report.gs']);
  const html = ctx.categorySummaryBarHtml_({
    yes_general: 73, yes_has_own_podcast: 3, no_decline: 50,
    info_request: 1, neutral_acknowledgment: 1, no_data_error: 3, other: 1,
  });
  check('categorySummaryBarHtml_: groups positive categories correctly (76 of 132)',
    html.includes('76 interested'), true);
  check('categorySummaryBarHtml_: groups negative categories correctly (53 of 132)',
    html.includes('53 declined'), true);
  check('categorySummaryBarHtml_: computes positive percentage (76/132 = 58%)',
    html.includes('(58%)'), true);
  check('categorySummaryBarHtml_: computes negative percentage (53/132 = 40%)',
    html.includes('(40%)'), true);
  check('categorySummaryBarHtml_: empty input returns empty string, not a divide-by-zero bar',
    ctx.categorySummaryBarHtml_({}), '');
}

// ---------------------------------------------------------------------------
// 11. escapeHtml never crashes on a non-string input (28 Aug 2026, real
// incident): runBounceAudit called escapeHtml(m.bounceDate), a real Date
// object (message.getDate()), and the old implementation called .replace()
// directly on its argument with no coercion -- Date has no such method, so
// this threw "TypeError: text.replace is not a function" in production. A
// shared global this widely called should never crash outright on a
// wrong-but-plausible input type.
// ---------------------------------------------------------------------------
check('escapeHtml: normal string still escapes correctly', escapeHtml('<b>a & b</b>'), '&lt;b&gt;a &amp; b&lt;/b&gt;');
check('[REAL] escapeHtml: a Date object does not throw (runBounceAudit incident)',
  (() => { try { escapeHtml(new Date(2026, 7, 28)); return 'ok'; } catch (e) { return 'THREW: ' + e; } })(),
  'ok');
check('escapeHtml: null does not throw', (() => { try { escapeHtml(null); return 'ok'; } catch (e) { return 'THREW: ' + e; } })(), 'ok');
check('escapeHtml: a number does not throw', (() => { try { escapeHtml(42); return 'ok'; } catch (e) { return 'THREW: ' + e; } })(), 'ok');

// ---------------------------------------------------------------------------
// FIX (28 Aug 2026, real risk found while adding the Lynn fallback tests):
// this summary used to sit right after section 7 -- every check added after
// it (the word-wrapped-attribution test, both new fallback tests above, and
// all of section 8) still ran, but its pass/fail was never counted here and
// could never trip process.exit(1). A real failure in any of those would
// have printed nothing and exited 0. Moved to the actual end of the file so
// every check in this suite is covered by one true summary.
console.log(`\n  ${passed} passed, ${failures.length} failed\n`);
if (failures.length) {
  failures.forEach((f, i) => console.log(`  ${i + 1}. FAIL ${f}\n`));
  process.exit(1);
}
console.log('  All parsing regression tests passed.\n');
