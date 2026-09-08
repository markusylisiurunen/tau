DELETE FROM entries_fts WHERE session_id = 'local-history-demo';
DELETE FROM sessions_fts WHERE session_id = 'local-history-demo';
DELETE FROM entries WHERE session_id = 'local-history-demo';
DELETE FROM attributes WHERE session_id = 'local-history-demo';
DELETE FROM sessions WHERE session_id = 'local-history-demo';

INSERT INTO sessions (
  session_id,
  attributes_json,
  created_at,
  updated_at,
  digest_title,
  digest_summary,
  digest_through_entry_id
) VALUES (
  'local-history-demo',
  '{"repository":"github.com/markusylisiurunen/tau","source":"tui","environment":"local development","branch":"history-web-view"}',
  1787673600000,
  1787673930000,
  'Refine the private history viewer',
  'The conversation iterates on a minimal dark monospace history viewer, inspects the Worker implementation, and verifies the focused history tests after updating its controls and tool presentation.',
  'demo-image-response'
);
INSERT INTO attributes (session_id, key, value) VALUES
  ('local-history-demo', 'repository', 'github.com/markusylisiurunen/tau'),
  ('local-history-demo', 'source', 'tui'),
  ('local-history-demo', 'environment', 'local development'),
  ('local-history-demo', 'branch', 'history-web-view');
INSERT INTO entries (session_id, position, entry_id, timestamp, payload_json, search_text) VALUES
  (
    'local-history-demo', 1, 'demo-user-1', 1787673600000,
    '{"id":"demo-user-1","sourceIds":["demo-user-1"],"type":"user","timestamp":1787673600000,"content":"Make the private history viewer feel like a minimal technical UI. Keep it dark, monospace, and easy to scan."}',
    'Make the private history viewer feel like a minimal technical UI. Keep it dark, monospace, and easy to scan.'
  ),
  (
    'local-history-demo', 2, 'demo-assistant-1', 1787673630000,
    '{"id":"demo-assistant-1","sourceIds":["demo-assistant-1"],"type":"assistant","timestamp":1787673630000,"content":"I will inspect the current renderer and reduce the visual system to a small set of reusable variables."}',
    'I will inspect the current renderer and reduce the visual system to a small set of reusable variables.'
  ),
  (
    'local-history-demo', 3, 'demo-tool-read', 1787673660000,
    '{"id":"demo-tool-read","sourceIds":["demo-tool-read"],"type":"tool","timestamp":1787673660000,"name":"bash","arguments":{"command":"sed -n ''760,1040p'' src/history/worker/index.ts","workingDirectory":"/Users/example/Code/tau"},"result":"Rendered the viewer functions and shared CSS variables.","outcome":"succeeded"}',
    'bash sed viewer functions shared CSS variables succeeded'
  ),
  (
    'local-history-demo', 4, 'demo-assistant-2', 1787673690000,
    '{"id":"demo-assistant-2","sourceIds":["demo-assistant-2"],"type":"assistant","timestamp":1787673690000,"content":"The page now uses 14px system monospace text, three text tones, an 8px spacing grid, and compact bordered transcript cards."}',
    'The page now uses 14px system monospace text, three text tones, an 8px spacing grid, and compact bordered transcript cards.'
  ),
  (
    'local-history-demo', 5, 'demo-user-2', 1787673720000,
    '{"id":"demo-user-2","sourceIds":["demo-user-2"],"type":"user","timestamp":1787673720000,"content":"Add repository and source filters, then run the focused tests."}',
    'Add repository and source filters, then run the focused tests.'
  ),
  (
    'local-history-demo', 6, 'demo-tool-test', 1787673750000,
    '{"id":"demo-tool-test","sourceIds":["demo-tool-test"],"type":"tool","timestamp":1787673750000,"name":"bash","arguments":{"command":"npx vitest run test/history.test.js --reporter=dot"},"result":"Test Files  1 passed (1)\nTests  49 passed (49)\nDuration  1.49s","outcome":"succeeded"}',
    'bash vitest history tests 49 passed succeeded'
  ),
  (
    'local-history-demo', 7, 'demo-tool-failed', 1787673780000,
    '{"id":"demo-tool-failed","sourceIds":["demo-tool-failed"],"type":"tool","timestamp":1787673780000,"name":"bash","arguments":{"command":"npm run nonexistent-check"},"result":"npm error Missing script: nonexistent-check","outcome":"failed"}',
    'bash npm missing script nonexistent-check failed'
  ),
  (
    'local-history-demo', 8, 'demo-final', 1787673840000,
    '{"id":"demo-final","sourceIds":["demo-final"],"type":"assistant","timestamp":1787673840000,"content":{"type":"text","text":"The viewer controls are updated. The successful and failed tool cards demonstrate both outcomes, and all real transcript content remains escaped as plain text."}}',
    'The viewer controls are updated. Successful and failed tool cards demonstrate outcomes. Transcript content remains escaped as plain text.'
  ),
  (
    'local-history-demo', 9, 'demo-user-image', 1787673870000,
    '{"id":"demo-user-image","sourceIds":["demo-user-image"],"type":"user","timestamp":1787673870000,"content":[{"type":"text","text":"This screenshot shows the copy control taking too much space. Make it compact without losing keyboard accessibility."},{"type":"image","mimeType":"image/png","data":"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="}]}',
    'This screenshot shows the copy control taking too much space. Make it compact without losing keyboard accessibility. image png'
  ),
  (
    'local-history-demo', 10, 'demo-tool-blocked', 1787673900000,
    '{"id":"demo-tool-blocked","sourceIds":["demo-tool-blocked"],"type":"tool","timestamp":1787673900000,"name":"bash","arguments":{"command":"git reset --hard HEAD~1"},"result":"Destructive operation requires explicit confirmation.","outcome":"blocked"}',
    'bash git reset hard destructive operation requires confirmation blocked'
  ),
  (
    'local-history-demo', 11, 'demo-image-response', 1787673930000,
    '{"id":"demo-image-response","sourceIds":["demo-image-response"],"type":"assistant","timestamp":1787673930000,"content":"The screenshot is now represented as an image attachment, while Markdown copies use a compact [image image/png] marker instead of embedding base64 data."}',
    'The screenshot is now represented as an image attachment while Markdown copies use a compact image marker instead of embedding base64 data.'
  );
INSERT INTO entries_fts (session_id, entry_id, position, text)
SELECT session_id, entry_id, position, search_text FROM entries WHERE session_id = 'local-history-demo';
INSERT INTO sessions_fts (session_id, title, summary) VALUES (
  'local-history-demo',
  'Refine the private history viewer',
  'The conversation iterates on a minimal dark monospace history viewer, inspects the Worker implementation, and verifies the focused history tests after updating its controls and tool presentation.'
);
