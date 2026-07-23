import type { Language, VoiceClipRole } from '@shared';

export interface CatalogueEntry {
  key: string;
  role: VoiceClipRole;
  text: Record<Language, string>;
  /** Rough length of the spoken clip, used for scheduling announcements. */
  durationMs: number;
}

/**
 * The closed clip library (spec section 15). A spoken instruction is assembled from these
 * short clips, never stored as a whole sentence, which is what keeps the library at a few
 * dozen files per language instead of growing with the number of routes.
 *
 * Street names are the one open vocabulary and are deliberately absent here - they are
 * generated on demand and keyed by hash (see streetClipKey).
 */
export const CLIP_CATALOGUE: CatalogueEntry[] = [
  // Prefix
  { key: 'prefix.in', role: 'prefix', text: { he: 'בעוד', en: 'in' }, durationMs: 400 },
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
  { key: 'dist.now', role: 'dist', text: { he: 'עכשיו', en: 'now' }, durationMs: 500 },

  // Actions
  { key: 'action.depart', role: 'action', text: { he: 'צא לדרך', en: 'start driving' }, durationMs: 800 },
  { key: 'action.arrive', role: 'action', text: { he: 'הגעת ליעד', en: 'you have arrived' }, durationMs: 900 },
  { key: 'action.continue', role: 'action', text: { he: 'המשך ישר', en: 'continue straight' }, durationMs: 800 },
  { key: 'action.turn_left', role: 'action', text: { he: 'פנה שמאלה', en: 'turn left' }, durationMs: 800 },
  { key: 'action.turn_right', role: 'action', text: { he: 'פנה ימינה', en: 'turn right' }, durationMs: 800 },
  { key: 'action.slight_left', role: 'action', text: { he: 'סטה מעט שמאלה', en: 'bear left' }, durationMs: 900 },
  { key: 'action.slight_right', role: 'action', text: { he: 'סטה מעט ימינה', en: 'bear right' }, durationMs: 900 },
  { key: 'action.sharp_left', role: 'action', text: { he: 'פנה בחדות שמאלה', en: 'turn sharply left' }, durationMs: 1000 },
  { key: 'action.sharp_right', role: 'action', text: { he: 'פנה בחדות ימינה', en: 'turn sharply right' }, durationMs: 1000 },
  { key: 'action.uturn', role: 'action', text: { he: 'בצע פניית פרסה', en: 'make a u-turn' }, durationMs: 950 },
  { key: 'action.keep_left', role: 'action', text: { he: 'הישאר בנתיב השמאלי', en: 'keep left' }, durationMs: 950 },
  { key: 'action.keep_right', role: 'action', text: { he: 'הישאר בנתיב הימני', en: 'keep right' }, durationMs: 950 },
  { key: 'action.roundabout_enter', role: 'action', text: { he: 'היכנס לכיכר', en: 'enter the roundabout' }, durationMs: 950 },
  { key: 'action.roundabout_exit', role: 'action', text: { he: 'צא מהכיכר', en: 'exit the roundabout' }, durationMs: 900 },
  { key: 'action.merge', role: 'action', text: { he: 'השתלב', en: 'merge' }, durationMs: 700 },
  { key: 'action.ramp_left', role: 'action', text: { he: 'קח את המחלף שמאלה', en: 'take the ramp on the left' }, durationMs: 1100 },
  { key: 'action.ramp_right', role: 'action', text: { he: 'קח את המחלף ימינה', en: 'take the ramp on the right' }, durationMs: 1100 },
  { key: 'action.ferry', role: 'action', text: { he: 'עלה למעבורת', en: 'board the ferry' }, durationMs: 900 },

  // Zone warnings. A zone alert always outranks a driving instruction (spec section 15.9).
  {
    key: 'zone.enter',
    role: 'zone',
    text: { he: 'שים לב, נכנסים לאזור אסור', en: 'attention, entering a forbidden zone' },
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
    text: { he: 'סטית מהמסלול', en: 'you have left the route' },
    durationMs: 1200,
  },
];

/**
 * Voice packs seeded for both languages. The voiceId is the full pack identifier the client
 * sends (it is what UserPreferences.voiceId holds, e.g. "he-default"), so a resolve request
 * built from a user's preferences matches a seeded pack instead of 404ing. More voices per
 * language are just more rows (e.g. "he-female").
 */
export const SEED_VOICE_PACKS: { id: string; language: Language; voiceId: string }[] = [
  { id: 'he-default', language: 'he', voiceId: 'he-default' },
  { id: 'en-default', language: 'en', voiceId: 'en-default' },
];
