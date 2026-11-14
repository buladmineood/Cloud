import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp, SESSION_COOKIE } from '../src/app.js';
import { b64url, hashPassword, sha256, signToken } from '../src/crypto.js';
import { computeTotals, nextNumber, validateLines } from '../src/documents.js';
import { effectivePlan } from '../src/plans.js';
import { MemoryStore } from '../src/store.js';

const ORIGIN = 'https://cloud.example';
const env = { APP_ORIGIN: ORIGIN, SESSION_SECRET: 'test-secret', PASSWORD_PEPPER: 'pepper', MAIL_ENABLED: 'false', GRAPH_TENANT_ID: 'tenant-1' };
const COMPANY = {
  name: 'Нашата ООД', eik: '123456786', vatNumber: 'BG123456786', city: 'София', address: 'ул. 1', vatRegistered: 'Да', invoiceStart: '1', dueDays: '7',
};
const member = (orgId, userId, role) => ({ id: `${orgId}:${userId}`, orgId, userId, role, isActive: 'Да' });
const user = (id, extra = {}) => ({ id, fullName: id.split('@')[0], isActive: 'Да', sessionVersion: '0', ...extra });

function setup(seed = {}, { plan = 'pro' } = {}) {
  const store = new MemoryStore({
    users: [user('admin@x.bg'), user('user@x.bg'), user('viewer@x.bg'), user('other@y.bg', { googleId: 'google:o' }), user('off@x.bg', { isActive: 'Не' }),
      user('staff@buladmin.eu', { platformRole: 'Администратор на БУЛАДМИН' })],
    orgs: [
      { id: 'ORG-A', ...COMPANY, planId: plan, orgStatus: 'Активна' },
      { id: 'ORG-B', ...COMPANY, name: 'Друга ООД', eik: '831641791', vatNumber: 'BG831641791', planId: 'free', orgStatus: 'Активна' },
    ],
    members: [member('ORG-A', 'admin@x.bg', 'Администратор'), member('ORG-A', 'user@x.bg', 'Потребител'), member('ORG-A', 'viewer@x.bg', 'Наблюдател'),
      member('ORG-B', 'other@y.bg', 'Администратор'), member('ORG-A', 'off@x.bg', 'Потребител')],
    companies: [
      { id: 'CO-1', orgId: 'ORG-A', name: 'Клиент ЕООД', relation: 'Клиент', city: 'Варна', address: 'бул. 2', eik: '', owner: 'user@x.bg' },
      { id: 'CO-B', orgId: 'ORG-B', name: 'Чужд клиент', relation: 'Клиент', city: 'Русе', address: 'ул. 3' },
    ],
    products: [
      { id: 'PR-1', orgId: 'ORG-A', name: 'Услуга', itemType: 'Услуга', unit: 'бр.', price: 100, vatRate: '20', isActive: 'Да' },
      { id: 'PR-2', orgId: 'ORG-A', name: 'Стока', itemType: 'Стока', unit: 'бр.', price: 10, vatRate: '20', stock: 50, isActive: 'Да' },
    ],
    ...seed,
  });
  const app = createApp({ env, store, now: () => new Date('2026-11-14T10:00:00Z') });
  const cookies = {};
  const call = async (method, path, { body, raw, type, as, org = 'ORG-A', headers = {} } = {}) => {
    const h = { ...headers };
    if (as) {
      cookies[as] ??= await signToken({ uid: as, ver: String((await store.find('users', 'id', as))[0]?.sessionVersion || '0') }, env.SESSION_SECRET, 3600);
      h.cookie = `${SESSION_COOKIE}=${cookies[as]}`;
    }
    if (org) h['x-org'] = org;
    if (method !== 'GET') h.origin ??= ORIGIN;
    if (body !== undefined) h['content-type'] = 'application/json';
    if (raw) h['content-type'] = type;
    const res = await app(new Request(`${ORIGIN}${path}`, { method, headers: h, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) }));
    const isJson = (res.headers.get('content-type') || '').includes('json');
    return { status: res.status, headers: res.headers, data: isJson ? await res.json() : new Uint8Array(await res.arrayBuffer()) };
  };
  return { store, call, app };
}

const LINES = [{ productId: 'PR-1', name: 'Услуга', qty: 2, price: 100, vatRate: 20 }, { productId: 'PR-2', name: 'Стока', qty: 3, price: 10, discount: 10, vatRate: 20 }];
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

test('без сесия данните не са достъпни', async () => {
  const { call } = setup();
  assert.equal((await call('GET', '/api/data')).status, 401);
  assert.deepEqual((await call('GET', '/api/me')).data, { authenticated: false });
});

test('междусайтова заявка за промяна се отказва', async () => {
  const { call } = setup();
  const res = await call('POST', '/api/auth/login', { body: { email: 'a', password: 'b' }, headers: { origin: 'https://evil.example' } });
  assert.equal(res.status, 403);
});

test('вход с парола, заключване след 5 грешни опита', async () => {
  const { store, call } = setup();
  await store.update('users', 'user@x.bg', { passwordHash: await hashPassword('correct horse battery', 'pepper') });
  const ok = await call('POST', '/api/auth/login', { body: { email: 'USER@x.bg', password: 'correct horse battery' } });
  assert.equal(ok.status, 200);
  for (let i = 0; i < 5; i++) assert.equal((await call('POST', '/api/auth/login', { body: { email: 'user@x.bg', password: 'wrong' } })).status, 401);
  assert.equal((await call('POST', '/api/auth/login', { body: { email: 'user@x.bg', password: 'correct horse battery' } })).status, 429);
});

test('/api/me показва организациите на потребителя', async () => {
  const { call } = setup();
  const res = await call('GET', '/api/me', { as: 'admin@x.bg' });
  assert.deepEqual(res.data.orgs.map((o) => [o.id, o.role, o.plan]), [['ORG-A', 'Администратор', 'Професионален']]);
});

test('регистрация, нова организация на безплатния план, уведомление към БУЛАДМИН', async () => {
  const { store, call } = setup();
  const signup = await call('POST', '/api/auth/signup', { body: { email: 'New@Firm.bg', fullName: 'Нов Човек', password: 'a long enough password' } });
  assert.equal(signup.status, 201);
  const cookie = signup.headers.get('set-cookie').split(';')[0];
  const org = await call('POST', '/api/orgs', { body: { name: 'Нова фирма ЕООД', eik: '200000003' }, headers: { cookie }, org: null });
  assert.equal(org.status, 422, 'ЕИК с грешна контролна сума се отказва');
  const ok = await call('POST', '/api/orgs', { body: { name: 'Нова фирма ЕООД', eik: '202020204' }, headers: { cookie }, org: null });
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  const [created] = await store.find('orgs', 'id', ok.data.id);
  assert.equal(created.planId, 'free');
  assert.equal((await store.find('members', 'id', `${ok.data.id}:new@firm.bg`))[0].role, 'Администратор');
  const dup = await call('POST', '/api/orgs', { body: { name: 'Пак', eik: '202020204' }, headers: { cookie }, org: null });
  assert.equal(dup.status, 409);
});

test('потребител от една организация не вижда и не пипа данни на друга', async () => {
  const { call } = setup();
  assert.equal((await call('GET', '/api/data', { as: 'admin@x.bg', org: 'ORG-B' })).status, 403);
  const data = await call('GET', '/api/data', { as: 'admin@x.bg' });
  assert.deepEqual(data.data.companies.map((c) => c.id), ['CO-1']);
  assert.equal(data.data.companies[0].orgId, undefined);
  assert.equal((await call('PATCH', '/api/data/companies/CO-B', { as: 'admin@x.bg', body: { city: 'Х' } })).status, 404);
  const deal = await call('POST', '/api/data/deals', { as: 'admin@x.bg', body: { title: 'Х', companyId: 'CO-B' } });
  assert.equal(deal.status, 422);
  const doc = await call('POST', '/api/documents', { as: 'admin@x.bg', body: { docType: 'Фактура', companyId: 'CO-B', lines: LINES } });
  assert.equal(doc.status, 422);
});

test('администратор на БУЛАДМИН влиза във всяка организация', async () => {
  const { call } = setup();
  const res = await call('GET', '/api/data', { as: 'staff@buladmin.eu', org: 'ORG-B' });
  assert.equal(res.status, 200);
  assert.equal(res.data.role, 'Администратор');
  assert.equal(res.data.viaPlatform, true);
  assert.equal((await call('GET', '/api/platform', { as: 'admin@x.bg' })).status, 403);
});

test('ограничения на безплатния план: контрагенти, фактури, потребители, лого', async () => {
  const many = Array.from({ length: 10 }, (_, i) => ({ id: `CO-F${i}`, orgId: 'ORG-A', name: `Ф${i}`, relation: 'Клиент', city: 'С', address: 'а' }));
  const { store, call } = setup({}, { plan: 'free' });
  store.tables.companies = many.concat(store.tables.companies.filter((c) => c.orgId !== 'ORG-A'));
  const over = await call('POST', '/api/data/companies', { as: 'admin@x.bg', body: { name: 'Единадесети' } });
  assert.equal(over.status, 402);
  assert.match(over.data.error.message, /до 10 контрагенти/);
  // Вече има 4 активни членове при лимит 1: нова покана се отказва.
  assert.equal((await call('POST', '/api/org/members', { as: 'admin@x.bg', body: { email: 'n@x.bg', role: 'Потребител' } })).status, 402);
  assert.equal((await call('PUT', '/api/org/logo', { as: 'admin@x.bg', raw: PNG, type: 'image/png' })).status, 402);

  store.tables.documents = Array.from({ length: 10 }, (_, i) => ({
    id: `D${i}`, orgId: 'ORG-A', docType: 'Фактура', docStatus: 'Издаден', number: String(i + 1).padStart(10, '0'), issueDate: '2026-11-02',
  }));
  const draft = await call('POST', '/api/documents', { as: 'admin@x.bg', body: { docType: 'Фактура', companyId: 'CO-F1', lines: LINES } });
  assert.equal(draft.status, 201);
  const issue = await call('POST', `/api/documents/${draft.data.id}/issue`, { as: 'admin@x.bg' });
  assert.equal(issue.status, 402);
  assert.match(issue.data.error.message, /фактури и проформи този месец/);
});

test('платеният план изтича и организацията минава на безплатния', () => {
  const plans = [{ id: 'free', isDefault: 'Да' }, { id: 'pro', isDefault: 'Не' }];
  assert.equal(effectivePlan({ planId: 'pro', planUntil: '2026-11-30' }, plans, '2026-11-14').id, 'pro');
  assert.equal(effectivePlan({ planId: 'pro', planUntil: '2026-11-13' }, plans, '2026-11-14').id, 'free');
  assert.equal(effectivePlan({ planId: 'missing' }, plans, '2026-11-14').id, 'free');
});

test('лого: качване, показване на членове, отказ за чужди', async () => {
  const { call } = setup();
  assert.equal((await call('PUT', '/api/org/logo', { as: 'admin@x.bg', raw: new Uint8Array([1, 2, 3]), type: 'image/png' })).status, 415);
  assert.equal((await call('PUT', '/api/org/logo', { as: 'user@x.bg', raw: PNG, type: 'image/png' })).status, 403);
  assert.equal((await call('PUT', '/api/org/logo', { as: 'admin@x.bg', raw: PNG, type: 'image/png' })).status, 200);
  const logo = await call('GET', '/api/orgs/ORG-A/logo', { as: 'viewer@x.bg', org: null });
  assert.equal(logo.status, 200);
  assert.deepEqual([...logo.data], [...PNG]);
  assert.equal((await call('GET', '/api/orgs/ORG-A/logo', { as: 'other@y.bg', org: null })).status, 403);
});

test('членове: покана, роли и последен администратор', async () => {
  const { store, call } = setup();
  const invite = await call('POST', '/api/org/members', { as: 'admin@x.bg', body: { email: 'Nov@x.bg', fullName: 'Нов', role: 'Потребител' } });
  assert.equal(invite.status, 201);
  assert.match(invite.data.link, /set-password\.html#t=u\./);
  // Съществуващ потребител от друга организация се добавя без линк.
  const existing = await call('POST', '/api/org/members', { as: 'admin@x.bg', body: { email: 'other@y.bg', role: 'Наблюдател' } });
  assert.equal(existing.data.link, undefined);
  const me = await call('GET', '/api/me', { as: 'other@y.bg' });
  assert.deepEqual(me.data.orgs.map((o) => o.id).sort(), ['ORG-A', 'ORG-B']);
  assert.equal((await call('PATCH', '/api/org/members/admin%40x.bg', { as: 'admin@x.bg', body: { role: 'Потребител' } })).status, 409);
  assert.equal((await call('POST', '/api/org/members', { as: 'user@x.bg', body: { email: 'b@x.bg', role: 'Потребител' } })).status, 403);
  assert.equal((await store.find('members', 'id', 'ORG-A:nov@x.bg'))[0].role, 'Потребител');
});

test('спряна организация не е достъпна за членовете', async () => {
  const { call } = setup();
  assert.equal((await call('PATCH', '/api/platform/orgs/ORG-A', { as: 'staff@buladmin.eu', body: { status: 'Спряна', planId: 'standard', planUntil: '2027-01-31' } })).status, 200);
  const res = await call('GET', '/api/data', { as: 'admin@x.bg' });
  assert.equal(res.status, 403);
  assert.match(res.data.error.message, /спрян/);
  const overview = await call('GET', '/api/platform', { as: 'staff@buladmin.eu' });
  const org = overview.data.orgs.find((o) => o.id === 'ORG-A');
  assert.deepEqual([org.status, org.planId, org.planUntil], ['Спряна', 'standard', '2027-01-31']);
  assert.equal(org.usage.maxUsers, 4);
});

test('БУЛАДМИН променя планове и добавя администратор на организация', async () => {
  const { store, call } = setup();
  const plan = await call('PUT', '/api/platform/plans/free', { as: 'staff@buladmin.eu', body: { name: 'Безплатен', maxCompanies: '25', maxInvoices: '', allowLogo: 'Не', isDefault: 'Да', isActive: 'Да' } });
  assert.equal(plan.status, 200);
  assert.equal((await store.find('plans', 'id', 'free'))[0].maxCompanies, 25);
  const add = await call('POST', '/api/platform/orgs/ORG-B/members', { as: 'staff@buladmin.eu', body: { email: 'boss@b.bg', role: 'Администратор' } });
  assert.equal(add.status, 201);
  assert.equal((await store.find('members', 'id', 'ORG-B:boss@b.bg'))[0].role, 'Администратор');
});

test('CRUD на контрагент с валидация, права и история', async () => {
  const { call } = setup();
  assert.equal((await call('POST', '/api/data/companies', { as: 'viewer@x.bg', body: { name: 'А' } })).status, 403);
  const bad = await call('POST', '/api/data/companies', { as: 'user@x.bg', body: { name: '', eik: '123', email: 'x' } });
  assert.ok(bad.data.error.fields.name && bad.data.error.fields.eik && bad.data.error.fields.email);
  const created = await call('POST', '/api/data/companies', { as: 'user@x.bg', body: { name: 'Нова ООД', eik: '123456786' } });
  assert.equal(created.status, 201);
  const id = created.data.id;
  await call('PATCH', `/api/data/companies/${id}`, { as: 'user@x.bg', body: { city: 'Русе' } });
  const hist = await call('GET', `/api/history/companies/${id}`, { as: 'viewer@x.bg' });
  assert.deepEqual(hist.data.map((e) => e.action), ['Промяна', 'Създаване']);
  assert.equal((await call('GET', `/api/history/companies/${id}`, { as: 'other@y.bg', org: 'ORG-B' })).data.length, 0);
  assert.equal((await call('DELETE', `/api/data/companies/${id}`, { as: 'user@x.bg' })).status, 403);
  assert.equal((await call('DELETE', `/api/data/companies/${id}`, { as: 'admin@x.bg' })).status, 200);
});

test('суми и ДДС по ставки', () => {
  const { lines } = validateLines(LINES, new Map([['PR-1', {}], ['PR-2', {}]]));
  assert.deepEqual(computeTotals(lines, 'Фактура'), { subtotal: 227, vatAmount: 45.4, total: 272.4, byRate: [{ rate: 20, base: 227, vat: 45.4 }] });
  assert.equal(computeTotals(lines, 'Кредитно известие').total, -272.4);
});

test('номерация: обща 10-цифрена поредица за фактури и известия', () => {
  const docs = [{ docType: 'Фактура', number: '0000000041' }, { docType: 'Кредитно известие', number: '0000000042' }, { docType: 'Оферта', number: 'OF-2026-0007' }];
  assert.equal(nextNumber(docs, 'Фактура', { year: '2026' }), '0000000043');
  assert.equal(nextNumber(docs, 'Оферта', { year: '2026' }), 'OF-2026-0008');
});

test('номерацията е отделна за всяка организация', async () => {
  const { call } = setup({
    documents: [{ id: 'DB', orgId: 'ORG-B', docType: 'Фактура', docStatus: 'Издаден', number: '0000000099', issueDate: '2026-11-01' }],
  });
  const draft = await call('POST', '/api/documents', { as: 'user@x.bg', body: { docType: 'Фактура', companyId: 'CO-1', lines: LINES } });
  const issued = await call('POST', `/api/documents/${draft.data.id}/issue`, { as: 'user@x.bg' });
  assert.equal(issued.data.number, '0000000001');
});

test('фактура: издаване, наличност, плащане, кредитно известие; PDF не се пази на сървъра', async () => {
  const { store, call } = setup();
  const draft = await call('POST', '/api/documents', { as: 'user@x.bg', body: { docType: 'Фактура', companyId: 'CO-1', lines: LINES } });
  const id = draft.data.id;
  const issued = await call('POST', `/api/documents/${id}/issue`, { as: 'user@x.bg' });
  assert.equal(issued.data.number, '0000000001');
  assert.equal((await store.find('products', 'id', 'PR-2'))[0].stock, 47);
  // PDF се създава наново в браузъра всеки път; адресът за архив вече не съществува.
  assert.equal((await call('PUT', `/api/documents/${id}/pdf`, { as: 'user@x.bg', raw: new TextEncoder().encode('%PDF-1.7'), type: 'application/pdf' })).status, 404);
  assert.equal(store.files.size, 0);

  const part = await call('POST', '/api/payments', { as: 'user@x.bg', body: { documentId: id, amount: '100' } });
  assert.equal(part.data.document.paymentStatus, 'Частично платен');
  const credit = await call('POST', `/api/documents/${id}/derive`, { as: 'user@x.bg', body: { docType: 'Кредитно известие' } });
  const creditIssued = await call('POST', `/api/documents/${credit.data.id}/issue`, { as: 'user@x.bg' });
  assert.equal(creditIssued.data.number, '0000000002');
  assert.equal((await store.find('products', 'id', 'PR-2'))[0].stock, 50);
});

test('без данни на фирмата не се издава документ', async () => {
  const { store, call } = setup();
  await store.update('orgs', 'ORG-A', { eik: '' });
  const draft = await call('POST', '/api/documents', { as: 'user@x.bg', body: { docType: 'Фактура', companyId: 'CO-1', lines: LINES } });
  const res = await call('POST', `/api/documents/${draft.data.id}/issue`, { as: 'user@x.bg' });
  assert.equal(res.status, 422);
});

test('настройки на организацията: само администратор и с проверка', async () => {
  const { call } = setup();
  assert.equal((await call('PUT', '/api/org/settings', { as: 'user@x.bg', body: COMPANY })).status, 403);
  assert.equal((await call('PUT', '/api/org/settings', { as: 'admin@x.bg', body: { ...COMPANY, eik: '1' } })).status, 422);
  assert.equal((await call('PUT', '/api/org/settings', { as: 'admin@x.bg', body: { ...COMPANY, eik: '831641791' } })).status, 409);
  const ok = await call('PUT', '/api/org/settings', { as: 'admin@x.bg', body: { ...COMPANY, iban: 'BG80 BNBG 9661 1020 3456 78' } });
  assert.equal(ok.data.iban, 'BG80BNBG96611020345678');
});

test('Google вход създава нов потребител с потвърден имейл', async () => {
  const { store } = setup();
  const app = createApp({
    env: { ...env, GOOGLE_CLIENT_ID: 'gid', GOOGLE_CLIENT_SECRET: 's' },
    store,
    fetchImpl: async () => new Response(JSON.stringify({
      id_token: `x.${b64url(new TextEncoder().encode(JSON.stringify({
        iss: 'https://accounts.google.com', aud: 'gid', exp: 9e9, nonce: 'n1', sub: 'g-9', email: 'nov@gmail.com', email_verified: true, name: 'Нов Човек',
      })))}.y`,
    })),
  });
  const flow = await signToken({ provider: 'google', state: 's1', nonce: 'n1', verifier: 'v' }, env.SESSION_SECRET, 600);
  const res = await app(new Request(`${ORIGIN}/api/auth/google/callback?state=s1&code=c`, { headers: { cookie: `__Host-bc_oauth=${flow}` } }));
  assert.equal(res.headers.get('location'), '/app.html');
  const [created] = await store.find('users', 'id', 'nov@gmail.com');
  assert.equal(created.googleId, 'google:g-9');
  assert.ok(created.emailVerifiedAt);
});

test('Microsoft акаунт от чужд tenant не се свързва с чужд имейл', async () => {
  const { store } = setup();
  const app = createApp({
    env: { ...env, MS_CLIENT_ID: 'mid' },
    store,
    fetchImpl: async () => new Response(JSON.stringify({
      id_token: `x.${b64url(new TextEncoder().encode(JSON.stringify({
        iss: 'https://login.microsoftonline.com/evil/v2.0', tid: 'evil', aud: 'mid', exp: 9e9, nonce: 'n1', sub: 'm-1', preferred_username: 'admin@x.bg',
      })))}.y`,
    })),
  });
  // Сертификатът не е нужен за проверката: подписът на клиента се подменя.
  const flow = await signToken({ provider: 'microsoft', state: 's1', nonce: 'n1', verifier: 'v' }, env.SESSION_SECRET, 600);
  const res = await app(new Request(`${ORIGIN}/api/auth/microsoft/callback?state=s1&code=c`, { headers: { cookie: `__Host-bc_oauth=${flow}` } })).catch((e) => e);
  if (res instanceof Response) {
    assert.match(res.headers.get('location'), /error=/);
  }
  assert.equal((await store.find('users', 'id', 'admin@x.bg'))[0].microsoftId, undefined);
});

test('еднократният линк се пази само като хеш', async () => {
  const { store, call } = setup();
  const res = await call('POST', '/api/platform/users/user%40x.bg/reset', { as: 'staff@buladmin.eu', org: null });
  const token = res.data.link.split('#t=')[1];
  const [u] = await store.find('users', 'id', 'user@x.bg');
  assert.equal(u.resetTokenHash, b64url(await sha256(token)));
});
