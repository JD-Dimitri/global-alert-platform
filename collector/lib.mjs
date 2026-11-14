// Utilitaires partagés par les collecteurs GLOBAL ALERT.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { createRequire } from 'node:module';
import { geoContains, geoBounds, geoCentroid } from 'd3-geo';
import { feature } from 'topojson-client';
import countries from 'i18n-iso-countries';

const require = createRequire(import.meta.url);
countries.registerLocale(require('i18n-iso-countries/langs/fr.json'));
countries.registerLocale(require('i18n-iso-countries/langs/en.json'));

const UA = 'GLOBAL-ALERT-collector/0.2 (+https://github.com/JD-Dimitri/global-alert-platform)';

/** fetch avec délai, nouvelles tentatives et User-Agent explicite. */
export async function http(url, { as = 'json', timeout = 30000, retries = 2, headers = {} } = {}) {
  let last;
  for (let i = 0; i <= retries; i++) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeout);
    try {
      const r = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': UA, Accept: as === 'json' ? 'application/json' : '*/*', ...headers } });
      if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
      return as === 'json' ? await r.json() : await r.text();
    } catch (e) {
      last = e;
      if (i < retries) await new Promise(res => setTimeout(res, 1500 * (i + 1)));
    } finally { clearTimeout(t); }
  }
  throw last;
}

/** Exécute un connecteur et consigne son état réel (jamais de « LIVE » simulé). */
export async function runConnector(meta, fn, status) {
  const t0 = Date.now();
  const s = { ...meta, lastCheck: new Date(t0).toISOString(), state: 'err', n: 0, err: '', ms: 0, lastData: null };
  try {
    const items = await fn();
    s.state = 'ok'; s.n = items.length;
    const times = items.map(e => Date.parse(e.updated || e.time)).filter(Number.isFinite);
    s.lastData = times.length ? new Date(Math.max(...times)).toISOString() : null;
    return items;
  } catch (e) {
    s.err = String(e?.message || e).slice(0, 300);
    console.error(`[${meta.id}] ÉCHEC : ${s.err}`);
    return null;
  } finally {
    s.ms = Date.now() - t0;
    status[meta.id] = s;
    console.log(`[${meta.id}] ${s.state} · ${s.n} éléments · ${s.ms} ms`);
  }
}

/* ---------- Géographie : pays (point dans polygone) + centroïdes ---------- */
const world = require('world-atlas/countries-50m.json');
const FEATS = feature(world, world.objects.countries).features.map(f => {
  const a2 = f.id ? countries.numericToAlpha2(f.id) : null;
  return { f, a2, fr: (a2 && countries.getName(a2, 'fr')) || f.properties.name, bbox: geoBounds(f) };
});
const EXTRA_FR = { 'N. Cyprus': 'Chypre du Nord', Somaliland: 'Somaliland', Kosovo: 'Kosovo' };
FEATS.forEach(c => { if (!c.a2 && EXTRA_FR[c.f.properties.name]) c.fr = EXTRA_FR[c.f.properties.name]; });

export function countryOf(lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  for (const c of FEATS) {
    const [[x0, y0], [x1, y1]] = c.bbox;
    if (lat < y0 || lat > y1) continue;
    if (x0 <= x1 && (lng < x0 || lng > x1)) continue;
    if (geoContains(c.f, [lng, lat])) return { name: c.fr, iso2: c.a2 };
  }
  return null;
}

/** Retrouve un pays à partir d'un nom anglais/français (ex. titres OMS) → centroïde. */
const ALIASES = { 'democratic republic of the congo': 'CD', 'republic of the congo': 'CG', 'congo': 'CG', 'united republic of tanzania': 'TZ',
  'türkiye': 'TR', 'turkiye': 'TR', 'viet nam': 'VN', 'lao people\'s democratic republic': 'LA', 'syrian arab republic': 'SY',
  'iran (islamic republic of)': 'IR', 'bolivia (plurinational state of)': 'BO', 'venezuela (bolivarian republic of)': 'VE',
  'republic of korea': 'KR', 'democratic people\'s republic of korea': 'KP', 'russian federation': 'RU', 'united kingdom of great britain and northern ireland': 'GB',
  'united states of america': 'US', 'côte d\'ivoire': 'CI', 'cote d\'ivoire': 'CI', 'occupied palestinian territory': 'PS', 'kosovo': 'XK' };
export function countryByName(name) {
  if (!name) return null;
  const n = name.trim().toLowerCase().replace(/\s+/g, ' ');
  const a2 = ALIASES[n] || countries.getAlpha2Code(name.trim(), 'en') || countries.getAlpha2Code(name.trim(), 'fr');
  if (!a2) return null;
  const c = FEATS.find(x => x.a2 === a2);
  if (!c) return null;
  const [lng, lat] = geoCentroid(c.f);
  return { name: c.fr, iso2: a2, lat, lng };
}

/* ---------- Divers ---------- */
export const R = (x, d = 3) => (Number.isFinite(+x) ? Math.round(+x * 10 ** d) / 10 ** d : null);
export function hav(a, b) {
  const r = Math.PI / 180, dLa = (b.lat - a.lat) * r, dLo = (b.lng - a.lng) * r;
  const x = Math.sin(dLa / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLo / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(x));
}
export function readJSON(path, fallback = null) { try { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback; } catch { return fallback; } }
export function writeJSON(path, data) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(data)); }
export const iso = t => (t == null ? null : new Date(t).toISOString());

/** Parse CSV simple (RFC 4180 : guillemets, virgules, retours ligne dans les champs). */
export function parseCSV(text) {
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
    else if (c !== '\r') f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  const [head, ...rest] = rows;
  return rest.filter(r => r.length === head.length).map(r => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}
