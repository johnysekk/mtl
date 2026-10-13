// /api/dac7-cron — DAC7: ŽÁDOST O ÚDAJE A UPOMÍNKY POSKYTOVATELŮM (denně, vercel.json).
//
// MTL jako provozovatel platformy musí do 31. ledna nahlásit za předchozí rok poskytovatele,
// kteří přes MTL prodávali osobní služby (tréninky, lekce, členství, kurzy) -- bez prahu objemu,
// ten platí jen pro zboží (FAQ Finanční správy k DAC7). Kdo nedodá údaje ani po dvou upomínkách,
// smí mu platforma po 60 dnech od žádosti účet zablokovat (§ 14zzc ZMSSD).
//
// Co se hlídá: totéž, co ukazuje Admin → DAC7 (renderDac7): země, IČO, adresa po částech
// (ulice, město, PSČ), u kouče datum narození. DIČ se nevyžaduje.
//
// Průběh pro poskytovatele s chybějícím údajem (tabulka dac7_requests, jeden řádek na rok):
//   den 0  žádost   ·  den 20 1. upomínka  ·  den 40 2. upomínka
//   den 60 upozornění adminovi s proklikem na profil poskytovatele (tam je tlačítko Pozastavit)
// Každý krok = notifikace v appce s proklikem na Fakturační údaje + e-mail. Doplněné údaje
// žádost uzavřou samy. Pozastavení dělá admin ručně (admin-suspend.js), ne tenhle cron.
import { providerTarget, providerNotify, providerMail, sbGet, sbWrite, esc, APP, FOUNDER_UUID } from './_provider-mail.js';

const q = encodeURIComponent;
const EU = ['AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU','IE','IT','LV','LT','LU','MT','NL','PL','PT','RO','SK','SI','ES','SE'];
const DAY = 86400000;
const STEP_DAYS = { rem1: 20, rem2: 40, admin: 60 };

const LBL = {
  country: ['země (stát sídla / bydliště)', 'country of residence'],
  ico: ['IČO', 'company / business ID'],
  address: ['adresa po částech (ulice, město, PSČ)', 'address split into street, city and postcode'],
  dob: ['datum narození', 'date of birth'],
};

// Všechny ostré transakce roku po stránkách (PostgREST vrací nejvýš 1000 řádků na dotaz).
async function yearTx(year) {
  const out = [];
  for (let off = 0; off < 200000; off += 1000) {
    const rows = await sbGet(`transactions?select=gym_id,coach_id,paid_to,type,test_mode&created_at=gte.${year}-01-01&created_at=lt.${year + 1}-01-01&order=created_at.asc&offset=${off}&limit=1000`);
    if (!rows || !rows.length) break;
    rows.forEach((t) => { if (!t.test_mode) out.push(t); });
    if (rows.length < 1000) break;
  }
  return out;
}

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return res.status(500).json({ error: 'CRON_SECRET not configured' });
  if ((req.headers.authorization || '') !== `Bearer ${secret}`) return res.status(401).json({ error: 'unauthorized' });

  const now = new Date();
  const year = Number(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Prague', year: 'numeric' }).format(now));
  const stats = { providers: 0, missing: 0, sent: { request: 0, rem1: 0, rem2: 0, admin: 0 }, resolved: 0 };
  try {
    // 1) Prodejci osobních služeb letos (stejné seskupení jako Admin → DAC7).
    const tx = await yearTx(year);
    const prov = {};
    tx.forEach((t) => {
      const coach = (t.paid_to === 'coach') || (t.coach_id && !t.gym_id);
      const id = coach ? t.coach_id : t.gym_id; if (!id) return;
      const k = (coach ? 'coach:' : 'gym:') + id;
      prov[k] = prov[k] || { kind: coach ? 'coach' : 'gym', id, svc: false };
      if (t.type !== 'merch') prov[k].svc = true;
    });
    const list = Object.values(prov).filter((p) => p.svc);
    stats.providers = list.length;

    // 2) Údaje -- klub i s majitelem (záloha, jako v Adminu), kouč z profilu.
    const gids = list.filter((p) => p.kind === 'gym').map((p) => p.id);
    const gm = {}, pm = {};
    for (let i = 0; i < gids.length; i += 100) {
      ((await sbGet(`gyms?id=in.(${gids.slice(i, i + 100).join(',')})&select=id,name,owner_id,tax_id,billing_line1,billing_city,billing_postal,billing_country`)) || []).forEach((g) => { gm[g.id] = g; });
    }
    const pids = [...new Set(list.filter((p) => p.kind === 'coach').map((p) => p.id).concat(Object.values(gm).map((g) => g.owner_id).filter(Boolean)))];
    for (let i = 0; i < pids.length; i += 100) {
      ((await sbGet(`profiles?id=in.(${pids.slice(i, i + 100).join(',')})&select=id,name,tax_id,billing_line1,billing_city,billing_postal,billing_country,birthdate`)) || []).forEach((p) => { pm[p.id] = p; });
    }
    const split = (x) => !!(x && x.billing_line1 && x.billing_city && x.billing_postal);
    const missingOf = (p) => {
      const g = p.kind === 'gym' ? (gm[p.id] || {}) : null;
      const pr = p.kind === 'gym' ? (pm[g && g.owner_id] || {}) : (pm[p.id] || {});
      const cc = String((g && g.billing_country) || pr.billing_country || '').toUpperCase();
      if (cc && !EU.includes(cc)) return null;                  // mimo EU se nehlásí
      const m = [];
      if (!cc) m.push('country');
      if (!(g && g.tax_id) && !pr.tax_id) m.push('ico');
      if (!split(g) && !split(pr)) m.push('address');
      if (p.kind === 'coach' && !pr.tax_id && !pr.birthdate) m.push('dob');
      return m;
    };

    // 3) Otevřené žádosti letošního roku.
    const reqRows = (await sbGet(`dac7_requests?year=eq.${year}&select=*`)) || [];
    const reqBy = {}; reqRows.forEach((r) => { reqBy[r.entity_kind + ':' + r.entity_id] = r; });

    for (const p of list) {
      const key = p.kind + ':' + p.id;
      const miss = missingOf(p);
      const r = reqBy[key];
      if (!miss || !miss.length) {
        if (r && !r.resolved_at) { await sbWrite('PATCH', `dac7_requests?id=eq.${r.id}`, { resolved_at: now.toISOString(), missing: [] }); stats.resolved++; }
        continue;
      }
      stats.missing++;
      let row = r, step = null;
      if (!row) {
        row = { entity_kind: p.kind, entity_id: p.id, year, missing: miss, first_at: now.toISOString() };
        await sbWrite('POST', 'dac7_requests', row);
        step = 'request';
      } else if (row.resolved_at) {
        // Údaje zase chybí (někdo je smazal) -- žádost začíná znovu od nuly.
        row = Object.assign({}, row, { first_at: now.toISOString(), rem1_at: null, rem2_at: null, admin_at: null, resolved_at: null, missing: miss });
        await sbWrite('PATCH', `dac7_requests?id=eq.${row.id}`, { first_at: row.first_at, rem1_at: null, rem2_at: null, admin_at: null, resolved_at: null, missing: miss });
        step = 'request';
      } else {
        const age = (now - new Date(row.first_at)) / DAY;
        if (!row.rem1_at && age >= STEP_DAYS.rem1) step = 'rem1';
        else if (row.rem1_at && !row.rem2_at && age >= STEP_DAYS.rem2) step = 'rem2';
        else if (row.rem2_at && !row.admin_at && age >= STEP_DAYS.admin) step = 'admin';
        if (JSON.stringify(row.missing || []) !== JSON.stringify(miss)) await sbWrite('PATCH', `dac7_requests?id=eq.${row.id}`, { missing: miss });
      }
      if (!step) continue;

      const T = await providerTarget(p.kind, p.id);
      if (!T) continue;
      const deadline = new Date(new Date(row.first_at).getTime() + STEP_DAYS.admin * DAY);
      const fmt = (d, en) => d.toLocaleDateString(en ? 'en-GB' : 'cs-CZ', { timeZone: 'Europe/Prague' });

      if (step === 'admin') {
        const lst = miss.map((m) => LBL[m][0]).join(', ');
        const msg_cs = `🧾 DAC7: ${p.kind === 'gym' ? 'klub' : 'kouč'} ${T.name} ani po žádosti a dvou upomínkách nedoplnil údaje (${lst}). Uběhlo 60 dní od žádosti (${fmt(new Date(row.first_at), false)}) — můžeš účet pozastavit.`;
        await providerNotify(FOUNDER_UUID, { kind: 'dac7_overdue', entity: p.kind, id: p.id, name: T.name, missing: miss, first_at: row.first_at,
          msg_cs, msg_en: `🧾 DAC7: ${p.kind === 'gym' ? 'club' : 'coach'} ${T.name} has not supplied the data (${miss.map((m) => LBL[m][1]).join(', ')}) after the request and two reminders. 60 days have passed — you can suspend the account.` });
        await sbWrite('PATCH', `dac7_requests?id=eq.${row.id}`, { admin_at: now.toISOString() });
        stats.sent.admin++;
        continue;
      }

      const en = T.lang === 'en';
      const lst = miss.map((m) => LBL[m][en ? 1 : 0]).join(', ');
      const subj = { gym: ['klub', 'club'], coach: ['profil kouče', 'coach profile'] }[p.kind];
      const stepCs = step === 'request' ? 'Žádost o doplnění údajů' : (step === 'rem1' ? '1. upomínka' : '2. upomínka');
      const stepEn = step === 'request' ? 'Request for missing details' : (step === 'rem1' ? '1st reminder' : '2nd reminder');
      const msg_cs = `🧾 ${stepCs} (DAC7): u ${subj[0] === 'klub' ? 'klubu' : 'profilu kouče'} ${T.name} chybí ${lst}. MTL je ze zákona musí za rok ${year} nahlásit finančnímu úřadu (DAC7). Doplň je ve Fakturačních údajích do ${fmt(deadline, false)} — jinak může být účet pozastaven.`;
      const msg_en = `🧾 ${stepEn} (DAC7): ${subj[1]} ${T.name} is missing ${lst}. By law MTL has to report them to the tax office for ${year} (DAC7). Add them in Billing details by ${fmt(deadline, true)}, otherwise the account may be suspended.`;
      await providerNotify(T.ownerId, { kind: 'dac7_data_needed', entity: p.kind, id: p.id, name: T.name, missing: miss, step, deadline: deadline.toISOString(), msg_cs, msg_en });
      await providerMail(T.email,
        en ? `${stepEn}: missing details for ${T.name} (DAC7)` : `${stepCs}: chybějící údaje u ${T.name} (DAC7)`,
        en
          ? ['Hello,', `the ${subj[1]} <b>${esc(T.name)}</b> is missing: <b>${esc(lst)}</b>.`,
             `As a platform operator, MTL has to report to the tax office once a year the providers who sold services through MTL and the amounts they received (EU directive DAC7). Without these details the report cannot be filed.`,
             `Please add them in the app under <b>Billing details</b> by <b>${fmt(deadline, true)}</b>. If they are still missing then, MTL may suspend the account until they are added.`]
          : ['Dobrý den,', `u ${subj[0] === 'klub' ? 'klubu' : 'profilu kouče'} <b>${esc(T.name)}</b> chybí: <b>${esc(lst)}</b>.`,
             `MTL jako provozovatel platformy musí jednou ročně nahlásit finančnímu úřadu poskytovatele, kteří přes MTL prodávali služby, a částky, které za ně dostali (evropská směrnice DAC7). Bez těchto údajů hlášení podat nejde.`,
             `Doplň je prosím v appce ve <b>Fakturačních údajích</b> do <b>${fmt(deadline, false)}</b>. Pokud budou i potom chybět, může MTL účet do jejich doplnění pozastavit.`],
        { text: en ? 'Add the details' : 'Doplnit údaje', url: `${APP}/?go=billing&k=${q(p.kind)}&id=${q(p.id)}` });
      if (step !== 'request') await sbWrite('PATCH', `dac7_requests?id=eq.${row.id}`, step === 'rem1' ? { rem1_at: now.toISOString() } : { rem2_at: now.toISOString() });
      stats.sent[step]++;
    }
    return res.status(200).json({ ok: true, year, ...stats });
  } catch (e) {
    console.error('[dac7-cron]', e.message);
    return res.status(500).json({ error: e.message, ...stats });
  }
}
