-- BookEase Growth counts: one row per place, Bangkok day, action and source.
CREATE TABLE IF NOT EXISTS hits (
  id     TEXT NOT NULL,   -- Google place id (shop or building)
  day    TEXT NOT NULL,   -- YYYY-MM-DD, Bangkok
  action TEXT NOT NULL,   -- view | call | map | web | line | book | review | open
  src    TEXT NOT NULL,   -- site | lalisa-page | qr | link | b:<buildingId> | direct …
  n      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (id, day, action, src)
);

-- BookEase Growth payments: one row per order = one Xendit invoice (external_id = order_id). Added 2026-11-16.
CREATE TABLE IF NOT EXISTS growth_orders (
  order_id       TEXT PRIMARY KEY,          -- growth-<placeTail>-<YYYYMM>-<rand6>
  place_id       TEXT NOT NULL,
  shop_name      TEXT NOT NULL,
  tier           INTEGER NOT NULL,          -- 1000 | 2000 | 3000
  amount         INTEGER NOT NULL,          -- THB, from the tier table (server-side)
  currency       TEXT NOT NULL DEFAULT 'THB',
  period         TEXT NOT NULL,             -- YYYYMM (Bangkok) the payment covers; renewal = a new order next month
  status         TEXT NOT NULL,             -- PENDING | PAID | EXPIRED | REVIEW
  invoice_id     TEXT NOT NULL,
  invoice_url    TEXT NOT NULL,
  created_at     INTEGER NOT NULL,          -- ms
  expires_at     INTEGER NOT NULL,
  checked_at     INTEGER NOT NULL DEFAULT 0,
  paid_at        INTEGER,
  paid_amount    INTEGER,
  payment_method TEXT,
  note           TEXT
);
CREATE INDEX IF NOT EXISTS growth_orders_place ON growth_orders (place_id, period, status);

-- Shop Radar Maps picture (worker creates these itself on first use). shot_state is the read-after-write copy of the
-- result, because KV can answer a stale "not found" for up to 60 s (2026-11-24).
CREATE TABLE IF NOT EXISTS shot_queue (place_id TEXT PRIMARY KEY, queued_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS shot_state (place_id TEXT PRIMARY KEY, meta TEXT NOT NULL, jpg BLOB, until INTEGER NOT NULL);
