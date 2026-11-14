// Assemble index.html (autonome) : head + body + fond de carte pays (world-atlas 110m) + noms FR.
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import countries from 'i18n-iso-countries';
const require = createRequire(import.meta.url);
countries.registerLocale(require('i18n-iso-countries/langs/fr.json'));
const world = require('world-atlas/countries-110m.json');
const fr = { 'N. Cyprus': 'Chypre du Nord', Somaliland: 'Somaliland', Kosovo: 'Kosovo' };
const world50 = require('world-atlas/countries-50m.json');
for (const g of world50.objects.countries.geometries) { const a2 = g.id && countries.numericToAlpha2(g.id); const n = a2 && countries.getName(a2, 'fr'); if (n) fr[g.properties.name] = n; }
const html = readFileSync('src/head.html', 'utf8') + readFileSync('src/body.html', 'utf8')
  .replace('/*__WORLD__*/null', JSON.stringify(world)).replace('/*__FR__*/{}', JSON.stringify(fr));
writeFileSync(process.argv[2] || 'index.html', html);
console.log('index.html :', (html.length / 1024).toFixed(0), 'Ko');
