-- BookEase Growth counts: one row per place, Bangkok day, action and source.
CREATE TABLE IF NOT EXISTS hits (
  id     TEXT NOT NULL,   -- Google place id (shop or building)
  day    TEXT NOT NULL,   -- YYYY-MM-DD, Bangkok
  action TEXT NOT NULL,   -- view | call | map | web | line | book | review | open
  src    TEXT NOT NULL,   -- site | lalisa-page | qr | link | b:<buildingId> | direct …
  n      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (id, day, action, src)
);
