-- Community reports raised against a computed route (spec section 17.3, "report or flag").

CREATE TABLE "route_reports" (
  "id"         TEXT NOT NULL,
  "route_id"   TEXT NOT NULL,
  "user_id"    TEXT,
  "type"       TEXT NOT NULL,
  "lat"        DOUBLE PRECISION NOT NULL,
  "lng"        DOUBLE PRECISION NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "route_reports_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "route_reports_route_id_idx" ON "route_reports" ("route_id");

ALTER TABLE "route_reports"
  ADD CONSTRAINT "route_reports_route_id_fkey"
  FOREIGN KEY ("route_id") REFERENCES "routes" ("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "route_reports"
  ADD CONSTRAINT "route_reports_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
