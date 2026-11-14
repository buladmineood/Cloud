import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp, SESSION_COOKIE } from '../src/app.js';
import { b64url, hashPassword, sha256, signToken } from '../src/crypto.js';
import { computeTotals, nextNumber, validateLines } from '../src/documents.js';
import { MemoryStore } from '../src/store.js';

const ORIGIN = 'https://cloud.example';
const env = { APP_ORIGIN: ORIGIN, SESSION_SECRET: 'test-secret', PASSWORD_PEPPER: 'pepper', MAIL_ENABLED: 'false', GRAPH_TENANT_ID: 'tenant-1' };
const COMPANY = {
  name: 'Нашата ООД', eik: '123456786', vatNumber: 'BG123456786', city: 'София', address: 'ул. 1', vatRegistered: 'Да', invoiceStart: '1', dueDays: '7',
};

function setup(seed = {}) {
  const store = new MemoryStore({
    users: [
      { id: 'admin@x.bg', fullName: 'Админ', role: 'Администратор', isActive: 'Да', sessionVersion: '0' },
      { id: 'user@x.bg', fullName: 'Потребител', role: 'Потребител', isActive: 'Да', sessionVersion: '0' },
      { id: 'viewer@x.bg', fullName: 'Наблюдател', role: 'Наблюдател', isActive: 'Да', sessionVersion: '0' },
      { id: 'off@x.bg', fullName: 'Спрян', role: 'Потребител', isActive: 'Не', sessionVersion: '0' },
    ],
    settings: [{ id: 'company', value: JSON.stringify(COMPANY) }],
    companies: [{ id: 'CO-1', name: 'Клиент ЕООД', relation: 'Клиент', city: 'Варна', address: 'бул. 2', eik: '', owner: 'user@x.bg' }],
    products: [
      { id: 'PR-1', name: 'Услуга', itemType: 'Услуга', unit: 'бр.', price: 100, vatRate: '20', isActive: 'Да' },
      { id: 'PR-2', name: 'Стока', itemType: 'Стока', unit: 'бр.', price: 10, vatRate: '20', stock: 50, isActive: 'Да' },
    ],
    ...seed,
  });
  const app = createApp({ env, store, now: () => new Date('2026-11-14T10:00:00Z') });
  const cookies = {};
  const call = async (method, path, { body, as, headers = {} } = {}) => {
    const h = { ...headers };
    if (as) {
      cookies[as] ??= await signToken({ uid: as, ver: String((await store.find('users', 'id', as))[0]?.sessionVersion || '0') }, env.SESSION_SECRET, 3600);
      h.cookie = `${SESSION_COOKIE}=${cookies[as]}`;
    }
    if (method !== 'GET') h.origin ??= ORIGIN;
    if (body !== undefined) h['content-type'] = 'application/json';
    const res = await app(new Request(`${ORIGIN}${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }));
    const text = await res.text();
    return { status: res.status, headers: res.headers, data: text ? JSON.parse(text) : null };
  };
  return { store, call };
}

const LINES = [{ productId: 'PR-1', name: 'Услуга', qty: 2, price: 100, vatRate: 20 }, { productId: 'PR-2', name: 'Стока', qty: 3, price: 10, discount: 10, vatRate: 20 }];

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
  assert.match(ok.headers.get('set-cookie'), /__Host-bc_session=/);
  for (let i = 0; i < 5; i++) assert.equal((await call('POST', '/api/auth/login', { body: { email: 'user@x.bg', password: 'wrong' } })).status, 401);
  assert.equal((await call('POST', '/api/auth/login', { body: { email: 'user@x.bg', password: 'correct horse battery' } })).status, 429);
});

test('спрян потребител не влиза и сесията му не важи', async () => {
  const { store, call } = setup();
  await store.update('users', 'off@x.bg', { passwordHash: await hashPassword('correct horse battery', 'pepper') });
  assert.equal((await call('POST', '/api/auth/login', { body: { email: 'off@x.bg', password: 'correct horse battery' } })).status, 401);
  assert.equal((await call('GET', '/api/data', { as: 'off@x.bg' })).status, 401);
});

test('покана и задаване на парола с еднократен линк', async () => {
  const { store, call } = setup();
  const invite = await call('POST', '/api/admin/users', { as: 'admin@x.bg', body: { email: 'New@x.bg', fullName: 'Нов', role: 'Потребител' } });
  assert.equal(invite.status, 201);
  const token = invite.data.link.split('#t=')[1];
  assert.equal((await call('POST', '/api/auth/set-password', { body: { token, password: 'short' } })).status, 422);
  const set = await call('POST', '/api/auth/set-password', { body: { token, password: 'a long enough password' } });
  assert.equal(set.status, 200);
  assert.equal((await call('POST', '/api/auth/set-password', { body: { token, password: 'a long enough password' } })).status, 400);
  assert.ok((await store.find('users', 'id', 'new@x.bg'))[0].passwordHash);
  assert.equal((await call('POST', '/api/admin/users', { as: 'user@x.bg', body: { email: 'b@x.bg', fullName: 'Б', role: 'Потребител' } })).status, 403);
});

test('администратор не може да си отнеме правата', async () => {
  const { call } = setup();
  assert.equal((await call('PATCH', '/api/admin/users/admin%40x.bg', { as: 'admin@x.bg', body: { role: 'Потребител' } })).status, 409);
  const res = await call('PATCH', '/api/admin/users/user%40x.bg', { as: 'admin@x.bg', body: { isActive: false } });
  assert.equal(res.data.isActive, 'Не');
});

test('Google вход свързва поканен потребител само с потвърден имейл', async () => {
  const { store, call } = setup();
  const app = createApp({
    env: { ...env, GOOGLE_CLIENT_ID: 'gid', GOOGLE_CLIENT_SECRET: 's' },
    store,
    fetchImpl: async () => new Response(JSON.stringify({
      id_token: `x.${b64url(new TextEncoder().encode(JSON.stringify({
        iss: 'https://accounts.google.com', aud: 'gid', exp: 9e9, nonce: 'n1', sub: 'g-123', email: 'user@x.bg', email_verified: true,
      })))}.y`,
    })),
  });
  const flow = await signToken({ provider: 'google', state: 's1', nonce: 'n1', verifier: 'v' }, env.SESSION_SECRET, 600);
  const res = await app(new Request(`${ORIGIN}/api/auth/google/callback?state=s1&code=c`, { headers: { cookie: `__Host-bc_oauth=${flow}` } }));
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/app.html');
  assert.equal((await store.find('users', 'id', 'user@x.bg'))[0].googleId, 'google:g-123');
});

test('CRUD на контрагент с валидация и права', async () => {
  const { call } = setup();
  assert.equal((await call('POST', '/api/data/companies', { as: 'viewer@x.bg', body: { name: 'А' } })).status, 403);
  const bad = await call('POST', '/api/data/companies', { as: 'user@x.bg', body: { name: '', eik: '123', email: 'x' } });
  assert.equal(bad.status, 422);
  assert.ok(bad.data.error.fields.name && bad.data.error.fields.eik && bad.data.error.fields.email);
  const created = await call('POST', '/api/data/companies', { as: 'user@x.bg', body: { name: 'Нова ООД', eik: '123456786' } });
  assert.equal(created.status, 201);
  assert.equal(created.data.relation, 'Клиент');
  assert.equal(created.data.owner, 'user@x.bg');
  const id = created.data.id;
  const updated = await call('PATCH', `/api/data/companies/${id}`, { as: 'user@x.bg', body: { city: 'Русе' } });
  assert.equal(updated.data.city, 'Русе');
  const hist = await call('GET', `/api/history/companies/${id}`, { as: 'viewer@x.bg' });
  assert.deepEqual(hist.data.map((e) => e.action), ['Промяна', 'Създаване']);
  assert.equal((await call('DELETE', `/api/data/companies/${id}`, { as: 'user@x.bg' })).status, 403);
  assert.equal((await call('DELETE', `/api/data/companies/${id}`, { as: 'admin@x.bg' })).status, 200);
});

test('контрагент с документи не се изтрива', async () => {
  const { call } = setup();
  await call('POST', '/api/documents', { as: 'user@x.bg', body: { docType: 'Оферта', companyId: 'CO-1', lines: LINES } });
  assert.equal((await call('DELETE', '/api/data/companies/CO-1', { as: 'admin@x.bg' })).status, 409);
});

test('сделка: приключване записва дата', async () => {
  const { call } = setup();
  const deal = await call('POST', '/api/data/deals', { as: 'user@x.bg', body: { title: 'Сделка', companyId: 'CO-1', amount: '1 200,50' } });
  assert.equal(deal.data.amount, 1200.5);
  assert.equal(deal.data.stage, 'Нова');
  const won = await call('PATCH', `/api/data/deals/${deal.data.id}`, { as: 'user@x.bg', body: { stage: 'Спечелена' } });
  assert.ok(won.data.closedAt);
  assert.equal((await call('POST', '/api/data/deals', { as: 'user@x.bg', body: { title: 'X', companyId: 'CO-404' } })).status, 422);
});

test('суми и ДДС по ставки', () => {
  const { lines } = validateLines(LINES, new Map([['PR-1', {}], ['PR-2', {}]]));
  assert.deepEqual(computeTotals(lines, 'Фактура'), { subtotal: 227, vatAmount: 45.4, total: 272.4, byRate: [{ rate: 20, base: 227, vat: 45.4 }] });
  assert.equal(computeTotals(lines, 'Кредитно известие').total, -272.4);
  assert.match(validateLines([], new Map()).error, /поне един ред/);
  assert.match(validateLines([{ name: 'a', qty: 1, price: 1, vatRate: 7 }], new Map()).error, /ставката/);
});

test('номерация: обща 10-цифрена поредица за фактури и известия', () => {
  const docs = [
    { docType: 'Фактура', number: '0000000041' },
    { docType: 'Кредитно известие', number: '0000000042' },
    { docType: 'Оферта', number: 'OF-2026-0007' },
  ];
  assert.equal(nextNumber(docs, 'Фактура', { year: '2026' }), '0000000043');
  assert.equal(nextNumber([], 'Фактура', { year: '2026', invoiceStart: '1001' }), '0000001001');
  assert.equal(nextNumber(docs, 'Оферта', { year: '2026' }), 'OF-2026-0008');
  assert.equal(nextNumber(docs, 'Оферта', { year: '2027' }), 'OF-2027-0001');
});

test('издаване на фактура, наличност, плащане и кредитно известие', async () => {
  const { store, call } = setup();
  const draft = await call('POST', '/api/documents', { as: 'user@x.bg', body: { docType: 'Фактура', companyId: 'CO-1', lines: LINES } });
  assert.equal(draft.status, 201);
  assert.equal(draft.data.number, '');
  assert.equal(draft.data.total, 272.4);
  assert.equal(draft.data.dueDate, '2026-11-21');
  const id = draft.data.id;

  const issued = await call('POST', `/api/documents/${id}/issue`, { as: 'user@x.bg' });
  assert.equal(issued.status, 200);
  assert.equal(issued.data.number, '0000000001');
  assert.equal(issued.data.buyer.name, 'Клиент ЕООД');
  assert.equal((await store.find('products', 'id', 'PR-2'))[0].stock, 47);
  assert.equal((await call('PATCH', `/api/documents/${id}`, { as: 'user@x.bg', body: { companyId: 'CO-1', lines: LINES } })).status, 409);

  assert.equal((await call('POST', '/api/payments', { as: 'user@x.bg', body: { documentId: id, amount: 300 } })).status, 422);
  const part = await call('POST', '/api/payments', { as: 'user@x.bg', body: { documentId: id, amount: '100' } });
  assert.equal(part.data.document.paymentStatus, 'Частично платен');
  const full = await call('POST', '/api/payments', { as: 'user@x.bg', body: { documentId: id, amount: 172.4, method: 'В брой' } });
  assert.equal(full.data.document.paymentStatus, 'Платен');
  assert.equal((await call('POST', `/api/documents/${id}/cancel`, { as: 'admin@x.bg' })).status, 409);

  const credit = await call('POST', `/api/documents/${id}/derive`, { as: 'user@x.bg', body: { docType: 'Кредитно известие' } });
  assert.equal(credit.status, 201);
  assert.equal(credit.data.total, -272.4);
  const creditIssued = await call('POST', `/api/documents/${credit.data.id}/issue`, { as: 'user@x.bg' });
  assert.equal(creditIssued.data.number, '0000000002');
  assert.equal((await store.find('products', 'id', 'PR-2'))[0].stock, 50);
});

test('оферта: номер, приемане и превръщане във фактура', async () => {
  const { call } = setup();
  const offer = await call('POST', '/api/documents', { as: 'user@x.bg', body: { docType: 'Оферта', companyId: 'CO-1', lines: LINES } });
  assert.equal(offer.data.dueDate, '2026-12-14');
  const issued = await call('POST', `/api/documents/${offer.data.id}/issue`, { as: 'user@x.bg' });
  assert.equal(issued.data.number, 'OF-2026-0001');
  const invoice = await call('POST', `/api/documents/${offer.data.id}/derive`, { as: 'user@x.bg', body: { docType: 'Фактура' } });
  assert.equal(invoice.status, 201);
  assert.equal(invoice.data.relatedId, offer.data.id);
  const data = await call('GET', '/api/data', { as: 'user@x.bg' });
  assert.equal(data.data.documents.find((d) => d.id === offer.data.id).docStatus, 'Приета');
});

test('без данни на фирмата не се издава документ', async () => {
  const { call } = setup({ settings: [] });
  const draft = await call('POST', '/api/documents', { as: 'user@x.bg', body: { docType: 'Фактура', companyId: 'CO-1', lines: LINES } });
  const res = await call('POST', `/api/documents/${draft.data.id}/issue`, { as: 'user@x.bg' });
  assert.equal(res.status, 422);
  assert.match(res.data.error.message, /Настройки/);
});

test('ставка 0% изисква основание', async () => {
  const { call } = setup();
  const draft = await call('POST', '/api/documents', { as: 'user@x.bg', body: { docType: 'Фактура', companyId: 'CO-1', lines: [{ name: 'Износ', qty: 1, price: 50, vatRate: 0 }] } });
  assert.equal((await call('POST', `/api/documents/${draft.data.id}/issue`, { as: 'user@x.bg' })).status, 422);
});

test('настройки на фирмата: само администратор и с проверка', async () => {
  const { call } = setup();
  assert.equal((await call('PUT', '/api/admin/settings', { as: 'user@x.bg', body: COMPANY })).status, 403);
  const bad = await call('PUT', '/api/admin/settings', { as: 'admin@x.bg', body: { ...COMPANY, eik: '1', vatNumber: 'X' } });
  assert.equal(bad.status, 422);
  const ok = await call('PUT', '/api/admin/settings', { as: 'admin@x.bg', body: { ...COMPANY, iban: 'BG80 BNBG 9661 1020 3456 78' } });
  assert.equal(ok.data.iban, 'BG80BNBG96611020345678');
});

test('сесията спира след смяна на ролята', async () => {
  const { call } = setup();
  assert.equal((await call('GET', '/api/data', { as: 'user@x.bg' })).status, 200);
  await call('PATCH', '/api/admin/users/user%40x.bg', { as: 'admin@x.bg', body: { role: 'Наблюдател' } });
  assert.equal((await call('GET', '/api/data', { as: 'user@x.bg' })).status, 401);
});

test('еднократният линк се пази само като хеш', async () => {
  const { store, call } = setup();
  const res = await call('POST', '/api/admin/users/user%40x.bg/reset', { as: 'admin@x.bg' });
  const token = res.data.link.split('#t=')[1];
  const [user] = await store.find('users', 'id', 'user@x.bg');
  assert.equal(user.resetTokenHash, b64url(await sha256(token)));
  assert.ok(!JSON.stringify(user).includes(token));
});
