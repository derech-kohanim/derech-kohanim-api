-- Route plan grouping + the indexes the 30 day retention sweep needs.
--
-- One POST /api/routes/compute stores every route of the plan as its own row. Until now those
-- rows were only related by having identical request JSON, which made "what else was offered
-- alongside the route this session used" a guess. plan_id/role/rank make it a lookup, which is
-- what the admin console's session debug view is built on.

ALTER TABLE "routes" ADD COLUMN IF NOT EXISTS "plan_id" TEXT;
ALTER TABLE "routes" ADD COLUMN IF NOT EXISTS "role" TEXT NOT NULL DEFAULT 'primary';
ALTER TABLE "routes" ADD COLUMN IF NOT EXISTS "rank" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS "routes_plan_id_idx" ON "routes" ("plan_id");
-- Retention deletes by age; nav_sessions.started_at and route_compute_stats.created_at are the
-- other two sweep predicates (the latter is already indexed by migration 008).
CREATE INDEX IF NOT EXISTS "routes_created_at_idx" ON "routes" ("created_at");
CREATE INDEX IF NOT EXISTS "nav_sessions_started_at_idx" ON "nav_sessions" ("started_at");

-- The trail of routes a session drove: the initial one plus one row per reroute. The session's
-- own route_id is overwritten on every reroute, so without this the route the driver actually
-- set out on is unrecoverable. route_id is intentionally not a foreign key - the trail is debug
-- history and must not disappear (or block) when the route rows are purged.
CREATE TABLE IF NOT EXISTS "nav_session_routes" (
  "id"         TEXT NOT NULL,
  "session_id" TEXT NOT NULL,
  "route_id"   TEXT NOT NULL,
  "reason"     TEXT NOT NULL DEFAULT 'initial',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "nav_session_routes_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "nav_session_routes_session_id_idx"
  ON "nav_session_routes" ("session_id");

ALTER TABLE "nav_session_routes"
  DROP CONSTRAINT IF EXISTS "nav_session_routes_session_id_fkey";
ALTER TABLE "nav_session_routes"
  ADD CONSTRAINT "nav_session_routes_session_id_fkey"
  FOREIGN KEY ("session_id") REFERENCES "nav_sessions" ("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- End-of-trip feedback must survive the purge of the route it was left on, so the reference is
-- nulled instead of cascading. The rating and free text are the durable signal; the geometry and
-- manoeuvres they refer to are not.
ALTER TABLE "nav_feedback" ALTER COLUMN "route_id" DROP NOT NULL;
ALTER TABLE "nav_feedback" DROP CONSTRAINT IF EXISTS "nav_feedback_route_id_fkey";
ALTER TABLE "nav_feedback"
  ADD CONSTRAINT "nav_feedback_route_id_fkey"
  FOREIGN KEY ("route_id") REFERENCES "routes" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
