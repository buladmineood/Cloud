// Създава таблиците (Microsoft Lists) в SharePoint сайта. Може да се пуска многократно:
// съществуващите таблици и потребители се пропускат, а новите колони от schema.json се добавят.
//
//   node scripts/provision.mjs --admin ime@bulmail.eu --name "Име Фамилия"
//
// Чете частния ключ на сертификата от worker/.dev.vars.
import { readFileSync } from 'node:fs';
import { b64url, CLIENT_ASSERTION_TYPE, clientAssertion, sha256 } from '../src/crypto.js';
import { DEFAULT_PLANS } from '../src/plans.js';
import schema from '../src/schema.json' with { type: 'json' };

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

const certEnv = {
  MS_CLIENT_ID: tomlVar('MS_CLIENT_ID'),
  MS_CERT_THUMBPRINT: tomlVar('MS_CERT_THUMBPRINT'),
  MS_CERT_PRIVATE_KEY: vars.MS_CERT_PRIVATE_KEY,
};
const tokenUrl = `https://login.microsoftonline.com/${tomlVar('GRAPH_TENANT_ID')}/oauth2/v2.0/token`;
const tokenRes = await fetch(tokenUrl, {
  method: 'POST',
  body: new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: certEnv.MS_CLIENT_ID,
    client_assertion_type: CLIENT_ASSERTION_TYPE,
    client_assertion: await clientAssertion(certEnv, tokenUrl),
    scope: 'https://graph.microsoft.com/.default',
  }),
});
if (!tokenRes.ok) throw new Error(`Token: ${tokenRes.status} ${await tokenRes.text()}`);
const { access_token: token } = await tokenRes.json();

async function graph(path, method = 'GET', body) {
  const res = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body && JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

function columnDefinition(c) {
  const base = { name: c.name, displayName: c.label, indexed: !!c.indexed };
  if (c.kind === 'date') return { ...base, dateTime: { format: 'dateTime' } };
  if (c.kind === 'day') return { ...base, dateTime: { format: 'dateOnly' } };
  if (c.kind === 'number') return { ...base, number: { decimalPlaces: 'automatic' } };
  if (c.kind === 'choice') return { ...base, choice: { choices: c.choices, displayAs: 'dropDownMenu' } };
  if (c.kind === 'multiline') return { ...base, text: { allowMultipleLines: true, linesForEditing: 6 } };
  return { ...base, text: {} };
}

const site = await graph(`/sites/${tomlVar('SP_HOSTNAME')}:${tomlVar('SP_SITE_PATH')}`);
console.log(`Сайт: ${site.webUrl}`);
const existing = (await graph(`/sites/${site.id}/lists?$select=id,displayName`)).value;

const listIds = {};
for (const [key, def] of Object.entries(schema)) {
  let list = existing.find((l) => l.displayName === def.title);
  if (list) {
    console.log(`  съществува: ${def.title}`);
  } else {
    list = await graph(`/sites/${site.id}/lists`, 'POST', {
      displayName: def.title,
      list: { template: 'genericList' },
      columns: def.columns.map(columnDefinition),
    });
    console.log(`  създадена:  ${def.title}`);
  }
  listIds[key] = list.id;

  // Колоната Title пази уникалния номер: индексира се, за да може да се търси по нея.
  const { value: columns } = await graph(`/sites/${site.id}/lists/${list.id}/columns?$select=id,name,indexed,displayName,choice`);
  // Новите колони от schema.json се добавят и към вече създадени таблици, а новите стойности за избор — към съществуващите.
  for (const column of def.columns) {
    const current = columns.find((c) => c.name === column.name);
    if (!current) {
      await graph(`/sites/${site.id}/lists/${list.id}/columns`, 'POST', columnDefinition(column));
      console.log(`    нова колона: ${column.label}`);
    } else if (column.kind === 'choice' && current.choice && column.choices.join('|') !== (current.choice.choices || []).join('|')) {
      await graph(`/sites/${site.id}/lists/${list.id}/columns/${current.id}`, 'PATCH', { choice: { ...current.choice, choices: column.choices } });
      console.log(`    нови стойности за „${column.label}“: ${column.choices.join(', ')}`);
    }
  }
  // По-рано сделката имаше колона „title“, която SharePoint не позволява (съвпада с вградената Title)
  // и вместо нея създаваше title0, title1… Тези колони не се използват и се махат.
  for (const stray of columns.filter((c) => /^title\d+$/.test(c.name) && !def.columns.some((d) => d.name === c.name))) {
    await graph(`/sites/${site.id}/lists/${list.id}/columns/${stray.id}`, 'DELETE');
    console.log(`    премахната излишна колона: ${stray.name} (${stray.displayName})`);
  }
  const title = columns.find((c) => c.name === 'Title');
  if (title && (!title.indexed || title.displayName !== def.titleLabel)) {
    await graph(`/sites/${site.id}/lists/${list.id}/columns/${title.id}`, 'PATCH', { indexed: true, displayName: def.titleLabel });
  }
}

// Плановете по подразбиране, които още ги няма. След това се променят от системата („БУЛАДМИН“ → „Планове“).
// При съществуващ план се попълват само новите възможности, ако още не са задавани — промените на администраторите остават.
const NEW_PLAN_FIELDS = ['maxBankAccounts', 'maxEmails', 'allowCurrencies', 'allowProcurement'];
const { value: planItems } = await graph(`/sites/${site.id}/lists/${listIds.plans}/items?expand=fields&$top=999`);
for (const { id, ...plan } of DEFAULT_PLANS) {
  const existingPlan = planItems.find((item) => item.fields.Title === id);
  if (!existingPlan) {
    const fields = { Title: id };
    for (const [key, value] of Object.entries(plan)) if (value !== '') fields[key] = value;
    await graph(`/sites/${site.id}/lists/${listIds.plans}/items`, 'POST', { fields });
    console.log(`  създаден план: ${plan.name}`);
  } else if (NEW_PLAN_FIELDS.every((key) => existingPlan.fields[key] === undefined || existingPlan.fields[key] === null)) {
    const fields = {};
    for (const key of NEW_PLAN_FIELDS) if (plan[key] !== '') fields[key] = plan[key];
    await graph(`/sites/${site.id}/lists/${listIds.plans}/items/${existingPlan.id}/fields`, 'PATCH', fields);
    console.log(`  нови възможности в план „${existingPlan.fields.name}“: ${Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  }
}

const PLATFORM_ADMIN = 'Администратор на БУЛАДМИН';
const admin = arg('--admin');
if (admin) {
  const email = admin.toLowerCase();
  const { value } = await graph(`/sites/${site.id}/lists/${listIds.users}/items?expand=fields`);
  const existing = value.find((item) => item.fields.Title?.toLowerCase() === email);
  if (existing) {
    if (existing.fields.platformRole !== PLATFORM_ADMIN) {
      await graph(`/sites/${site.id}/lists/${listIds.users}/items/${existing.id}/fields`, 'PATCH', { platformRole: PLATFORM_ADMIN });
      console.log(`  ${email} вече е администратор на БУЛАДМИН`);
    } else {
      console.log(`  потребителят вече е вписан: ${email}`);
    }
  } else {
    // Първият потребител е администратор на БУЛАДМИН. Влиза с Google или Microsoft с този имейл
    // или задава парола през еднократен линк, валиден 72 часа.
    const token = `u.${b64url(crypto.getRandomValues(new Uint8Array(32)))}`;
    await graph(`/sites/${site.id}/lists/${listIds.users}/items`, 'POST', {
      fields: {
        Title: email,
        fullName: arg('--name') || email,
        isActive: 'Да',
        platformRole: PLATFORM_ADMIN,
        sessionVersion: '0',
        failedLogins: '0',
        resetTokenHash: b64url(await sha256(token)),
        resetExpires: new Date(Date.now() + 72 * 3600 * 1000).toISOString(),
      },
    });
    console.log(`  добавен администратор: ${email}`);
    console.log(`  линк за задаване на парола: ${tomlVar('APP_ORIGIN')}/set-password.html#t=${token}`);
  }
}
console.log('Готово.');
