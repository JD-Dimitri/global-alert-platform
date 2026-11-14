// Connecteurs « granularité locale » : alertes officielles CAP (tous pays), foyers satellite,
// petits séismes (EMSC) et incidents rapportés par la presse (GDELT, étiquetés non vérifiés).
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { http, R, iso, hav, countryByIso3, parseCSV } from './lib.mjs';

const now = Date.now();

/* =====================================================================
   1. IFRC Alert Hub — alertes officielles au format CAP (≈130 pays)
   Schéma : https://github.com/IFRCGo/alert-hub-backend/blob/develop/schema.graphql
   ===================================================================== */
const CAP_SEV = { EXTREME: 5, SEVERE: 4, MODERATE: 3, MINOR: 2, UNKNOWN: 0 };
const CAP_SEV_FR = { EXTREME: 'extrême', SEVERE: 'sévère', MODERATE: 'modérée', MINOR: 'mineure', UNKNOWN: 'inconnue' };
export const CAP_CAT_FR = { GEO: 'Géophysique', MET: 'Météo', SAFETY: 'Sécurité publique', SECURITY: 'Sûreté', RESCUE: 'Secours', FIRE: 'Incendie',
  HEALTH: 'Santé', ENV: 'Environnement', TRANSPORT: 'Transports', INFRA: 'Infrastructures', CBRNE: 'NRBC', OTHER: 'Autre' };
const Q = `query($offset:Int!){ public { alerts(order:{sent:DESC}, pagination:{offset:$offset, limit:100}) { count items {
  id sent url sender status msgType identifier
  country { name iso3 }
  admin1s { name }
  infos { language event headline description instruction effective onset expires category severity urgency certainty senderName web
          areas { areaDesc polygons { value } circles { value } } }
} } } }`;

function capPoint(areas) {
  for (const a of areas || []) {
    for (const p of a.polygons || []) {
      const pts = String(p.value).trim().split(/\s+/).map(s => s.split(',').map(Number)).filter(([la, lo]) => Number.isFinite(la) && Number.isFinite(lo));
      if (pts.length) return { lat: pts.reduce((s, x) => s + x[0], 0) / pts.length, lng: pts.reduce((s, x) => s + x[1], 0) / pts.length, precision: 'zone', area: a.areaDesc };
    }
    for (const c of a.circles || []) {
      const [ll] = String(c.value).trim().split(/\s+/); const [la, lo] = ll.split(',').map(Number);
      if (Number.isFinite(la) && Number.isFinite(lo)) return { lat: la, lng: lo, precision: 'zone', area: a.areaDesc };
    }
  }
  return null;
}
const pickInfo = infos => infos.find(i => /^fr/i.test(i.language || '')) || infos.find(i => /^en/i.test(i.language || '')) || infos[0];

export async function alerthub() {
  const out = []; let offset = 0, count = Infinity;
  while (offset < count && offset < 4000) {
    const j = await http('https://alerthub-api.ifrc.org/graphql/', { timeout: 60000, method: 'POST', body: JSON.stringify({ query: Q, variables: { offset } }) });
    if (j.errors?.length) throw new Error('GraphQL : ' + j.errors[0].message);
    const page = j.data.public.alerts; count = page.count;
    for (const a of page.items) {
      if (a.status !== 'ACTUAL' || a.msgType === 'CANCEL' || !a.infos?.length) continue;
      const inf = pickInfo(a.infos);
      if (inf.expires && Date.parse(inf.expires) < now) continue;
      let pt = capPoint(inf.areas);
      const zone = (inf.areas || []).map(x => x.areaDesc).filter(Boolean).slice(0, 4).join(', ');
      if (!pt) { const c = countryByIso3(a.country?.iso3); if (!c) continue; pt = { lat: c.lat, lng: c.lng, precision: 'pays' }; }
      const sev = CAP_SEV[inf.severity] ?? 0;
      out.push({
        id: 'cap-' + a.id, cat: 'cap', titleOrig: inf.headline || inf.event, event: inf.event, capCat: inf.category,
        lat: R(pt.lat), lng: R(pt.lng), precision: pt.precision,
        time: iso(Date.parse(inf.onset || inf.effective || a.sent)), updated: iso(Date.parse(a.sent)), expires: inf.expires || null,
        sev, sevWhy: `Gravité CAP déclarée par l'autorité émettrice : « ${CAP_SEV_FR[inf.severity] || inf.severity} » (urgence ${inf.urgency?.toLowerCase?.()}, certitude ${inf.certainty?.toLowerCase?.()}).`,
        description: (inf.description || '').slice(0, 900), instruction: (inf.instruction || '').slice(0, 600),
        authority: inf.senderName || a.sender, zone: zone || (a.admin1s || []).map(x => x.name).join(', '), lang: inf.language,
        verif: 'officiel', sources: [{ n: `${inf.senderName || a.sender} (CAP via IFRC Alert Hub)`, u: inf.web || a.url }]
      });
    }
    offset += 100;
  }
  return out;
}

/* =====================================================================
   2. NASA FIRMS — anomalies thermiques VIIRS (24 h, fichiers publics sans clé)
   Agrégées en cellules de 0,2° pour rester lisibles et légères.
   ===================================================================== */
const FIRMS_FILES = [
  ['VIIRS NOAA-20', 'https://firms.modaps.eosdis.nasa.gov/data/active_fire/noaa-20-viirs-c2/csv/J1_VIIRS_C2_Global_24h.csv'],
  ['VIIRS S-NPP', 'https://firms.modaps.eosdis.nasa.gov/data/active_fire/suomi-npp-viirs-c2/csv/SUOMI_VIIRS_C2_Global_24h.csv'],
  ['MODIS', 'https://firms.modaps.eosdis.nasa.gov/data/active_fire/modis-c6.1/csv/MODIS_C6_1_Global_24h.csv']];
export async function firms() {
  let rows, sensor, last;
  for (const [name, url] of FIRMS_FILES) {
    try { rows = parseCSV(await http(url, { as: 'text', timeout: 120000 })); sensor = name; break; } catch (e) { last = e; }
  }
  if (!rows) throw last;
  const cells = new Map(), C = 0.2;
  for (const r of rows) {
    const conf = String(r.confidence || '').toLowerCase();
    if (conf === 'l' || conf === 'low' || (+conf && +conf < 30)) continue;     // détections peu fiables écartées
    const lat = +r.latitude, lng = +r.longitude, frp = +r.frp || 0; if (!Number.isFinite(lat)) continue;
    const k = Math.floor(lat / C) + ':' + Math.floor(lng / C);
    let c = cells.get(k); if (!c) cells.set(k, c = { n: 0, frp: 0, max: 0, la: 0, lo: 0, t: 0 });
    c.n++; c.frp += frp; c.max = Math.max(c.max, frp); c.la += lat; c.lo += lng;
    const t = Date.parse(`${r.acq_date}T${String(r.acq_time).padStart(4, '0').replace(/(\d\d)(\d\d)/, '$1:$2')}:00Z`); if (t > c.t) c.t = t;
  }
  return [...cells.entries()].sort((a, b) => b[1].frp - a[1].frp).slice(0, 3500).map(([k, c]) => ({
    id: 'firms-' + k.replace(/[:.]/g, '_'), cat: 'hotspot', titleOrig: `${c.n} détection(s) thermique(s)`, lat: R(c.la / c.n), lng: R(c.lo / c.n),
    time: iso(c.t), updated: iso(c.t), detections: c.n, frpSum: Math.round(c.frp), frpMax: Math.round(c.max), sensor,
    sev: c.frp > 1000 ? 3 : c.n >= 10 ? 2 : 1,
    sevWhy: `Puissance radiative cumulée ${Math.round(c.frp)} MW sur ${c.n} détection(s) : >1 000 MW modérée · ≥10 détections faible · sinon information. Indicateur satellite, sans évaluation au sol.`,
    verif: 'officiel', precision: 'cellule', sources: [{ n: `NASA FIRMS (${sensor})`, u: 'https://firms.modaps.eosdis.nasa.gov/map/' }]
  }));
}

/* =====================================================================
   3. EMSC — séismes (dont petites magnitudes, Europe / Méditerranée / océan Indien)
   ===================================================================== */
export async function emsc() {
  const start = new Date(now - 3 * 864e5).toISOString().slice(0, 19);
  const j = await http(`https://www.seismicportal.eu/fdsnws/event/1/query?format=json&limit=1500&minmag=1.5&start=${start}`, { timeout: 60000 });
  return (j.features || []).map(f => {
    const p = f.properties, [lng, lat] = f.geometry.coordinates, m = p.mag;
    const s = m == null ? 0 : m < 3 ? 1 : m < 4.5 ? 2 : m < 6 ? 3 : m < 7 ? 4 : 5;
    return {
      id: 'emsc-' + (p.unid || f.id), cat: 'quake', titleOrig: `M ${m} - ${p.flynn_region}`, placeOrig: p.flynn_region,
      lat: R(lat), lng: R(lng), depth: R(p.depth, 1), mag: m, magType: p.magtype, time: iso(Date.parse(p.time)), updated: iso(Date.parse(p.lastupdate || p.time)),
      sev: s, sevWhy: `Magnitude ${m} → barème séisme : <3 info · 3–4,5 faible · 4,5–6 modérée · 6–7 élevée · ≥7 critique`,
      verif: p.evtype === 'ke' || p.auth ? 'officiel' : 'officiel-auto', precision: 'exact',
      sources: [{ n: 'EMSC' + (p.auth ? ' / ' + p.auth : ''), u: `https://www.seismicportal.eu/eventdetails.html?unid=${p.unid}` }]
    };
  }).filter(e => Number.isFinite(e.lat));
}

/* =====================================================================
   4. GDELT GKG 2.0 — incidents locaux rapportés par la presse mondiale
   Fichiers publiés toutes les 15 min (anglais + traduction de 65 langues).
   ⚠ Données de presse : classification par mots-clés du titre, lieu géocodé
   automatiquement depuis le texte. Retenu seulement si ≥ 2 médias distincts.
   ===================================================================== */
export const PRESS_CATS = {
  roadacc: { fr: 'Accident de la route', re: /\b(accident(s)? de (la )?(route|circulation|voiture|moto|bus|camion)|accident routier|collision|carambolage|percut|car crash|road (accident|crash)|traffic (accident|collision)|crash on|bus (crash|accident)|truck (crash|accident)|motorcycle (crash|accident)|head-on|pile-?up|accidente (de tr[aá]fico|vial|de tr[aá]nsito)|choque (frontal|de veh)|acidente (de tr[aâ]nsito|rodovi[aá]rio)|verkehrsunfall|incidente stradale|scontro frontale)\b/i },
  shooting: { fr: 'Fusillade', re: /\b(fusillade|coups de feu|tir(s)? mortel|shooting|shot dead|gunman|gunfire|tiroteo|balacera|tiroteio|schie(ss|ß)erei|sparatoria)\b/i },
  attack: { fr: 'Agression / attaque', re: /\b(agression|agress[ée]|attaque au couteau|poignard|stabbing|stabbed|assault(ed)?|machete attack|apu[ñn]alad|agresi[oó]n|esfaquead|messerangriff|accoltellat|aggressione)\b/i },
  kidnap: { fr: 'Enlèvement', re: /\b(enl[eè]vement|enlev[ée]|kidnapp?(ed|ing)?|abduct(ed|ion)|secuestr|sequestr|entf[üu]hr|rapit[oa]|rapimento)\b/i },
  protest: { fr: 'Manifestation', re: /\b(manifestation|manifestants|protest(ers|s)?|demonstrat(ion|ors)|rally against|manifestaci[oó]n|manifestantes|protesto|kundgebung|demonstration|corteo)\b/i },
  blast: { fr: 'Incendie / explosion', re: /\b(explosion|incendie|blaze|fire (kills|broke out|destroys|engulf)|gas leak|explosi[oó]n|incendio|inc[eê]ndio|brand in|esplosione)\b/i }
};
const EXCLUDE = /\b(football|soccer|match|game|cup|league|election|stock|shares|film|movie|series|album|concert|video game|gaming|anniversary|years ago|trial of|sentenced|court|verdict|tribunal|proc[eè]s|condamn)/i;

function lastUpdateUrls(txt) { return txt.split('\n').map(l => l.trim().split(/\s+/)[2]).filter(u => u && /gkg\.csv\.zip$/.test(u)); }
function unzipText(buf) {
  const dir = mkdtempSync(join(tmpdir(), 'gkg-')), f = join(dir, 'f.zip');
  writeFileSync(f, buf);
  return execFileSync('unzip', ['-p', f], { maxBuffer: 1024 * 1024 * 512 }).toString('utf8');
}
async function fetchBuf(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(90000) });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + url);
  return Buffer.from(await r.arrayBuffer());
}
function pickLocation(v1) {
  // V1Locations : type#nom#pays(FIPS)#adm1#lat#lon#featureId ; types 3/4 = ville, 2/5 = état/région, 1 = pays
  const locs = (v1 || '').split(';').map(s => s.split('#')).filter(x => x.length >= 7 && x[4] && x[5]);
  const rank = t => ({ 3: 0, 4: 0, 2: 1, 5: 1 }[t] ?? 9);
  locs.sort((a, b) => rank(a[0]) - rank(b[0]));
  const l = locs[0]; if (!l || rank(l[0]) > 1) return null;
  return { name: l[1], lat: +l[4], lng: +l[5], fid: l[6], precision: rank(l[0]) === 0 ? 'ville' : 'region' };
}
function title(extras) { const m = /<PAGE_TITLE>([\s\S]*?)<\/PAGE_TITLE>/.exec(extras || ''); return m ? m[1].replace(/\s+/g, ' ').trim() : null; }

/** Lit les derniers fichiers GKG, renvoie les articles candidats (accumulés sur 48 h via le cache). */
export async function gdeltArticles(prevCache = []) {
  const [en, tr] = await Promise.all([
    http('http://data.gdeltproject.org/gdeltv2/lastupdate.txt', { as: 'text' }),
    http('http://data.gdeltproject.org/gdeltv2/lastupdate-translation.txt', { as: 'text' }).catch(() => '')]);
  const urls = [...lastUpdateUrls(en), ...lastUpdateUrls(tr)];
  if (!urls.length) throw new Error('lastupdate.txt sans fichier GKG');
  const seen = new Set(prevCache.map(a => a.u)), fresh = [];
  for (const url of urls) {
    const text = unzipText(await fetchBuf(url));
    for (const line of text.split('\n')) {
      const f = line.split('\t'); if (f.length < 27) continue;
      const u = f[4]; if (!u || seen.has(u)) continue;
      const t = title(f[26]); if (!t || EXCLUDE.test(t)) continue;
      const cat = Object.entries(PRESS_CATS).find(([, c]) => c.re.test(t))?.[0]; if (!cat) continue;
      const loc = pickLocation(f[9]); if (!loc) continue;
      seen.add(u);
      const d = f[1]; const ts = Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8), +d.slice(8, 10), +d.slice(10, 12));
      fresh.push({ u, t, cat, dom: f[3] || new URL(u).hostname, ts, loc, tr: url.includes('translation') });
    }
  }
  return [...prevCache.filter(a => now - a.ts < 48 * 3600e3), ...fresh];
}

/** Regroupe les articles par catégorie + lieu + 36 h ; ne garde que les incidents couverts par ≥ 2 médias distincts. */
export function clusterPress(arts) {
  const groups = [];
  for (const a of arts.sort((x, y) => x.ts - y.ts)) {
    const g = groups.find(g => g.cat === a.cat && (g.fid === a.loc.fid || hav(g, a.loc) < 15) && a.ts - g.last < 36 * 3600e3);
    if (g) { g.arts.push(a); g.last = a.ts; } else groups.push({ cat: a.cat, fid: a.loc.fid, lat: a.loc.lat, lng: a.loc.lng, name: a.loc.name, precision: a.loc.precision, first: a.ts, last: a.ts, arts: [a] });
  }
  return groups.map(g => ({ ...g, doms: [...new Set(g.arts.map(a => a.dom))] })).filter(g => g.doms.length >= 2).map(g => {
    const best = g.arts.find(a => !a.tr) || g.arts[0];
    return {
      id: `press-${g.cat}-${String(g.fid).replace(/[^A-Za-z0-9]/g, '')}-${Math.floor(g.first / 36e5)}`, cat: g.cat, press: true,
      titleOrig: best.t, placeOrig: g.name, lat: R(g.lat), lng: R(g.lng), precision: g.precision,
      time: iso(g.first), updated: iso(g.last), sev: 0,
      sevWhy: 'Information de presse : aucune évaluation officielle de gravité.',
      verif: 'presse', nMedia: g.doms.length,
      sources: g.arts.filter((a, i, all) => all.findIndex(b => b.dom === a.dom) === i).slice(0, 8).map(a => ({ n: a.dom, u: a.u, t: a.t }))
    };
  });
}
