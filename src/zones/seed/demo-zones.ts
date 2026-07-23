import type { GeoJsonPolygon, Stringency } from '@shared';

export interface DemoZone {
  name: string;
  nameHe: string;
  stringency: Stringency;
  geometry: GeoJsonPolygon;
}

/**
 * Demo zones ported from the proof of concept: small rectangles over Bnei Brak, positioned
 * so a direct route between the demo endpoints must detour around them.
 *
 * NOT halachic data. Production data is the association-managed, versioned zone layers
 * described in spec section 3.
 */
export const DEMO_ZONES: DemoZone[] = [
  {
    name: 'Bnei Brak - Rabbi Akiva quarter (demo)',
    nameHe: 'בני ברק - רובע רבי עקיבא (הדגמה)',
    stringency: 'basic',
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [34.829, 32.081],
          [34.836, 32.081],
          [34.836, 32.087],
          [34.829, 32.087],
          [34.829, 32.081],
        ],
      ],
    },
  },
  {
    name: 'Bnei Brak - Zichron Meir west (demo)',
    nameHe: 'בני ברק - זכרון מאיר מערב (הדגמה)',
    stringency: 'basic',
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [34.8215, 32.0825],
          [34.827, 32.0825],
          [34.827, 32.0885],
          [34.8215, 32.0885],
          [34.8215, 32.0825],
        ],
      ],
    },
  },
  {
    name: 'Bnei Brak - Ramat Aharon (demo)',
    nameHe: 'בני ברק - רמת אהרן (הדגמה)',
    stringency: 'taharat',
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [34.838, 32.088],
          [34.845, 32.088],
          [34.845, 32.094],
          [34.838, 32.094],
          [34.838, 32.088],
        ],
      ],
    },
  },
  {
    name: 'Bnei Brak - Pardes Katz west (demo)',
    nameHe: 'בני ברק - פרדס כץ מערב (הדגמה)',
    stringency: 'machmirim',
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [34.82, 32.09],
          [34.827, 32.09],
          [34.827, 32.096],
          [34.82, 32.096],
          [34.82, 32.09],
        ],
      ],
    },
  },
];
