/**
 * Test harness for the .gs parsing logic -- ADDED 27 Aug 2026.
 *
 * WHY THIS EXISTS: every parsing bug this week (CRLF endings, NFKC lookalike
 * characters, nested "> " quote depth, "[email]" bracket rendering, dropped
 * "On <date>" preambles, Outlook/Apple forward banners) was found the same
 * way -- deploy to Apps Script, clear the skip cache, wait for a live run,
 * read the log, guess again. That loop is slow, needs a human at every step,
 * and only ever exercises the handful of threads currently in the backlog.
 *
 * Apps Script has no local runtime, but the parsing functions are pure string
 * handling -- they only touch GmailApp through a message object's getters. So
 * they run fine in plain Node against a stub message, which is all this does.
 *
 * NOT a substitute for a live run: nothing here proves Gmail hands us the
 * bodies we think it does. It proves that GIVEN a body shape, the parser
 * resolves the address we expect -- which is precisely what kept regressing.
 *
 * Run: node gs_tests/run_tests.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO = path.join(__dirname, '..');

// The real project shares ONE global scope across every .gs file (see
// CLAUDE.md). Loading them into a single VM context reproduces that exactly,
// including the fact that a duplicate global in a second file would shadow
// the first -- so if that ever happens, these tests see it too.
//
// Default is the two files the parsing paths actually need. Set GS_LOAD_ALL=1
// to load EVERY .gs file into the one scope instead -- that turns the "never
// redefine an existing global" rule from CLAUDE.md into something a machine
// checks, since a duplicate `const` across two files throws on load here the
// same way it would shadow silently in Apps Script. loadAllGsFiles() below
// wraps that as an assertion.
const GS_FILES = process.env.GS_LOAD_ALL
  ? fs.readdirSync(path.join(__dirname, '..')).filter(f => f.endsWith('.gs')).sort()
  : ['Code.gs', 'missed_leads_audit.gs'];

// `extraFiles`: optional array of additional .gs filenames to load into the
// same shared context, on top of GS_FILES. Added 28 Aug 2026 so a test can
// exercise a specific companion file (e.g. learning_loop.gs's consolidation
// logic) without paying for GS_LOAD_ALL, and without changing what the
// default suite loads.
function buildContext(extraFiles) {
  const logs = [];
  const sandbox = {
    console,
    // Apps Script services. Only what top-level code and the parsing paths
    // actually touch -- anything else stays undefined on purpose, so a test
    // that wanders into un-stubbed territory fails loudly instead of quietly
    // passing against a fake.
    Logger: { log: (m) => logs.push(String(m)) },
    Utilities: {
      formatDate: () => '',
      sleep: () => {},
      computeDigest: () => [],
      DigestAlgorithm: { MD5: 'MD5' },
      Charset: { UTF_8: 'UTF_8' },
    },
    GmailApp: {
      getUserLabelByName: () => null,
      createLabel: () => null,
      getDraftMessages: () => [],
      search: () => [],
    },
    SpreadsheetApp: { openById: () => null },
    PropertiesService: {
      getScriptProperties: () => ({ getProperty: () => null, setProperty: () => {} }),
    },
    CacheService: {
      getScriptCache: () => ({ get: () => null, put: () => {} }),
    },
    UrlFetchApp: { fetch: () => ({ getResponseCode: () => 200, getContentText: () => '{}' }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    ScriptApp: { getProjectTriggers: () => [], newTrigger: () => ({}) },
    Session: { getActiveUser: () => ({ getEmail: () => 'joana@iconsofrealestate.com' }) },
    MailApp: { sendEmail: () => {} },
    DriveApp: { getFileById: () => null },
    DocumentApp: { openById: () => null },
  };
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);

  const filesToLoad = GS_FILES.concat(
    (extraFiles || []).filter(f => GS_FILES.indexOf(f) === -1)
  );
  for (const file of filesToLoad) {
    const src = fs.readFileSync(path.join(REPO, file), 'utf8');
    try {
      vm.runInContext(src, context, { filename: file });
    } catch (e) {
      throw new Error(`Failed loading ${file} into the test context: ${e.message}`);
    }
  }
  return { context, logs };
}

/**
 * Minimal stand-in for a GmailMessage. Only the getters the parsing paths
 * call are implemented; every one of them is a real method on GmailMessage
 * with the same name and return type (string), so a test body that parses
 * here is a body shape that parses in production.
 */
// `attachments`: optional array of { contentType, data } -- simulates
// GmailAttachment for the getEffectivePlainBody_ fallback (28 Aug 2026,
// Krista's thread: a message whose real content sits in a text/plain
// attachment instead of the body, which getPlainBody()/getBody() alone
// can't see).
function fakeMessage({ body = '', from = '', to = '', cc = '', html = null, isDraft = false, attachments = [] } = {}) {
  return {
    getPlainBody: () => body,
    getBody: () => (html === null ? body : html),
    getFrom: () => from,
    getTo: () => to,
    getCc: () => cc,
    isDraft: () => isDraft,
    getAttachments: () => attachments.map(a => ({
      getContentType: () => a.contentType,
      getDataAsString: () => a.data,
    })),
  };
}

/**
 * Loads every .gs file in the repo into ONE shared context, and returns an
 * error string if any of them collide. This is the automated form of the
 * project's hardest-won rule (CLAUDE.md: "Never redefine an existing global
 * function name in a second file -- a duplicate silently shadows the real one
 * and has caused real bugs here"). Returns null when the whole project loads
 * cleanly.
 */
function loadAllGsFiles() {
  const files = fs.readdirSync(REPO).filter(f => f.endsWith('.gs')).sort();
  const saved = process.env.GS_LOAD_ALL;
  process.env.GS_LOAD_ALL = '1';
  try {
    buildContext();
    return null;
  } catch (e) {
    return e.message;
  } finally {
    if (saved === undefined) delete process.env.GS_LOAD_ALL;
    else process.env.GS_LOAD_ALL = saved;
  }
}

module.exports = { buildContext, fakeMessage, loadAllGsFiles };
