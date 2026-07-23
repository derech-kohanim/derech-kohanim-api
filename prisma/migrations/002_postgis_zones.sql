-- Zone geometry. Kept out of the Prisma schema on purpose: Prisma has no PostGIS geometry
-- type, so these tables are created and queried with raw SQL (spec section 6.1).

CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE IF NOT EXISTS zone_layers (
  id          serial PRIMARY KEY,
  stringency  text NOT NULL UNIQUE,
  version     int NOT NULL DEFAULT 1,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS zones (
  id          serial PRIMARY KEY,
  layer_id    int NOT NULL REFERENCES zone_layers(id) ON DELETE CASCADE,
  name        text NOT NULL,
  name_he     text NOT NULL DEFAULT '',
  source      text NOT NULL DEFAULT 'seed',
  geom        geometry(Polygon, 4326) NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Mandatory for performance: every route verification is a spatial query.
CREATE INDEX IF NOT EXISTS zones_geom_gix ON zones USING GIST (geom);
CREATE INDEX IF NOT EXISTS zones_layer_idx ON zones (layer_id);

INSERT INTO zone_layers (stringency) VALUES ('basic'), ('taharat'), ('machmirim')
  ON CONFLICT (stringency) DO NOTHING;
