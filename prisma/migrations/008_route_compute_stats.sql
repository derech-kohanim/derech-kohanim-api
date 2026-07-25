-- Per-compute timing/debug telemetry for POST /api/routes/compute, surfaced in the admin
-- console. Written defensively from an interceptor + RoutingService and never on the hot path
-- of returning the route, so a failure to record can never break or slow a compute.
--
-- Ids are supplied by the application layer (Prisma @default(uuid())), matching every other
-- table, so no DB-side uuid default is needed.

CREATE TABLE IF NOT EXISTS route_compute_stats (
  id                 text PRIMARY KEY,
  created_at         timestamptz NOT NULL DEFAULT now(),
  -- Routing provider that actually served the route, and the engine the request asked for.
  provider           text NOT NULL,
  engine             text NOT NULL,
  -- Provider/route computation time (RoutingService.computePlan).
  compute_ms         integer NOT NULL,
  -- Total server request-handling time for the compute request.
  handling_ms        integer NOT NULL,
  alternative_count  integer NOT NULL DEFAULT 0,
  verified_clean     boolean NOT NULL DEFAULT false,
  stringency         text NOT NULL,
  mode               text NOT NULL,
  origin_lat         double precision NOT NULL,
  origin_lng         double precision NOT NULL,
  dest_lat           double precision NOT NULL,
  dest_lng           double precision NOT NULL,
  distance_meters    integer,
  duration_seconds   integer,
  avoid_danger_zones boolean NOT NULL DEFAULT true,
  avoid_tolls        boolean NOT NULL DEFAULT false,
  -- Best route id from the plan, so the detail view can pull the stored RoutePlan payload.
  route_id           text,
  user_id            text
);

CREATE INDEX IF NOT EXISTS route_compute_stats_created_idx
  ON route_compute_stats (created_at DESC);
