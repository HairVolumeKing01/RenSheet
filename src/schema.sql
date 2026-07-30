-- 激活码表
CREATE TABLE IF NOT EXISTS activation_codes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  code          TEXT    UNIQUE NOT NULL,
  plan          TEXT    NOT NULL,
  status        TEXT    NOT NULL DEFAULT 'unused',
  expires_at    TEXT    NOT NULL,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  renewed_at    TEXT,
  batch_label   TEXT,
  delivered_to  TEXT,
  delivered_at  TEXT,
  activated_at  TEXT
);

CREATE INDEX IF NOT EXISTS idx_codes_code ON activation_codes(code);
CREATE INDEX IF NOT EXISTS idx_codes_status ON activation_codes(status);

-- 试用追踪表
CREATE TABLE IF NOT EXISTS trial_usage (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  fp_hash     TEXT    NOT NULL,
  tool        TEXT    NOT NULL,
  remaining   INTEGER NOT NULL DEFAULT 2,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_trial_fp_tool ON trial_usage(fp_hash, tool);
