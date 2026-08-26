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
  // FIX (27 Aug 2026, real risk found in review, verified by execution): the
  // single combined regex below required the hosting phrase to come BEFORE
  // "podcast"/"show" in the subject. Verified failing to match real, valid
  // subject shapes that just reorder the same words -- "Podcast in Texas --
  // are you up for hosting?" and "Your own real estate show -- open to
  // hosting?" -- both real Maildoso subject-line variants. A miss here
  // applies LABEL_SUBJECT_MISMATCH, documented elsewhere as PERMANENT (a
  // thread's first-message subject can never change), so one reworded
  // subject line in a sequence silently and permanently excludes every lead
  // in it. Split into two independent patterns, tested with AND instead of
  // one ordered regex -- see matchesSubjectPattern_() below. Also \b-bounded
  // "podcast|show" so "showing" (as in an open house) can no longer
  // false-positive match "show".
  HOSTING_PHRASE_PATTERN: /(up for hosting|want to host|thinking about hosting|ever considered hosting|open to hosting)/i,
  PODCAST_OR_SHOW_PATTERN: /\b(podcast|show)\b/i,

  INTERNAL_DOMAINS: ['iconsofrealestate.com', 'ardorseo.com'],

  // ADDED (27 Aug 2026, real incident -- confirmed lead loss, header
  // screenshots from Kris). The Maildoso cold-outreach sequences send FROM
  // rotating alias mailboxes on their own throwaway domains, not from
  // INTERNAL_DOMAINS. A lead replies to whichever alias mailed them, and that
  // alias then forwards the whole exchange into network@ (Gmail shows it as
  // "<alias> via ardorseo.com"). So on those threads the last message's From
  // header is the ALIAS, never the lead.
  //
  // That broke the 13 Aug shortcut in runReplyDrafterInner, which reads: if
  // the last sender is neither internal nor the network address itself, it
  // must be the lead replying directly -- so take the From header and skip
  // the forward parser entirely. An alias satisfies "neither", so the alias
  // itself got used as the lead email.
  //
  // Confirmed consequence, not theoretical: a draft on Jennifer's thread was
  // addressed to a.palmer@topaustinseo.site, a human reviewed and sent it,
  // and it bounced ("Delivery incomplete ... a.palmer@topaustinseo.site").
  // The real lead on that thread -- officerjenny77@gmail.com, sitting in the
  // forwarded To: line -- never received anything.
  //
  // These are deliberately NOT added to INTERNAL_DOMAINS: isRealTeamReply()
  // treats an internal sender as "a human already answered this" and applies
  // LABEL_ALREADY_ANSWERED_BY_TEAM, which permanently excludes the thread
  // from the search. That would bury these threads instead of fixing them --
  // and they contain live, unanswered leads (e.g. katie@beamanrealty.com
  // asking "I'm actually in Arkansas now. Do you have room for an Arkansas
  // podcast?"). An alias means "parse the body for the real lead", which is
  // what REQUIRED_CC_ADDRESSES already means -- hence a separate list.
  //
  // Match is by domain, since the local part rotates per sending mailbox.
  // Add new outreach domains here as Maildoso sending accounts are added.
  // Harvested from a live sweep of Joana's mailbox (27 Aug 2026), not from
  // guesswork. Maildoso spins up new sending domains continuously, so this
  // list WILL fall behind -- it is the secondary net. The primary detection
  // is structural and needs no list; see isForwardedFromSendingAlias_().
  FORWARDING_ALIAS_DOMAINS: [
    'topaustinseo.site',              // a.palmer@       -- bounced 25 Aug (Jennifer)
    'scalingflowly.com',              // joana-peixe@    -- bounced 21 Aug (Michael)
    'iconsrealestatenet.com',         // joana_peixe@    -- bounced 21 Aug (Kathy)
    'scaleflowly.com',                // joana@          -- bounced 25 May (Cameron)
    'iconsofrealestatepodcasts.com',  // joana@          -- bounced twice, 21 Aug
    'reachpilotteam.com',             // anna.wilson@
    'reachpilothub.com',              // awilson@        -- distinct domain from the above
    'iconsrealestatesteam.site',      // j.peixe@
    'iconsrealestatemedia.com',       // jpeixe@
    'iconsrealestatefocus.com',       // joana@
    'iconsrealestate.com',            // joana@          -- note: NOT iconsofrealestate.com
    'pixingsproduct.com',             // joanap@
    'battletowardssafetymail.info',   // tevin@
    'theiconsofrealestatepodcast.com' // kris.r@         -- retired (outreach ran under Kris's name before Joana)
  ],

  LABEL_YES: '1. Spam YES',
  LABEL_YES_PENCILED: '1. Spam YES/Penciled',
  LABEL_NO: '2. Spam NO',
  LABEL_STOP: '3. Spam STOP',

  // CHANGED (25 Aug 2026, per direct request -- Joana, Slack): these four
  // labels were being auto-applied by the AI's own classification the
  // moment a draft was created -- before any human reviewed or sent
  // anything. Joana flagged two problems: the AI's classification "has
  // lots of mistakes," and the reply tracker counts positive/negative off
  // these labels, so a wrong auto-label directly corrupts that count. She
  // wants each person to apply the label themselves after actually sending
  // the reply instead. Set false disables auto-apply at both call sites
  // (applyBusinessLabel() and the opt-out STOP branch in
  // runReplyDrafterInner()) without touching anything else -- confirmed
  // safe: opt-out suppression re-checks OPT_OUT_PATTERNS live every run
  // regardless of the STOP label, and thread exclusion from future scans
  // is handled separately by LABEL_AI_DRAFTED, which is unaffected.
  AUTO_APPLY_BUSINESS_LABELS: false,

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

  // ADDED (24 Aug 2026, per direct request -- Joana): the AI should only
  // ever draft the LEAD's very first reply to the cold-outreach sequence
  // (the one Maildoso forwards in). If that lead writes back a SECOND time
  // -- whether to a sent reply, a still-pending draft, or anything else --
  // that's a real, ongoing conversation now and should go to a human, not
  // get auto-drafted again. Checked via hasAlreadySentReplyTo_() (has our
  // account ever sent this lead anything before), not thread state, since
  // thread-ID fragmentation (mismatched Subject/References headers between
  // what we send and what the lead's client threads their reply under --
  // the same class of issue documented throughout this project) means a
  // second reply doesn't reliably land back in the same Gmail thread that
  // carries LABEL_AI_DRAFTED, so a thread-level check alone would miss it.
  LABEL_ALREADY_REPLIED_ONCE: 'AI-Skipped-AlreadyRepliedOnce',

  // ADDED (27 Aug 2026, real incident -- a nightly ping-pong burning Gmail
  // quota). The opt-out and auto-reply/OOO suppression paths applied
  // LABEL_AI_DRAFTED to permanently exclude a thread, WITHOUT ever creating a
  // draft. That label means exactly one thing everywhere else in this project:
  // "a draft for this thread is sitting in the folder awaiting review."
  // reconcile_missing_drafts.gs exists to find threads carrying it with no
  // draft behind them and strip it -- so every night it correctly undid these,
  // the threads re-entered the search, the drafter re-applied the label, and
  // round it went. Each lap costs a full getMessages() plus a real Sent-folder
  // search per thread.
  //
  // The opt-out half used to be shielded by reconcile's "leave it alone if it
  // carries 3. Spam STOP" guard. That guard went dead on 25 Aug when
  // AUTO_APPLY_BUSINESS_LABELS was set false -- the comment justifying that
  // flip reasoned that exclusion "is handled separately by LABEL_AI_DRAFTED,
  // which is unaffected", which did not account for reconcileMissingDrafts,
  // whose entire job is removing LABEL_AI_DRAFTED. The auto-reply half was
  // never covered by that guard at all and has ping-ponged since reconcile
  // went daily on 22 Aug.
  //
  // Fixed by saying what is actually true instead: this thread is suppressed
  // and NO draft was made. reconcileMissingDrafts only ever inspects threads
  // carrying LABEL_AI_DRAFTED, so it leaves these alone permanently.
  LABEL_SUPPRESSED_NO_DRAFT: 'AI-Skipped-Suppressed',
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

  // ADDED (25 Aug 2026, per direct request -- Sean's own links given by Kris):
  // real incident flagged in the 24 Aug "Spam Replies Feedback" doc review --
  // Joana's real replies pick the booking link for whoever is actually taking
  // the call (usually Sean Church, Network Manager) when a lead gets handed
  // off, but the AI-drafted version always defaulted to Joana's own link
  // regardless. Substituted in place of BOOKING_LINK_URL specifically when
  // result.needsTeammateRouting is true -- see the draft-assembly block in
  // runReplyDrafterInner(). needsTeammateRouting's own definition (see
  // classifyAndDraft()'s prompt, below) is consistently described everywhere
  // in this codebase (Code.gs, daily_report.gs, stalled_bookings_audit.gs) as
  // "a qualification call" -- never as a sales call -- so this is the
  // Qualification Call link specifically, not the Sales Call one.
  //
  // Sean's SALES Call link (https://link.iconsofrealestate.com/widget/bookings/sean-icons-podcast-production)
  // is deliberately NOT wired in anywhere: nothing this project drafts is
  // positioned after a qualification call has already happened (that
  // conversation is Sean's own, off-script, off-Gmail), so there is no point
  // in the current flow where inserting it would be correct. If that
  // changes -- e.g. a future cadence follows up AFTER a qualification call --
  // revisit this rather than guessing it into a live draft now.
  SEAN_QUALIFICATION_CALL_URL: 'https://link.iconsofrealestate.com/widget/bookings/sean-podcast-production',

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
  // TEMPORARY (20 Aug 2026, real incident): dropped to 0 to halt new draft
  // creation entirely while CONFIG.MAX_PENDING_DRAFTS_IN_FOLDER's counting
  // was being verified, then RESTORED to 10 (20 Aug 2026) once
  // countPendingAiDrafts_() was confirmed to be the real Gmail REST API
  // count, verified correct twice against the actual Drafts folder (63
  // reported vs 63 counted by hand).
  //
  // LOWERED to 5 (24 Aug 2026, real incident): 20-per-run combined with the
  // 5-minute auto-trigger had produced 43 drafts in one ~30-minute burst
  // before the folder-wide cap below was actually live on the deployed
  // script -- per-run and folder caps are independent safety nets, and even
  // 10 is too high a per-run ceiling on its own once a run fires every 5
  // minutes. Matches FOLLOWUP_DRAFT_CAP in lead_followup_sequences.gs, same
  // reasoning: small steady batches every 5 minutes reach the folder cap
  // gradually instead of in one shot.
  //
  // RAISED to 25 (25 Aug 2026, per direct request). The trigger is now on a
  // 15-minute cadence, not 5 -- a third as many firings per hour as when the
  // 43-draft incident happened -- and the folder-wide cap this incident was
  // really about is independently confirmed working today (stopped a run
  // cleanly at exactly 25, and now exits before the Gmail search entirely
  // once the folder's already full). MAX_PENDING_DRAFTS_IN_FOLDER (now 50,
  // see above) remains a hard ceiling regardless of this number -- a single
  // run cannot exceed it no matter how high this is set.
  MAX_DRAFTS_PER_RUN: 25,

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
  //
  // RAISED to 50 (25 Aug 2026, per direct request): 25 was hit today (23
  // already in the folder, 2 more created, run stopped there per the log).
  // Per the same incremental-trust pattern this project has used throughout
  // -- MAX_DRAFTS_PER_RUN went 5->10->20 as each batch reviewed clean -- if
  // this fills up fast again, the fix is reviewing it down, not necessarily
  // raising the number again; watch the next few days before doubling it a
  // second time.
  MAX_PENDING_DRAFTS_IN_FOLDER: 50,

  // FLIPPED BACK (24 Aug 2026, per direct request -- "handle declines
  // too"): was TEMPORARY since 18 Aug so the review cap could be spent
  // entirely on positive-category drafts while the hub-guest-invite close
  // on declines was still unproven. That close has been live and confirmed
  // working for weeks now, and the actual cost concern this flag protected
  // against -- paying the full SOP-sized call to classify a decline just to
  // throw the draft away -- is now handled earlier and more cheaply by
  // looksLikeDeclineCheaply_() (added the same day, see the call site in
  // runReplyDrafterInner): an unambiguous decline is now caught by a short,
  // SOP-free pre-check before the expensive call ever runs, so drafting
  // declines again doesn't reopen that waste. This flag now only controls
  // whether a decline THAT PASSES the cheap pre-check (i.e. the model
  // itself is not confident it's a clear decline) still gets a real draft
  // -- which is exactly the ambiguous case most worth a human seeing.
  DRAFT_ONLY_POSITIVE_FOR_NOW: false,

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
// FIX (27 Aug 2026, real risk found in review, verified by execution): the
// bare \bstop\b alternative matched ordinary business English, not just
// opt-outs. Confirmed true (and therefore permanently suppressed) against
// "one-stop shop for agents!", "stop by our office any time", and
// "non-stop showings this week" -- \b matches at a hyphen (non-word char),
// so hyphenation offered no protection either. Until 27 Aug this bug was
// partly masked: a false-positive got AI-Drafted-PendingReview, which the
// nightly reconciler stripped, giving the thread another chance. Once
// AI-Skipped-Suppressed replaced that (see CONFIG.LABEL_SUPPRESSED_NO_DRAFT),
// a false positive became permanent -- which is what makes this now urgent
// rather than latent. Replaced the bare word with the phrasings that
// actually mean opt-out: alone-on-a-line "STOP", "please stop", "reply
// STOP", and "stop " immediately followed by the verb being objected to.
// Also tolerates a curly apostrophe (U+2019) in "don't" -- iOS/macOS Mail
// and Outlook autocorrect to it by default, and the straight-quote-only
// `'?` silently missed every phone-composed "don't contact me again".
const OPT_OUT_PATTERNS = /(^\s*stop[.!]?\s*$|\bplease\s+stop\b|\breply\s+stop\b|\bstop\s+(sending|emailing|contacting|texting|messaging)\b|\bunsubscribe\b|\bremove me\b|\btake me off\b|\bdo not (contact|email) me\b|\bfuck off\b|\bfuck you\b|\bpiss off\b|\bget lost\b|\bleave me (the fuck )?alone\b|\bdon['’]?t (contact|email|message|text) me again\b)/i;

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
// FIX (27 Aug 2026, real risk found in review, verified by execution): the
// combined pattern below was applied to the lead's FRESH reply body as well
// as the subject. Two of its alternatives are too broad for real prose:
// "out of (the )?office" matched "Sounds great! I'm out of the office until
// Monday but let's set something up after" -- an interested lead, not an
// auto-reply -- and "no longer (be |)(...|used?|valid|active|...)" matched
// "We no longer use that CRM, but the podcast idea sounds interesting" and
// "I'm no longer active in Dallas -- I moved to Austin. Still want in!".
// Both permanently suppress a lead who said yes.
//
// A real auto-responder always LEADS with "out of office" (it has nothing
// else to say); a real lead mentioning their own OOO status puts their
// actual answer first. So AUTOREPLY_SUBJECT_PATTERNS below (unchanged,
// still broad) is for the SUBJECT line only, where "Automatic reply:" /
// "Out of Office:" prefixes are unambiguous regardless of position and
// short subjects carry little false-positive risk. The BODY check
// (looksLikeAutoReplyBody_ below) requires "out of office" to open the
// message, and requires the generic "no longer X" verbs to be anchored to
// an actual contact channel (email/address/number/mailbox/inbox) rather
// than matching anywhere in a sentence.
const AUTOREPLY_SUBJECT_PATTERNS = /(mailbox that is not actively monitored|does not correspond to a valid address|delivery (has |)failed|undeliverable|out of (the |)office|automatic reply|auto-reply|this is an automated|heavy volume of emails|currently unavailable and will respond|no longer (be |)(reach(ed|able)|used?|valid|active|monitored|using)|do not (send|reply|use) to this email|please use (my |the |a )?(new|updated) email)/i;

// Unambiguous regardless of where they appear -- these phrases essentially
// never occur in a genuine interested reply, so no position anchoring
// needed.
const AUTOREPLY_BODY_UNAMBIGUOUS_PATTERNS = /(mailbox that is not actively monitored|does not correspond to a valid address|delivery (has |)failed|undeliverable|automatic reply|auto-reply|this is an automated|heavy volume of emails|currently unavailable and will respond|do not (send|reply|use) to this email|please use (my |the |a )?(new|updated) email)/i;

// The generic "no longer X" verbs only count as a dead-contact signal when
// anchored to an actual contact channel -- either "no longer reachable at
// this email" (channel after) or "this email is no longer used/valid/
// active/monitored" (channel before). Tolerates a small amount of text
// between the two halves ("my old email is honestly no longer valid").
const CONTACT_CHANNEL_NOUN_ = '(email( address)?|address|number|mailbox|inbox|contact( info(rmation)?)?)';
const NO_LONGER_REACHABLE_PATTERN_ = new RegExp(
  'no longer (be )?reach(ed|able)( at)? (this|that|my|the) ' + CONTACT_CHANNEL_NOUN_ +
  '|(this|that|my|the) ' + CONTACT_CHANNEL_NOUN_ + '[^.!?\\n]{0,40}no longer (be )?(used?|valid|active|monitored|in use)' +
  '|no longer (be )?(used?|valid|active|monitored|in use)[^.!?\\n]{0,40}(this|that|my|the) ' + CONTACT_CHANNEL_NOUN_,
  'i'
);

function looksLikeAutoReplyBody_(freshText) {
  const text = (freshText || '').trim();
  if (!text) return false;
  if (AUTOREPLY_BODY_UNAMBIGUOUS_PATTERNS.test(text)) return true;
  if (NO_LONGER_REACHABLE_PATTERN_.test(text)) return true;
  // "out of office" only counts when it opens the message, with nothing but
  // a subject pronoun/adverb in front -- see comment above. A window-based
  // check ("within the first N words") isn't tight enough: "Sounds great!
  // I'm out of the office until Monday" still lands inside a small word
  // window. Anchored to the very start of the trimmed text instead.
  if (/^\s*(i am|i'm)?\s*(currently\s+)?out of (the )?office/i.test(text)) return true;
  return false;
}

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

  [CONFIG.LABEL_AI_DRAFTED, CONFIG.LABEL_NEEDS_ROUTING, CONFIG.LABEL_ALREADY_ANSWERED_BY_TEAM, CONFIG.LABEL_SUBJECT_MISMATCH, CONFIG.LABEL_ALREADY_REPLIED_ONCE, CONFIG.LABEL_SUPPRESSED_NO_DRAFT].forEach(name => {
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
    draftsTab.appendRow(['Timestamp', 'Thread ID', 'Subject', 'Prospect Email', 'Category', 'Needs Teammate Routing', 'Draft Text', 'Draft Link', 'SOP Mode', 'LLM Provider', 'Estimated Cost USD']);
  }

  let learningTab = ss.getSheetByName('Learning Log');
  if (!learningTab) {
    learningTab = ss.insertSheet('Learning Log');
    learningTab.appendRow(['Compared At', 'Thread ID', 'Subject', 'Category', 'Original AI Draft', 'Final Sent Text', 'Was Edited', 'Reviewed For SOP', 'SOP Mode', 'LLM Provider', 'Draft Similarity %']);
  }

  let suggestionsTab = ss.getSheetByName('SOP Suggestions');
  if (!suggestionsTab) {
    suggestionsTab = ss.insertSheet('SOP Suggestions');
    suggestionsTab.appendRow(['Generated At', 'Based On N Edits', 'Suggested Change', 'Status (pending/approved/rejected)']);
  }

  // ADDED (25 Aug 2026): sendOpsAlert() in quota_guard_and_alerting.gs
  // creates this tab lazily too, but listing it here keeps every standard
  // tab creatable from one place, same as the others above.
  ensureOpsAlertLogTabExists_(ss);

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

// ADDED (24 Aug 2026): closes the "add J1/K1 by hand" open item left over
// from the cost-logging work, and adds the matching Learning Log columns for
// the quality half of the split test.
//
// Why this is a separate function and not part of ensureLogSheetExists():
// that one only writes headers when it CREATES a sheet, and both of these
// tabs have existed for months with hundreds of real rows. Same situation
// migrateAddSopModeColumn() above was written for.
//
// Why it does NOT reuse migrateAddSopModeColumn's "append at
// headers.length + 1" approach: that helper finds the end of the header row
// via getLastColumn(), which reports the last column containing ANY data --
// and logDraftToSheet() has already been writing real values into J and K
// for rows created since yesterday, with no header above them. So
// getLastColumn() already returns 11 on that tab, and appending "one past
// the end" would drop these labels in column L, two columns away from the
// data they name. These are written to their exact known positions instead,
// matching logDraftToSheet()'s own append order, and only when the target
// cell is empty -- so this is safe to run repeatedly and will never
// overwrite a label a human has customized.
function migrateAddLlmColumns() {
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);

  const plan = [
    { sheet: 'AI Drafts Log', labels: { 10: 'LLM Provider', 11: 'Estimated Cost USD' } },
    { sheet: 'Learning Log', labels: { 10: 'LLM Provider', 11: 'Draft Similarity %' } },
  ];

  plan.forEach(spec => {
    const tab = ss.getSheetByName(spec.sheet);
    if (!tab) {
      Logger.log('migrateAddLlmColumns: sheet "' + spec.sheet + '" not found, skipping.');
      return;
    }
    Object.keys(spec.labels).forEach(colStr => {
      const col = Number(colStr);
      const label = spec.labels[colStr];
      const cell = tab.getRange(1, col);
      const current = String(cell.getValue() || '').trim();
      if (current === label) {
        Logger.log('migrateAddLlmColumns: "' + spec.sheet + '" column ' + col + ' already labeled "' + label + '", skipping.');
        return;
      }
      if (current !== '') {
        Logger.log('migrateAddLlmColumns: "' + spec.sheet + '" column ' + col + ' already holds "' + current + '" -- NOT overwriting. Check this by hand; expected "' + label + '".');
        return;
      }
      cell.setValue(label);
      Logger.log('migrateAddLlmColumns: labeled "' + spec.sheet + '" column ' + col + ' as "' + label + '".');
    });
  });
}

// ONE-OFF (24 Aug 2026, per direct request): migrateAddLlmColumns() above
// correctly refused to touch "Learning Log" column K -- it already held
// "Estimated Cost USD", left over from an earlier draft of this feature
// before the columns were split (see logLearningLoop's K1 was never
// supposed to duplicate the AI Drafts Log's cost column; K is what
// runLearningLoopInner() writes draftSimilarityPercent() into). That
// refusal was the right call in general (never silently clobber a label a
// human might have customized) but wrong in this ONE specific case, where
// the existing label is a known leftover, not a customization.
//
// Narrow on purpose: only fires if K1 still holds exactly the stale label,
// so running this after it's already fixed (by hand or by running this
// twice) is a safe no-op, and it will never touch a label that isn't this
// exact known case. Run once from the editor, then this function has
// nothing left to do.
function fixLearningLogK1Label() {
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const tab = ss.getSheetByName('Learning Log');
  if (!tab) {
    Logger.log('fixLearningLogK1Label: "Learning Log" sheet not found.');
    return;
  }
  const cell = tab.getRange(1, 11);
  const current = String(cell.getValue() || '').trim();
  const stale = 'Estimated Cost USD';
  const correct = 'Draft Similarity %';
  if (current === correct) {
    Logger.log('fixLearningLogK1Label: already "' + correct + '", nothing to do.');
    return;
  }
  if (current !== stale) {
    Logger.log('fixLearningLogK1Label: K1 holds "' + current + '", not the expected stale label "' + stale + '" -- NOT touching it. Check by hand.');
    return;
  }
  cell.setValue(correct);
  Logger.log('fixLearningLogK1Label: relabeled "Learning Log" K1 from "' + stale + '" to "' + correct + '".');
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
    tab.appendRow(['Thread ID', 'Skip Reason', 'Last Checked At', 'Message Count At Cache']);
    return tab;
  }

  // MIGRATION (26 Aug 2026, real incident): 'Message Count At Cache' is new
  // -- see isSkipCacheFresh_ below for why. This tab is pure cache with no
  // human-readable history value (rewritten wholesale by saveSkipCache
  // every run), so just extend the header in place -- old rows without a
  // count read back as null and fail the freshness check safely (forces an
  // immediate re-check rather than trusting a stale verdict).
  if (tab.getLastColumn() < 4) {
    tab.getRange(1, 4).setValue('Message Count At Cache');
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
    const messageCount = values[i][3];
    if (threadId && lastCheckedAt instanceof Date) {
      map[threadId] = {
        reason: reason,
        lastCheckedAt: lastCheckedAt,
        messageCount: (typeof messageCount === 'number' && messageCount > 0) ? messageCount : null,
      };
    }
  }
  return map;
}

// FIX (26 Aug 2026, real incident): these skip reasons are documented
// above as state-dependent ("could flip with new activity"), but the only
// invalidation was this blind SKIP_CACHE_TTL_HOURS timer -- a thread that
// got real new activity (e.g. a lead's follow-up reply restoring the
// network CC) kept returning its stale verdict for up to 6 more hours.
// Confirmed via a real thread: cached "not CC-d to network on last
// message" 30 minutes prior, but the lead's actual latest message (which
// arrived after that check) DID have the CC and was asking a live,
// answerable question -- the drafter would have sat on it for hours.
// currentMessageCount comes from thread.getMessageCount(), a cheap
// thread-level metadata call (same category as getFirstMessageSubject()
// above -- NOT the expensive getMessages() fetch), so checking it doesn't
// reintroduce the cost this cache exists to avoid.
function isSkipCacheFresh_(entry, currentMessageCount) {
  if (!entry) return false;
  if (entry.messageCount != null && currentMessageCount != null && entry.messageCount !== currentMessageCount) {
    return false; // new activity since this was cached -- always worth a fresh look, TTL or not
  }
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
    [threadId, cacheMap[threadId].reason, cacheMap[threadId].lastCheckedAt, cacheMap[threadId].messageCount || '']
  );

  const lastRow = tab.getLastRow();
  if (lastRow > 1) tab.getRange(2, 1, lastRow - 1, 4).clearContent();
  if (rows.length > 0) tab.getRange(2, 1, rows.length, 4).setValues(rows);
}

// FIX (27 Aug 2026, real incident): the "permanent skip" paths in
// runReplyDrafterInner all looked like this:
//
//     if (someLabel) thread.addLabel(someLabel);
//     delete skipCache[threadId];   // permanently excluded via label now
//
// The label was applied CONDITIONALLY but the cache entry was dropped
// UNCONDITIONALLY, on the assumption the label had taken over the job of
// excluding this thread. When the label doesn't exist that assumption is
// false in the worst possible way: the thread ends up with NO suppression
// at all -- not labeled (so the search query's -label: clause can't drop
// it) and not cached (so the skip cache can't either) -- and gets fully
// re-fetched and re-searched on every single run, forever.
//
// That is exactly what happened to AI-Skipped-AlreadyRepliedOnce, which
// CONFIG has named since 24 Aug 2026 but which was never created in Gmail.
// Two consecutive live runs 15 minutes apart re-processed the same ~85
// threads in full, each logging "labeled so it stops reappearing" while
// nothing was being labeled. The same runs prove the intended behaviour
// works when the label DOES exist: two threads hit the
// AI-Skipped-AlreadyAnsweredByTeam path in the first run and were simply
// absent from the second (113 candidate threads down to 111).
//
// getOrCreateTrackingLabel_() now makes the missing-label case very
// unlikely, but "unlikely" is what the old code already assumed. Degrade
// to the skip cache instead: suppressed for SKIP_CACHE_TTL_HOURS rather
// than not at all, and loudly logged so the cause is obvious next time.
function recordPermanentSkip_(thread, label, labelName, skipCache, threadId, messageCount, cacheReason, logReason, subject) {
  if (label) {
    thread.addLabel(label);
    delete skipCache[threadId]; // genuinely excluded via label now -- any earlier cache entry is moot
    Logger.log('DIAGNOSTIC -- skipped (' + logReason + '), labeled so it stops reappearing: ' + subject);
    return;
  }

  skipCache[threadId] = { reason: cacheReason, lastCheckedAt: new Date(), messageCount: messageCount };
  Logger.log('DIAGNOSTIC -- skipped (' + logReason + '). NOTE: label "' + labelName + '" does not exist in Gmail and could not be created, so this thread could NOT be permanently excluded -- cached for ' + SKIP_CACHE_TTL_HOURS + 'h instead. Run setup() in Code.gs to create the missing tracking labels: ' + subject);
}

/**
 * ONE-OFF (26 Aug 2026, real incident) -- run this manually once, right
 * after deploying the isSkipCacheFresh_ fix above, to force every
 * candidate thread to get a fresh look on the very next runReplyDrafter
 * firing. Pre-fix cache entries don't have the new message-count field,
 * so isSkipCacheFresh_ falls back to pure TTL for them and they'd
 * otherwise keep returning their stale verdict until each entry's own
 * SKIP_CACHE_TTL_HOURS naturally expires. Safe to run any time -- this
 * tab is pure cache with no human-readable history value; clearing it
 * just means the next run re-derives everything from scratch instead of
 * trusting anything cached.
 */
function clearSkipCache() {
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const tab = ensureSkipCacheTabExists(ss);
  const lastRow = tab.getLastRow();
  if (lastRow <= 1) {
    Logger.log('clearSkipCache -- already empty, nothing to clear.');
    return;
  }
  const lastCol = Math.max(tab.getLastColumn(), 4);
  tab.getRange(2, 1, lastRow - 1, lastCol).clearContent();
  Logger.log('clearSkipCache -- cleared ' + (lastRow - 1) + ' cached row(s). Every candidate thread will get a fresh look on the next runReplyDrafter run.');
}

// ---------- MAIN ENTRY POINT ----------

function runReplyDrafter() {
  // ADDED (23 Aug 2026, per direct request): weekdays stay on the 15-min
  // cadence set in setup_all_triggers.gs, but on weekends -- when nobody's
  // reviewing drafts -- there's no reason to check that often. Apps Script's
  // interval triggers (everyMinutes/everyHours) can't be restricted to
  // specific days (only a single daily .onWeekDay().atHour() fire supports
  // that), so rather than juggling two triggers, this single 15-min trigger
  // keeps firing all week, but on Saturday/Sunday only the firing that lands
  // in each hour's first 15-minute window actually proceeds -- the other
  // three quietly no-op right here, before ANY Gmail API call, which is the
  // whole point: this check is pure Date math, essentially free either way.
  const nowInTz = new Date();
  // FIX (27 Aug 2026): this compared Utilities.formatDate(..., 'EEE') against
  // the English literals 'Sat' and 'Sun'. 'EEE' renders through the SCRIPT
  // PROJECT'S LOCALE, not a fixed one -- under a French locale, entirely
  // plausible for a Europe/Paris project, it yields 'sam.' and 'dim.', the
  // comparison never matches, and the weekend throttle silently never engages.
  // No error, no log line, just four runs an hour all weekend forever.
  // getDay() is locale-proof and returns in the script timezone (Europe/Paris,
  // per appsscript.json), which is what this wants. Matches the day check
  // already proven in lead_followup_sequences.gs.
  const dayOfWeek = nowInTz.getDay(); // 0 = Sunday, 6 = Saturday
  if (dayOfWeek === 0 || dayOfWeek === 6) {
    const minuteOfHour = Number(Utilities.formatDate(nowInTz, 'Europe/Paris', 'mm'));
    if (minuteOfHour >= 15) {
      Logger.log('Skipping runReplyDrafter -- weekend throttle (effectively hourly): not this run\'s turn (minute ' + minuteOfHour + ').');
      return;
    }
  }

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
    Logger.log('Skipping runReplyDrafter -- Gmail quota already known exhausted today, ' + timeUntilQuotaResetDescription_() + '.');
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
    // FIX (27 Aug 2026, real risk found in review): isQuotaExceededError
    // alone matches ANY service's daily-quota error (urlfetch, Drive, ...),
    // not just Gmail's. isGmailSpecificQuotaError additionally requires the
    // error text to name Gmail, so a non-Gmail quota error correctly falls
    // to the "not quota" branch below instead of shutting down every
    // Gmail-touching trigger for a quota that was never actually hit.
    if (isGmailSpecificQuotaError(e)) {
      markGmailQuotaExhausted();
      sendOpsAlert(
        'Gmail quota exhausted -- runReplyDrafter stopped',
        'runReplyDrafter hit the Gmail daily quota and will now skip itself on every trigger firing (every 15 min weekdays, ~hourly weekends) for the rest of today (Pacific time). This should resolve automatically tomorrow. Raw error: ' + e
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
  // CHANGED (27 Aug 2026, real incident -- see getOrCreateTrackingLabel_):
  // these five are the script's own AI-* bookkeeping labels, and every
  // "permanent skip" path below is load-bearing on them actually existing.
  // Create them on demand instead of silently running without them.
  const labelDrafted = getOrCreateTrackingLabel_(CONFIG.LABEL_AI_DRAFTED);
  const labelNeedsRouting = getOrCreateTrackingLabel_(CONFIG.LABEL_NEEDS_ROUTING);
  const labelAlreadyAnsweredByTeam = getOrCreateTrackingLabel_(CONFIG.LABEL_ALREADY_ANSWERED_BY_TEAM);
  const labelSubjectMismatch = getOrCreateTrackingLabel_(CONFIG.LABEL_SUBJECT_MISMATCH);
  const labelAlreadyRepliedOnce = getOrCreateTrackingLabel_(CONFIG.LABEL_ALREADY_REPLIED_ONCE);
  const labelSuppressedNoDraft = getOrCreateTrackingLabel_(CONFIG.LABEL_SUPPRESSED_NO_DRAFT);

  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const skipCache = loadSkipCache(ss);

  // FIX (27 Aug 2026, real incident): saveSkipCache was reached only on the
  // normal fall-through and the folder-full early return. An uncaught throw
  // escaped past both, out of this function, and into runReplyDrafter's
  // catch -- which never saves. callLlmWithFallback throws whenever BOTH
  // Kimi and Anthropic fail (quota_guard_and_alerting.gs), and it is called
  // from classifyAndDraft outside any try, so this is a live path, not a
  // hypothetical one. Both providers failing on thread 150 discarded all 149
  // skip determinations already computed that run -- including the expensive
  // getMessages()-derived ones -- and the next firing 15 minutes later redid
  // every one of them. That feeds straight into the Gmail quota exhaustion
  // this cache exists to prevent.
  //
  // A finally covers every exit: normal completion, all five `break
  // pagination` sites, the folder-full return, and any throw. The separate
  // save that used to sit on the folder-full path is gone, since a return
  // inside try runs the finally on its way out.
  //
  // FIX (27 Aug 2026, real regression from the change above): processed and
  // draftsCreated were declared INSIDE this try block, but the closing
  // Logger.log that reads them sits AFTER the finally -- outside the try's
  // scope. Every run that reached the bottom of the loop threw
  // ReferenceError on its own completion line, which runReplyDrafter's catch
  // then reported as "failed (not quota) -- this needs a real look" even
  // though the run had already done all its real work correctly. Declared
  // here, above the try, so both the loop body and the final log line share
  // one scope.
  let processed = 0;
  let draftsCreated = 0;
  // FIX (27 Aug 2026, real risk found in review): see the catch around
  // createThreadedDraft_ below -- this counts consecutive draft-creation
  // failures so a persistent Gmail-side problem (rate limit, quota, a
  // revoked scope) stops the run instead of burning a full LLM call per
  // remaining thread only to fail identically each time.
  let consecutiveDraftFailures = 0;
  const MAX_CONSECUTIVE_DRAFT_FAILURES = 3;

  try {

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
    const searchQuery = '(' + addressClauses + ') newer_than:180d -label:"' + CONFIG.LABEL_AI_DRAFTED + '" -label:"' + CONFIG.LABEL_STOP + '" -label:"' + CONFIG.LABEL_ALREADY_ANSWERED_BY_TEAM + '" -label:"' + CONFIG.LABEL_SUBJECT_MISMATCH + '" -label:"' + CONFIG.LABEL_ALREADY_REPLIED_ONCE + '" -label:"' + CONFIG.LABEL_SUPPRESSED_NO_DRAFT + '"';

    Logger.log('DIAGNOSTIC -- search query: ' + searchQuery);

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
    // REAL INCIDENT, 20 Aug 2026 -- four different ways of asking GmailApp
    // for this count were each wrong, in different ways, live:
    //   1. GmailApp.getDraftMessages().length -- counts Joana's ~50+ permanent
    //      reusable template drafts too ("Let's roll!", "Sales Briefing -
    //      LEAD NAME - DATE", etc., some from Oct 2025) -- cap was dead on
    //      arrival regardless of real backlog.
    //   2. labelDrafted.getThreads().length -- the label alone is stale (443
    //      -- a thread keeps it even after its draft is long gone, per
    //      reconcile_missing_drafts.gs, which exists for exactly that gap).
    //   3. GmailApp.getDraftMessages().filter(d => thread has label) -- let 70
    //      real drafts through before a cap of 25 ever tripped.
    //   4. GmailApp.search('in:draft label:"..."') combined in one query
    //      returned 0 despite dozens of real matches; splitting into two
    //      separate GmailApp.search() calls (no message-object access at all)
    //      still reported 11-12 against a real 44+.
    // Every one of those goes through GmailApp's wrapper. The one method
    // verified correct against this exact account during the incident (via a
    // live Gmail API call, independent of GmailApp) was the Gmail REST API's
    // own drafts.list with a `q` filter. See countPendingAiDrafts_() below --
    // calls that same endpoint directly via UrlFetchApp, bypassing GmailApp's
    // wrapper for this one check. No manifest/advanced-service changes needed
    // (a past attempt at that broke Git Pull -- see git history) since this
    // uses the OAuth token Apps Script already grants GmailApp.
    //
    // FAILS CLOSED: if the API call itself fails for any reason, treat the
    // folder as full (block new drafts) rather than defaulting to 0 (which is
    // exactly the failure mode behind incidents #1-4 above -- an undercount
    // silently allowing unlimited creation). Getting this wrong in the
    // "blocks too eagerly" direction is a minor annoyance Joana can notice
    // and rerun; getting it wrong the other way is the incident we just had.
    const startingDraftCount = countPendingAiDrafts_();
    Logger.log('DIAGNOSTIC -- ' + startingDraftCount + ' draft(s) already in the folder at run start (cap: ' + CONFIG.MAX_PENDING_DRAFTS_IN_FOLDER + ').');

    // ADDED (25 Aug 2026, per direct request -- "why isn't the first thing to
    // check the MAX pending drafts"): a real gap. startingDraftCount was
    // computed above, but nothing acted on it until deep inside the pagination
    // loop, AFTER GmailApp.search() had already fetched up to 500 threads --
    // real Gmail API cost paid even in the one case where it's already certain,
    // before a single thread is looked at, that zero drafts can be created this
    // run. Harmless on a run like today's (23/25, room for 2 -- the search was
    // going to be needed anyway), but on any run where the folder is already
    // AT or OVER cap -- exactly the situation this limit exists to react to,
    // and the likely state on a busy day once drafts pile up faster than
    // review -- the old code paid for that search and page-iteration setup on
    // every single 15-minute firing for zero possible benefit. Bail before
    // ever calling GmailApp.search() when there's no room to begin with.
    if (startingDraftCount >= CONFIG.MAX_PENDING_DRAFTS_IN_FOLDER) {
      Logger.log('Folder already at/over MAX_PENDING_DRAFTS_IN_FOLDER (' + startingDraftCount + '/' + CONFIG.MAX_PENDING_DRAFTS_IN_FOLDER + ') -- skipping this run entirely, no Gmail search performed. Will try again next run once the folder is reviewed down.');
      return; // the finally below saves the cache on the way out

    }

    // ADDED (25 Aug 2026, real incident -- see draftAlreadyExistsFor()'s
    // comment): fetch the existing Drafts folder ONCE for this whole run,
    // instead of once per candidate thread inside the loop below.
    const existingDrafts = GmailApp.getDraftMessages();
    // ADDED (25 Aug 2026, per direct request -- "should we log each call so we
    // keep track"): the flat "+1 per thread" self-tracked counter (below, in
    // the main loop) badly undercounted real Gmail API cost for exactly the
    // bug just fixed above -- getDraftMessages() plus one .getTo() call per
    // existing draft, which used to happen per THREAD, now happens once here.
    // Recording its real weight (1 for the list fetch + 1 per draft it
    // contains) keeps the self-tracked total closer to what Google actually
    // sees, so the proactive 40,000 soft cap in quota_guard_and_alerting.gs
    // has a real chance of tripping before Google's own wall does next time.
    recordGmailQuotaUsage_(1 + existingDrafts.length);

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
        // ADDED (22 Aug 2026, per direct request): recordGmailQuotaUsage_()
        // below can flip isGmailQuotaExhausted() to true mid-run (self-imposed
        // soft cap) -- check it here too, not just once at the top of
        // runReplyDrafter(), so a long-running page loop actually stops the
        // moment that happens instead of grinding through the rest of the page.
        if (isGmailQuotaExhausted()) {
          Logger.log('Gmail quota marked exhausted mid-run -- stopping cleanly. Remaining threads will be picked up next run.');
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
      if (!matchesSubjectPattern_(subject)) {
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
      const currentMessageCount = thread.getMessageCount(); // cheap thread-level metadata, not getMessages()
      if (isSkipCacheFresh_(cacheEntry, currentMessageCount)) {
        Logger.log('DIAGNOSTIC -- skipped (cached ' + Math.round((Date.now() - cacheEntry.lastCheckedAt.getTime()) / 60000) + 'm ago: ' + cacheEntry.reason + '): ' + subject);
        continue;
      }

      const messages = thread.getMessages();
      // SELF-TRACKED QUOTA COUNTER (22 Aug 2026, per direct request): see the
      // fuller comment in quota_guard_and_alerting.gs -- this is a per-thread
      // proxy, not an exact Gmail API call count, meant to self-stop BEFORE
      // Google's real daily limit throws instead of only reacting after.
      recordGmailQuotaUsage_(1);
      const lastMsg = lastNonDraftMessage_(messages) || messages[messages.length - 1];

      if (!isCcdToNetworkGroupAnywhereInThread(messages)) {
        skipCache[threadId] = { reason: 'network never CC-d anywhere in this thread', lastCheckedAt: new Date(), messageCount: messages.length };
        Logger.log('DIAGNOSTIC -- skipped (network never CC-d anywhere in this thread), cached for ' + SKIP_CACHE_TTL_HOURS + 'h: ' + subject);
        continue;
      }

      const lastSenderEmail = extractEmail(lastMsg.getFrom());
      if (isRealTeamReply(lastSenderEmail)) {
        recordPermanentSkip_(thread, labelAlreadyAnsweredByTeam, CONFIG.LABEL_ALREADY_ANSWERED_BY_TEAM, skipCache, threadId, messages.length,
          'already answered by ' + lastSenderEmail,
          'already answered by ' + lastSenderEmail,
          subject);
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
      // FIX (27 Aug 2026, real incident): the 13 Aug shortcut below assumes a
      // last sender who is neither internal nor the network address must BE the
      // lead. Maildoso's sending aliases break that assumption -- they are
      // neither, yet they are us. Treat an alias exactly like the network
      // address: a signal to parse the forwarded body for the real lead, never
      // a lead in its own right. See CONFIG.FORWARDING_ALIAS_DOMAINS.
      const isAliasItself = CONFIG.REQUIRED_CC_ADDRESSES.some(addr => addr.toLowerCase() === lastSenderEmail.toLowerCase())
        || isForwardedFromSendingAlias_(lastMsg, lastSenderEmail);
      let leadEmail, originalSubjectFromForward;

      if (!isAliasItself) {
        leadEmail = lastSenderEmail;
        originalSubjectFromForward = null;
      } else {
        const forwardInfo = extractForwardedLeadInfo(lastMsg);
        if (!forwardInfo) {
          skipCache[threadId] = { reason: 'could not parse forwarded lead info', lastCheckedAt: new Date(), messageCount: messages.length };
          Logger.log('Could not parse forwarded lead info for: ' + subject + ' -- skipping rather than guessing, cached for ' + SKIP_CACHE_TTL_HOURS + 'h.');
          continue;
        }
        leadEmail = forwardInfo.email;
        originalSubjectFromForward = forwardInfo.originalSubject;
      }

      // FIX (26 Aug 2026, real incident): a bounce/mail-delivery-failure
      // message landing as the thread's last message (e.g. an earlier draft
      // got sent to a dead address and Gmail threaded the bounce back in)
      // was being treated as if the bounce SENDER were the real lead --
      // isNonHumanSender() already existed (missed_leads_audit.gs, shared
      // global scope) but was never called here. AUTOREPLY_PATTERNS below
      // catches some of this too, but only after leadEmail has already been
      // used for the draft-exists check and everything past it -- this
      // catches it immediately, before leadEmail is used for anything.
      if (isNonHumanSender(leadEmail)) {
        skipCache[threadId] = { reason: 'lead email looks like a bounce/system address (' + leadEmail + '), not a real lead', lastCheckedAt: new Date(), messageCount: messages.length };
        Logger.log('DIAGNOSTIC -- skipped (lead email looks like a bounce/system address: ' + leadEmail + '), cached for ' + SKIP_CACHE_TTL_HOURS + 'h: ' + subject);
        continue;
      }

      // BACKSTOP (27 Aug 2026, real incident): whatever path produced leadEmail
      // above, it must be an outside human before it is used as a draft
      // recipient. A draft addressed to one of our own addresses is never
      // useful and, when a reviewer sends it, either bounces (the confirmed
      // a.palmer@topaustinseo.site case) or mails the team itself. Cheap check,
      // and it fails safe: a genuine lead can never match one of our own
      // domains. Cached rather than labeled, since a later message on the same
      // thread may well carry a parseable real lead.
      if (isUnmailableAsLead_(leadEmail)) {
        skipCache[threadId] = { reason: 'resolved lead email (' + leadEmail + ') is one of our own addresses, not a real lead', lastCheckedAt: new Date(), messageCount: messages.length };
        Logger.log('DIAGNOSTIC -- skipped (resolved lead email ' + leadEmail + ' is one of our own addresses -- team, sending alias, or the network list -- not a real lead), cached for ' + SKIP_CACHE_TTL_HOURS + 'h: ' + subject);
        continue;
      }

      if (draftedThisRun.has(leadEmail.toLowerCase()) || draftAlreadyExistsFor(leadEmail, existingDrafts)) {
        skipCache[threadId] = { reason: 'draft already exists for ' + leadEmail, lastCheckedAt: new Date(), messageCount: messages.length };
        Logger.log('DIAGNOSTIC -- skipped (draft already exists for ' + leadEmail + '), cached for ' + SKIP_CACHE_TTL_HOURS + 'h: ' + subject);
        continue;
      }

      // ADDED (24 Aug 2026, per direct request -- Joana): only ever draft a
      // lead's FIRST reply to the cold-outreach sequence. If we've ever sent
      // this lead anything before -- an earlier AI-drafted reply, or a fully
      // manual one -- this is now an ongoing conversation and goes to a human,
      // not back through the AI. Checked against the real Sent folder by lead
      // email address (not thread/label state) specifically because a second
      // reply doesn't reliably land back in the same Gmail thread that carries
      // LABEL_AI_DRAFTED -- see CONFIG.LABEL_ALREADY_REPLIED_ONCE's comment.
      if (hasAlreadySentReplyTo_(leadEmail)) {
        recordPermanentSkip_(thread, labelAlreadyRepliedOnce, CONFIG.LABEL_ALREADY_REPLIED_ONCE, skipCache, threadId, messages.length,
          'already sent a reply to ' + leadEmail + ' before -- follow-up reply, left for the team',
          'already sent a reply to ' + leadEmail + ' before -- this is a follow-up reply, per policy leaving it for the team',
          subject);
        continue;
      }

      const replyBody = extractProspectFreshReplyText(lastMsg);

      const alreadyLabeledStop = threadHasLabel(thread, CONFIG.LABEL_STOP);
      if (alreadyLabeledStop || OPT_OUT_PATTERNS.test(replyBody)) {
        if (CONFIG.AUTO_APPLY_BUSINESS_LABELS && labelStop && !alreadyLabeledStop) thread.addLabel(labelStop);
        // CHANGED (27 Aug 2026): was thread.addLabel(labelDrafted) -- see
        // CONFIG.LABEL_SUPPRESSED_NO_DRAFT for the nightly ping-pong that caused.
        recordPermanentSkip_(thread, labelSuppressedNoDraft, CONFIG.LABEL_SUPPRESSED_NO_DRAFT, skipCache, threadId, messages.length,
          'opt-out -- suppressed, no draft made',
          'suppressed (opt-out): ' + leadEmail,
          subject);
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
      if (looksLikeAutoReplyBody_(replyBody) || AUTOREPLY_SUBJECT_PATTERNS.test(lastMsg.getSubject())) {
        // CHANGED (27 Aug 2026): was thread.addLabel(labelDrafted) -- see
        // CONFIG.LABEL_SUPPRESSED_NO_DRAFT for the nightly ping-pong that caused.
        recordPermanentSkip_(thread, labelSuppressedNoDraft, CONFIG.LABEL_SUPPRESSED_NO_DRAFT, skipCache, threadId, messages.length,
          'auto-reply/OOO -- suppressed, no draft made',
          'suppressed (auto-reply/OOO, not a real reply): ' + leadEmail,
          subject);
        processed++;
        continue;
      }

      // ADDED (24 Aug 2026, per direct request -- "you are paying full price to
      // classify declines and throwing the result away"). REAL WASTE, measured:
      // 37 LLM calls today produced 2 drafts. Every thread reaching this point
      // used to go straight into the full classifyAndDraft() call -- ~9k tokens
      // of SOP plus a fully written reply body -- and THEN, only after paying
      // for all of it, DRAFT_ONLY_POSITIVE_FOR_NOW would look at the returned
      // category and bin the whole thing if it was a decline.
      //
      // This is a cheap gate in front of that: a short prompt (no SOP at all,
      // just the reply text) that answers one question -- is this obviously a
      // decline? On a hit we skip the expensive call entirely, saving the SOP
      // input AND the drafted body we were never going to use.
      //
      // DELIBERATELY CONSERVATIVE, because the failure modes are not symmetric.
      // Wrongly skipping a real lead is the Montell/Mariann/Mumu incident of
      // 17 Aug -- a genuinely interested reply written off, which is the worst
      // outcome this system has. Wrongly continuing just costs one full call,
      // which is what happened every time before today. So the gate only acts
      // on an unambiguous decline and is told in the prompt to answer "unsure"
      // whenever there is any doubt at all; anything but a confident "decline"
      // falls through to the full path unchanged.
      //
      // Only runs while DRAFT_ONLY_POSITIVE_FOR_NOW is on -- and as of 24 Aug
      // 2026 it is off (see CONFIG), so this whole block is currently a no-op.
      // Left in place rather than deleted: it's a real, tested cost-saver for
      // exactly the situation the flag describes (declines are being binned,
      // so don't pay full price to classify one), and turning that situation
      // back on is one config flip away. Once DRAFT_ONLY_POSITIVE_FOR_NOW is
      // off, there is nothing being binned, so there is nothing to save by
      // skipping the full call -- every category, decline included, now gets
      // a real classification and a real draft.
      if (CONFIG.DRAFT_ONLY_POSITIVE_FOR_NOW) {
        const cheapVerdict = looksLikeDeclineCheaply_(replyBody, subject);
        if (cheapVerdict === 'decline') {
          skipCache[threadId] = { reason: 'cheap pre-check read it as a clear decline (deprioritized, no full LLM call made)', lastCheckedAt: new Date(), messageCount: messages.length };
          Logger.log('DIAGNOSTIC -- skipped BEFORE the expensive call (cheap pre-check: clear decline, and declines are deprioritized right now), cached for ' + SKIP_CACHE_TTL_HOURS + 'h: ' + subject);
          continue;
        }
        Logger.log('DIAGNOSTIC -- cheap pre-check returned "' + cheapVerdict + '" for: ' + subject + ' -- proceeding to the full classify/draft call.');
      }

      const state = extractStateFromSubject(subject);
      const matchedShow = state ? stateDirectory[normalizeState(state)] : null;

      const context = buildThreadContext(messages);
      const sopMode = assignSopMode(threadId);
      const likelyBlankOrSignatureOnly = looksLikeBlankOrSignatureOnly_(replyBody);
      // systemPrompt is passed through UNCHANGED (pure SOP text) so it stays
      // byte-identical across every call and both providers can actually cache
      // it -- the mode override rides in the user prompt now.
      const result = classifyAndDraft(systemPrompt, subject, context, leadEmail, state, matchedShow, buildSopModeOverride(sopMode), likelyBlankOrSignatureOnly);

      if (!result) {
        skipCache[threadId] = { reason: 'classification/draft failed', lastCheckedAt: new Date(), messageCount: messages.length };
        Logger.log('Classification/draft failed for: ' + subject + ', cached for ' + SKIP_CACHE_TTL_HOURS + 'h.');
        continue;
      }

      // OFF as of 24 Aug 2026 (see CONFIG.DRAFT_ONLY_POSITIVE_FOR_NOW -- per
      // direct request, "handle declines too"). Was TEMPORARY since 18 Aug to
      // focus review capacity on positive replies while the hub-guest-invite
      // close on declines was unproven; that close has been live and working
      // for weeks. This guard, and the cheap pre-check gate above it, both key
      // off the same flag and both currently no-op -- flip it back to true to
      // restore the old deprioritize-declines behavior in one place.
      if (CONFIG.DRAFT_ONLY_POSITIVE_FOR_NOW && (result.category === 'no_decline' || result.category === 'no_data_error')) {
        skipCache[threadId] = { reason: 'deprioritized (' + result.category + ') -- focusing on positive replies for now', lastCheckedAt: new Date(), messageCount: messages.length };
        Logger.log('DIAGNOSTIC -- skipped (deprioritized ' + result.category + ' per today\'s request), cached for ' + SKIP_CACHE_TTL_HOURS + 'h: ' + subject);
        continue;
      }

      if (result.category === 'no_decline' && matchedShow) {
        commitNoDeclineVariation(result.candidateVariationIndex);
      }

      try {
        const priorityNote = buildPriorityCheckNote(result);
        const sopModeNote = buildSopModeNote(sopMode);
        const llmProviderNote = buildLlmProviderNote(result.llmProvider);
        // ADDED (25 Aug 2026, per direct request): a needsTeammateRouting draft
        // is, by definition, handing this lead to a real qualification call --
        // point the (BOOKING_LINK) token at Sean's Qualification Call link
        // instead of Joana's own. Still just a default: nothing here is ever
        // auto-sent, so if it should really be Bens, Joana swaps it before
        // sending, same correction she was already making by hand.
        const bookingLinkForThisDraft = result.needsTeammateRouting ? CONFIG.SEAN_QUALIFICATION_CALL_URL : null;
        const aiReplyPlain = priorityNote + sopModeNote + llmProviderNote + sanitizeEmojiForGmail(markdownLinksToPlain(result.draftBody, bookingLinkForThisDraft));
        const historyPlain = stripForwardHeaderKeepHistory(lastMsg.getPlainBody());
        const fullPlainBody = aiReplyPlain + '\n\n' + historyPlain;

        const priorityNoteHtml = escapeHtml(priorityNote).replace(/\n/g, '<br>');
        const sopModeNoteHtml = escapeHtml(sopModeNote).replace(/\n/g, '<br>');
        const llmProviderNoteHtml = escapeHtml(llmProviderNote).replace(/\n/g, '<br>');
        const aiReplyHtml = priorityNoteHtml + sopModeNoteHtml + llmProviderNoteHtml + emojiToHtmlEntities(sanitizeEmojiForGmail(markdownLinksToHtml(result.draftBody, bookingLinkForThisDraft)));
        const historyHtml = emojiToHtmlEntities(escapeHtml(historyPlain).replace(/\n/g, '<br>'));
        const fullHtmlBody = aiReplyHtml + '<br><br>' + historyHtml;

        const cleanSubject = (originalSubjectFromForward || subject).replace(/^(fwd:\s*)+/i, '').trim();
        // FIX (17 Aug 2026, real incident -- Joana's top-priority, repeatedly
        // flagged complaint): GmailApp.createDraft() composed a brand-new,
        // unthreaded message every time. See createThreadedDraft_() above for
        // the full history and why the base service can't do this correctly.
        createThreadedDraft_(thread, lastMsg, leadEmail, CONFIG.NETWORK_CC_ON_REPLY, cleanSubject, fullPlainBody, fullHtmlBody);
        // ADDED (25 Aug 2026, per direct request -- weighted quota tracking):
        // actual draft creation is several real Gmail Advanced Service calls
        // (not the flat "1" already recorded per thread above) -- creating the
        // draft itself, plus the label operations right after this block.
        // Weighted at 5 as a conservative estimate, not an exact count.
        recordGmailQuotaUsage_(5);
        var draftLink = 'https://mail.google.com/mail/u/0/#all/' + thread.getId();
        draftedThisRun.add(leadEmail.toLowerCase());
        draftsCreated++;
        consecutiveDraftFailures = 0;
        delete skipCache[threadId]; // now permanently excluded via LABEL_AI_DRAFTED below -- any earlier cache entry is moot
      } catch (e) {
        // FIX (27 Aug 2026, real risk found in review): this catch had no
        // quota check, no markGmailQuotaExhausted(), and no failure-count
        // bailout. When Gmail starts returning 429/403, the loop used to
        // `continue` straight to the next thread -- which pays a FRESH full
        // classifyAndDraft() call (a written reply body, real LLM cost)
        // before failing at exactly the same step, up to MAX_THREADS_PER_RUN
        // times, every 15 minutes, all day. recordGmailQuotaUsage_ was also
        // only called on the success path above, so these failing calls
        // were invisible to the self-tracked quota counter too.
        Logger.log('Draft creation failed for ' + subject + ': ' + e);
        recordGmailQuotaUsage_(5); // it was attempted against Gmail; it cost, success or not
        if (isGmailSpecificQuotaError(e)) throw e; // let runReplyDrafter's catch trip the real circuit breaker
        consecutiveDraftFailures++;
        if (consecutiveDraftFailures >= MAX_CONSECUTIVE_DRAFT_FAILURES) {
          sendOpsAlert(
            'runReplyDrafter -- draft creation failing repeatedly',
            consecutiveDraftFailures + ' consecutive createThreadedDraft_ failures. Stopping this run rather than continuing to pay a full LLM call per remaining thread for the same failure. Last error: ' + e
          );
          break pagination;
        }
        continue;
      }

      if (CONFIG.AUTO_APPLY_BUSINESS_LABELS) {
        applyBusinessLabel(thread, result.category, labelYes, labelYesPenciled, labelNo);
      }

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

      logDraftToSheet(thread.getId(), subject, leadEmail, result.category, result.needsTeammateRouting, result.draftBody, draftLink, sopMode, result.llmProvider, result.llmCostUsd);

        processed++;
      }

      if (page.length < PAGE_SIZE) break; // short page -- that was the last of the real backlog
      pageStart += PAGE_SIZE;
    }
  } finally {
    // FIX (27 Aug 2026, real risk in the change above): saveSkipCache does an
    // unguarded clearContent()+setValues(). A throw inside a finally DISCARDS
    // the in-flight exception and propagates the new one instead -- so a
    // genuine Gmail quota error escaping the try above could be replaced by a
    // Sheets error, isQuotaExceededError would then see the wrong error and
    // return false, and the circuit breaker would never trip. Guarding this
    // save can never mask a real failure; letting it throw always could.
    try {
      saveSkipCache(ss, skipCache);
    } catch (saveErr) {
      Logger.log('saveSkipCache failed in finally (not masking the run\'s real error, if any): ' + saveErr);
    }
  }

  Logger.log('Run complete. Threads processed: ' + processed + ', drafts created: ' + draftsCreated);
}

function logDraftToSheet(threadId, subject, prospectEmail, category, needsRouting, draftText, draftLink, sopMode, llmProvider, llmCostUsd) {
  if (!CONFIG.SPREADSHEET_ID || CONFIG.SPREADSHEET_ID === 'PASTE_YOUR_SHEET_ID_HERE') return;
  try {
    const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    const tab = ss.getSheetByName('AI Drafts Log');
    if (!tab) {
      // FIX (27 Aug 2026, real risk found in review): this used to return
      // silently. The Gmail draft still gets created and labeled -- only the
      // sheet record is lost -- but that record is the input to
      // registerNewPodcastSalesLeads (follow-up enrollment), runLearningLoop
      // (the SOP-improvement and Kimi-vs-Anthropic quality loop),
      // runDailyReport, runStalledBookingsAudit, and the heartbeat's
      // staleness check. A renamed tab or a fresh sheet nobody ran setup() on
      // would silently take all of those dark together, with the actual
      // cause -- this one missing tab -- never logged anywhere a human would see.
      Logger.log('WARNING -- "AI Drafts Log" tab not found. A draft was just created in Gmail but NOT recorded here.');
      sendOpsAlert('logDraftToSheet -- "AI Drafts Log" tab missing',
        'A reply draft for "' + subject + '" was created in Gmail and labeled, but could not be logged to the "AI Drafts Log" tab because that tab does not exist in the spreadsheet. Every downstream system that reads that tab (follow-up enrollment, the learning loop, the daily report, the stalled-bookings audit, the heartbeat) will not see this draft. Run setup() in Code.gs to recreate the expected tabs.');
      return;
    }
    // ADDED (24 Aug 2026, per direct request -- "cost per draft"): these two
    // columns land AFTER the existing ones on purpose -- the tab already has
    // 275+ historical rows and a fixed header row; appending past the
    // existing header just means older rows show blank in these two columns
    // (there's no real cost data for them anyway) rather than risking a
    // rewrite of a header humans may have already customized. Add "LLM
    // Provider" and "Estimated Cost USD" as header labels for columns J/K
    // once, by hand, in the Sheet -- this code doesn't touch row 1.
    tab.appendRow([new Date(), threadId, subject, prospectEmail, category, !!needsRouting, draftText, draftLink || '', sopMode || 'joana', llmProvider || '', llmCostUsd != null ? llmCostUsd : '']);
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
// RESTRUCTURED (24 Aug 2026, real incident -- this was the 7x cost bug):
// this used to return the SOP text with the mode override appended, and that
// combined result was sent as the `system` field. So the system field was
// DIFFERENT on every call, alternating between the Hormozi and Joana variants
// per assignSopMode().
//
// Why that was so expensive: prompt caching on both providers is a PREFIX
// match, and the system field is part of that prefix. Anthropic tolerated it
// -- it holds multiple concurrent cache entries, so both variants stayed
// warm, which is why Anthropic's spend stayed low. Moonshot/Kimi does not
// honour cache_control at all (confirmed 24 Aug 2026 -- its caching is
// automatic on prefix match, and any change to the system field invalidates
// it), so an alternating system prompt thrashed Kimi's cache to roughly
// nothing and re-billed the full ~9k-token SOP at full input price on
// essentially every call. That is the 7x.
//
// Fix: the system field is now the SOP text and NOTHING else -- byte-identical
// on every call, for every thread, in both modes. The mode override moved
// into the user prompt, where per-call variation belongs and costs nothing.
// It is appended at the very END of the user prompt, which preserves the
// 18 Aug fix's whole point (the override must be "the last thing it reads",
// since asking the model to look up a heading earlier in the prompt was
// confirmed not to work) -- if anything it is now more final than before.
function buildSopModeOverride(mode) {
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
    return '\n\n---\n\nMANDATORY OVERRIDE FOR THIS REPLY ONLY -- HORMOZI MODE (active split test, 18 Aug 2026). This is a REQUIREMENT, not a style suggestion: you MUST use the exact text below in place of the standard core pitch paragraph, cost-question close, and CTA close, with no exceptions. Do not blend the two styles, do not fall back to the standard wording above, do not decide the standard version fits better. Do NOT combine the CTA close below with the standard mode\'s "I\'ll have one of our team give you a call" line -- use ONLY the CTA close below.\n\n' +
      'CORE PITCH PARAGRAPH (use this, not the standard one): "Most agents know they should be building a personal brand, but between showings and closings there\'s never time to actually create content consistently. That\'s exactly what this solves: a podcast where you just show up for a relaxed 20-30 minute conversation with a local business owner, lender, or community leader a couple times a month — we handle 100% of the production, editing, publishing, and turning it into social clips, so it adds zero to your workload. We\'ve done this for 100+ agents across 30 states, and for the ones who lean into it, it\'s turned into real referral relationships in their market, not just downloads."\n\n' +
      'BENEFIT LINE (include right after the pitch paragraph): "The real benefit? It grows your sphere of influence, builds your authority as the go-to name in your market, and — most importantly — helps you sell more houses."\n\n' +
      'COST-QUESTION CLOSE (use this if cost comes up, not the standard one): "Great question -- quick context before the number: this isn\'t just a podcast, it\'s a done-for-you authority engine. We handle 100% of the production, editing, publishing, distribution, and turning every episode into social content, so all you do is show up and talk. Packages start around a one-time $497 start-up kit and $600/month for ongoing production -- less than most agents spend on a month of ad spend that disappears the moment they stop paying for it, while this compounds into a library that keeps working for you and building the kind of referral relationships that are worth a lot more than $600 a month. The exact package depends on your goals and how hands-on you\'d like the team to be, so rather than lock in a number over email, let\'s get that dialed in on a quick call. A lot of hosts also bring on a sponsor to offset the cost, which tends to be an easy sell in real estate." Never present these figures as the final or only price -- they are a starting point, and the close should route to a call for the real number, especially for a clearly hot/motivated lead. Do not open with "there is a cost involved" or any other pain-first framing -- value and context come before the number, never after.\n\n' +
      'CTA CLOSE (use this, not the standard "I\'ll have one of our team give you a call" line): "Here\'s the quick version: [detail specific to what they asked]. Want the full picture in under 15 minutes instead? Grab a slot here: [book a 15-minute Zoom Call here](BOOKING_LINK) — I\'ll walk you through everything and answer whatever\'s on your mind."\n\n' +
      'Do NOT name a specific teammate (e.g. "Sean," "Bens") as the one who will personally call or reach out. Nobody is automatically CC\'d or notified when this reply sends -- naming someone specific here is a promise the system cannot back up unless a human manually loops them in afterward. If a handoff needs mentioning, say "someone from our team" / "I\'ll have one of our team reach out," never a specific name.\n\n' +
      'Everything else in the SOP above (categories, hard rules, tone, emoji, link formatting, no_decline handling, etc.) stays exactly as written -- only these four pieces change for this reply.';
  }
  return '\n\n---\n\nACTIVE SPLIT TEST -- JOANA MODE (assigned to this specific reply, 18 Aug 2026): ignore the "## HORMOZI MODE OVERRIDES" section entirely if present above -- use only the standard SOP text for this reply.';
}

// Mirrors buildPriorityCheckNote()'s pattern exactly (bracketed, marked
// DELETE BEFORE SENDING) so Joana and Goodness see mode the same way they
// already see the priority flag -- no new convention to learn.
// ADDED (24 Aug 2026, per direct request -- "note if it was kimi or
// anthropic AI so we can measure the quality of the output too"): the
// Kimi-vs-Anthropic split test measures price automatically (LLM Cost Log
// tab, plus the per-draft cost column) but quality has no automatic
// measure -- the only judge of whether a draft is any good is the human
// reading it before they send it. That judgement happens in Gmail, where
// until now nothing said which model wrote the thing being judged. So
// Joana/Goodness could not have told you "the bad ones are all Kimi" even
// if it were true.
//
// Two things now capture that. This line puts the provider in front of the
// reviewer at the moment they form an opinion, so a "this one's rough" note
// is attributable. And the Learning Log records the same provider next to
// how heavily the draft was edited before sending (see runLearningLoopInner
// in learning_loop.gs), which turns those individual judgements into a
// number per provider.
//
// Same DELETE-THIS-LINE convention as the two notes above, and it sits in
// the same block that gets stripped before sending. Note this note is NOT
// part of what gets logged as the draft text -- logDraftToSheet() stores
// result.draftBody, the model's raw output, so prepending here cannot skew
// the draft-vs-sent comparison the quality metric is built on.
function buildLlmProviderNote(llmProvider) {
  if (!llmProvider) {
    return '[AI MODEL: unknown -- provider could not be determined for this draft. DELETE THIS LINE BEFORE SENDING.]\n\n';
  }
  const label = llmProvider === 'kimi'
    ? 'KIMI (Moonshot kimi-k2.6)'
    : 'ANTHROPIC (Claude Sonnet 5)';
  return '[AI MODEL: ' + label + ' -- part of an active Kimi-vs-Anthropic quality/cost test. ' +
    'If this draft is noticeably better or worse than usual, say which model it was when you flag it. ' +
    'DELETE THIS LINE BEFORE SENDING.]\n\n';
}

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

    // FIX (27 Aug 2026, real risk found in review): if any of these headers
    // is renamed, reordered out, or gains a stray character, indexOf returns
    // -1, row[-1] is undefined, state/link/showName all become '', and
    // EVERY row hits the unlogged `continue` below -- no exception is
    // thrown, so the catch never fires either. The function used to return
    // an empty map completely silently. Two real consequences: every reply
    // drafted falls back to the generic hub invite instead of a
    // state-specific show, and registerNewHubGuestInvites' `if
    // (!matchedShow) return;` means the entire Hub Guest cadence enrolls
    // nobody, with no log line anywhere pointing at this as the cause.
    if (stateCol === -1 || nameCol === -1 || hostCol === -1 || linkCol === -1) {
      Logger.log('WARNING -- State Podcast Show Directory is missing an expected header. Found headers: ' + JSON.stringify(header) + ' (need: state, show name, host, show link). Returning an EMPTY directory -- every state falls back to the generic invite, and Hub Guest enrollment will match nothing, until the header is fixed.');
      return map;
    }

    let skippedIncomplete = 0;
    for (let r = 1; r < values.length; r++) {
      const row = values[r];
      const state = String(row[stateCol] || '').trim();
      const link = String(row[linkCol] || '').trim();
      const showName = String(row[nameCol] || '').trim();
      if (!state || !link || !showName) { skippedIncomplete++; continue; }
      map[normalizeState(state)] = {
        showName: showName,
        host: String(row[hostCol] || '').trim(),
        link: link
      };
    }
    Logger.log('State Podcast Show Directory loaded: ' + Object.keys(map).length + ' state(s), ' + skippedIncomplete + ' row(s) skipped (missing state/show name/link).');
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

// The five AI-* labels this script owns outright -- kept in sync with the
// list setup() creates. NOT the business labels (1./2./3. Spam YES/NO/STOP,
// 0. PRIORITY): those are Joana's, already exist in Gmail, and are
// deliberately only warned about (never auto-created) so a typo in CONFIG
// surfaces as a warning instead of silently creating a near-duplicate label
// beside the real one.
const SELF_OWNED_TRACKING_LABELS = [
  'AI-Drafted-PendingReview',
  'AI-NeedsTeammateRouting',
  'AI-Skipped-AlreadyAnsweredByTeam',
  'AI-Skipped-NotPodcastOutreach',
  'AI-Skipped-AlreadyRepliedOnce',
  'AI-Skipped-Suppressed'
];

// FIX (27 Aug 2026, real incident): CONFIG.LABEL_ALREADY_REPLIED_ONCE was
// added 24 Aug 2026, but the label itself only ever got created by setup(),
// which nobody re-ran afterwards -- so it never existed in Gmail. Every run
// since has logged "Label not found, skipping auto-apply for:
// AI-Skipped-AlreadyRepliedOnce" at startup and then failed to exclude a
// single one of the ~85 threads that hit that path, because both of its
// suppression mechanisms depend on the label (see the call site). Confirmed
// live across two runs 15 minutes apart: identical ~85 threads re-fetched
// and re-searched in full both times.
//
// Auto-create rather than just warn: these labels are this script's own
// bookkeeping, setup() creates them unconditionally anyway, and "someone
// adds a label to CONFIG and forgets to re-run setup()" is precisely the
// failure that just cost a week of runs. Creating it here makes the drafter
// self-healing on the next firing instead of needing a manual step nobody
// knows to take.
function getOrCreateTrackingLabel_(name) {
  const existing = GmailApp.getUserLabelByName(name);
  if (existing) return existing;

  if (SELF_OWNED_TRACKING_LABELS.indexOf(name) === -1) {
    Logger.log('Label not found and NOT auto-created (not a self-owned AI-* tracking label): ' + name);
    return null;
  }

  try {
    const created = GmailApp.createLabel(name);
    Logger.log('Tracking label "' + name + '" did not exist in Gmail -- created it. (setup() in Code.gs creates these too; this run self-healed instead of waiting for someone to re-run it.)');
    return created;
  } catch (e) {
    Logger.log('WARNING: tracking label "' + name + '" does not exist and could not be created: ' + e + '. Threads that would carry it fall back to the skip cache this run, so they are suppressed for ' + SKIP_CACHE_TTL_HOURS + 'h rather than not at all.');
    return null;
  }
}

function extractEmail(fromHeader) {
  const match = fromHeader.match(/<(.+?)>/);
  return (match ? match[1] : fromHeader).toLowerCase().trim();
}

// See CONFIG.HOSTING_PHRASE_PATTERN / CONFIG.PODCAST_OR_SHOW_PATTERN for why
// this is two independent tests ANDed together rather than one ordered regex.
function matchesSubjectPattern_(subject) {
  return CONFIG.HOSTING_PHRASE_PATTERN.test(subject) && CONFIG.PODCAST_OR_SHOW_PATTERN.test(subject);
}

function isInternal(email) {
  return CONFIG.INTERNAL_DOMAINS.some(domain => email.endsWith('@' + domain));
}

// ADDED (27 Aug 2026, real incident): true for the Maildoso sending-alias
// mailboxes that forward lead replies into network@ -- see
// CONFIG.FORWARDING_ALIAS_DOMAINS for the full incident. An alias is never
// the lead and must never be drafted to; its presence as a sender means
// "the real lead is inside the forwarded body, go parse it".
function isForwardingAlias(email) {
  if (!email) return false;
  const e = String(email).toLowerCase().trim();
  return CONFIG.FORWARDING_ALIAS_DOMAINS.some(domain => e.endsWith('@' + domain));
}

// PRIMARY sending-alias detection (27 Aug 2026). A domain allowlist alone
// cannot hold: a live sweep of Joana's mailbox turned up 14 distinct Maildoso
// sending domains and they keep rotating, so any hardcoded list is out of
// date the moment a new mailbox is provisioned -- and being out of date here
// means drafting to an address that bounces.
//
// The structural signal needs no list. Every alias forward looks the same:
// the message is addressed TO the network list (not merely CC-d to it, which
// is what a lead's own reply does) and its body opens with Gmail's forward
// header block. A genuine direct reply from a lead is addressed to Joana with
// network@ on Cc, so it never matches.
//
// Requiring BOTH conditions is what keeps this safe. Checking for a forward
// block alone would misfire constantly, since a lead replying directly quotes
// the whole chain -- forward header included -- in their own reply.
function isForwardedFromSendingAlias_(message, senderEmail) {
  if (isForwardingAlias(senderEmail)) return true;  // known domain -- secondary net
  if (isInternal(senderEmail)) return false;        // a real teammate; isRealTeamReply handles that

  const to = (message.getTo() || '').toLowerCase();
  const addressedToNetwork = CONFIG.REQUIRED_CC_ADDRESSES.some(addr => to.indexOf(addr.toLowerCase()) !== -1);
  if (!addressedToNetwork) return false;

  return /-{3,}\s*Forwarded message\s*-{3,}/i.test(message.getPlainBody());
}

// A lead address must be a real outside human: not the team, not a sending
// alias, not the network list address itself. Used as the last gate before
// an address is treated as a draft recipient.
function isUnmailableAsLead_(email) {
  if (!email) return true;
  const e = String(email).toLowerCase().trim();
  if (isInternal(e)) return true;
  if (isForwardingAlias(e)) return true;
  return CONFIG.REQUIRED_CC_ADDRESSES.some(addr => addr.toLowerCase() === e);
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

// FIX (27 Aug 2026, real incident -- verified by execution, not just
// reading). The old version located the first unquoted "On ... wrote:" line
// and collected everything AFTER it. But in a standard top-posted reply the
// lead's own words are BEFORE that line, and the line right after it is
// "> quoted text", which broke the collector on its very first iteration.
// Verified: run against a real top-posted Gmail reply, this returned "".
// Every consumer -- OPT_OUT_PATTERNS, AUTOREPLY_PATTERNS, the cheap decline
// pre-check, looksLikeBlankOrSignatureOnly_ -- then evaluated an empty
// string, so all of them silently became no-ops, and
// looksLikeBlankOrSignatureOnly_ returned true for EVERY thread -- the exact
// opposite of what it exists to detect.
//
// When there was no "On ... wrote:" line at all (an Outlook-style quote
// header, or a lead's first-ever reply with nothing to quote), the old
// version fell back to returning the WHOLE body, quoted cold-outreach
// footer included. Verified: OPT_OUT_PATTERNS then matched the "Reply STOP
// to unsubscribe" line from OUR OWN quoted outreach email -- text the lead
// never wrote -- and the thread was suppressed permanently.
//
// Now collects the lines BEFORE the first quote marker instead, which is
// where a lead's fresh words actually live, and recognizes the Outlook
// "From:/Sent:/Subject:" quote-header shape as a boundary too, not just
// Gmail's "On ... wrote:" and ">" prefixes.
function extractProspectFreshReplyText(message) {
  const body = message.getPlainBody();
  const lines = body.split('\n');

  const QUOTE_START = /^(On .+wrote:\s*$|-{3,}\s*Forwarded message\s*-{3,}|From\s*:\s|Sent\s*:\s|Subject\s*:\s)/i;

  const freshLines = [];
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('>')) break;
    if (QUOTE_START.test(trimmed)) break;
    freshLines.push(lines[i]);
  }
  return freshLines.join('\n').trim();
}

// FIX (27 Aug 2026, real incident -- verified by execution, not just reading):
// the old approach was one bounded regex per field --
// `From:\s*([^\s<>]+@[^\s<>\n]+)` -- which demands the address be the FIRST
// whitespace-delimited token after "From:". Gmail's own forward header is
// "From: Katie Beaman <katie@beamanrealty.com>" -- the first token is
// "Katie", which has no "@", so the match fails outright. Confirmed live:
// a bare "From: katie@beamanrealty.com" parses; the exact same address with
// a display name in front of it does not. This is very likely the real
// cause behind the 13 Aug comment below recording "144/144 genuine
// unanswered leads failing to parse" -- that was diagnosed as "no true
// forward header exists"; the header exists, the old regex just couldn't
// read it. It also silently defeated the 27 Aug "lead is in the To: line"
// repair, since that fix lived entirely inside `if (forwardMatch)`.
//
// Parses the header block line-by-line into a {from, to, subject, cc} map
// instead of one bounded, order-dependent regex. This removes both the
// display-name blind spot and the fixed-byte-window / fixed-field-order
// assumptions the old regex carried (a long recipient list or an inserted
// Cc/Reply-To line could push a real field past the old {0,200}/{0,400}
// windows or past the old From/Date/Subject/To ordering).
function parseForwardHeaderBlock_(body) {
  const sepMatch = body.match(/-{3,}\s*Forwarded message\s*-{3,}/i);
  if (!sepMatch) return null;

  // The separator's own trailing newline becomes an empty first element
  // when split below -- strip it first so the "blank line ends the header
  // block" check further down doesn't fire immediately on that artifact
  // instead of on a genuine blank line after the real header fields.
  const afterSep = body.slice(sepMatch.index + sepMatch[0].length).replace(/^\r?\n+/, '').split('\n');
  const header = {};
  let lastKey = null;
  const MAX_HEADER_LINES = 20; // safety cap -- a real forward header block is a handful of lines

  for (let i = 0; i < afterSep.length && i < MAX_HEADER_LINES; i++) {
    const line = afterSep[i];
    if (line.trim() === '') break; // blank line -- end of header block, quoted body follows

    const m = line.match(/^\s*(From|Date|Subject|To|Cc|Reply-To)\s*:\s*(.*)$/i);
    if (m) {
      const key = m[1].toLowerCase().replace('-', '');
      if (!(key in header)) header[key] = m[2].trim();
      lastKey = key;
    } else if (lastKey && /^\s+\S/.test(line)) {
      // a wrapped continuation of the previous header value (e.g. a long
      // recipient list), not a new field
      header[lastKey] = (header[lastKey] + ' ' + line.trim()).trim();
    } else {
      break; // not a header line and not a continuation -- header block is over
    }
  }

  return header;
}

function extractForwardedLeadInfo(message) {
  const body = message.getPlainBody();

  // Primary case: a real Gmail/Outlook "Forward" with a header block.
  const header = parseForwardHeaderBlock_(body);
  if (header && header.from) {
    const fromEmail = extractEmail(header.from).toLowerCase().trim();
    const originalSubject = header.subject ? header.subject.trim() : null;

    // FIX (27 Aug 2026, real incident): the forwarded block is not always a
    // lead's INBOUND message. Two real shapes exist on these threads:
    //
    //   From: katie@beamanrealty.com          <- lead's reply, lead is the From
    //   To:   anna.wilson@reachpilotteam.com
    //
    //   From: joana@iconsofrealestate.com     <- our OUTBOUND message, forwarded
    //   To:   officerjenny77@gmail.com           back in; lead is the To
    //
    // Reading From unconditionally returned our own address on the second
    // shape. Combined with the sending-alias bug (see
    // CONFIG.FORWARDING_ALIAS_DOMAINS), that is how a draft ended up
    // addressed to a.palmer@topaustinseo.site and bounced, while the real
    // lead officerjenny77@gmail.com -- right there in the To: line -- got
    // nothing. When the From is one of ours, the lead is the To.
    if (isInternal(fromEmail) || isForwardingAlias(fromEmail)) {
      if (header.to) {
        const toEmail = extractEmail(header.to).toLowerCase().trim();
        if (!isUnmailableAsLead_(toEmail)) {
          return { email: toEmail, originalSubject: originalSubject };
        }
      }
      // Both ends are ours -- an internal forward with no outside party in
      // it. Returning the From here would draft a reply to ourselves.
      return null;
    }

    if (fromEmail.indexOf('@') !== -1) {
      return { email: fromEmail, originalSubject: originalSubject };
    }
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
    // Skip our own quoted lines -- Joana/Sean's (isInternal) and, since
    // 27 Aug 2026, the Maildoso sending aliases, whose "On ... wrote:" lines
    // match this pattern just as readily and are never the lead.
    if (isUnmailableAsLead_(candidateEmail)) continue;

    return {
      email: candidateEmail,
      originalSubject: null // no clean original subject in this format; caller already falls back to `subject` when this is null
    };
  }

  return null;
}

// FIX (27 Aug 2026): the old regex hardcoded the Gmail field order
// (From/Date/Subject/To). An Outlook-order forward (e.g. From/Date/To/
// Subject) or one with an inserted Cc/Reply-To line didn't match at all, so
// the whole header block survived into the draft body -- a duplicated
// forward header pasted above the quoted history in what Joana reviews.
// Strips generically instead: from the separator to the first blank line,
// whatever fields are in between and in whatever order.
function stripForwardHeaderKeepHistory(plainBody) {
  const headerBlock = /-{3,}\s*Forwarded message\s*-{3,}[\s\S]*?\n\s*\n/i;
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

// FIX (26 Aug 2026, real incident -- confirmed via a real header screenshot,
// Kris): the previous "not CC-d to network on last message" check
// (isCcdToNetworkGroup applied to ONLY the last message) was blocking
// essentially every real lead thread. These threads route through
// network@ardorseo.com / network@iconsofrealestate.com as a mailing-list
// address (Gmail shows "mailing list: network@ardorseo.com" on the
// message), not a manual CC a person can drop on Reply -- but a lead's
// own direct reply, or a later message from Joana replying without going
// back through that list address, still won't individually carry it, and
// checking only the LAST message meant one such message permanently
// broke an otherwise-legitimate thread. The original per-message check
// existed to exclude threads that "went private" (team no longer in the
// loop) -- checking the whole thread instead still excludes anything
// network@ never touched at all, it just stops requiring it on literally
// the final message.
function isCcdToNetworkGroupAnywhereInThread(messages) {
  return messages.some(isCcdToNetworkGroup);
}

// UPDATED (25 Aug 2026): bookingLinkOverrideUrl is optional and defaults to
// CONFIG.BOOKING_LINK_URL (Joana's) exactly as before -- every existing
// caller (both follow-up cadences in lead_followup_sequences.gs, neither of
// which has a teammate-handoff concept) keeps working unchanged. Only the
// main reply drafter passes an override, and only for needsTeammateRouting
// drafts -- see runReplyDrafterInner().
function substituteLinkTokens(text, bookingLinkOverrideUrl) {
  return text
    .replace(/\(HUB_LINK\)/g, '(' + CONFIG.HUB_LINK_URL + ')')
    .replace(/\(BOOKING_LINK\)/g, '(' + (bookingLinkOverrideUrl || CONFIG.BOOKING_LINK_URL) + ')');
}

function markdownLinksToHtml(text, bookingLinkOverrideUrl) {
  const withTokensResolved = substituteLinkTokens(text, bookingLinkOverrideUrl);
  const withBold = withTokensResolved.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  const withLinks = withBold.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  return withLinks.replace(/\n/g, '<br>');
}

function markdownLinksToPlain(text, bookingLinkOverrideUrl) {
  const withTokensResolved = substituteLinkTokens(text, bookingLinkOverrideUrl);
  const withLinks = withTokensResolved.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');
  return withLinks.replace(/\*\*([^*]+)\*\*/g, '$1');
}

function threadHasLabel(thread, labelName) {
  return thread.getLabels().some(l => l.getName() === labelName);
}

/**
 * ADDED (20 Aug 2026, real incident): counts real, currently-existing
 * drafts on threads labeled CONFIG.LABEL_AI_DRAFTED, via the Gmail REST
 * API's own drafts.list endpoint (q=label:...) instead of GmailApp -- see
 * the long comment above the MAX_PENDING_DRAFTS_IN_FOLDER check in
 * runReplyDrafterInner() for why GmailApp's own draft-counting methods
 * were unreliable on this account.
 *
 * Paginates fully rather than trusting resultSizeEstimate (which the
 * Gmail API documents as approximate) -- this cap needs an exact count,
 * not an estimate, to mean anything.
 *
 * Returns CONFIG.MAX_PENDING_DRAFTS_IN_FOLDER (i.e. "treat the folder as
 * full") if the API call itself fails, so a transient error can only ever
 * make this run too cautious, never silently permissive -- the exact
 * failure mode behind every prior incident on this check.
 */
// FIX (27 Aug 2026, real risk found in review): fails closed correctly (the
// deliberate, documented direction -- see the incident note below), but used
// to do so with no alert at all. A PERSISTENT failure (a revoked scope, a
// changed API, an expired token edge case) makes every run for the rest of
// time look identical to a legitimately full folder -- "Folder already
// at/over MAX_PENDING_DRAFTS_IN_FOLDER" -- with nothing to distinguish a
// broken API from a folder a human just hasn't reviewed down yet. sendOpsAlert
// already dedupes by subject+day, so this fires at most once per day even
// though countPendingAiDrafts_ is called every 15 minutes. Also capped the
// pagination loop -- a server returning a non-advancing nextPageToken would
// otherwise spin until Apps Script's own execution limit killed it.
function countPendingAiDrafts_() {
  const query = 'label:"' + CONFIG.LABEL_AI_DRAFTED + '"';
  let total = 0;
  let pageToken = null;
  let pages = 0;
  const MAX_PAGES = 50; // 50 x 100 = 5,000 drafts -- far past any real folder size

  try {
    do {
      if (++pages > MAX_PAGES) {
        Logger.log('countPendingAiDrafts_ -- exceeded ' + MAX_PAGES + ' pages without exhausting nextPageToken -- stopping rather than looping to the execution time limit.');
        break;
      }

      let url = 'https://gmail.googleapis.com/gmail/v1/users/me/drafts?q=' + encodeURIComponent(query) + '&maxResults=100';
      if (pageToken) url += '&pageToken=' + encodeURIComponent(pageToken);

      const response = UrlFetchApp.fetch(url, {
        headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
        muteHttpExceptions: true,
      });

      if (response.getResponseCode() !== 200) {
        Logger.log('countPendingAiDrafts_ -- Gmail API call failed (HTTP ' + response.getResponseCode() + '): ' + response.getContentText() + ' -- failing closed (treating folder as full).');
        sendOpsAlert('countPendingAiDrafts_ -- cannot count pending drafts, drafter is blocked',
          'countPendingAiDrafts_ got HTTP ' + response.getResponseCode() + ' from the Gmail drafts.list API. Failing closed, so runReplyDrafter will create ZERO drafts until this is fixed -- and its own log will read exactly like a full folder, not a broken API. Response body: ' + response.getContentText().slice(0, 500));
        return CONFIG.MAX_PENDING_DRAFTS_IN_FOLDER;
      }

      const data = JSON.parse(response.getContentText());
      total += (data.drafts || []).length;
      pageToken = data.nextPageToken || null;
    } while (pageToken);

    return total;
  } catch (e) {
    Logger.log('countPendingAiDrafts_ -- exception: ' + e + ' -- failing closed (treating folder as full).');
    sendOpsAlert('countPendingAiDrafts_ -- cannot count pending drafts, drafter is blocked',
      'countPendingAiDrafts_ threw an exception. Failing closed, so runReplyDrafter will create ZERO drafts until this is fixed. Raw error: ' + e);
    return CONFIG.MAX_PENDING_DRAFTS_IN_FOLDER;
  }
}

// FIXED (25 Aug 2026, real incident -- Gmail quota exhausted mid-run,
// "Service invoked too many times for one day: premium gmail"): called once
// per CANDIDATE THREAD from runReplyDrafterInner()'s main loop, and every
// call re-fetched GmailApp.getDraftMessages() plus .getTo() on every existing
// draft from scratch -- O(threads x drafts already in the folder) real
// Gmail API calls in a single run. With today's higher MAX_PENDING_DRAFTS_IN_FOLDER
// (50) and MAX_DRAFTS_PER_RUN (25), that blew up badly enough to burn through
// the real Google daily quota in one run (confirmed live: 11+ straight
// failures from exactly this function right before the quota error). Added
// an optional precomputedDrafts param so a hot-loop caller can fetch
// GmailApp.getDraftMessages() ONCE for the whole run and pass it in here --
// runReplyDrafterInner() does this now.
//
// CORRECTED (27 Aug 2026, real risk found in review): the claim that used to
// be here -- that the other two call sites "check one lead in isolation, not
// in a per-thread loop" -- was false. Both reconcile_missing_drafts.gs and
// lead_followup_sequences.gs call this from INSIDE a per-thread/per-row loop
// (up to 500 threads and ~215 queue rows respectively), each with no
// precomputedDrafts -- the exact O(threads x drafts) pattern this fix was
// written to eliminate, just in two other files. Both now hoist their own
// GmailApp.getDraftMessages() once per run and pass it in, the same way
// runReplyDrafterInner() does.
// FIX (27 Aug 2026, real risk found in review): the same substring-match bug
// draftAlreadyExistsFor was fixed for on 27 Aug -- `recipients.indexOf(target)
// !== -1`, where a lead like ann@x.com matched a header actually addressed to
// joann@x.com -- was independently present in four other places that each
// parse a raw To/Cc header string looking for one address. Shared here so all
// of them compare parsed addresses instead of doing their own substring test.
function recipientListIncludes_(rawRecipients, targetEmail) {
  const target = String(targetEmail || '').toLowerCase().trim();
  if (!target) return false;
  return String(rawRecipients || '').split(',').some(one => {
    const trimmed = one.trim();
    return trimmed && extractEmail(trimmed) === target;
  });
}

function draftAlreadyExistsFor(leadEmail, precomputedDrafts) {
  const drafts = precomputedDrafts || GmailApp.getDraftMessages();
  const target = leadEmail.toLowerCase().trim();
  let readFailures = 0;
  for (let i = 0; i < drafts.length; i++) {
    try {
      // FIX (27 Aug 2026, real incident): this was a SUBSTRING test --
      // to.indexOf(target) !== -1 -- so any lead address that happens to be a
      // substring of a different draft's recipient matched. ann@x.com matched
      // a draft addressed to joann@x.com; sara@y.com matched tamsara@y.com.
      // The thread was then skipped as "draft already exists" AND that verdict
      // was written to the skip cache for SKIP_CACHE_TTL_HOURS, so a single
      // spurious match suppressed a real lead for six hours at a stretch.
      //
      // This is what diagnoseDraftRecipients() was added on 26 Aug to chase:
      // a run reported "draft already exists" for four unrelated leads against
      // a folder holding one draft. It was read at the time as a human editing
      // drafts mid-run. It was not -- it was this.
      //
      // Compare parsed addresses instead. getTo() returns a comma-separated
      // recipient list which may be either bare addresses or "Name <addr>"
      // form, so split and run each through extractEmail (which handles both).
      const recipients = String(drafts[i].getTo() || '').split(',');
      for (let r = 0; r < recipients.length; r++) {
        const one = recipients[r].trim();
        if (!one) continue;
        if (extractEmail(one) === target) return true;
      }
    } catch (e) {
      Logger.log('Skipped a draft while checking for duplicates (likely being edited/deleted concurrently): ' + e);
      readFailures++;
    }
  }

  // FIX (27 Aug 2026, real risk found in review): every per-draft failure
  // above was swallowed, and the loop fell through to `return false` even
  // when EVERY read failed -- turning a quota/rate-limit error into "no
  // duplicate exists". The project's own incident record notes the 25 Aug
  // quota wall was preceded by repeated instances of the log line above;
  // each one was a false negative, and each one risked a real duplicate
  // draft to a lead who already had one (or, at the reconcile.gs/
  // lead_followup_sequences.gs call sites, a live draft's label being
  // stripped as a false "phantom"). A single concurrently-edited draft
  // (the case this catch names) is still fine to skip quietly -- it's a
  // majority of reads failing that means the data can't be trusted.
  if (drafts.length > 0 && readFailures >= Math.ceil(drafts.length / 2)) {
    throw new Error('draftAlreadyExistsFor: ' + readFailures + '/' + drafts.length +
      ' draft reads failed -- refusing to report "no duplicate exists" on unreliable data.');
  }
  return false;
}

/**
 * ONE-OFF DIAGNOSTIC (26 Aug 2026, real incident) -- run this manually to
 * see exactly what getTo()/getCc()/getSubject() return for every draft
 * currently in the folder. Added because draftAlreadyExistsFor() was
 * matching several clearly-unrelated lead emails against what should be
 * a single draft in the folder -- logging the raw values settles what's
 * actually in there instead of guessing.
 */
function diagnoseDraftRecipients() {
  const drafts = GmailApp.getDraftMessages();
  Logger.log('diagnoseDraftRecipients -- ' + drafts.length + ' draft(s) in the folder.');
  drafts.forEach((d, i) => {
    try {
      Logger.log(
        '[' + i + '] subject=' + JSON.stringify(d.getSubject()) +
        ' to=' + JSON.stringify(d.getTo()) +
        ' cc=' + JSON.stringify(d.getCc()) +
        ' bcc=' + JSON.stringify(d.getBcc())
      );
    } catch (e) {
      Logger.log('[' + i + '] FAILED to read: ' + e);
    }
  });
}

// ADDED (24 Aug 2026, per direct request -- Joana): ground truth for
// "have we ever sent this lead a reply before," checked directly against
// the Sent folder rather than any label or sheet-row state. GmailApp.search
// returning at least one match is enough -- this only needs a yes/no, not
// the actual message.
function hasAlreadySentReplyTo_(leadEmail) {
  return GmailApp.search('in:sent to:"' + leadEmail + '"', 0, 1).length > 0;
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

// ADDED (24 Aug 2026): the cheap half of the two-stage classify. Sends only
// the prospect's own fresh reply text and the subject -- NO SOP -- so this
// call is a few hundred tokens against the ~9k the full call costs.
//
// Returns 'decline' ONLY on an unambiguous decline; 'unsure' or 'other' for
// everything else, including any failure. Every non-'decline' answer means
// "carry on and do the full call", so a broken or unavailable LLM makes this
// gate a no-op rather than a lead-shredder -- the same fail-safe direction
// countPendingAiDrafts_() uses. Note the returned category is NEVER used to
// label or file the thread; the full call remains the only thing that
// classifies for real. This only ever decides whether to spend money.
function looksLikeDeclineCheaply_(replyBody, subject) {
  const text = String(replyBody || '').trim();
  if (!text) return 'unsure'; // nothing to judge -- let the full call decide

  const system = 'You are a strict classifier. You answer with exactly one word and nothing else.';
  const userPrompt = 'Below is a real estate agent\'s reply to a cold email that invited them to host a podcast.\n\n' +
    'Answer with exactly ONE word:\n' +
    '  decline  -- ONLY if this is an unmistakable, final "no". A flat "not interested", "no thanks", "please remove me", "we already have one and are not adding another".\n' +
    '  other    -- anything else at all.\n' +
    '  unsure   -- if you are not certain.\n\n' +
    'CRITICAL: answering "decline" causes this lead to be dropped with no reply written, so the bar is deliberately high. These are NOT declines -- answer "other" for all of them:\n' +
    '  - asking any question at all, however skeptical\n' +
    '  - asking for more information, details, pricing, or examples\n' +
    '  - a timing objection ("not right now", "swamped this month", "ask me next quarter")\n' +
    '  - saying they are busy, travelling, or will get back to you\n' +
    '  - any hint of curiosity or conditional interest\n' +
    'If you feel any pull toward "decline" but could argue the other side, answer "unsure". A wrong "decline" loses a real customer; a wrong "other" costs a fraction of a cent.\n\n' +
    'SUBJECT: ' + String(subject || '') + '\n\nTHEIR REPLY:\n' + text.slice(0, 2000);

  try {
    const data = callLlmWithFallback(system, userPrompt, 16, 'declinePreCheck');
    const block = (data.content || []).find(c => c.type === 'text');
    if (!block) return 'unsure';
    const answer = String(block.text || '').trim().toLowerCase().replace(/[^a-z]/g, '');
    if (answer === 'decline') return 'decline';
    return answer === 'other' ? 'other' : 'unsure';
  } catch (e) {
    // Never let a pre-check failure drop a lead -- fall through to the full
    // call, which is exactly what happened before this gate existed.
    Logger.log('looksLikeDeclineCheaply_ -- pre-check failed (' + e + '), proceeding to the full call as if it had returned "unsure".');
    return 'unsure';
  }
}

// ADDED (25 Aug 2026, per direct request): a pure heuristic, no LLM call --
// unlike looksLikeDeclineCheaply_ above, this can never save a call
// (blank_or_signature_only always gets a real drafted reply per the SOP,
// same as no_decline does now), so there's nothing to gate. What this
// targets instead is a real, documented correctness bug: the SOP's own
// change log (20 Aug 2026) records the model drafting a genuinely blank
// reply (Katie -- a signature block with no actual message) as if it
// expressed interest, fabricating enthusiasm the prospect never showed.
// Detection was left entirely to the model's own read of the thread; this
// hands it an explicit, deterministic signal instead, folded into the user
// prompt as a hint the model can still disagree with -- never a skip,
// never a decision on its own, just a second opinion from a cheaper, more
// literal check than "did the model correctly read a wall of signature
// text as nothing."
//
// DELIBERATELY NARROW: only fires on text that's empty, or short AND has
// none of a sentence's normal markers (no question mark, no ! or ., no
// common reply words). A real terse reply ("Yes!", "No thanks.", "Sounds
// good") reliably has at least one of those; a name/title/phone-number
// signature block reliably has none. Erring toward under-firing here is
// the safe direction -- a missed hint just means the model judges it
// alone, same as it always has; a wrong hint on a genuine reply risks
// steering the model toward Katie's exact mistake, just aimed the other
// way (treating a real reply as if it were nothing).
function looksLikeBlankOrSignatureOnly_(replyBody) {
  const text = String(replyBody || '').trim();
  if (!text) return true; // nothing at all -- unambiguous

  if (text.length > 60) return false; // long enough that it's not a bare signature line
  if (/[?!.]/.test(text)) return false; // has real sentence-ending punctuation

  const commonReplyWords = /\b(yes|yeah|yep|sure|no|nope|not|thanks|thank|sounds|interested|maybe|busy|sorry|ok|okay|please|remove|stop|call|text|works|later|soon|available|schedule)\b/i;
  if (commonReplyWords.test(text)) return false; // reads like an actual response, not just a signature

  // Caught in testing: a real question missing its "?" ("What is this
  // about", "Is this a scam") has none of the signals above but is
  // obviously not a signature block. A leading question word is a real
  // sentence even without terminal punctuation -- casual replies routinely
  // drop it.
  if (/^(who|what|when|where|why|how|is|are|do|does|did|can|could|would|will)\b/i.test(text)) return false;

  return true;
}

// SHARED (25 Aug 2026, real incident, live): both classifyAndDraft() below
// and classifyAndDraftFollowUp() in lead_followup_sequences.gs ask the model
// for an object shaped {...short fields..., draft_body: "..."} with
// draft_body always the LAST field. Confirmed live, 25 Aug 2026 (Erika,
// Nathaniel -- both genuinely interested yes_general replies, both
// needs_teammate_routing=true per the model's own reasoning): the model is
// instructed (Hormozi mode especially) to reproduce SOP close text that is
// itself full of literal double quotes ("Great question! ...", "A lot of
// hosts also bring on a sponsor..."). When it doesn't escape those as \"
// inside the JSON string, strict JSON.parse breaks on the first unescaped
// quote inside draft_body -- discarding an otherwise-correct classification,
// and a genuinely interested lead's reply along with it, for a full 6h
// skip-cache wait before it's even retried.
//
// draft_body being reliably the LAST field means it can be delimited
// structurally -- from its opening quote to the FINAL "} at the end of the
// object -- without needing a general JSON parser to correctly quote-match a
// value that may itself contain unescaped quotes or literal newlines. Every
// other field is swept generically (string or true/false), so this works
// unchanged across both schemas that use it (category/needs_teammate_routing/
// priority/reasoning here; lead_state/action/reasoning in the follow-up
// drafter). Returns null (not a guess) when there's no draft_body match at
// all -- that means something else broke, not this specific quote problem,
// and the caller falls through to its existing failure path.
function unescapeJsonString_(s) {
  return s
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}

function recoverTruncatedDraftJson_(cleanedText) {
  const draftBodyMatch = cleanedText.match(/"draft_body"\s*:\s*"([\s\S]*)"\s*\}\s*$/);
  if (!draftBodyMatch) return null;

  const beforeDraftBody = cleanedText.slice(0, draftBodyMatch.index);
  const result = { draft_body: unescapeJsonString_(draftBodyMatch[1]) };

  const fieldPattern = /"([a-z_]+)"\s*:\s*(?:"((?:[^"\\]|\\.)*)"|(true|false))/gi;
  let m;
  while ((m = fieldPattern.exec(beforeDraftBody)) !== null) {
    const key = m[1];
    if (m[2] !== undefined) {
      result[key] = unescapeJsonString_(m[2]);
    } else {
      result[key] = m[3] === 'true';
    }
  }
  return result;
}

function classifyAndDraft(systemPrompt, subject, threadContext, prospectEmail, state, matchedShow, sopModeOverride, likelyBlankOrSignatureOnly) {
  const candidateVariation = peekNoDeclineVariation();

  const matchedShowBlock = matchedShow
    ? `MATCHED SHOW FOR THIS PROSPECT'S STATE (${state}): "${matchedShow.showName}" hosted by ${matchedShow.host} -- ${matchedShow.link}\nIf this reply is a no_decline, close with EXACTLY this text (verbatim, only substituting {{name}}, {{show}}, {{state}} with the real values -- do not rephrase, shorten, or improvise a different version): "${candidateVariation.text}" -- then add the link on its own, formatted per the SOP's link rules.`
    : `MATCHED SHOW FOR THIS PROSPECT'S STATE: none available${state ? ' (state detected as ' + state + ' but no confirmed show yet in the Directory)' : ' (could not determine state from subject line)'}.\nIf this reply is a no_decline, fall back to the generic guest-network invite per the SOP (the rotation above only applies when a real show match exists).`;

  // ADDED (25 Aug 2026, per direct request): a deterministic second opinion
  // on blank_or_signature_only, folded in as a hint the model can disagree
  // with -- never a skip, never a determination on its own. Real, documented
  // failure this targets (SOP change log, 20 Aug 2026): the model drafted a
  // genuinely blank reply (Katie -- a signature block, no actual message) as
  // if it expressed interest, fabricating enthusiasm the prospect never
  // showed. See looksLikeBlankOrSignatureOnly_() for the (deliberately
  // narrow) heuristic and why a wrong hint here is safe either direction.
  const blankHintBlock = likelyBlankOrSignatureOnly
    ? '\nAUTOMATED HINT (not a determination -- verify against the actual thread content above and use your own judgment): the prospect\'s fresh reply text looks like it may be empty or just a signature block, with no real message. If that\'s accurate, this is blank_or_signature_only per the SOP -- do not treat it as interest.\n'
    : '';

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
${blankHintBlock}
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

  // The mode override goes LAST in the user prompt, not in the system field --
  // see buildSopModeOverride() for why that placement is what makes the SOP
  // prefix cacheable on both providers.
  const userPromptWithMode = userPrompt + (sopModeOverride || '');

  const data = callLlmWithFallback(systemPrompt, userPromptWithMode, 2000, 'classifyAndDraft');

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
  const cleanedText = textBlock.text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try {
    parsed = JSON.parse(cleanedText);
  } catch (e) {
    parsed = recoverTruncatedDraftJson_(cleanedText);
    if (!parsed) {
      Logger.log('Failed to parse LLM JSON response: ' + textBlock.text);
      return null;
    }
    Logger.log('classifyAndDraft -- recovered via fallback parser (likely an unescaped quote in draft_body): ' + subject);
  }

  // ADDED (24 Aug 2026, per direct request): attach real cost-per-draft
  // data using this specific call's own usage, not an average -- see
  // providerFromModel_()/estimateCallCostUsd_() in
  // quota_guard_and_alerting.gs. This is the SAME number already written to
  // the "LLM Cost Log" tab for this call; carrying it here too means it
  // lands directly on the AI Drafts Log row (via logDraftToSheet below)
  // instead of requiring a join between two tabs to answer "cost per draft."
  // UPDATED (24 Aug 2026): prefer the provider stamped on the response by
  // callLlmWithFallback() itself -- it knows which branch it called, so it
  // cannot be wrong. providerFromModel_ stays as the fallback for any path
  // that somehow returns an unstamped body, but it is now an inference from
  // the echoed model string rather than the primary source of truth. Same
  // for cost: reuse the figure already computed and written to the LLM Cost
  // Log for this exact call, so the per-draft column and the cost tab can
  // never disagree about the same call.
  const llmProvider = data._servedByProvider || providerFromModel_(data.model);
  const llmCostUsd = (data._estimatedCostUsd != null)
    ? data._estimatedCostUsd
    : estimateCallCostUsd_(llmProvider, data.usage);

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
    llmProvider: llmProvider,
    llmCostUsd: llmCostUsd,
  };
}

// CACHED (15 Aug 2026): this used to re-fetch the live SOP Doc on EVERY
// runReplyDrafter run (every 5 minutes). Kris only edits the Doc about once a
// day (after reviewing Goodness's feedback), so that was ~288 Doc fetches a
// day for a doc that changes once. Now cached in CacheService for
// SOP_CACHE_TTL_SECONDS. A same-day Doc edit is picked up on the next run
// after the cache expires (max ~6h stale), or immediately via
// clearSopCache().
//
// CORRECTED then IMPLEMENTED (22 Aug 2026): this comment used to claim a
// separate "cache_control: ephemeral" Anthropic prompt-caching mechanism
// already existed on the LLM call itself -- it didn't (checked
// attemptLlmCall_() directly, system was a plain string). That's now fixed
// for real: attemptLlmCall_() in quota_guard_and_alerting.gs sends this SOP
// text as a cache_control: {type: "ephemeral", ttl: "1h"} content block, a
// SEPARATE cache from this Doc-fetch one -- this one avoids re-fetching the
// Google Doc, that one avoids re-billing the full SOP as input tokens on
// every LLM call. See the comment in attemptLlmCall_() for why 1h TTL and
// how to verify it's actually hitting.
const SOP_CACHE_KEY = 'SOP_FULL_TEXT';
// ADDED (25 Aug 2026, per direct request): the cache TTL alone means a real
// Doc edit can serve stale (pre-edit) content to real classify/draft calls
// for up to 6 hours -- confirmed happening today, the Doc was edited twice
// in one session, and the only thing that would have refreshed the cache
// promptly was a human remembering to call clearSopCache() by hand. Stores
// the Doc's own lastUpdated timestamp alongside the cached text, so
// buildSystemPrompt() can cheaply check "did the Doc actually change" via
// DriveApp (already a granted, working scope in this project -- see
// learning_loop.gs) instead of trusting a blind timer. Same TTL as the text
// itself so both entries expire together and never disagree.
const SOP_CACHE_LAST_MODIFIED_KEY = 'SOP_FULL_TEXT_LAST_MODIFIED_ISO';
const SOP_CACHE_TTL_SECONDS = 6 * 60 * 60; // 6 hours (CacheService max)

function clearSopCache() {
  CacheService.getScriptCache().remove(SOP_CACHE_KEY);
  CacheService.getScriptCache().remove(SOP_CACHE_LAST_MODIFIED_KEY);
  Logger.log('SOP cache cleared -- next buildSystemPrompt() call re-fetches the Doc fresh.');
}

function buildSystemPrompt() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get(SOP_CACHE_KEY);
  const cachedLastModifiedIso = cache.get(SOP_CACHE_LAST_MODIFIED_KEY);

  // Only trust the cached text once we've confirmed the Doc hasn't changed
  // since we fetched it -- cachedLastModifiedIso being missing (e.g. right
  // after this code first deploys, or an old cache entry from before this
  // fix existed) falls through to a real fetch rather than guessing it's
  // still fresh.
  if (cached && cached.trim().length > 200 && cachedLastModifiedIso) {
    try {
      const liveLastModifiedIso = DriveApp.getFileById(CONFIG.SOP_DOC_ID).getLastUpdated().toISOString();
      if (liveLastModifiedIso === cachedLastModifiedIso) {
        Logger.log('SOP loaded from cache (' + cached.length + ' chars, confirmed unchanged since last fetch).');
        return cached;
      }
      Logger.log('SOP Doc has changed since the cached copy was fetched (was ' + cachedLastModifiedIso + ', now ' + liveLastModifiedIso + ') -- re-fetching instead of serving a stale cache.');
    } catch (driveErr) {
      // Can't check freshness -- that's a reason to fall back to what we
      // have, not a reason to force an unrelated re-fetch. Same
      // fail-safe-toward-the-cheaper-path shape as the rest of this file.
      Logger.log('SOP cache freshness check failed (' + driveErr + ') -- using cached text anyway.');
      return cached;
    }
  }

  try {
    const doc = DocumentApp.openById(CONFIG.SOP_DOC_ID);
    const rawText = doc.getBody().getText();
    // TRIMMED (25 Aug 2026, per direct request): buildSystemPrompt() used to
    // return the ENTIRE Doc body, including the "## FOLLOW-UP DRAFTING" and
    // "## Change log" sections -- real, sizeable chunks of the Doc (roughly a
    // fifth to a quarter of it) with zero bearing on drafting an initial
    // reply. FOLLOW-UP DRAFTING is only ever consumed by
    // buildFollowUpSystemPrompt() in lead_followup_sequences.gs, which does
    // its OWN separate DocumentApp fetch and extracts just that section by
    // heading -- this trim doesn't touch that path at all. Change log has no
    // code consumer anywhere; it's pure human documentation of past edits.
    //
    // Cutting them here, not from the Doc itself: both stay fully intact and
    // readable in the live Doc (Change log's whole point is a human audit
    // trail; deleting it for real, unlike the two genuinely-dead sections
    // removed earlier today, would destroy real value). This only changes
    // what gets sent to the LLM as billed input tokens on every single
    // classifyAndDraft call -- the same section is still there for a human
    // reading the Doc directly, and still there for the follow-up drafter's
    // own extraction.
    //
    // FOLLOW-UP DRAFTING is confirmed to be followed only by Change log, to
    // the end of the document (both real, both dead weight for this path) --
    // truncating everything from that heading onward removes both in one cut.
    // Same heading-match pattern buildFollowUpSystemPrompt() already uses,
    // for the same reason: don't rename or delete that heading in the Doc.
    // If the heading isn't found (Doc restructured unexpectedly), fail open --
    // return the full text rather than silently guessing where to cut.
    const followUpHeadingMatch = rawText.match(/^##\s*FOLLOW-UP DRAFTING\b[^\n]*$/im);
    const text = followUpHeadingMatch
      ? rawText.slice(0, followUpHeadingMatch.index).trim()
      : rawText;
    if (!followUpHeadingMatch) {
      Logger.log('WARNING: "## FOLLOW-UP DRAFTING" heading not found in SOP Doc -- sending the full text uncut (includes FOLLOW-UP DRAFTING/Change log sections this path doesn\'t need). Check the Doc structure.');
    }
    if (text && text.trim().length > 200) {
      try {
        cache.put(SOP_CACHE_KEY, text, SOP_CACHE_TTL_SECONDS);
        // Best-effort -- if this specific call fails, the text cache above
        // still succeeded and still serves real savings; the next call just
        // won't find a lastModifiedIso, so it re-fetches and tries again
        // instead of ever trusting an unconfirmed cache entry as fresh.
        try {
          const liveLastModifiedIso = DriveApp.getFileById(CONFIG.SOP_DOC_ID).getLastUpdated().toISOString();
          cache.put(SOP_CACHE_LAST_MODIFIED_KEY, liveLastModifiedIso, SOP_CACHE_TTL_SECONDS);
        } catch (driveErr) {
          Logger.log('Could not record SOP Doc lastUpdated for freshness checks (non-fatal): ' + driveErr);
        }
        Logger.log('SOP fetched from Doc and cached (' + text.length + ' chars, trimmed from ' + rawText.length + ').');
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

  // FIX (27 Aug 2026, real risk found in review): both failure paths above
  // used to fall through to this stub with only a Logger.log line. Real
  // Gmail drafts get created for real leads from this ~60-word fallback
  // instead of the actual SOP -- they look completely normal to a reviewer
  // and are one click from being sent, off-SOP. sendOpsAlert dedupes by
  // subject+day, so this fires at most once per day even though
  // buildSystemPrompt runs on every classifyAndDraft call.
  sendOpsAlert('SOP Doc unreadable -- drafts are using the fallback prompt',
    'buildSystemPrompt() could not get a usable SOP from CONFIG.SOP_DOC_ID this run (see the execution log for the specific reason -- unreadable Doc, or suspiciously short body). Every draft created until this is fixed is written from a ~60-word stub, not the real SOP, and will look normal in the Drafts folder. Check that the Doc is still shared with this script and has real content.');

  return `You are drafting email replies for Joana Peixe, Podcast Network Manager at Icons of Real Estate, replying to real estate agents who received a cold outreach inviting them to host a regional podcast. The full SOP could not be loaded from its Doc this run, so: keep replies warm, first-name, brief, never mention you are an AI, never state a dollar figure, and for a clear decline just thank them for their time and wish them continued success without pitching further.`;
}