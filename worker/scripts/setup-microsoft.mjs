// Настройва Microsoft 365 за cloud.buladmin.eu наведнъж. Администратор влиза с код в браузъра, след което скриптът:
//   1. създава (или намира) отделно приложение „BULADMIN Cloud“ в Entra със сертификата от .secrets/buladmin-cloud.cer
//      и адреса за вход; записва неговия Application ID в wrangler.toml (MS_CLIENT_ID);
//   2. одобрява за цялата организация входа (openid, email, profile) и правото Sites.Selected;
//   3. добавя домейна cloud.buladmin.eu в tenant-а и показва DNS записите, които трябват;
//   4. дава на приложението достъп само до SharePoint сайта от SP_SITE_PATH (временно manage);
//   5. пуска provision.mjs (таблици и първи администратор);
//   6. намалява правата върху сайта до write.
// Приложението на портала не се променя. Може да се пуска повторно: готовите стъпки се пропускат.
//
//   node scripts/setup-microsoft.mjs --admin ime@bulmail.eu --name "Име Фамилия"
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Публичното приложение на Microsoft за Graph от командния ред; достъпът е този на влезлия администратор.
const GRAPH_CLI_CLIENT_ID = '14d82eec-204b-4c2f-b7e8-296a70dab67e';
const GRAPH_APP_ID = '00000003-0000-0000-c000-000000000000';
const SCOPES = [
  'Application.ReadWrite.All', 'AppRoleAssignment.ReadWrite.All', 'DelegatedPermissionGrant.ReadWrite.All',
  'Sites.FullControl.All', 'Domain.ReadWrite.All',
].join(' ');
const GRAPH = 'https://graph.microsoft.com/v1.0';
const APP_NAME = 'BULADMIN Cloud';
const MAIL_DOMAIN = 'cloud.buladmin.eu';

const here = (path) => fileURLToPath(new URL(path, import.meta.url));
let toml = readFileSync(here('../wrangler.toml'), 'utf8');
const tomlVar = (key) => toml.match(new RegExp(`^${key} = "(.*)"$`, 'm'))[1];
const arg = (flag) => {
  const i = process.argv.indexOf(flag);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const sleep = (seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000));

const tenant = tomlVar('GRAPH_TENANT_ID');
const certificate = readFileSync(here('../.secrets/buladmin-cloud.cer'));
const callback = `${tomlVar('APP_ORIGIN')}/api/auth/microsoft/callback`;

async function signIn() {
  const base = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0`;
  const res = await fetch(`${base}/devicecode`, {
    method: 'POST',
    body: new URLSearchParams({ client_id: GRAPH_CLI_CLIENT_ID, scope: SCOPES }),
  });
  const device = await res.json();
  if (!res.ok) throw new Error(`Вход: ${device.error_description || res.status}`);
  console.log(`LOGIN ${device.verification_uri} КОД: ${device.user_code}`);

  const deadline = Date.now() + device.expires_in * 1000;
  while (Date.now() < deadline) {
    await sleep(device.interval || 5);
    const poll = await fetch(`${base}/token`, {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        client_id: GRAPH_CLI_CLIENT_ID,
        device_code: device.device_code,
      }),
    });
    const data = await poll.json();
    if (poll.ok) return data.access_token;
    if (data.error !== 'authorization_pending' && data.error !== 'slow_down') {
      throw new Error(`Вход: ${data.error}: ${String(data.error_description).split('\n')[0]}`);
    }
  }
  throw new Error('Вход: кодът изтече.');
}

const token = await signIn();
console.log('Входът е успешен.');

async function graph(path, method = 'GET', body) {
  const res = await fetch(path.startsWith('http') ? path : `${GRAPH}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body && JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    const error = new Error(`${method} ${path}: ${res.status} ${detail.error?.code || ''} ${detail.error?.message || ''}`);
    error.status = res.status;
    error.code = detail.error?.code;
    throw error;
  }
  return res.status === 204 ? null : res.json();
}

// 1. Отделно приложение за cloud
const graphSp = await graph(`/servicePrincipals(appId='${GRAPH_APP_ID}')?$select=id,appRoles,oauth2PermissionScopes`);
const sitesSelected = graphSp.appRoles.find((r) => r.value === 'Sites.Selected');
const delegated = ['openid', 'email', 'profile'].map((value) => graphSp.oauth2PermissionScopes.find((s) => s.value === value));
const requiredResourceAccess = [{
  resourceAppId: GRAPH_APP_ID,
  resourceAccess: [{ id: sitesSelected.id, type: 'Role' }, ...delegated.map((s) => ({ id: s.id, type: 'Scope' }))],
}];

let [app] = (await graph(`/applications?$filter=displayName eq '${APP_NAME}'&$select=id,appId,web,keyCredentials`)).value;
if (app) {
  console.log(`1. Приложението „${APP_NAME}“ съществува: ${app.appId}`);
  if (!app.web?.redirectUris?.includes(callback)) {
    await graph(`/applications/${app.id}`, 'PATCH', { web: { redirectUris: [...(app.web?.redirectUris || []), callback] } });
    console.log(`   добавен адрес за вход ${callback}`);
  }
  if (!app.keyCredentials?.length) {
    await graph(`/applications/${app.id}`, 'PATCH', {
      keyCredentials: [{ type: 'AsymmetricX509Cert', usage: 'Verify', displayName: APP_NAME, key: certificate.toString('base64') }],
    });
    console.log('   качен сертификат');
  }
} else {
  // Вход само със служебни акаунти (Microsoft Entra), без лични Microsoft акаунти.
  app = await graph('/applications', 'POST', {
    displayName: APP_NAME,
    signInAudience: 'AzureADMultipleOrgs',
    web: { redirectUris: [callback], implicitGrantSettings: { enableIdTokenIssuance: false } },
    keyCredentials: [{ type: 'AsymmetricX509Cert', usage: 'Verify', displayName: APP_NAME, key: certificate.toString('base64') }],
    requiredResourceAccess,
    info: { marketingUrl: 'https://cloud.buladmin.eu/' },
  });
  console.log(`1. Създадено приложение „${APP_NAME}“: ${app.appId}`);
}
const appId = app.appId;
if (tomlVar('MS_CLIENT_ID') !== appId) {
  toml = toml.replace(/^MS_CLIENT_ID = ".*"$/m, `MS_CLIENT_ID = "${appId}"`);
  writeFileSync(here('../wrangler.toml'), toml);
  console.log(`   MS_CLIENT_ID в wrangler.toml е обновен на ${appId}`);
}

let appSp;
for (let attempt = 0; !appSp; attempt++) {
  try {
    appSp = await graph(`/servicePrincipals(appId='${appId}')?$select=id`);
  } catch (err) {
    if (err.status !== 404) throw err;
    try {
      appSp = await graph('/servicePrincipals', 'POST', { appId });
    } catch (createErr) {
      if (attempt > 5) throw createErr;
      await sleep(5);
    }
  }
}
// setup-mail.ps1 чете този идентификатор: Exchange изисква ID-то от Enterprise applications.
writeFileSync(here('../.secrets/service-principal-id.txt'), appSp.id);

// 2. Одобрение за организацията. Mail.Send нарочно НЕ се дава тук: в Entra то важи за всички кутии в tenant-а.
// Изпращането се разрешава само за no-reply@cloud.buladmin.eu през Exchange RBAC със scripts/setup-mail.ps1.
const assignments = (await graph(`/servicePrincipals/${appSp.id}/appRoleAssignments`)).value;
if (assignments.some((a) => a.appRoleId === sitesSelected.id && a.resourceId === graphSp.id)) {
  console.log('2. Sites.Selected вече е одобрено.');
} else {
  await graph(`/servicePrincipals/${graphSp.id}/appRoleAssignedTo`, 'POST', { principalId: appSp.id, resourceId: graphSp.id, appRoleId: sitesSelected.id });
  console.log('2. Sites.Selected е одобрено.');
}
const grants = (await graph(`/oauth2PermissionGrants?$filter=clientId eq '${appSp.id}'`)).value;
const grant = grants.find((g) => g.resourceId === graphSp.id && g.consentType === 'AllPrincipals');
if (!grant) {
  await graph('/oauth2PermissionGrants', 'POST', { clientId: appSp.id, consentType: 'AllPrincipals', resourceId: graphSp.id, scope: 'openid email profile' });
  console.log('   входът е одобрен за цялата организация (без екран за съгласие).');
} else {
  console.log('   входът вече е одобрен за организацията.');
}

// 3. Домейн за имейлите
let domain;
try {
  domain = await graph(`/domains/${MAIL_DOMAIN}`);
} catch (err) {
  if (err.status !== 404) throw err;
  domain = await graph('/domains', 'POST', { id: MAIL_DOMAIN });
  console.log(`3. Домейнът ${MAIL_DOMAIN} е добавен в tenant-а.`);
}
if (!domain.isVerified) {
  try {
    domain = await graph(`/domains/${MAIL_DOMAIN}/verify`, 'POST');
  } catch { /* записът за проверка още не е в DNS */ }
}
const dnsRow = (r) => {
  if (r.recordType === 'Txt') return `TXT   ${r.label}   "${r.text}"`;
  if (r.recordType === 'Mx') return `MX    ${r.label}   ${r.mailExchange}   (приоритет ${r.preference})`;
  if (r.recordType === 'CName') return `CNAME ${r.label}   ${r.canonicalName}`;
  return `${r.recordType} ${r.label}`;
};
if (domain.isVerified) {
  console.log(`3. Домейнът ${MAIL_DOMAIN} е потвърден.`);
  if (!domain.supportedServices?.includes('Email')) {
    try {
      await graph(`/domains/${MAIL_DOMAIN}`, 'PATCH', { supportedServices: ['Email'] });
      console.log('   включена е услугата Email.');
    } catch (err) {
      console.log(`   ВНИМАНИЕ: не успях да включа Email за домейна: ${err.message}`);
    }
  }
  const records = (await graph(`/domains/${MAIL_DOMAIN}/serviceConfigurationRecords`)).value
    .filter((r) => r.supportedService === 'Email');
  console.log('DNS-MAIL Записи за поща в DNS (Cloudflare, DNS only):');
  for (const r of records) console.log(`DNS-MAIL ${dnsRow(r)}`);
} else {
  const records = (await graph(`/domains/${MAIL_DOMAIN}/verificationDnsRecords`)).value.filter((r) => r.recordType === 'Txt');
  console.log(`3. Домейнът ${MAIL_DOMAIN} чака потвърждение. Добавете в DNS (Cloudflare, DNS only) и пуснете скрипта отново:`);
  for (const r of records) console.log(`DNS-VERIFY ${dnsRow(r)}`);
}

// 4. Достъп само до сайта на cloud
const site = await graph(`/sites/${tomlVar('SP_HOSTNAME')}:${tomlVar('SP_SITE_PATH')}?$select=id,webUrl`);
const findGrant = async () => (await graph(`/sites/${site.id}/permissions`)).value
  .find((p) => (p.grantedToIdentitiesV2 || p.grantedToIdentities || []).some((g) => g.application?.id === appId));
const setRole = (siteGrant, roles) => graph(`/sites/${site.id}/permissions/${siteGrant.id}`, 'PATCH', { roles });

const existing = await findGrant();
if (existing) {
  await setRole(existing, ['manage']);
} else {
  await graph(`/sites/${site.id}/permissions`, 'POST', {
    roles: ['manage'],
    grantedToIdentities: [{ application: { id: appId, displayName: APP_NAME } }],
  });
}
console.log(`4. Приложението има временно право manage върху ${site.webUrl}.`);

// 5. Таблици. Новото приложение и сертификатът се разпространяват до няколко минути, затова има повторни опити.
const admin = arg('--admin');
const provisionArgs = [here('./provision.mjs'), ...(admin ? ['--admin', admin, '--name', arg('--name') || admin] : [])];
let provisioned = false;
for (let attempt = 1; attempt <= 12 && !provisioned; attempt++) {
  console.log(`5. Създаване на таблиците, опит ${attempt}...`);
  const result = spawnSync(process.execPath, provisionArgs, { stdio: 'inherit', env: process.env });
  provisioned = result.status === 0;
  if (!provisioned && attempt < 12) await sleep(30);
}
if (!provisioned) throw new Error('Таблиците не бяха създадени. Вижте грешката по-горе; правото остава manage.');

// 6. За ежедневната работа стига write.
await setRole(await findGrant(), ['write']);
console.log('6. Правата върху сайта са намалени до write.');
console.log('ГОТОВО');
