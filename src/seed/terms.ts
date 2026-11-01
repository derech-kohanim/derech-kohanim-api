import type { Language } from '@shared';

/** Bumping this invalidates every previous acceptance and forces a fresh one. */
export const TERMS_VERSION = '2026-07-01';

export const TERMS_DOCUMENTS: {
  language: Language;
  title: string;
  body: string;
}[] = [
  {
    language: 'he',
    title: 'תנאי שימוש - דרך כהנים',
    body: [
      '## מה השירות עושה',
      '',
      'דרך כהנים מחשב מסלולי נסיעה שנמנעים מאזורים המסומנים כאסורים לכהנים,',
      'לפי רמת החומרה שבחרת. כל מסלול נבדק בשרת מול הפוליגונים לפני שהוא מוצג.',
      '',
      '## מה השירות אינו מבטיח',
      '',
      'איכות ההימנעות תלויה באיכות נתוני האזורים ובנתוני הכבישים של ספק הניתוב.',
      'מסלול שסומן כלא מאומת עובר באזור אסור. אפשר לנסוע בו ביודעין רק אחרי אישור מפורש,',
      'באחריות הנוסע, ובמהלך הנסיעה מוצגת התראה לפני כל כניסה לאזור.',
      'האחריות ההלכתית הסופית היא של המשתמש.',
      '',
      '## פרטיות',
      '',
      'מיקום המוצא והיעד נשלחים לספק הניתוב לצורך חישוב המסלול.',
      'שאילתות חיפוש כתובות נשמרות במטמון בשרת לתקופה מוגבלת כדי לחסוך בקריאות.',
      '',
      '## בטיחות בנהיגה',
      '',
      'אין להפעיל את הממשק בזמן נהיגה. ההנחיה הקולית היא הערוץ הראשי, המסך הוא גיבוי.',
    ].join('\n'),
  },
  {
    language: 'en',
    title: 'Terms of use - Derech Kohanim',
    body: [
      '## What the service does',
      '',
      'Derech Kohanim computes driving routes that avoid the zones marked forbidden for',
      'kohanim at the stringency level you choose. Every route is verified on the server',
      'against the polygons before it is shown.',
      '',
      '## What the service does not promise',
      '',
      'Avoidance quality depends on the quality of the zone data and of the routing',
      'provider road data. A route marked unverified passes through a forbidden zone. It can',
      'be driven knowingly only after an explicit confirmation, at the driver\'s',
      'responsibility, and an alert is shown before every zone entry during the drive.',
      'Final halachic responsibility rests with the user.',
      '',
      '## Privacy',
      '',
      'Origin and destination are sent to the routing provider to compute the route.',
      'Address search queries are cached on the server for a limited period to reduce calls.',
      '',
      '## Driving safety',
      '',
      'Do not operate the interface while driving. Voice guidance is the primary channel,',
      'the screen is a backup.',
    ].join('\n'),
  },
];
