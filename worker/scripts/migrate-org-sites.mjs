// Премества данните на фирмите, регистрирани преди отделните сайтове, от общия сайт /sites/cloud
// в собствен сайт /sites/cloud-<id> за всяка фирма. Може да се пуска многократно: вече копираните записи се пропускат.
//
//   node scripts/migrate-org-sites.mjs                 – показва кои фирми ще се преместят (нищо не променя)
//   node scripts/migrate-org-sites.mjs --run           – премества всички
//   node scripts/migrate-org-sites.mjs --run --org ORG-XXXX
//
// Докато трае преместването фирмата е в състояние „Подготвя се“ и потребителите ѝ виждат съобщение да изчакат.
// Оригиналните записи в общия сайт НЕ се изтриват — остават като резервно копие.
import { readFileSync } from 'node:fs';
import schema from '../src/schema.json' with { type: 'json' };
import { GraphStore } from '../src/store.js';

const vars = Object.fromEntries(
  readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.includes('=') && !line.startsWith('#'))
    .map((line) => {
      const i = line.indexOf('=');
      return [line.slice(0, i).trim(), line.slice(i + 1).trim().replace(/^"|"$/g, '')];
    }),
);
const toml = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
const tomlVar = (key) => toml.match(new RegExp(`^${key} = "(.*)"$`, 'm'))[1];
const arg = (flag) => {
  const i = process.argv.indexOf(flag);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const sleep = (seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000));

const env = {
  SP_HOSTNAME: tomlVar('SP_HOSTNAME'),
  SP_SITE_PATH: tomlVar('SP_SITE_PATH'),
  SP_SITE_OWNER: tomlVar('SP_SITE_OWNER'),
  GRAPH_TENANT_ID: tomlVar('GRAPH_TENANT_ID'),
  MS_CLIENT_ID: tomlVar('MS_CLIENT_ID'),
  MS_CERT_THUMBPRINT: tomlVar('MS_CERT_THUMBPRINT'),
  MS_CERT_PRIVATE_KEY: vars.MS_CERT_PRIVATE_KEY,
};
const store = new GraphStore(env);
const run = process.argv.includes('--run');
const only = arg('--org');

const ORG_SITE_TABLES = Object.keys(schema).filter((k) => schema[k].generic).concat(['documents', 'payments', 'audit']);
// Историята за профили, фирми и планове остава в общия сайт.
const CENTRAL_AUDIT = ['users', 'orgs', 'members', 'plans', 'settings'];

const orgs = (await store.list('orgs')).filter((o) => !o.sitePath && (!only || o.id === only));
if (!orgs.length) {
  console.log('Няма фирми за преместване.');
  process.exit(0);
}

for (const org of orgs) {
  const sitePath = `/sites/cloud-${org.id.toLowerCase()}`;
  const rows = {};
  for (const table of ORG_SITE_TABLES) {
    rows[table] = (await store.find(table, 'orgId', org.id)).filter((r) => table !== 'audit' || !CENTRAL_AUDIT.includes(r.entity));
  }
  const counts = Object.entries(rows).filter(([, r]) => r.length).map(([t, r]) => `${schema[t].title}: ${r.length}`).join(', ');
  console.log(`${org.id} „${org.name}“ → https://${env.SP_HOSTNAME}${sitePath}`);
  console.log(`   ${counts || 'няма записи'}${org.logoItemId ? ', лого' : ''}`);
  if (!run) continue;

  // 1. Фирмата временно не се отваря, за да не се въвеждат данни по време на копирането.
  await store.update('orgs', org.id, { dbStatus: 'Подготвя се', dbError: '' });
  try {
    // 2. Сайт.
    let status = await store.createSite({ sitePath, title: `BulAdmin Cloud – ${org.name}`, owner: env.SP_SITE_OWNER || org.createdBy });
    for (let i = 0; status === 'provisioning' && i < 60; i++) {
      await sleep(10);
      status = await store.siteStatus(sitePath);
    }
    if (status !== 'ready') throw new Error(`сайтът не е готов (${status})`);
    console.log('   сайтът е готов');

    // 3. Таблици (Graph вижда новия сайт с малко закъснение).
    const db = store.forSite(sitePath);
    for (let attempt = 0; ; attempt++) {
      try {
        if ((await db.ensureLists(ORG_SITE_TABLES, 50)).done) break;
      } catch (err) {
        if (attempt > 12) throw err;
        await sleep(10);
      }
    }
    console.log('   таблиците са създадени');

    // 4. Записите; вече копираните (по номер) се пропускат.
    for (const table of ORG_SITE_TABLES) {
      if (!rows[table].length) continue;
      const have = new Set((await db.list(table)).map((r) => r.id));
      let copied = 0;
      for (const record of rows[table]) {
        if (have.has(record.id)) continue;
        await db.create(table, record);
        copied += 1;
      }
      console.log(`   ${schema[table].title}: копирани ${copied}, вече налични ${rows[table].length - copied}`);
    }

    // 5. Логото — в библиотеката на новия сайт.
    const patch = { sitePath, dbStatus: 'Готова', dbError: '' };
    if (org.logoItemId) {
      const bytes = await store.downloadFile(org.logoItemId);
      const ext = org.logoType === 'image/jpeg' ? 'jpg' : 'png';
      patch.logoItemId = await db.uploadFile(`Логота/${org.id}.${ext}`, bytes, org.logoType || 'image/png');
      console.log('   логото е копирано');
    }

    // 6. Фирмата започва да работи с новия сайт.
    await store.update('orgs', org.id, patch);
    console.log('   ГОТОВО: фирмата работи с отделния сайт; старите записи в общия сайт са запазени.');
  } catch (err) {
    // Без sitePath фирмата продължава да работи с общия сайт, както досега.
    await store.update('orgs', org.id, { dbStatus: 'Готова', dbError: `Преместване: ${err.message}`.slice(0, 250) });
    console.error(`   ГРЕШКА: ${err.message}. Фирмата продължава да работи с общия сайт.`);
    process.exitCode = 1;
  }
}
if (!run) console.log('\nЗа преместване пуснете отново с --run.');
