// Проверява връзката с Microsoft 365 със същия код като Worker-а: чете таблиците в SharePoint
// и по желание праща пробен имейл от MAIL_FROM.
//   node scripts/check-microsoft.mjs [--mail ime@bulmail.eu]
import { readFileSync } from 'node:fs';
import { renderEmail } from '../src/email.js';
import { GraphStore } from '../src/store.js';

const toml = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
const env = Object.fromEntries([...toml.matchAll(/^([A-Z_]+) = "(.*)"$/gm)].map((m) => [m[1], m[2]]));
for (const line of readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8').split(/\r?\n/)) {
  const i = line.indexOf('=');
  if (i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
}
const store = new GraphStore(env);

const users = await store.list('users');
console.log(`SharePoint: ${users.length} потребител(и): ${users.map((u) => `${u.id} (${u.role}, ${u.isActive})`).join(', ')}`);
for (const table of ['companies', 'documents', 'settings']) console.log(`  ${table}: ${(await store.list(table)).length} записа`);

const i = process.argv.indexOf('--mail');
if (i > 0) {
  const to = process.argv[i + 1];
  await store.sendMail(env.MAIL_FROM, to, 'Проверка: имейлите на BulAdmin CRM / ERP работят', renderEmail({
    origin: env.APP_ORIGIN,
    title: 'Имейлите работят',
    paragraphs: [`Това е пробно съобщение от ${env.MAIL_FROM}. Поканите и линковете за нова парола ще идват оттук.`],
    action: { label: 'Отворете системата', url: env.APP_ORIGIN },
  }));
  console.log(`Имейл: изпратен до ${to}`);
}
console.log('ГОТОВО');
