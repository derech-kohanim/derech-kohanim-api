-- End-of-trip feedback: a driver rates a completed route good/bad, with an optional free-text
-- description on a 'bad' rating. Guests may submit anonymously, so user_id is nullable.

CREATE TABLE "nav_feedback" (
  "id"         TEXT NOT NULL,
  "route_id"   TEXT NOT NULL,
  "user_id"    TEXT,
  "rating"     TEXT NOT NULL,
  "text"       TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "nav_feedback_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "nav_feedback_route_id_idx" ON "nav_feedback" ("route_id");

ALTER TABLE "nav_feedback"
  ADD CONSTRAINT "nav_feedback_route_id_fkey"
  FOREIGN KEY ("route_id") REFERENCES "routes" ("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "nav_feedback"
  ADD CONSTRAINT "nav_feedback_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
