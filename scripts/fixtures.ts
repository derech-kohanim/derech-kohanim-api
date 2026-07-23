import type { AvoidZone } from '../src/common/geo';
import type { GeoJsonPolygon, Stringency, ZoneFeature } from '@shared';

/**
 * Self-contained test polygons for the verify harness. Kept OUT of the database and out of the
 * boot seed on purpose: the real database contains only imported data. These fixtures exist
 * only so the avoidance invariants can be checked deterministically, over the same Bnei Brak
 * geometry the presets use.
 */
function rect(west: number, south: number, east: number, north: number): GeoJsonPolygon {
  return {
    type: 'Polygon',
    coordinates: [
      [
        [west, south],
        [east, south],
        [east, north],
        [west, north],
        [west, south],
      ],
    ],
  };
}

interface Fixture {
  name: string;
  stringency: Stringency;
  city: string;
  geometry: GeoJsonPolygon;
}

const FIXTURES: Fixture[] = [
  {
    name: 'Bnei Brak - Rabbi Akiva quarter (fixture)',
    stringency: 'basic',
    city: 'בני ברק',
    geometry: rect(34.829, 32.081, 34.836, 32.087),
  },
  {
    name: 'Bnei Brak - Zichron Meir west (fixture)',
    stringency: 'basic',
    city: 'בני ברק',
    geometry: rect(34.8215, 32.0825, 34.827, 32.0885),
  },
  {
    name: 'Bnei Brak - Ramat Aharon (fixture)',
    stringency: 'taharat',
    city: 'בני ברק',
    geometry: rect(34.838, 32.088, 34.845, 32.094),
  },
  {
    name: 'Bnei Brak - Pardes Katz west (fixture)',
    stringency: 'machmirim',
    city: 'בני ברק',
    geometry: rect(34.82, 32.09, 34.827, 32.096),
  },
];

/** A danger-zone fixture straddling a separate corridor, away from the stringency fixtures. */
export const DANGER_FIXTURE: GeoJsonPolygon = rect(34.792, 32.052, 34.799, 32.059);

const STRINGENCY_LEVEL: Record<Stringency, number> = { basic: 1, taharat: 2, machmirim: 3 };

/** A stub ZonesService: returns cumulative fixture zones without touching the database. */
export const fixtureZones = {
  async getZones(stringency: Stringency): Promise<ZoneFeature[]> {
    const max = STRINGENCY_LEVEL[stringency];
    return FIXTURES.filter((f) => STRINGENCY_LEVEL[f.stringency] <= max).map((f, index) => ({
      type: 'Feature' as const,
      properties: {
        id: index + 1,
        name: f.name,
        nameHe: f.name,
        stringency: f.stringency,
        city: f.city,
        street: null,
        description: `fixture zone: ${f.name}`,
      },
      geometry: f.geometry,
    }));
  },
  async getVersion(): Promise<number> {
    return 1;
  },
  async getCollection(stringency: Stringency) {
    return {
      type: 'FeatureCollection' as const,
      features: await this.getZones(stringency),
      version: 1,
    };
  },
};

/** A stub DangerZonesService: one danger-zone fixture, marked danger. */
export const fixtureDanger = {
  async getAvoidZones(): Promise<AvoidZone[]> {
    return [
      {
        type: 'Feature' as const,
        danger: true,
        properties: {
          id: 1_000_001,
          name: 'Test danger zone (fixture)',
          nameHe: 'Test danger zone (fixture)',
          stringency: 'basic' as Stringency,
          city: 'אוסלו',
          street: null,
          description: 'fixture danger zone (Area A)',
        },
        geometry: DANGER_FIXTURE,
      },
    ];
  },
  async getVersion(): Promise<number> {
    return 1;
  },
  async getCollection() {
    const zones = await this.getAvoidZones();
    return {
      type: 'FeatureCollection' as const,
      features: zones.map((z) => ({
        type: 'Feature' as const,
        properties: {
          id: z.properties.id,
          name: z.properties.name,
          city: z.properties.city,
          description: z.properties.description,
        },
        geometry: z.geometry,
      })),
      version: 1,
    };
  },
};
