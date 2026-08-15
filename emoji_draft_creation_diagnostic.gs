/**
 * EMOJI DIAGNOSTIC, ROUND 3 — one-off debugging tool used 28 Jul 2026.
 * Kept for reference; not part of the regular running system.
 * ---------------------------------------------------------------------------
 * The last remaining suspect. Both prior tests proved the string is 100%
 * correct all the way up to and including the second JSON.parse. The only
 * thing left untested was GmailApp.createDraft() itself. This creates one
 * throwaway draft with nothing in it but the two emoji, hardcoded directly
 * in the script (no API call, no JSON parsing).
 *
 * CONCLUSION FROM THAT SESSION: confirmed GmailApp.createDraft() was the
 * actual corruption point. The RAW line broke; the HTML-entity-converted
 * line rendered correctly. This is why Code.gs's emojiToHtmlEntities()
 * function exists -- this test is what proved it works.
 *
 * Paste as a new file, select "runEmojiDraftCreationTest", run, then check
 * the resulting draft (subject "EMOJI TEST ROUND 2 -- DELETE ME"). Delete
 * the test draft afterward -- it's not a real lead.
 */

function runEmojiDraftCreationTest() {
  const testBody = 'TEST PLAIN: \u{1F399}\uFE0F\u2728 (raw characters, expect this one broken)';

  function emojiToHtmlEntities(text) {
    let result = '';
    for (const char of text) {
      const cp = char.codePointAt(0);
      result += cp > 0xFFFF ? '&#' + cp + ';' : char;
    }
    return result;
  }

  const testHtmlRaw = 'TEST HTML RAW: \u{1F399}\uFE0F\u2728 (raw characters in htmlBody, expect broken)';
  const testHtmlEntities = emojiToHtmlEntities('TEST HTML ENTITIES: \u{1F399}\uFE0F\u2728 (HTML entity workaround, hoping this one works)');

  Logger.log('HTML entity version of the test string: ' + testHtmlEntities);

  const draft = GmailApp.createDraft(
    Session.getActiveUser().getEmail(),
    'EMOJI TEST ROUND 2 -- DELETE ME',
    testBody,
    { htmlBody: testHtmlRaw + '<br><br>' + testHtmlEntities }
  );

  Logger.log('Draft created. Check it in Gmail -- compare the RAW line (expect broken) against the ENTITIES line (hoping for correct emoji).');
  Logger.log('Draft ID: ' + draft.getId());
}
