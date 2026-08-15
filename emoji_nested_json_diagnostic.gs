/**
 * EMOJI DIAGNOSTIC, ROUND 2 — one-off debugging tool used 28 Jul 2026.
 * Kept for reference; not part of the regular running system.
 * ---------------------------------------------------------------------------
 * Tests the specific step the first test didn't cover: the real pipeline
 * asks Claude to return a JSON OBJECT (with draft_body as one of the
 * fields), then parses THAT JSON string a second time to pull draft_body
 * out. This replicates the real shape exactly.
 *
 * CONCLUSION FROM THAT SESSION: both before and after the second parse,
 * character codes were correct. The corruption was NOT here either --
 * traced further to GmailApp.createDraft() itself.
 *
 * Paste as a new file, select "runEmojiNestedJsonTest", run, check the log.
 */

function runEmojiNestedJsonTest() {
  const props = PropertiesService.getScriptProperties();
  const apiKey = props.getProperty('ANTHROPIC_API_KEY');
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY not set in Script Properties.');
  }

  const payload = {
    model: CONFIG.MODEL,
    max_tokens: 200,
    messages: [{
      role: 'user',
      content: 'Return ONLY a JSON object, no markdown fences, no preamble, with this exact shape: {"draft_body": "a studio microphone emoji followed immediately by a sparkles emoji, nothing else"}. Put the actual emoji characters themselves in the draft_body value, not a text description of them.'
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

  Logger.log('--- NESTED JSON DIAGNOSTIC ---');

  const outerData = JSON.parse(response.getContentText('UTF-8'));
  const textBlock = outerData.content.find(c => c.type === 'text');
  if (!textBlock) {
    Logger.log('No text block found. Full response: ' + JSON.stringify(outerData));
    return;
  }

  Logger.log('Raw inner text BEFORE second JSON.parse: ' + textBlock.text);
  Logger.log('Character codes of raw inner text:');
  let i = 0;
  for (const char of textBlock.text) {
    const cp = char.codePointAt(0);
    Logger.log('  [' + i + '] ' + cp + ' (0x' + cp.toString(16).toUpperCase() + ')');
    i++;
  }

  let parsed;
  try {
    parsed = JSON.parse(textBlock.text.trim());
  } catch (e) {
    Logger.log('Second JSON.parse FAILED: ' + e);
    return;
  }

  Logger.log('draft_body AFTER second JSON.parse: ' + parsed.draft_body);
  Logger.log('Character codes of draft_body AFTER second parse:');
  i = 0;
  for (const char of parsed.draft_body) {
    const cp = char.codePointAt(0);
    Logger.log('  [' + i + '] ' + cp + ' (0x' + cp.toString(16).toUpperCase() + ')');
    i++;
  }

  Logger.log('--- END DIAGNOSTIC ---');
}
