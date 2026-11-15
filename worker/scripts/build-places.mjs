// Подготвя данните за автоматичното попълване на адреси: населени места, пощенски кодове и области
// в България и държавите от ЕС. Източник: GeoNames Postal Codes (https://download.geonames.org/export/zip/,
// лиценз CC BY 4.0). Резултатът са статични файлове в assets/data/places/<код>.json, които браузърът
// зарежда при нужда от GitHub Pages — без Worker-а и без SharePoint.
//
//   node scripts/build-places.mjs            – сваля и обновява всички държави
//   node scripts/build-places.mjs BG AT      – само избраните
import { mkdirSync, writeFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

// Гърция липсва в GeoNames Postal Codes, затова там остава само ръчно въвеждане.
export const EU = ['AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'HR', 'HU', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK'];
const OUT = new URL('../../assets/data/places/', import.meta.url);

// Минимален четец на ZIP: намира файла в централната директория и го разархивира.
function unzip(buf, wanted) {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd -= 1;
  let p = buf.readUInt32LE(eocd + 16);
  const count = buf.readUInt16LE(eocd + 10);
  for (let i = 0; i < count; i += 1) {
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    if (name === wanted) {
      const start = offset + 30 + buf.readUInt16LE(offset + 26) + buf.readUInt16LE(offset + 28);
      const data = buf.subarray(start, start + size);
      return (method === 0 ? data : inflateRawSync(data)).toString('utf8');
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`${wanted} липсва в архива`);
}

// „Айтос / Ajtos“ → кирилица и латиница поотделно (само за България).
const split = (text) => {
  const [local, latin = ''] = String(text || '').split(' / ');
  return [local.trim(), latin.trim()];
};
const BG_REGIONS = { 'София (столица)': 'София-град' };

function build(cc, text) {
  const regions = [];
  const munis = [];
  const index = (list, value) => {
    if (!value) return -1;
    let i = list.indexOf(value);
    if (i < 0) i = list.push(value) - 1;
    return i;
  };
  const seen = new Set();
  const places = [];
  for (const line of text.split('\n')) {
    const f = line.split('\t');
    if (f.length < 6 || !f[1] || !f[2]) continue;
    const [name, latin] = cc === 'BG' ? split(f[2]) : [f[2].trim(), ''];
    let [region] = cc === 'BG' ? split(f[3]) : [f[3].trim()];
    region = BG_REGIONS[region] || region;
    const [muni] = cc === 'BG' ? split(f[5]) : [f[5].trim()];
    // В Португалия кодът е до улица (1000-001); пази се само частта за местността (1000-), останалото се дописва.
    const code = cc === 'PT' ? `${f[1].trim().slice(0, 4)}-` : f[1].trim();
    const key = `${code}|${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const row = [code, name, index(regions, region), index(munis, muni && muni !== name ? muni : '')];
    if (latin && latin !== name) row.push(latin);
    places.push(row);
  }
  places.sort((a, b) => a[1].localeCompare(b[1], cc === 'BG' ? 'bg' : 'en') || a[0].localeCompare(b[0]));
  return { c: cc, r: regions, m: munis, p: places };
}

const wanted = process.argv.slice(2).map((x) => x.toUpperCase());
mkdirSync(OUT, { recursive: true });
let total = 0;
for (const cc of wanted.length ? wanted : EU) {
  const res = await fetch(`https://download.geonames.org/export/zip/${cc}.zip`);
  if (!res.ok) throw new Error(`${cc}: HTTP ${res.status}`);
  const data = build(cc, unzip(Buffer.from(await res.arrayBuffer()), `${cc}.txt`));
  const json = JSON.stringify(data);
  writeFileSync(new URL(`${cc}.json`, OUT), json);
  total += json.length;
  console.log(`${cc}: ${data.p.length} места, ${data.r.length} области/региона, ${(json.length / 1024).toFixed(0)} KB`);
}
console.log(`Общо ${(total / 1048576).toFixed(1)} MB в assets/data/places/`);
