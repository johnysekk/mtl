// THE single source of truth for MTL's spatial constants. They used to live as five separate
// literals across four files and had already drifted: the deck and the founder hotspot ran on
// 20 km while the two demand endpoints ran on 25. That gap had a visible consequence -- a student
// was shown "every klub within 20 km" and the club was then handed people from 25 km, i.e. people
// the app had never shown that klub to.
//
// Everything is 20 km. It is the number the STUDENT was shown, so it is the only one that can be
// honestly reported back to a club.
//
// Deliberately NOT smaller (15 km was considered): shrinking the radius would also shrink what
// counts as "no klub near me", which would fire the passive demand signal MORE often and inflate
// the numbers -- the opposite of what tighter data should do. The real answer to "will these
// people actually come?" is not a smaller circle but showing the DISTRIBUTION (how many within
// 5 / 10 / 20 km), because the honest radius depends on the time of day: nobody drives 20 km to a
// 06:30 class, plenty will for an 18:00 one. One number cannot carry that; bands can.

export const LOCAL_KM = 20;      // "near me" everywhere: deck, hotspot clustering, gym coverage, demand
export const DEMAND_THRESHOLD = 15;  // unique people before a number is shown to a club (small-number privacy)
export const DEMAND_FRESH_DAYS = 120; // older signals are ignored entirely

// Bands the club-facing panel should lead with, nearest first. See MTL-poptavkovy-formular.md:
// lead with the SMALLEST number, never the total -- a club that opens a class expecting 14 and
// gets 4 never trusts the data again.
export const DEMAND_BANDS_KM = [5, 10, 20];
