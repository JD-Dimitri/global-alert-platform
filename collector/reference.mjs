// Collecteur des couches PERMANENTES (infrastructures, référentiels) — exécution hebdomadaire.
// Chaque couche garde sa source, sa licence et sa date. En cas d'échec, le fichier précédent est conservé.
import { http, countryOf, parseCSV, R, readJSON, writeJSON } from './lib.mjs';

const OUT = process.env.OUT_DIR || 'data';
const now = new Date().toISOString();
const index = readJSON(`${OUT}/ref/index.json`, {});
const only = process.argv.slice(2);

const withCountry = items => items.map(i => ({ ...i, c: i.c || countryOf(i.lat, i.lng)?.name || null }));
async function layer(key, meta, fn) {
  if (only.length && !only.includes(key)) return;
  const t0 = Date.now();
  try {
    const res = await fn();
    const items = res.items ? res.items : res;
    const data = { generated: now, ...meta, ...(res.items ? res : {}), items: withCountry(items).filter(i => Number.isFinite(i.lat) && Number.isFinite(i.lng)) };
    writeJSON(`${OUT}/ref/${key}.json`, data);
    index[key] = { ...meta, generated: now, n: data.items.length, state: 'ok', err: '' };
    console.log(`[${key}] ok · ${data.items.length} éléments · ${Date.now() - t0} ms`);
  } catch (e) {
    index[key] = { ...(index[key] || meta), state: index[key]?.n ? 'stale' : 'err', err: String(e?.message || e).slice(0, 300), lastTry: now };
    console.error(`[${key}] ÉCHEC : ${e?.message || e}`);
  }
}

/* ---------- OpenStreetMap via Overpass (ODbL) ---------- */
async function overpass(q) {
  const body = 'data=' + encodeURIComponent(`[out:json][timeout:280];${q}`);
  const endpoints = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
  let last;
  for (const ep of endpoints) {
    try {
      const r = await fetch(ep, { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'GLOBAL-ALERT-collector/0.2' }, signal: AbortSignal.timeout(300000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return (await r.json()).elements || [];
    } catch (e) { last = e; }
  }
  throw last;
}
const osmItems = (els, detail) => els.map(e => ({
  n: e.tags?.['name:fr'] || e.tags?.name || e.tags?.['name:en'] || null,
  lat: R(e.lat ?? e.center?.lat, 3), lng: R(e.lon ?? e.center?.lon, 3), d: detail(e.tags || {}),
  u: `https://www.openstreetmap.org/${e.type}/${e.id}`
}));
const OSM = { source: 'OpenStreetMap (contributeurs)', sourceUrl: 'https://www.openstreetmap.org/copyright', licence: 'ODbL 1.0 — © contributeurs OpenStreetMap', note: 'Couverture inégale selon les pays : données collaboratives publiques.' };

/* ---------- Couches ---------- */
await layer('airport', { source: 'OurAirports', sourceUrl: 'https://ourairports.com/data/', licence: 'Domaine public', note: 'Aéroports classés « large_airport ».', precision: 'Point de référence de l\'aéroport' }, async () => {
  const rows = parseCSV(await http('https://raw.githubusercontent.com/davidmegginson/ourairports-data/main/airports.csv', { as: 'text', timeout: 60000 }));
  return rows.filter(r => r.type === 'large_airport').map(r => ({ n: r.name, lat: R(r.latitude_deg), lng: R(r.longitude_deg), d: [r.iata_code, r.municipality].filter(Boolean).join(' · '), u: r.home_link || `https://ourairports.com/airports/${r.ident}/` }));
});

const GPPD = 'https://raw.githubusercontent.com/wri/global-power-plant-database/master/output_database/global_power_plant_database.csv';
let gppdRows = null;
const gppd = async () => gppdRows ||= parseCSV(await http(GPPD, { as: 'text', timeout: 120000 }));
await layer('nuclear', { source: 'WRI — Global Power Plant Database v1.3', sourceUrl: 'https://datasets.wri.org/dataset/globalpowerplantdatabase', licence: 'CC BY 4.0', note: 'Centrales électronucléaires ; base figée en 2021 (les centrales plus récentes peuvent manquer).', precision: 'Coordonnées de la centrale' }, async () =>
  (await gppd()).filter(r => r.primary_fuel === 'Nuclear').map(r => ({ n: r.name, lat: R(r.latitude), lng: R(r.longitude), d: `${Math.round(+r.capacity_mw).toLocaleString('fr-FR')} MW${r.owner ? ' · ' + r.owner : ''}`, c: null })));
await layer('dam', { source: 'WRI — Global Power Plant Database v1.3', sourceUrl: 'https://datasets.wri.org/dataset/globalpowerplantdatabase', licence: 'CC BY 4.0', note: 'Grands barrages hydroélectriques : centrales hydro ≥ 1 000 MW (base figée en 2021). Les barrages non électriques ne sont pas inclus.', precision: 'Coordonnées de la centrale' }, async () =>
  (await gppd()).filter(r => r.primary_fuel === 'Hydro' && +r.capacity_mw >= 1000).map(r => ({ n: r.name, lat: R(r.latitude), lng: R(r.longitude), d: `${Math.round(+r.capacity_mw).toLocaleString('fr-FR')} MW` })));

await layer('dc', { source: 'PeeringDB — installations d\'interconnexion', sourceUrl: 'https://www.peeringdb.com/', licence: 'Données PeeringDB, usage public selon leur AUP', note: 'Centres de données et points d\'interconnexion déclarés par leurs opérateurs.', precision: 'Coordonnées déclarées par l\'opérateur' }, async () => {
  const j = await http('https://www.peeringdb.com/api/fac?status=ok', { timeout: 120000 });
  return (j.data || []).filter(f => f.latitude && f.longitude).map(f => ({ n: f.name, lat: R(f.latitude), lng: R(f.longitude), d: [f.org_name, f.city].filter(Boolean).join(' · '), u: `https://www.peeringdb.com/fac/${f.id}` }));
});

await layer('spaceport', { source: 'Launch Library 2 — sites de lancement', sourceUrl: 'https://thespacedevs.com/llapi', licence: 'Gratuit avec attribution', precision: 'Coordonnées du site' }, async () => {
  const out = []; let url = 'https://ll.thespacedevs.com/2.3.0/locations/?limit=100';
  while (url && out.length < 400) { const j = await http(url); out.push(...j.results); url = j.next; }
  return out.filter(l => l.latitude != null).map(l => ({ n: l.name, lat: R(l.latitude), lng: R(l.longitude), d: `${l.total_launch_count ?? '?'} lancement(s) recensé(s)` }));
});

await layer('port', { source: 'NGA — World Port Index (Pub. 150)', sourceUrl: 'https://msi.nga.mil/Publications/WPI', licence: 'Domaine public (gouvernement des États-Unis)', note: 'Ports de grande taille (« harbor size » L).', precision: 'Coordonnées du port' }, async () => {
  const j = await http('https://msi.nga.mil/api/publications/world-port-index?output=json', { timeout: 120000 });
  const list = j.ports || j.data || [];
  return list.filter(p => /^L/i.test(p.harborSize || p.harborSizeCode || '')).map(p => ({ n: p.portName || p.mainPortName, lat: R(p.ycoord ?? p.latitude), lng: R(p.xcoord ?? p.longitude), d: p.countryName || '' }));
});

await layer('cable', { source: 'TeleGeography — Submarine Cable Map', sourceUrl: 'https://www.submarinecablemap.com/', licence: 'CC BY-NC-SA 3.0 — usage non commercial uniquement', note: 'Tracés indicatifs ; points d\'atterrissement affichés comme marqueurs.', precision: 'Tracé schématique' }, async () => {
  const [g, lp] = await Promise.all([http('https://www.submarinecablemap.com/api/v3/cable/cable-geo.json', { timeout: 90000 }), http('https://www.submarinecablemap.com/api/v3/landing-point/landing-point-geo.json', { timeout: 90000 })]);
  const lines = [];
  for (const f of g.features || []) {
    const geom = f.geometry; if (!geom) continue;
    const parts = geom.type === 'MultiLineString' ? geom.coordinates : [geom.coordinates];
    for (const p of parts) lines.push({ n: f.properties?.name, col: f.properties?.color || '#06b6d4', p: p.map(([x, y]) => [R(y, 2), R(x, 2)]) });
  }
  const items = (lp.features || []).map(f => ({ n: f.properties?.name, lat: R(f.geometry.coordinates[1]), lng: R(f.geometry.coordinates[0]), d: 'Point d\'atterrissement de câble' }));
  return { items, lines };
});

const cur = k => readJSON(new URL(`./curated/${k}.json`, import.meta.url).pathname);
await layer('choke', { ...(({ items, ...m }) => m)(cur('choke')), licence: 'Liste curée, sources publiques citées' }, async () => cur('choke').items);
await layer('bourse', { ...(({ items, ...m }) => m)(cur('bourse')), licence: 'Liste curée, sources publiques citées' }, async () => cur('bourse').items);

await layer('milbase', { ...OSM, note: OSM.note + ' Uniquement les emprises militaires nommées et publiquement cartographiées.', precision: 'Centre de l\'emprise' }, async () =>
  osmItems(await overpass('nwr["military"~"^(base|naval_base)$"]["name"];out center tags;'), t => t.operator || t['military:branch'] || '').slice(0, 6000));
await layer('milair', { ...OSM, precision: 'Centre de l\'aérodrome' }, async () =>
  osmItems(await overpass('nwr["military"="airfield"];out center tags;'), t => [t.iata, t.icao, t.operator].filter(Boolean).join(' · ')));
await layer('border', { ...OSM, precision: 'Poste frontière' }, async () =>
  osmItems(await overpass('node["barrier"="border_control"];out tags;'), t => t.operator || ''));
await layer('observ', { ...OSM, note: OSM.note + ' Observatoires astronomiques nommés.', precision: 'Coordonnées du site' }, async () =>
  osmItems(await overpass('nwr["man_made"="observatory"]["name"];out center tags;'), t => t.operator || t.observatory || ''));

writeJSON(`${OUT}/ref/index.json`, index);
console.log('Référentiels :', Object.entries(index).map(([k, v]) => `${k}=${v.state}:${v.n ?? 0}`).join(' '));
