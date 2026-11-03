DELETE FROM entries_fts WHERE session_id LIKE 'local-history-%';
DELETE FROM sessions_fts WHERE session_id LIKE 'local-history-%';
DELETE FROM entries WHERE session_id LIKE 'local-history-%';
DELETE FROM attributes WHERE session_id LIKE 'local-history-%';
DELETE FROM sessions WHERE session_id LIKE 'local-history-%';

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

INSERT INTO sessions (
  session_id,
  attributes_json,
  created_at,
  updated_at,
  parent_session_id,
  digest_title,
  digest_summary,
  digest_through_entry_id
) VALUES
  (
    'local-history-demo-renderer',
    '{"source":"subagent"}',
    1787673640000,
    1787673680000,
    'local-history-demo',
    'Inspect the viewer renderer',
    'A worker reads the Worker renderer and reports which styles can move into shared variables.',
    'renderer-assistant'
  ),
  (
    'local-history-demo-contrast',
    '{"source":"subagent"}',
    1787673650000,
    1787673670000,
    'local-history-demo-renderer',
    'Check muted text contrast against the dark background of the transcript cards',
    'A nested worker measures the contrast of the muted and dim text tones.',
    'contrast-assistant'
  ),
  (
    'local-history-demo-tests',
    '{"source":"subagent"}',
    1787673740000,
    1787673760000,
    'local-history-demo',
    NULL,
    NULL,
    NULL
  ),
  (
    'local-history-orphan',
    '{"source":"subagent"}',
    1787673000000,
    1787673100000,
    'local-history-parent-not-replicated',
    'Review a worker whose parent is missing',
    'This worker reached the history service before its parent session did.',
    'orphan-assistant'
  );
INSERT INTO entries (session_id, position, entry_id, timestamp, payload_json, search_text) VALUES
  (
    'local-history-demo-renderer', 1, 'renderer-user', 1787673640000,
    '{"id":"renderer-user","sourceIds":["renderer-user"],"type":"user","timestamp":1787673640000,"content":"Read the viewer renderer and list the styles that repeat."}',
    'Read the viewer renderer and list the styles that repeat.'
  ),
  (
    'local-history-demo-renderer', 2, 'renderer-assistant', 1787673680000,
    '{"id":"renderer-assistant","sourceIds":["renderer-assistant"],"type":"assistant","timestamp":1787673680000,"content":"Spacing and text tones repeat across the cards, so both can move into shared variables."}',
    'Spacing and text tones repeat across the cards, so both can move into shared variables.'
  ),
  (
    'local-history-demo-contrast', 1, 'contrast-user', 1787673650000,
    '{"id":"contrast-user","sourceIds":["contrast-user"],"type":"user","timestamp":1787673650000,"content":"Measure the contrast of the muted and dim text tones."}',
    'Measure the contrast of the muted and dim text tones.'
  ),
  (
    'local-history-demo-contrast', 2, 'contrast-assistant', 1787673670000,
    '{"id":"contrast-assistant","sourceIds":["contrast-assistant"],"type":"assistant","timestamp":1787673670000,"content":"Both tones stay above 4.5:1 on the background and on the card surface."}',
    'Both tones stay above 4.5:1 on the background and on the card surface.'
  ),
  (
    'local-history-demo-tests', 1, 'tests-user', 1787673740000,
    '{"id":"tests-user","sourceIds":["tests-user"],"type":"user","timestamp":1787673740000,"content":"Run the focused history tests."}',
    'Run the focused history tests.'
  ),
  (
    'local-history-orphan', 1, 'orphan-assistant', 1787673100000,
    '{"id":"orphan-assistant","sourceIds":["orphan-assistant"],"type":"assistant","timestamp":1787673100000,"content":"The parent session has not been replicated."}',
    'The parent session has not been replicated.'
  );
INSERT INTO entries_fts (session_id, entry_id, position, text)
SELECT session_id, entry_id, position, search_text FROM entries
WHERE session_id IN ('local-history-demo-renderer', 'local-history-demo-contrast', 'local-history-demo-tests', 'local-history-orphan');
INSERT INTO sessions_fts (session_id, title, summary)
SELECT session_id, digest_title, digest_summary FROM sessions
WHERE session_id IN ('local-history-demo-renderer', 'local-history-demo-contrast', 'local-history-orphan');

-- A chain deeper than the tree limit and a parent with more children than the limit.
INSERT INTO sessions (session_id, attributes_json, created_at, updated_at, parent_session_id, digest_title, digest_summary, digest_through_entry_id)
WITH RECURSIVE chain(level) AS (
  SELECT 0 UNION ALL SELECT level + 1 FROM chain WHERE level < 10
)
SELECT
  'local-history-deep-' || level,
  '{"source":"subagent"}',
  1787670000000 + level,
  1787670000000 + level,
  CASE WHEN level = 0 THEN NULL ELSE 'local-history-deep-' || (level - 1) END,
  'Deep tree level ' || level,
  'Fixture session at level ' || level || ' of a deep tree.',
  'none'
FROM chain;
INSERT INTO sessions (session_id, attributes_json, created_at, updated_at, parent_session_id, digest_title, digest_summary, digest_through_entry_id)
WITH RECURSIVE wide(position) AS (
  SELECT 0 UNION ALL SELECT position + 1 FROM wide WHERE position < 205
)
SELECT
  'local-history-wide-' || position,
  '{"source":"subagent"}',
  1787660000000 + position,
  1787660000000 + position,
  CASE WHEN position = 0 THEN NULL ELSE 'local-history-wide-0' END,
  CASE WHEN position = 0 THEN 'Wide tree root' ELSE 'Wide tree child ' || position END,
  'Fixture session ' || position || ' of a wide tree.',
  'none'
FROM wide;

INSERT INTO attributes (session_id, key, value)
SELECT session_id, 'source', 'subagent' FROM sessions
WHERE session_id LIKE 'local-history-%' AND session_id <> 'local-history-demo';
INSERT INTO sessions_fts (session_id, title, summary)
SELECT session_id, digest_title, digest_summary FROM sessions
WHERE session_id LIKE 'local-history-deep-%' OR session_id LIKE 'local-history-wide-%';
