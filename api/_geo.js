// THE single source of truth for MTL's spatial constants and training-time windows. They used to
// live as five separate literals across four files and had already drifted: the deck and the
// founder hotspot ran on 20 km while the two demand endpoints ran on 25. That gap had a visible
// consequence -- a student was shown "every club within 20 km" and the club was then handed people
// from 25 km, i.e. people the app had never shown that club to.
//
// Everything is 20 km. It is the number the STUDENT was shown, so it is the only one that can be
// honestly reported back to a club.
//
// Deliberately NOT smaller (15 km was considered): shrinking the radius would also shrink what
// counts as "no club near me", which would fire the passive demand signal MORE often and inflate
// the numbers -- the opposite of what tighter data should do. The real answer to "will these people
// actually come?" is not a smaller circle but showing the DISTRIBUTION (how many within 5 / 10 /
// 20 km), because the honest radius depends on the time of day: nobody drives 20 km to a 06:30
// class, plenty will for an 18:00 one. One number cannot carry that; bands can.

export const LOCAL_KM = 20;           // "near me" everywhere: deck, hotspot clustering, gym coverage, demand
export const DEMAND_THRESHOLD = 15;   // unique people before a number is shown to a club (small-number privacy)
export const DEMAND_FRESH_DAYS = 120; // older signals are ignored entirely

// Bands the club-facing panel leads with, nearest first. Lead with the SMALLEST number, never the
// total -- a club that opens a class expecting 14 and gets 4 never trusts the data again.
export const DEMAND_BANDS_KM = [5, 10, 20];

// -- Training-time windows -------------------------------------------------------------------
// The SAME six windows are used by the student ("when could you train?"), by the club panel
// ("mornings are missing here") and by the matching between them. Defined twice they would drift,
// and a student asking for "podvecer" would never match a club opening a 16:00 class.
//
// THE RULE, and it must be printed wherever these appear so nobody has to deduce it:
//   Every window is decided by the START of the class. The single exception is MORNING, decided by
//   the END -- because the morning constraint is never "I want to start at 07:00", it is "I have to
//   be finished before work". Every other window has the opposite constraint: "I can't start before
//   I leave work".
//
// Naming: the LABEL is a plain time-of-day word that is true for everyone; the work/school context
// is only a subtitle. Naming the window itself "Po praci" would quietly exclude shift workers,
// students, parents on leave and pensioners -- and those are precisely the people who can fill the
// dead midday hours, i.e. the most commercially valuable answers in the whole form.
export const TIME_WINDOWS = [
  { v: 'morning',   cs: 'R\u00e1no',     en: 'Morning',       subCs: 'stihnu p\u0159ed prac\u00ed / \u0161kolou', subEn: 'done before work / school', by: 'end',   to: '08:30' },
  { v: 'forenoon',  cs: 'Dopoledne',     en: 'Late morning',  subCs: '',                            subEn: '',                          by: 'start', from: '08:30', to: '12:00' },
  { v: 'afternoon', cs: 'Odpoledne',     en: 'Afternoon',     subCs: '',                            subEn: '',                          by: 'start', from: '12:00', to: '16:00' },
  { v: 'earlyeve',  cs: 'Podve\u010der', en: 'Early evening', subCs: 'po \u0161kole, po pr\u00e1ci', subEn: 'after school, after work',  by: 'start', from: '16:00', to: '19:30' },
  { v: 'evening',   cs: 'Ve\u010der',    en: 'Evening',       subCs: '',                            subEn: '',                          by: 'start', from: '19:30' },
  { v: 'weekend',   cs: 'V\u00edkend',   en: 'Weekend',       subCs: '',                            subEn: '',                          by: 'day',   days: [0, 6] },
];

// Which window does a class fall into? Mirrors the rule above, so a club's own schedule can be
// matched against what people asked for without a translation layer.
export function windowOf(startHHMM, endHHMM, weekday) {
  if (weekday === 0 || weekday === 6) return 'weekend';
  const mins = (t) => { const m = /^(\d{1,2}):(\d{2})/.exec(String(t || '')); return m ? (+m[1] * 60 + +m[2]) : null; };
  const e = mins(endHHMM), s = mins(startHHMM);
  if (e != null && e <= 8 * 60 + 30) return 'morning';   // decided by the END
  if (s == null) return null;
  if (s < 12 * 60) return 'forenoon';
  if (s < 16 * 60) return 'afternoon';
  if (s < 19 * 60 + 30) return 'earlyeve';
  return 'evening';
}

// -- Why people are not going to the clubs that already exist ---------------------------------
// FOUNDER-ONLY. None of this is ever shown to a club, and that is a deliberate simplification
// rather than a privacy rule: a club does not need to know why someone is NOT coming. It needs to
// know that someone WILL. That positive answer already exists in TIME_WINDOWS from step 1 of the
// form ("14 people can only train mornings"), which is the same fact in a usable shape. Feeding
// clubs the negative version would add a mechanic that helps nobody and can only cause offence.
//
// For MTL these answers are the most valuable thing in the dataset -- they explain why a market
// is not working -- so they are collected, aggregated in the founder hotspot, and stop there.
export const GAP_REASONS = [
  { v: 'time',       cs: '\u010cas',                 en: 'Time' },
  { v: 'distance',   cs: 'Doj\u00ed\u017ed\u011bn\u00ed', en: 'Distance' },
  { v: 'price',      cs: 'Cena',                     en: 'Price' },
  { v: 'level',      cs: '\u00darove\u0148',         en: 'Level' },
  { v: 'atmosphere', cs: 'Atmosf\u00e9ra',           en: 'Atmosphere' },
  { v: 'browsing',   cs: 'Nev\u00edm, jen hled\u00e1m', en: 'Just looking' },
];
