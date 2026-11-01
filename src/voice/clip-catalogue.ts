import type { Language, VoiceClipRole } from '@shared';

/**
 * Selectable voices. Mirrors VOICE_IDS in the shared contract, which cannot be imported at
 * runtime (only `import type` from @shared survives the build). The voice id picks the
 * speaker's voice (male or female). The wording is the same in every Hebrew pack: the driver
 * is always addressed in the masculine.
 */
export const VOICE_IDS = ['he-male', 'he-female', 'en-default'] as const;

/** Legacy id saved in preferences before the voice choice existed. Same as he-male. */
export const LEGACY_HEBREW_VOICE_ID = 'he-default';

/** Every voice id a client may send: the selectable ones plus the legacy alias. */
export const ACCEPTED_VOICE_IDS: string[] = [...VOICE_IDS, LEGACY_HEBREW_VOICE_ID];

export interface CatalogueEntry {
  key: string;
  role: VoiceClipRole;
  /**
   * Spoken text per language. Hebrew addresses the driver in the masculine in every pack, and
   * the verbs are vocalized so TTS pronounces them correctly.
   */
  text: Record<Language, string>;
  /** Rough length of the spoken clip, used for scheduling announcements. */
  durationMs: number;
}

/**
 * Maps whatever voice id a client sent onto the id of a seeded pack. Unknown and legacy ids
 * fall back to the language's masculine/default voice, so a resolve request from an older
 * client still lands on a real pack instead of 404ing mid-navigation.
 */
export function canonicalVoiceId(language: Language, voiceId: string | undefined): string {
  if (language === 'en') return 'en-default';
  return voiceId === 'he-female' ? 'he-female' : 'he-male';
}

/**
 * The text a clip speaks for a given pack. The same in the male and female packs: only the
 * synthesized voice differs (see tts.service.ts).
 */
export function clipText(entry: CatalogueEntry, language: Language, _voiceId: string): string {
  return entry.text[language];
}

/** Ordinals for roundabout exits, feminine to agree with "יציאה". */
const EXIT_ORDINALS: { he: string; en: string }[] = [
  { he: 'הראשונה', en: 'first' },
  { he: 'השנייה', en: 'second' },
  { he: 'השלישית', en: 'third' },
  { he: 'הרביעית', en: 'fourth' },
  { he: 'החמישית', en: 'fifth' },
  { he: 'השישית', en: 'sixth' },
  { he: 'השביעית', en: 'seventh' },
  { he: 'השמינית', en: 'eighth' },
];

/**
 * The closed clip library (spec section 15). A spoken instruction is assembled from these
 * short clips, never stored as a whole sentence, which is what keeps the library at a few
 * dozen files per language instead of growing with the number of routes.
 *
 * Street names are the one open vocabulary and are deliberately absent here - they are
 * generated on demand and keyed by hash (see streetClipKey).
 *
 * Hebrew wording: only the verbs addressed to the driver carry niqqud. TTS engines read unvocalized Hebrew
 * verbs ambiguously (פנה as "pana" instead of "pne"), and vocalizing just those words fixes
 * the pronunciation without making the rest of the text harder to maintain. The vocalized
 * forms and several phrasings are taken from the masculine Hebrew voice prompts of DirGo
 * Navigation (voice/iw/iw_tts.js), a fork of OsmAnd under GPLv3.
 */
export const CLIP_CATALOGUE: CatalogueEntry[] = [
  // Prefix
  {
    key: 'prefix.in',
    role: 'prefix',
    text: { he: 'בעוד', en: 'in' },
    durationMs: 400,
  },
  {
    key: 'prefix.then',
    role: 'prefix',
    text: { he: 'לאחר מכן', en: 'then' },
    durationMs: 600,
  },

  // Distance ladder - a closed set, so the real distance is rounded to the nearest rung.
  {
    key: 'dist.2km',
    role: 'dist',
    text: { he: 'שני קילומטר', en: 'two kilometers' },
    durationMs: 900,
  },
  {
    key: 'dist.1km',
    role: 'dist',
    text: { he: 'קילומטר', en: 'one kilometer' },
    durationMs: 800,
  },
  {
    key: 'dist.800m',
    role: 'dist',
    text: { he: 'שמונה מאות מטר', en: 'eight hundred meters' },
    durationMs: 1000,
  },
  {
    key: 'dist.500m',
    role: 'dist',
    text: { he: 'חמש מאות מטר', en: 'five hundred meters' },
    durationMs: 1000,
  },
  {
    key: 'dist.300m',
    role: 'dist',
    text: { he: 'שלוש מאות מטר', en: 'three hundred meters' },
    durationMs: 1000,
  },
  {
    key: 'dist.200m',
    role: 'dist',
    text: { he: 'מאתיים מטר', en: 'two hundred meters' },
    durationMs: 900,
  },
  {
    key: 'dist.100m',
    role: 'dist',
    text: { he: 'מאה מטר', en: 'one hundred meters' },
    durationMs: 850,
  },
  {
    key: 'dist.50m',
    role: 'dist',
    text: { he: 'חמישים מטר', en: 'fifty meters' },
    durationMs: 850,
  },
  {
    key: 'dist.now',
    role: 'dist',
    text: { he: 'עכשיו', en: 'now' },
    durationMs: 500,
  },

  // Actions
  {
    key: 'action.depart',
    role: 'action',
    text: { he: 'צֵא לדרך', en: 'start driving' },
    durationMs: 800,
  },
  {
    key: 'action.arrive',
    role: 'action',
    text: { he: 'הִגַּעְתָּ ליעד', en: 'you have arrived' },
    durationMs: 900,
  },
  {
    key: 'action.continue',
    role: 'action',
    text: { he: 'הַמְשֵׁךְ ישר', en: 'continue straight' },
    durationMs: 800,
  },
  {
    key: 'action.turn_left',
    role: 'action',
    text: { he: 'פְּנֵה שמאלה', en: 'turn left' },
    durationMs: 800,
  },
  {
    key: 'action.turn_right',
    role: 'action',
    text: { he: 'פְּנֵה ימינה', en: 'turn right' },
    durationMs: 800,
  },
  {
    key: 'action.slight_left',
    role: 'action',
    text: { he: 'פְּנֵה קַלּוֹת שמאלה', en: 'bear left' },
    durationMs: 900,
  },
  {
    key: 'action.slight_right',
    role: 'action',
    text: { he: 'פְּנֵה קַלּוֹת ימינה', en: 'bear right' },
    durationMs: 900,
  },
  {
    key: 'action.sharp_left',
    role: 'action',
    text: { he: 'פְּנֵה חַדּוֹת שמאלה', en: 'turn sharply left' },
    durationMs: 1000,
  },
  {
    key: 'action.sharp_right',
    role: 'action',
    text: {
      he: 'פְּנֵה חַדּוֹת ימינה',
      en: 'turn sharply right',
    },
    durationMs: 1000,
  },
  {
    key: 'action.uturn',
    role: 'action',
    text: { he: 'בַּצֵּעַ פניית פרסה', en: 'make a u-turn' },
    durationMs: 950,
  },
  {
    key: 'action.keep_left',
    role: 'action',
    text: { he: 'הִיצָּמֵד לשמאל', en: 'keep left' },
    durationMs: 950,
  },
  {
    key: 'action.keep_right',
    role: 'action',
    text: { he: 'הִיצָּמֵד לימין', en: 'keep right' },
    durationMs: 950,
  },
  {
    key: 'action.roundabout_enter',
    role: 'action',
    text: { he: 'הִיכָּנֵס לכיכר', en: 'enter the roundabout' },
    durationMs: 950,
  },
  {
    key: 'action.roundabout_exit',
    role: 'action',
    text: { he: 'צֵא מהכיכר', en: 'exit the roundabout' },
    durationMs: 900,
  },
  {
    key: 'action.merge',
    role: 'action',
    text: { he: 'הִשְׁתַּלֵּב', en: 'merge' },
    durationMs: 700,
  },
  {
    key: 'action.ramp_left',
    role: 'action',
    text: {
      he: 'קַח את המחלף שמאלה',
      en: 'take the ramp on the left',
    },
    durationMs: 1100,
  },
  {
    key: 'action.ramp_right',
    role: 'action',
    text: {
      he: 'קַח את המחלף ימינה',
      en: 'take the ramp on the right',
    },
    durationMs: 1100,
  },
  {
    key: 'action.ferry',
    role: 'action',
    text: { he: 'עֲלֵה למעבורת', en: 'board the ferry' },
    durationMs: 900,
  },

  // Roundabout exit ordinal, spoken after action.roundabout_enter ("ביציאה השלישית").
  ...EXIT_ORDINALS.map((ordinal, index): CatalogueEntry => ({
    key: `exit.${index + 1}`,
    role: 'action',
    text: { he: `ביציאה ${ordinal.he}`, en: `at the ${ordinal.en} exit` },
    durationMs: 1000,
  })),

  // Zone warnings. A zone alert always outranks a driving instruction (spec section 15.9).
  {
    key: 'zone.enter',
    role: 'zone',
    text: {
      he: 'שִׂים לֵב, נכנסים לאזור אסור',
      en: 'attention, entering a forbidden zone',
    },
    durationMs: 1600,
  },
  {
    key: 'zone.exit',
    role: 'zone',
    text: { he: 'יצאנו מהאזור האסור', en: 'leaving the forbidden zone' },
    durationMs: 1400,
  },
  {
    key: 'zone.origin',
    role: 'zone',
    text: {
      he: 'נקודת המוצא נמצאת בתוך אזור אסור',
      en: 'the starting point is inside a forbidden zone',
    },
    durationMs: 1900,
  },
  {
    key: 'zone.destination',
    role: 'zone',
    text: {
      he: 'היעד נמצא בתוך אזור אסור',
      en: 'the destination is inside a forbidden zone',
    },
    durationMs: 1700,
  },
  {
    key: 'zone.ahead',
    role: 'zone',
    text: { he: 'אזור אסור לפנינו', en: 'forbidden zone ahead' },
    durationMs: 1300,
  },

  // Road alerts along the route.
  {
    key: 'alert.speed_camera',
    role: 'misc',
    text: {
      he: 'מַצְלֵמַת מְהִירוּת לְפָנֶיךָ',
      en: 'speed camera ahead',
    },
    durationMs: 1300,
  },
  {
    key: 'alert.rail_crossing',
    role: 'misc',
    text: {
      he: 'מפגש מסילת ברזל לְפָנֶיךָ',
      en: 'railway crossing ahead',
    },
    durationMs: 1400,
  },
  {
    key: 'alert.speeding',
    role: 'misc',
    text: {
      he: 'שִׂים לֵב, אַתָּה חוֹרֵג מהמהירות המותרת',
      en: 'attention, you are over the speed limit',
    },
    durationMs: 1800,
  },

  // Miscellaneous states the navigation screen speaks.
  {
    key: 'misc.rerouting',
    role: 'misc',
    text: { he: 'מחשב מסלול מחדש', en: 'recalculating the route' },
    durationMs: 1200,
  },
  {
    key: 'misc.route_not_verified',
    role: 'misc',
    text: {
      he: 'לא נמצא מסלול מאומת',
      en: 'no verified route was found',
    },
    durationMs: 1400,
  },
  {
    key: 'misc.off_route',
    role: 'misc',
    text: { he: 'סָטִיתָ מהמסלול', en: 'you have left the route' },
    durationMs: 1200,
  },
  {
    key: 'misc.gps_lost',
    role: 'misc',
    text: { he: 'אין קליטת לוויין', en: 'GPS signal lost' },
    durationMs: 1100,
  },
  {
    key: 'misc.gps_recovered',
    role: 'misc',
    text: { he: 'הקליטה חזרה', en: 'GPS signal restored' },
    durationMs: 900,
  },
  {
    key: 'misc.back_on_route',
    role: 'misc',
    text: { he: 'חָזַרְתָּ למסלול', en: 'you are back on the route' },
    durationMs: 1000,
  },
  {
    // Offline guidance: with no connection a new route cannot be computed, so the driver is
    // steered back to the route already on the device.
    key: 'misc.return_to_route',
    role: 'misc',
    text: { he: 'חֲזוֹר למסלול', en: 'return to the route' },
    durationMs: 1000,
  },
];

/**
 * Voice packs seeded at boot. The voiceId is the full pack identifier the client sends (it
 * is what UserPreferences.voiceId holds), so a resolve request built from a user's
 * preferences matches a seeded pack. The legacy `he-default` id is not a pack of its own: it
 * resolves to he-male through canonicalVoiceId.
 */
export const SEED_VOICE_PACKS: {
  id: string;
  language: Language;
  voiceId: string;
}[] = [
  { id: 'he-male', language: 'he', voiceId: 'he-male' },
  { id: 'he-female', language: 'he', voiceId: 'he-female' },
  { id: 'en-default', language: 'en', voiceId: 'en-default' },
];
