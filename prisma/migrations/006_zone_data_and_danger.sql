-- Real halachic zone data carries a city, street and the full explanation. Danger zones
-- (Oslo "Area A") are a separate axis, kept in their own table with their own version.

ALTER TABLE zones ADD COLUMN IF NOT EXISTS city text;
ALTER TABLE zones ADD COLUMN IF NOT EXISTS street text;
ALTER TABLE zones ADD COLUMN IF NOT EXISTS description text;

CREATE TABLE IF NOT EXISTS danger_zones (
  id          serial PRIMARY KEY,
  name        text NOT NULL,
  city        text,
  description text,
  source      text NOT NULL DEFAULT 'import',
  version     int NOT NULL DEFAULT 1,
  geom        geometry(Polygon, 4326) NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Mandatory for performance: danger-zone verification is a spatial query on every route.
CREATE INDEX IF NOT EXISTS danger_zones_geom_gix ON danger_zones USING GIST (geom);
