// Collecteur des événements (toutes les 10 min via GitHub Actions).
// Uniquement des sources publiques, gratuites et officielles ou institutionnelles.
// Sortie : data/events.json + data/status.json
import { http, runConnector, countryOf, countryByName, hav, R, iso, readJSON, writeJSON } from './lib.mjs';

const OUT = process.env.OUT_DIR || 'data';
const PREV = process.env.PREV_DIR || 'prev';
const now = Date.now();
const status = {};
const prev = readJSON(`${PREV}/events.json`, { events: [], nongeo: [] });
const prevStatus = readJSON(`${PREV}/status.json`, {});

/* ===================== Barèmes de gravité (1–5, 0 = indéterminée) ===================== */
const sevQuake = m => m == null ? [0, 'Magnitude inconnue'] :
  [m < 3 ? 1 : m < 4.5 ? 2 : m < 6 ? 3 : m < 7 ? 4 : 5, `Magnitude ${m.toFixed(1)} → barème séisme : <3 info · 3–4,5 faible · 4,5–6 modérée · 6–7 élevée · ≥7 critique`];
const GDACS_SEV = { green: 2, orange: 4, red: 5 };
function sevMeasure(cat, v, unit) {
  if (v == null) return null;
  if (cat === 'storm' && /kts|knot/i.test(unit || '')) return [v < 34 ? 2 : v < 64 ? 3 : v < 96 ? 4 : 5, `Vent soutenu ${v} nœuds → <34 faible · 34–63 modérée · 64–95 élevée · ≥96 critique`];
  if (cat === 'fire' && /acre/i.test(unit || '')) return [v < 1000 ? 2 : v < 1e4 ? 3 : v < 1e5 ? 4 : 5, `Surface ${Math.round(v).toLocaleString('fr-FR')} acres → <1 000 faible · 1 000–10 000 modérée · 10 000–100 000 élevée · >100 000 critique`];
  return null;
}

/* ===================== Connecteurs ===================== */
const C = {
  usgs: { id: 'usgs', name: 'USGS Earthquake Hazards Program', url: 'https://earthquake.usgs.gov/earthquakes/feed/', licence: 'Domaine public (gouvernement des États-Unis)', cats: ['quake'] },
  eonet: { id: 'eonet', name: 'NASA EONET v3', url: 'https://eonet.gsfc.nasa.gov/', licence: 'Domaine public (NASA)', cats: ['fire', 'storm', 'flood', 'volcano', 'drought', 'ice'] },
  gdacs: { id: 'gdacs', name: 'GDACS — Commission européenne (JRC) / ONU', url: 'https://www.gdacs.org/', licence: 'Réutilisation libre avec attribution', cats: ['quake', 'storm', 'flood', 'volcano', 'drought', 'fire'] },
  asam: { id: 'asam', name: 'NGA — Anti-Shipping Activity Messages', url: 'https://msi.nga.mil/Piracy', licence: 'Domaine public (gouvernement des États-Unis)', cats: ['piracy'] },
  ll2: { id: 'll2', name: 'Launch Library 2 (The Space Devs)', url: 'https://thespacedevs.com/llapi', licence: 'Gratuit (offre libre, 15 requêtes/h), attribution', cats: ['launch'] },
  cneos: { id: 'cneos', name: 'NASA JPL CNEOS — Fireballs', url: 'https://cneos.jpl.nasa.gov/fireballs/', licence: 'Domaine public (NASA/JPL)', cats: ['fireball'] },
  who: { id: 'who', name: 'OMS — Disease Outbreak News', url: 'https://www.who.int/emergencies/disease-outbreak-news', licence: 'OMS — réutilisation non commerciale avec attribution', cats: ['health'] },
  kev: { id: 'kev', name: 'CISA — Known Exploited Vulnerabilities', url: 'https://www.cisa.gov/known-exploited-vulnerabilities-catalog', licence: 'Domaine public (gouvernement des États-Unis)', cats: ['cyber'] }
};

async function usgs() {
  const [a, b] = await Promise.all([
    http('https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_week.geojson'),
    http('https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_month.geojson')]);
  const seen = new Map();
  for (const f of [...a.features, ...b.features]) {
    if (seen.has(f.id)) continue;
    const p = f.properties, [lng, lat, depth] = f.geometry.coordinates, [sev, why] = sevQuake(p.mag);
    seen.set(f.id, {
      id: 'usgs-' + f.id, cat: 'quake', title: `Séisme de magnitude ${p.mag?.toFixed(1) ?? '?'}`, titleOrig: p.title, placeOrig: p.place,
      lat: R(lat), lng: R(lng), depth: R(depth, 1), mag: p.mag, time: iso(p.time), updated: iso(p.updated), sev, sevWhy: why,
      verif: p.status === 'reviewed' ? 'officiel-revu' : 'officiel-auto',
      tsunami: p.tsunami === 1, felt: p.felt || null, pager: p.alert || null,
      precision: 'exact', sources: [{ n: 'USGS', u: p.url }]
    });
  }
  return [...seen.values()];
}

const EONET_MAP = { wildfires: 'fire', severeStorms: 'storm', floods: 'flood', volcanoes: 'volcano', drought: 'drought', seaLakeIce: 'ice' };
const centroid = g => {
  if (g.type === 'Point') return g.coordinates;
  const ring = g.type === 'Polygon' ? g.coordinates[0] : g.coordinates[0][0];
  return [ring.reduce((s, p) => s + p[0], 0) / ring.length, ring.reduce((s, p) => s + p[1], 0) / ring.length];
};
async function eonet() {
  const j = await http('https://eonet.gsfc.nasa.gov/api/v3/events?status=open&days=60');
  const out = [];
  for (const ev of j.events || []) {
    const cat = EONET_MAP[ev.categories?.[0]?.id]; if (!cat || !ev.geometry?.length) continue;
    const g = ev.geometry[ev.geometry.length - 1], [lng, lat] = centroid(g);
    const s = sevMeasure(cat, g.magnitudeValue, g.magnitudeUnit) || [0, 'La source ne fournit pas de mesure permettant d\'évaluer la gravité.'];
    out.push({
      id: 'eonet-' + ev.id, cat, titleOrig: ev.title, lat: R(lat), lng: R(lng),
      time: iso(ev.geometry[0].date), updated: iso(g.date), sev: s[0], sevWhy: s[1], mag: g.magnitudeValue ?? null, magUnit: g.magnitudeUnit || null,
      verif: 'officiel', precision: g.type === 'Point' ? 'approx' : 'zone',
      track: ev.geometry.slice(-12).map(x => { const c = centroid(x); return [iso(x.date), R(c[1], 2), R(c[0], 2), x.magnitudeValue ?? null]; }),
      sources: [{ n: 'NASA EONET', u: ev.link }, ...(ev.sources || []).map(s => ({ n: s.id, u: s.url }))]
    });
  }
  return out;
}

const GDACS_MAP = { EQ: 'quake', TC: 'storm', FL: 'flood', VO: 'volcano', DR: 'drought', WF: 'fire' };
async function gdacs() {
  const j = await http('https://www.gdacs.org/gdacsapi/api/events/geteventlist/MAP', { timeout: 45000 });
  const out = [];
  for (const f of j.features || []) {
    const p = f.properties || {}, cat = GDACS_MAP[p.eventtype]; if (!cat || !f.geometry) continue;
    if (p.iscurrent === false || p.iscurrent === 'false') continue;
    const [lng, lat] = f.geometry.type === 'Point' ? f.geometry.coordinates : centroid(f.geometry);
    const lvl = String(p.alertlevel || '').toLowerCase(), sev = GDACS_SEV[lvl] ?? 0;
    const sd = p.severitydata || {};
    out.push({
      id: `gdacs-${p.eventtype}-${p.eventid}`, cat, titleOrig: p.name || p.description, lat: R(lat), lng: R(lng),
      time: iso(Date.parse(p.fromdate)), updated: iso(Date.parse(p.datemodified || p.todate || p.fromdate)),
      sev, sevWhy: sev ? `Niveau d'alerte GDACS « ${p.alertlevel} » (évaluation d'impact humanitaire : vert faible · orange élevé · rouge critique)${sd.severitytext ? ' — ' + sd.severitytext : ''}` : 'Niveau GDACS non fourni.',
      gdacsLevel: p.alertlevel || null, verif: 'officiel', precision: p.eventtype === 'EQ' ? 'exact' : 'approx',
      countryHint: p.country || null,
      sources: [{ n: 'GDACS', u: p.url?.report || `https://www.gdacs.org/report.aspx?eventtype=${p.eventtype}&eventid=${p.eventid}` }]
    });
  }
  return out;
}

async function asam() {
  const since = new Date(now - 120 * 864e5).toISOString().slice(0, 10);
  const j = await http(`https://msi.nga.mil/api/publications/asam?output=json&sort=date&minOccurDate=${since}`, { timeout: 45000 });
  const list = j.asam || j.data || [];
  return list.map(a => {
    const lat = +a.latitude, lng = +a.longitude;
    return {
      id: 'asam-' + String(a.reference).replace(/[^A-Za-z0-9]/g, '-'), cat: 'piracy',
      titleOrig: `${a.hostility || 'Incident'} — ${a.victim || 'navire'}`, description: a.description || '',
      lat: R(lat), lng: R(lng), time: iso(Date.parse(a.date)), updated: iso(Date.parse(a.date)),
      sev: 0, sevWhy: 'Les messages ASAM ne comportent pas d\'échelle de gravité normalisée.',
      verif: 'officiel', precision: 'approx', hostility: a.hostility || null, victim: a.victim || null,
      sources: [{ n: 'NGA ASAM ' + a.reference, u: 'https://msi.nga.mil/Piracy' }]
    };
  }).filter(e => Number.isFinite(e.lat) && Number.isFinite(e.lng));
}

async function ll2() {
  const base = 'https://ll.thespacedevs.com/2.3.0/launches';
  const [up, past] = await Promise.all([http(`${base}/upcoming/?limit=40&mode=normal`), http(`${base}/previous/?limit=30&mode=normal`)]);
  const map = (l, done) => {
    const pad = l.pad || {}, lat = parseFloat(pad.latitude), lng = parseFloat(pad.longitude);
    const st = l.status?.abbrev || '';
    const confirmed = ['Success', 'Failure', 'Partial Failure', 'In Flight'].includes(st);
    return {
      id: 'll2-' + l.id, cat: 'launch', titleOrig: l.name, lat: R(lat), lng: R(lng),
      time: iso(Date.parse(l.net)), updated: iso(Date.parse(l.last_updated || l.net)),
      sev: st === 'Failure' || st === 'Partial Failure' ? 3 : 1,
      sevWhy: st === 'Failure' ? 'Échec de lancement confirmé.' : 'Lancement : information (pas de danger évalué).',
      verif: confirmed ? 'officiel' : 'annonce', launchStatus: l.status?.name || null, launchStatusAbbrev: st,
      provider: l.launch_service_provider?.name || null, rocket: l.rocket?.configuration?.full_name || null,
      mission: l.mission?.name || null, missionDesc: l.mission?.description || null, padName: pad.name || null, upcoming: !done,
      precision: 'exact', sources: [{ n: 'Launch Library 2', u: l.url }]
    };
  };
  return [...up.results.map(l => map(l, false)), ...past.results.map(l => map(l, true))].filter(e => Number.isFinite(e.lat));
}

async function cneos() {
  const j = await http('https://ssd-api.jpl.nasa.gov/fireball.api?limit=60&req-loc=true');
  const F = j.fields || [];
  const ix = k => F.indexOf(k);
  return (j.data || []).map(r => {
    const lat = +r[ix('lat')] * (r[ix('lat-dir')] === 'S' ? -1 : 1), lng = +r[ix('lon')] * (r[ix('lon-dir')] === 'W' ? -1 : 1);
    const t = Date.parse(r[ix('date')].replace(' ', 'T') + 'Z'), kt = +r[ix('impact-e')];
    return {
      id: 'cneos-' + r[ix('date')].replace(/[^0-9]/g, ''), cat: 'fireball', titleOrig: `Fireball ${r[ix('date')]} UTC`,
      lat: R(lat, 1), lng: R(lng, 1), time: iso(t), updated: iso(t),
      sev: 1, sevWhy: 'Bolide détecté par capteurs gouvernementaux : information.',
      energyKt: Number.isFinite(kt) ? kt : null, altKm: r[ix('alt')] ? +r[ix('alt')] : null, velKms: r[ix('vel')] ? +r[ix('vel')] : null,
      verif: 'officiel', precision: 'approx', sources: [{ n: 'NASA JPL CNEOS', u: 'https://cneos.jpl.nasa.gov/fireballs/' }]
    };
  }).filter(e => Number.isFinite(e.lat) && Number.isFinite(e.lng));
}

async function who() {
  const j = await http("https://www.who.int/api/news/diseaseoutbreaknews?sf_culture=en&$orderby=PublicationDateAndTime%20desc&$top=40");
  const out = [];
  for (const d of j.value || []) {
    const title = d.Title || d.OverrideTitle || '';
    const parts = title.split(/\s[-–—]\s/); const place = parts.length > 1 ? parts[parts.length - 1] : null;
    const c = place && countryByName(place.replace(/\s*\(.*?\)\s*$/, '').trim()) || (place && countryByName(place.trim()));
    const t = Date.parse(d.PublicationDateAndTime || d.PublicationDate);
    if (now - t > 180 * 864e5) continue;
    out.push({
      id: 'who-' + (d.DonId || d.Id || d.UrlName), cat: 'health', titleOrig: title, disease: parts.length > 1 ? parts.slice(0, -1).join(' – ') : title,
      lat: c ? R(c.lat, 2) : null, lng: c ? R(c.lng, 2) : null, countryForced: c ? { name: c.name, iso2: c.iso2 } : null,
      time: iso(t), updated: iso(Date.parse(d.LastModified || d.PublicationDateAndTime || t)),
      sev: 0, sevWhy: 'L\'OMS publie une évaluation de risque dans le texte ; elle n\'est pas convertie automatiquement.',
      verif: 'officiel', precision: c ? 'pays' : 'none',
      sources: [{ n: 'OMS DON', u: d.UrlName ? `https://www.who.int/emergencies/disease-outbreak-news/item/${d.UrlName}` : C.who.url }]
    });
  }
  return out;
}

async function kev() {
  const j = await http('https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json', { timeout: 45000 });
  return (j.vulnerabilities || []).filter(v => now - Date.parse(v.dateAdded) < 45 * 864e5).map(v => ({
    id: 'kev-' + v.cveID, cat: 'cyber', titleOrig: `${v.cveID} — ${v.vulnerabilityName}`, vendor: v.vendorProject, product: v.product,
    description: v.shortDescription, ransomware: v.knownRansomwareCampaignUse === 'Known', dueDate: v.dueDate,
    lat: null, lng: null, time: iso(Date.parse(v.dateAdded)), updated: iso(Date.parse(v.dateAdded)),
    sev: v.knownRansomwareCampaignUse === 'Known' ? 4 : 3, sevWhy: 'Vulnérabilité activement exploitée (catalogue KEV de la CISA)' + (v.knownRansomwareCampaignUse === 'Known' ? ', utilisée par des rançongiciels.' : '.'),
    verif: 'officiel', precision: 'none', sources: [{ n: 'CISA KEV', u: `https://nvd.nist.gov/vuln/detail/${v.cveID}` }]
  }));
}

/* ===================== Exécution ===================== */
// Launch Library 2 : offre gratuite limitée à 15 requêtes/h → appel au plus toutes les 30 min, sinon cache.
const ll2Due = !prevStatus.ll2 || prevStatus.ll2.state !== 'ok' || now - Date.parse(prevStatus.ll2.lastCheck) > 29 * 60e3;
const results = await Promise.all([
  runConnector(C.usgs, usgs, status), runConnector(C.eonet, eonet, status), runConnector(C.gdacs, gdacs, status),
  runConnector(C.asam, asam, status), ll2Due ? runConnector(C.ll2, ll2, status) : Promise.resolve(null),
  runConnector(C.cneos, cneos, status), runConnector(C.who, who, status), runConnector(C.kev, kev, status)]);
const byId = Object.fromEntries(Object.keys(C).map((k, i) => [k, results[i]]));

// En cas d'échec ponctuel (ou LL2 non dû), on réutilise la dernière collecte réussie, en le signalant.
const prevAll = [...(prev.events || []), ...(prev.nongeo || [])];
for (const k of Object.keys(C)) {
  if (byId[k]) continue;
  const old = prevAll.filter(e => (e.via ? e.via[0] === k : e.id.startsWith(k + '-')));
  byId[k] = old;
  if (!ll2Due && k === 'll2' && prevStatus.ll2) status.ll2 = { ...prevStatus.ll2, note: 'Cache (appel limité à 1 toutes les 30 min)' };
  else if (status[k]) status[k].note = old.length ? `Échec : ${old.length} élément(s) de la collecte précédente conservés` : 'Échec, aucune donnée en cache';
}

/* ===================== Fusion / déduplication multi-sources ===================== */
let all = Object.entries(byId).flatMap(([k, list]) => (list || []).map(e => ({ ...e, via: e.via || [k] })));
const primary = all.filter(e => !e.id.startsWith('gdacs-'));
const gd = all.filter(e => e.id.startsWith('gdacs-'));
const tol = { quake: [100, 5 * 60e3], storm: [400, 4 * 864e5], flood: [200, 10 * 864e5], fire: [100, 7 * 864e5], volcano: [50, 30 * 864e5], drought: [500, 60 * 864e5] };
let merged = 0;
for (const g of gd) {
  const [dk, dt] = tol[g.cat] || [100, 864e5];
  const nameKey = (g.titleOrig || '').toLowerCase().match(/[a-z]{4,}/g) || [];
  let best = null, bestD = Infinity;
  for (const p of primary) {
    if (p.cat !== g.cat || p.lat == null) continue;
    const d = hav(p, g), tdiff = Math.abs(Date.parse(p.time) - Date.parse(g.time));
    const nameHit = g.cat === 'storm' && nameKey.some(w => (p.titleOrig || '').toLowerCase().includes(w));
    if ((d <= dk && tdiff <= dt) || (nameHit && d < 1500)) { if (d < bestD) { best = p; bestD = d; } }
  }
  if (best) {
    merged++;
    best.sources.push(...g.sources); best.via = [...new Set([...best.via, ...g.via])];
    best.gdacsLevel = g.gdacsLevel;
    if (g.sev > best.sev) { best.sev = g.sev; best.sevWhy = g.sevWhy; }
    else if (g.sev) best.sevWhy += ` · GDACS : alerte « ${g.gdacsLevel} ».`;
  } else primary.push(g);
}
all = primary;

/* ===================== Enrichissement : pays, titres FR, statut ===================== */
const FR = { fire: 'Feu de forêt', storm: 'Tempête', flood: 'Inondation', volcano: 'Activité volcanique', drought: 'Sécheresse', ice: 'Glace marine',
  piracy: 'Acte de piraterie / brigandage', launch: 'Lancement', fireball: 'Bolide', health: 'Alerte sanitaire', cyber: 'Vulnérabilité exploitée' };
const DIRS = { N: 'N', S: 'S', E: 'E', W: 'O', NE: 'NE', NW: 'NO', SE: 'SE', SW: 'SO', NNE: 'NNE', NNW: 'NNO', SSE: 'SSE', SSW: 'SSO', ENE: 'ENE', ESE: 'ESE', WNW: 'ONO', WSW: 'OSO' };
const cleanName = s => (s || '').replace(/^(Wildfires?|Forest fires?|Tropical (Storm|Cyclone|Depression)|Typhoon|Hurricane|Super Typhoon|Cyclone|Volcano|Floods?|Iceberg|Drought|Earthquake)\s*[-–:]?\s*/i, '').replace(/^(in|at|near)\s+/i, '').trim();
const VERIF = { 'officiel-revu': 'Officiel — paramètres revus par un sismologue', 'officiel-auto': 'Officiel — calcul automatique, non encore revu', officiel: 'Source officielle', annonce: 'Annoncé — non encore confirmé' };

for (const e of all) {
  const seenU = new Set(); e.sources = e.sources.filter(s => s.u && !seenU.has(s.u) && seenU.add(s.u));
  const c = e.countryForced || (e.lat != null ? countryOf(e.lat, e.lng) : null);
  e.country = c?.name || null; e.iso2 = c?.iso2 || null; delete e.countryForced;
  if (e.cat === 'quake') {
    const m = (e.placeOrig || '').match(/^(\d+)\s*km\s+([NSEW]{1,3})\s+of\s+(.+)$/i);
    e.place = m ? `à ${m[1]} km au ${DIRS[m[2].toUpperCase()] || m[2]} de ${m[3]}` : (e.placeOrig || e.titleOrig || '');
    if (!e.title) e.title = `Séisme de magnitude ${e.mag?.toFixed?.(1) ?? '?'}`;
  } else if (e.cat === 'launch') {
    e.title = `${e.upcoming ? 'Lancement prévu' : 'Lancement'} — ${e.titleOrig}`; e.place = e.padName || '';
  } else if (e.cat === 'health') {
    e.title = `Alerte sanitaire OMS — ${e.disease}`; e.place = e.country || 'Localisation non précisée';
  } else if (e.cat === 'cyber') {
    e.title = `${FR.cyber} — ${e.titleOrig}`; e.place = `${e.vendor} · ${e.product}`;
  } else if (e.cat === 'piracy') {
    e.title = `${FR.piracy} — ${e.victim || 'navire'}`; e.place = e.country ? `Eaux de/près de ${e.country}` : 'En mer';
  } else if (e.cat === 'fireball') {
    e.title = `Bolide${e.energyKt ? ` (énergie d'impact ~${e.energyKt} kt)` : ''}`; e.place = e.country || 'Au-dessus de l\'océan / zone non attribuée';
  } else {
    const n = cleanName(e.titleOrig); e.title = `${FR[e.cat]} — ${n || e.titleOrig}`; e.place = n || e.titleOrig;
  }
  const indep = new Set(e.via).size;
  e.verifLabel = (VERIF[e.verif] || 'Source officielle') + (indep > 1 ? ` · confirmé par ${indep} sources indépendantes` : '');
  e.nsrc = indep;
}

const events = all.filter(e => e.lat != null && e.lng != null).sort((a, b) => Date.parse(b.time) - Date.parse(a.time));
const nongeo = all.filter(e => e.lat == null || e.lng == null).sort((a, b) => Date.parse(b.time) - Date.parse(a.time));

writeJSON(`${OUT}/events.json`, { generated: new Date(now).toISOString(), merged, events, nongeo });
writeJSON(`${OUT}/status.json`, status);
console.log(`→ ${events.length} événements géolocalisés, ${nongeo.length} non géolocalisés, ${merged} fusions multi-sources.`);
const okN = Object.values(status).filter(s => s.state === 'ok').length;
if (!okN) { console.error('Aucun connecteur opérationnel.'); process.exitCode = 1; }
