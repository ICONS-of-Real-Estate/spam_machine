/**
 * EMOJI RAW BYTE DIAGNOSTIC — one-off debugging tool used 28 Jul 2026 to
 * trace the emoji corruption bug. Kept for reference; not part of the
 * regular running system, no trigger needed.
 * ---------------------------------------------------------------------------
 * Purpose: isolate exactly WHERE the emoji corruption happens. This makes a
 * tiny API call asking Claude to output ONLY the two emoji in question, then
 * logs the actual Unicode code points of what comes back -- completely
 * bypassing markdownLinksToHtml, sanitizeEmojiForGmail, GmailApp.createDraft,
 * and everything else in the normal pipeline.
 *
 * CONCLUSION FROM THAT SESSION: the raw API response was always correct.
 * The actual corruption was traced to GmailApp.createDraft() itself, fixed
 * via HTML numeric entity conversion (see emojiToHtmlEntities in Code.gs).
 *
 * Paste this as a new file, select "runEmojiRawByteTest" in the function
 * dropdown, click Run, then check the Execution log, if ever needed again.
 */

function runEmojiRawByteTest() {
  const props = PropertiesService.getScriptProperties();
  const apiKey = props.getProperty('ANTHROPIC_API_KEY');
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY not set in Script Properties.');
  }

  const payload = {
    model: CONFIG.MODEL,
    max_tokens: 50,
    messages: [{
      role: 'user',
      content: 'Output ONLY these two emoji characters, nothing else, no words: a studio microphone emoji followed immediately by a sparkles emoji.'
    }]
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

  Logger.log('--- RAW BYTE DIAGNOSTIC ---');
  Logger.log('HTTP status: ' + response.getResponseCode());

  const rawTextNoCharset = response.getContentText();
  Logger.log('Raw response text (no charset specified): ' + rawTextNoCharset);

  const rawTextUtf8 = response.getContentText('UTF-8');
  Logger.log('Raw response text (explicit UTF-8): ' + rawTextUtf8);

  const data = JSON.parse(rawTextUtf8);
  const textBlock = data.content.find(c => c.type === 'text');
  if (!textBlock) {
    Logger.log('No text block found. Full response: ' + JSON.stringify(data));
    return;
  }

  const emojiText = textBlock.text;
  Logger.log('Claude returned this text: "' + emojiText + '"');
  Logger.log('Character-by-character breakdown:');

  let i = 0;
  for (const char of emojiText) {
    const codePoint = char.codePointAt(0);
    Logger.log('  [' + i + '] code point: ' + codePoint + ' (hex: 0x' + codePoint.toString(16).toUpperCase() + ')');
    i++;
  }

  Logger.log('--- END DIAGNOSTIC ---');
}
