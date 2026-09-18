// _vat.js — DANOVY REZIM NA DOKLADU. Jedno misto pro cely system.
//
// Rezim se neridi jen dodavatelem, ale i tim, CO se prodava a KDO je odberatel. Drive to
// umel jen ep-doklad.js pro predplatne EP a commission-cron pro provize; doklad organizace
// klubum zadny rezim nenesl, takze ceska federace fakturovala slovenskemu klubu s ceskou
// DPH a bez vety o prenesene dani.
//
// TOHLE JE MECHANIKA, NE DANOVE PORADENSTVI. Sazby, vety a hranice si nech potvrdit ucetni;
// kod jen zajistuje, ze doklad nese to, co mu ucetni rekne.

export const EU = ['AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU','IE','IT',
  'LV','LT','LU','MT','NL','PL','PT','RO','SK','SI','ES','SE'];

export const isEU = (cc) => EU.indexOf(String(cc || '').toUpperCase()) >= 0;

// kind rozhoduje o miste plneni:
//   'service'     obecna sluba (clensky poplatek federaci). B2B pres hranice v EU -> prenesena
//                 danova povinnost. Bez DIC odberatele rezim urcit nejde -> 'need_vat'.
//   'electronic'  elektronicky poskytovana sluba (predplatne EP). Bez DIC v EU je mistem
//                 plneni stat odberatele -> 'oss_pending', doklad nevystavovat automaticky.
//   'event'       VSTUP NA AKCI. Dani se tam, kde se akce kona, a to bez ohledu na to, odkud
//                 je kupujici a jestli je to firma nebo divak (cl. 53 smernice 2006/112/ES).
//                 Zadne DIC, zadna prenesena povinnost -- proto se jen prevezme rezim
//                 poradatele. Kdo pora akci v jine zemi, resi tamni registraci sam; appka
//                 mu do toho nemluvi a hlavne mu doklad nezmeni na neco, co neplati.
export function vatMode(supCountry, custCountry, custDic, opts = {}) {
  const kind = String(opts.kind || 'service');
  const supIsVatPayer = !!opts.supIsVatPayer;
  const sc = String(supCountry || 'CZ').toUpperCase();
  const cc = String(custCountry || sc).toUpperCase();

  if (!supIsVatPayer) return { mode: 'no_vat_supplier', note: 'Dodavatel není plátcem DPH.', rate: 0 };

  // CLENSKY PRISPEVEK SPOLKU VLASTNIM CLENUM je podle § 61 písm. a) zákona o DPH plnění
  // osvobozené od daně bez nároku na odpočet. Pak se rezim neresi vubec: neni co prenaset,
  // neni potreba DIC odberatele a poskytovatel se nestava identifikovanou osobou (§ 6i ma
  // pro osvobozene sluzby vyjimku). JE TO VOLBA ORGANIZACE, ne odhad appky -- judikatura
  // (NSS) rika, ze nalepka "clensky prispevek" sama nestaci, rozhoduji stanovy a to, za co
  // se plati. U preshranicniho odberatele navic posuzuje osvobozeni pravo JEHO statu.
  if (kind === 'membership' && opts.feeExempt) {
    return { mode: 'exempt_membership', rate: 0,
      note: 'Osvobozeno od DPH — plnění jako protihodnota členského příspěvku vlastním členům (§ 61 písm. a) zákona o DPH).' };
  }

  if (kind === 'event') {
    return { mode: 'domestic', rate: null,
      note: 'Vstup na akci — zdaněno v místě konání akce (čl. 53 směrnice 2006/112/ES).' };
  }

  if (cc === sc) return { mode: 'domestic', note: null, rate: null };

  if (isEU(cc)) {
    if (custDic) {
      return { mode: 'reverse_charge', rate: 0,
        note: 'Daň odvede příjemce plnění (reverse charge, čl. 196 směrnice 2006/112/ES).' };
    }
    if (kind === 'electronic') {
      return { mode: 'oss_pending', rate: 0,
        note: 'Odběratel bez DIČ v jiném státě EU — místem plnění je jeho stát (režim OSS). Doklad prověří účetní.' };
    }
    // Obecna sluzba bez DIC odberatele: nevime, jestli je to osoba povinna k dani, a podle
    // toho se lisi cely rezim. Doklad se nevystavi a odberatel se vyzve k doplneni DIC --
    // stejne jako u provizi MTL (brana require_vat_foreign).
    return { mode: 'need_vat', rate: 0,
      note: 'Odběratel v jiném státě EU bez DIČ — bez něj nelze určit daňový režim.' };
  }

  return { mode: 'outside_eu', rate: 0, note: 'Plnění mimo EU — bez české DPH (§ 9 zákona o DPH).' };
}

// Sazba, kterou ma doklad ukazat: vlastni sazba dodavatele jen u domaciho rezimu, jinak nula.
export function vatRateFor(mode, supRate) {
  return (mode === 'domestic') ? (supRate != null ? supRate : null) : 0;
}

// BRANA PRED PLATBOU. Prehranicni plneni v ramci EU se bez DIC odberatele nesmi vubec
// zaplatit: doklad by pak nesel vystavit a penize uz by lezely na uctu. Kontroluje se drive,
// nez se klubu ukaze QR kod nebo platebni tlacitko, ne az u vystavovani dokladu.
export function needVatBeforePay(supCountry, custCountry, custDic, feeExempt) {
  // PLATCOVSTVI DODAVATELE O NICEM NEROZHODUJE. Drive tu stalo `if (!supIsVatPayer) return
  // false`, jako by neplatce nic neresil. Podle § 6i ZDPH se cesky NEPLATCE stava
  // identifikovanou osobou uz dnem poskytnuti sluzby s mistem plneni v jinem clenskem state
  // a musi podat souhrnne hlaseni -- a v tom je DIC odberatele podstatnou naleziostí, bez
  // nej ho podat nelze. Rozhoduje tedy charakter plneni: osvobozene -> nic, zdanitelne ->
  // DIC je podminka.
  if (feeExempt) return false;
  const sc = String(supCountry || 'CZ').toUpperCase();
  const cc = String(custCountry || '').toUpperCase();
  if (!cc) return false;                               // zemi neznam -> nelze rozhodnout
  if (cc === sc) return false;                         // domaci plneni
  if (!isEU(cc)) return false;                         // mimo EU se DIC neuplatnuje
  return !String(custDic || '').trim();
}
