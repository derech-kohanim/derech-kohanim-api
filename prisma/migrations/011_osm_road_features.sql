-- Road features extracted from the OpenStreetMap extract the routing graph is built from.
-- Both tables are replaced wholesale by scripts/import-osm-features.ts whenever the maintainer
-- refreshes the extract; nothing else writes them.

-- Fixed speed cameras and level crossings, announced along a route as events.
CREATE TABLE "road_alerts" (
  "osm_id"        BIGINT NOT NULL,
  "type"          TEXT NOT NULL,           -- 'speed_camera' | 'rail_crossing'
  "max_speed_kmh" INTEGER,                 -- the camera's enforced limit, when tagged
  "direction_deg" DOUBLE PRECISION,        -- the camera's facing direction, when tagged in degrees
  "guarded"       BOOLEAN,                 -- level crossing with barriers or gates
  "geom"          geometry(Point, 4326) NOT NULL,
  CONSTRAINT "road_alerts_pkey" PRIMARY KEY ("type", "osm_id")
);

CREATE INDEX "road_alerts_geom_idx" ON "road_alerts" USING GIST ("geom");

-- Ways that carry turn-lane markings, looked up by OSM way id for lane guidance. The geometry
-- tells which way the way was drawn, which decides whether :forward or :backward applies.
CREATE TABLE "osm_turn_lanes" (
  "way_id"              BIGINT NOT NULL,
  "turn_lanes"          TEXT,
  "turn_lanes_forward"  TEXT,
  "turn_lanes_backward" TEXT,
  "oneway"              TEXT,
  "geom"                geometry(LineString, 4326) NOT NULL,
  CONSTRAINT "osm_turn_lanes_pkey" PRIMARY KEY ("way_id")
);
