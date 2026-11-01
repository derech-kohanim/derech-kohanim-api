-- Reports and feedback sent by signed-in users. Every report is kept here, whether or not the
-- GitHub issue could be filed, so the admin console always has the full list; issue_number and
-- issue_url link to the issue in the private support repository once it exists.
CREATE TABLE IF NOT EXISTS "support_reports" (
  "id"           TEXT PRIMARY KEY,
  "user_id"      TEXT REFERENCES "users"("id") ON DELETE SET NULL,
  "kind"         TEXT NOT NULL,
  "message"      TEXT NOT NULL,
  "platform"     TEXT NOT NULL,
  "app_version"  TEXT NOT NULL,
  "device"       TEXT,
  "route_id"     TEXT,
  "zone_id"      INTEGER,
  "lat"          DOUBLE PRECISION,
  "lng"          DOUBLE PRECISION,
  "reply_by_email" BOOLEAN NOT NULL DEFAULT FALSE,
  "issue_number" INTEGER,
  "issue_url"    TEXT,
  "merged"       BOOLEAN NOT NULL DEFAULT FALSE,
  "created_at"   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "support_reports_created_idx" ON "support_reports" ("created_at" DESC);
