// ════════════════════════════════════════════════════════════════════════════
// JAK ZMĚNIT PODMÍNKY:
// 1) přepiš text mezi `zpětnými apostrofy` níže (piš normálně, jako do Wordu)
// 2) změň datum ve 'version' u toho jazyka na dnešní (např. 'cs-2026-08-10')
// 3) ulož a nasaď. Hotovo. (Formátování a všechno ostatní řeší appka sama.)
// ════════════════════════════════════════════════════════════════════════════
//
// PSANÍ TEXTU (nemusíš umět HTML):
//   • Řádek NAPSANÝ VELKÝMI PÍSMENY  = nadpis (appka ho udělá tučný, větší)
//   • Prázdný řádek                  = mezera mezi odstavci
//   • Řádek začínající "- " nebo "• " = odrážka
//   • Všechno ostatní                = normální odstavec
//   To je vše. Piš jako mail; appka to zobrazí hezky.
//
// DŮLEŽITÉ: text a 'version' patří k sobě. Když změníš text, ZMĚŇ i datum ve
// version u toho JEDNOHO jazyka. Ostatní jazyky se nedotýkej. Když bys na to
// zapomněl, appka tě sama upozorní (žádné tiché chyby).
//
// Přidat další jazyk = přidej další klíč (např. de:{...}) jen tam, kde MTL
// právně nabízí službu.
// ════════════════════════════════════════════════════════════════════════════

window.MTL_LEGAL = {

  // ── PODMÍNKY & ZŘEKNUTÍ SE ODPOVĚDNOSTI ──────────────────────────────────
  terms: {
    cs: {
      version: 'cs-2026-06-26',
      text: `SEM VLOŽ ČESKÉ ZNĚNÍ PODMÍNEK.

Piš normálně. Nadpisy velkými písmeny, odstavce oddělené prázdným řádkem,
odrážky začni "- ".`
    },
    en: {
      version: 'en-2026-06-26',
      text: `PUT THE ENGLISH TERMS HERE.

Write normally. Headings in CAPS, paragraphs separated by a blank line,
bullets start with "- ".`
    }
  },

  // ── ZÁSADY OCHRANY OSOBNÍCH ÚDAJŮ (GDPR) ─────────────────────────────────
  privacy: {
    cs: {
      version: 'cs-2026-06-26',
      text: `SEM VLOŽ ČESKÉ ZNĚNÍ ZÁSAD OCHRANY OSOBNÍCH ÚDAJŮ.`
    },
    en: {
      version: 'en-2026-06-26',
      text: `PUT THE ENGLISH PRIVACY POLICY HERE.`
    }
  },

  // ── PODMÍNKY SPOLUPRÁCE (kouč / gym) ─────────────────────────────────────
  partner: {
    cs: {
      version: 'cs-2026-06-26',
      text: `SEM VLOŽ ČESKÉ ZNĚNÍ PODMÍNEK SPOLUPRÁCE.`
    },
    en: {
      version: 'en-2026-06-26',
      text: `PUT THE ENGLISH PARTNER TERMS HERE.`
    }
  }

};

// ── Formátovač: plain text -> hezké HTML (appka to volá sama; needituj) ──────
window.mtlLegalHtml = function (raw) {
  var esc = function (s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); };
  var lines = String(raw || '').replace(/\r/g, '').split('\n');
  var out = [], list = null;
  var flush = function () { if (list) { out.push('<ul style="margin:6px 0 12px;padding-left:20px;">' + list.join('') + '</ul>'); list = null; } };
  for (var i = 0; i < lines.length; i++) {
    var t = lines[i].trim();
    if (!t) { flush(); continue; }
    if (/^[-•]\s+/.test(t)) { if (!list) list = []; list.push('<li style="margin-bottom:4px;line-height:1.5;">' + esc(t.replace(/^[-•]\s+/, '')) + '</li>'); continue; }
    flush();
    var letters = t.replace(/[^A-Za-zÀ-ž]/g, '');
    var isHeading = letters.length >= 2 && letters === letters.toUpperCase();
    if (isHeading) out.push('<div style="font-weight:800;font-size:15px;color:var(--dark);margin:16px 0 6px;">' + esc(t) + '</div>');
    else out.push('<p style="margin:0 0 10px;line-height:1.55;color:var(--mid);">' + esc(t) + '</p>');
  }
  flush();
  return out.join('');
};

// ── Helper appky: vrátí {version, html} pro daný dokument + aktuální jazyk ────
window.mtlLegalDoc = function (kind, lang) {
  try {
    var d = (window.MTL_LEGAL[kind] || {});
    var e = d[lang] || d.cs || d.en || {};
    return { version: e.version || (kind + '-0'), text: e.text || '', html: window.mtlLegalHtml(e.text || '') };
  } catch (e) { return { version: kind + '-0', text: '', html: '' }; }
};
