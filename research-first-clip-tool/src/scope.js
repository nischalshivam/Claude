// ============================================================
//  scope.js — SHOW / EPISODE IDENTITY ka EK hi source of truth.
//
//  Kyun ye file bani (M3.6.1):
//  check-pack.js apna scope key `kind::title` se banata tha, locate.js
//  `kind::title::year::version` se. Do alag hisaab = check-pack ka forecast aur
//  render ka asli behaviour kabhi match nahi karte the.
//
//  Usse bada bug: SERIES ke scope mein `year` EPISODE ka air year hota hai
//  (P01=2011, P02=2008, P04=2009, P05=2015, P06=2012, P07=2025 — sab "Phineas
//  and Ferb"). Year ko show ki pehchaan maan lene se engine ek hi show ke
//  episodes ko SAAT ALAG SHOW samajh raha tha. Nateeja:
//    - `allow_context_borrow` kaam hi nahi karta tha (same-show pack milta hi nahi)
//    - scope_relation same-series footage ko CROSS_SHOW label kar deta tha
//
//  Isliye:
//    SERIES  -> show ki pehchaan = kind + title + version   (air year NAHI)
//    FILM    -> film ki pehchaan = kind + title + year + version  (year yahan
//               ASLI identity hai: 1998 wali film aur 2015 wali remake alag hain)
//    episode -> show + season + episode number + episode title + language/dub
//
//  version/cut/dub ko har jagah rakha hai taaki reboot ("2017 version"),
//  director's cut, aur dub alag-alag rahen.
// ============================================================
'use strict';

const norm = s => String(s == null ? '' : s).trim().toLowerCase().replace(/\s+/g, ' ');

// FILM jaise ek-baar-release hone wale kinds mein year hi identity ka hissa hai.
// SERIES/SEASON mein year episode ka air year hota hai — identity nahi.
const YEAR_IS_IDENTITY = new Set(['FILM', 'MOVIE', 'DOCUMENTARY', 'SPECIAL', 'SHORT', 'OVA']);

/** Show/film ki pehchaan. Ek hi show ke saare episodes ka ye EK hi hota hai. */
function workKey(sc) {
  if (!sc) return '';
  const kind = norm(sc.kind).toUpperCase();
  const bits = [kind, norm(sc.title)];
  if (YEAR_IS_IDENTITY.has(kind)) bits.push(sc.year == null ? '' : String(sc.year));
  bits.push(norm(sc.version || sc.cut || ''));
  return bits.join('::');
}

/** Episode ki pehchaan — "same show" ka matlab "same episode" nahi hota. */
function episodeKey(sc) {
  if (!sc) return '';
  const ep = [
    sc.season == null ? '' : `s${sc.season}`,
    sc.episode_number == null ? '' : `e${sc.episode_number}`,
    norm(sc.episode_title || ''),
    norm(sc.language || sc.dub || ''),
  ].join('|');
  return `${workKey(sc)}::${ep}`;
}

const isGraphic = sc => norm(sc && sc.kind).toUpperCase() === 'GRAPHIC';

/**
 * Do scopes ka rishta. `a` = beat ka apna scope, `b` = jo footage sach mein laga.
 * SAME_EPISODE | SAME_SHOW_OTHER_EPISODE | CROSS_SHOW | GRAPHIC | NONE
 */
function relation(a, b) {
  if (!a || !b) return 'NONE';
  if (isGraphic(a) || isGraphic(b)) return 'GRAPHIC';
  if (workKey(a) !== workKey(b)) return 'CROSS_SHOW';
  return episodeKey(a) === episodeKey(b) ? 'SAME_EPISODE' : 'SAME_SHOW_OTHER_EPISODE';
}

/** Wahi rishta jab sirf keys haath mein hon (resolved entries par yehi hota hai). */
function relationOfKeys(aWork, aEp, bWork, bEp) {
  if (!aWork || !bWork) return 'NONE';
  if (String(aWork).startsWith('GRAPHIC::') || String(bWork).startsWith('GRAPHIC::')) return 'GRAPHIC';
  if (aWork !== bWork) return 'CROSS_SHOW';
  return (aEp || aWork) === (bEp || bWork) ? 'SAME_EPISODE' : 'SAME_SHOW_OTHER_EPISODE';
}

/**
 * Poore pack ka index: pack -> keys, aur SOURCE -> uska ASLI maalik pack.
 *
 * Source ownership ab authoritative hai. Pehle timeline "pehla aisa moment
 * dhoondo jiske allowed_source_ids mein ye source hai" karke maalik guess karta
 * tha — bahut se moments ek hi source ko allow karte hain, isliye wo guess
 * galat scope_relation de sakta tha.
 */
function indexPack(pack) {
  const byPack = {}, byWork = {}, byEpisode = {}, sourceOwner = {};
  for (const pk of ((pack && pack.packs) || [])) {
    const sc = pk.scope || {};
    const wk = workKey(sc), ek = episodeKey(sc);
    byPack[pk.pack_id] = { pack_id: pk.pack_id, scope: sc, work_key: wk, episode_key: ek, graphic: isGraphic(sc) };
    if (wk && !isGraphic(sc)) {
      (byWork[wk] = byWork[wk] || []).push(pk.pack_id);
      (byEpisode[ek] = byEpisode[ek] || []).push(pk.pack_id);
    }
    for (const s of (pk.sources || [])) {
      sourceOwner[s.source_id] = { pack_id: pk.pack_id, work_key: wk, episode_key: ek, scope: sc };
    }
  }
  return { byPack, byWork, byEpisode, sourceOwner, works: Object.keys(byWork) };
}

module.exports = { workKey, episodeKey, relation, relationOfKeys, indexPack, isGraphic, norm };
