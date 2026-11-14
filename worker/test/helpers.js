// Обща тестова среда: демо данни в паметта и помощник за заявки към API-то.
import { createApp, SESSION_COOKIE } from '../src/app.js';
import { signToken } from '../src/crypto.js';
import { MemoryStore } from '../src/store.js';

export const ORIGIN = 'https://cloud.example';
export const env = { APP_ORIGIN: ORIGIN, SESSION_SECRET: 'test-secret', PASSWORD_PEPPER: 'pepper', MAIL_ENABLED: 'false', GRAPH_TENANT_ID: 'tenant-1' };
export const COMPANY = {
  name: 'Нашата ООД', eik: '123456786', vatNumber: 'BG123456786', city: 'София', address: 'ул. 1', vatRegistered: 'Да', invoiceStart: '1', dueDays: '7',
};
export const member = (orgId, userId, role) => ({ id: `${orgId}:${userId}`, orgId, userId, role, isActive: 'Да' });
export const user = (id, extra = {}) => ({ id, fullName: id.split('@')[0], isActive: 'Да', sessionVersion: '0', ...extra });

// Таблиците с данни на фирма: в тестовете те отиват в сайта на съответната фирма, както в SharePoint.
const ORG_TABLES = ['companies', 'contacts', 'deals', 'activities', 'tenders', 'products', 'documents', 'payments', 'audit'];
export const siteOf = (orgId) => `/sites/cloud-${orgId.toLowerCase()}`;

export function setup(seed = {}, { plan = 'pro', mail = false, fetchImpl, at = '2026-11-14T10:00:00Z' } = {}) {
  const all = {
    users: [user('admin@x.bg'), user('user@x.bg'), user('viewer@x.bg'), user('other@y.bg', { googleId: 'google:o' }), user('off@x.bg', { isActive: 'Не' }),
      user('staff@buladmin.eu', { platformRole: 'Администратор на БУЛАДМИН' })],
    orgs: [
      { id: 'ORG-A', ...COMPANY, planId: plan, orgStatus: 'Активна', sitePath: siteOf('ORG-A'), dbStatus: 'Готова' },
      { id: 'ORG-B', ...COMPANY, name: 'Друга ООД', eik: '831641791', vatNumber: 'BG831641791', planId: 'free', orgStatus: 'Активна', sitePath: siteOf('ORG-B'), dbStatus: 'Готова' },
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
  };
  // Фирмите от seed без сайт се допълват със сайт, освен ако тестът изрично не е задал друго.
  all.orgs = all.orgs.map((o) => (Object.hasOwn(o, 'sitePath') ? o : { ...o, sitePath: siteOf(o.id), dbStatus: 'Готова' }));
  const central = Object.fromEntries(Object.entries(all).filter(([table]) => !ORG_TABLES.includes(table)));
  const store = new MemoryStore(central);
  for (const table of ORG_TABLES) {
    for (const row of all[table] || []) {
      const org = all.orgs.find((o) => o.id === row.orgId);
      store.forSite(org?.sitePath || '').tables[table].push(structuredClone(row));
    }
  }
  const app = createApp({
    env: { ...env, MAIL_ENABLED: mail ? 'true' : 'false', MAIL_FROM: 'no-reply@cloud.example' }, store, now: () => new Date(at), ...(fetchImpl && { fetchImpl }),
  });
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

export const LINES = [{ productId: 'PR-1', name: 'Услуга', qty: 2, price: 100, vatRate: 20 }, { productId: 'PR-2', name: 'Стока', qty: 3, price: 10, discount: 10, vatRate: 20 }];
export const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

