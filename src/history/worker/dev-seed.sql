INSERT OR IGNORE INTO sessions (
  session_id,
  attributes_json,
  created_at,
  updated_at,
  digest_title,
  digest_summary,
  digest_through_entry_id
) VALUES (
  'local-history-demo',
  '{"repository":"github.com/markusylisiurunen/tau","source":"tui","environment":"local development"}',
  1787673600000,
  1787673660000,
  'Local history viewer',
  'A fixture conversation for developing the private read-only history UI.',
  'demo-tool'
);
INSERT OR IGNORE INTO attributes (session_id, key, value) VALUES
  ('local-history-demo', 'repository', 'github.com/markusylisiurunen/tau'),
  ('local-history-demo', 'source', 'tui'),
  ('local-history-demo', 'environment', 'local development');
INSERT OR IGNORE INTO entries (
  session_id,
  position,
  entry_id,
  timestamp,
  payload_json,
  search_text
) VALUES
  (
    'local-history-demo',
    1,
    'demo-user',
    1787673600000,
    '{"id":"demo-user","sourceIds":["demo-user"],"type":"user","timestamp":1787673600000,"content":"Show me the private history viewer."}',
    'Show me the private history viewer.'
  ),
  (
    'local-history-demo',
    2,
    'demo-assistant',
    1787673630000,
    '{"id":"demo-assistant","sourceIds":["demo-assistant"],"type":"assistant","timestamp":1787673630000,"content":"The Worker renders this transcript without browser JavaScript."}',
    'The Worker renders this transcript without browser JavaScript.'
  ),
  (
    'local-history-demo',
    3,
    'demo-tool',
    1787673660000,
    '{"id":"demo-tool","sourceIds":["demo-tool"],"type":"tool","timestamp":1787673660000,"name":"bash","arguments":{"command":"printf local"},"result":"local","outcome":"succeeded"}',
    'bash printf local local'
  );
DELETE FROM entries_fts WHERE session_id = 'local-history-demo';
INSERT INTO entries_fts (session_id, entry_id, position, text) VALUES
  ('local-history-demo', 'demo-user', 1, 'Show me the private history viewer.'),
  ('local-history-demo', 'demo-assistant', 2, 'The Worker renders this transcript without browser JavaScript.'),
  ('local-history-demo', 'demo-tool', 3, 'bash printf local local');
DELETE FROM sessions_fts WHERE session_id = 'local-history-demo';
INSERT INTO sessions_fts (session_id, title, summary) VALUES (
  'local-history-demo',
  'Local history viewer',
  'A fixture conversation for developing the private read-only history UI.'
);
