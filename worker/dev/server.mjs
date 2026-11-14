// Локален преглед БЕЗ Microsoft и Google: данните са в паметта, а входът е симулиран.
// Симулираният вход съществува само в този файл и не се качва в Cloudflare.
//   npm run dev  ->  http://localhost:8790
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp, SESSION_COOKIE } from '../src/app.js';
import { computeTotals } from '../src/documents.js';
import { defaultChecklist } from '../src/procurement.js';
import { b64url, sha256, signToken } from '../src/crypto.js';
import { MemoryStore } from '../src/store.js';

const PORT = 8790;
const ORIGIN = `http://localhost:${PORT}`;
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const env = {
  APP_ORIGIN: ORIGIN,
  SESSION_SECRET: 'dev-only',
  PASSWORD_PEPPER: 'dev-only',
  MAIL_ENABLED: process.env.DEV_MAIL ? 'true' : 'false',
  MAIL_FROM: 'no-reply@cloud.buladmin.eu',
};
const DEV_SETUP_TOKEN = 'u.dev-setup';

const at = (daysAgo) => new Date(Date.now() - daysAgo * 864e5).toISOString().replace(/\.\d+Z$/, 'Z');
const day = (offset) => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);
const stamp = (days) => ({ createdAt: at(days), updatedAt: at(days) });

const company = {
  name: 'БУЛАДМИН ООД', eik: '831641791', vatNumber: 'BG831641791', mol: 'Демо Администратор', city: 'София',
  address: 'бул. Витоша 1', phone: '+359 2 123 4567', email: 'office@buladmin.eu', iban: 'BG80BNBG96611020345678', bank: 'Демо банка',
  bic: 'BNBGBGSF', vatRegistered: 'Да', invoiceStart: '1', dueDays: '7', currency: 'EUR',
};
const lines = [
  { productId: 'PR-DEMO0001', name: 'Абонаментно счетоводно обслужване', unit: 'мес.', qty: 1, price: 250, discount: 0, vatRate: 20 },
  { productId: 'PR-DEMO0002', name: 'Подаване на годишна декларация', unit: 'бр.', qty: 1, price: 120, discount: 10, vatRate: 20 },
];
const totals = computeTotals(lines, 'Фактура');
const doc = (id, docType, number, docStatus, companyId, days, extra = {}) => ({
  id, docType, number, docStatus, companyId, companyName: companyId === 'CO-DEMO0001' ? 'Пример ЕООД' : 'Търговия АД',
  issueDate: day(-days), taxEventDate: day(-days), dueDate: day(-days + 7), dealId: '', relatedId: '', lines: JSON.stringify(lines),
  buyer: docStatus === 'Чернова' ? '' : JSON.stringify({ name: 'Пример ЕООД', eik: '123456786', vatNumber: 'BG123456786', mol: 'Иван Иванов', city: 'Варна', address: 'бул. Примерен 2' }),
  seller: docStatus === 'Чернова' ? '' : JSON.stringify(company), currency: 'EUR',
  subtotal: totals.subtotal, vatAmount: totals.vatAmount, total: totals.total, paidAmount: 0, paymentStatus: 'Неплатен',
  paymentMethod: 'Банков превод', vatExemptReason: '', notes: '', createdBy: 'admin@buladmin.eu', issuedBy: docStatus === 'Чернова' ? '' : 'Демо Администратор',
  issuedAt: docStatus === 'Чернова' ? '' : at(days), ...stamp(days), ...extra,
});

const seed = {
  users: [
    { id: 'admin@buladmin.eu', fullName: 'Демо Администратор', role: 'Администратор', isActive: 'Да', jobTitle: 'Управител', sessionVersion: '0', createdAt: at(60) },
    { id: 'sales@buladmin.eu', fullName: 'Демо Търговец', role: 'Потребител', isActive: 'Да', jobTitle: 'Търговски представител', sessionVersion: '0', createdAt: at(40) },
    { id: 'viewer@buladmin.eu', fullName: 'Демо Наблюдател', role: 'Наблюдател', isActive: 'Да', jobTitle: 'Счетоводител', sessionVersion: '0', createdAt: at(20) },
    // Вход с парола: отворете /set-password.html#t=u.dev-setup
    {
      id: 'nov@buladmin.eu', fullName: 'Нов Потребител', role: 'Потребител', isActive: 'Да', sessionVersion: '0', createdAt: at(1),
      resetTokenHash: b64url(await sha256(DEV_SETUP_TOKEN)), resetExpires: new Date(Date.now() + 864e5).toISOString(),
    },
  ],
  settings: [{ id: 'company', value: JSON.stringify(company), updatedAt: at(60), updatedBy: 'admin@buladmin.eu' }],
  companies: [
    { id: 'CO-DEMO0001', name: 'Пример ЕООД', relation: 'Клиент', eik: '123456786', vatNumber: 'BG123456786', mol: 'Иван Иванов', city: 'Варна', address: 'бул. Примерен 2', phone: '+359 888 123 456', email: 'office@example.com', website: '', iban: '', owner: 'sales@buladmin.eu', notes: 'Клиент от 2024 г.', ...stamp(50) },
    { id: 'CO-DEMO0002', name: 'Търговия АД', relation: 'Потенциален клиент', eik: '', vatNumber: '', mol: 'Петя Георгиева', city: 'Пловдив', address: 'ул. Търговска 5', phone: '+359 878 555 111', email: 'info@targovia.example', website: 'https://targovia.example', iban: '', owner: 'admin@buladmin.eu', notes: '', ...stamp(12) },
    { id: 'CO-DEMO0003', name: 'Офис Консумативи ООД', relation: 'Доставчик', eik: '', vatNumber: '', mol: '', city: 'София', address: 'ул. Складова 9', phone: '', email: 'orders@office.example', website: '', iban: '', owner: 'admin@buladmin.eu', notes: '', ...stamp(30) },
  ],
  contacts: [
    { id: 'CT-DEMO0001', firstName: 'Иван', lastName: 'Иванов', companyId: 'CO-DEMO0001', position: 'Управител', phone: '+359 888 123 456', email: 'ivan@example.com', notes: '', ...stamp(50) },
    { id: 'CT-DEMO0002', firstName: 'Петя', lastName: 'Георгиева', companyId: 'CO-DEMO0002', position: 'Финансов директор', phone: '+359 878 555 111', email: 'petya@targovia.example', notes: '', ...stamp(12) },
  ],
  deals: [
    { id: 'DL-DEMO0001', dealName: 'Годишен договор за счетоводство', companyId: 'CO-DEMO0002', contactId: 'CT-DEMO0002', stage: 'Оферта', amount: 3600, expectedClose: day(14), owner: 'admin@buladmin.eu', lostReason: '', notes: '', closedAt: '', ...stamp(10) },
    { id: 'DL-DEMO0002', dealName: 'Регистрация на ДДС', companyId: 'CO-DEMO0001', contactId: 'CT-DEMO0001', stage: 'Преговори', amount: 450, expectedClose: day(5), owner: 'sales@buladmin.eu', lostReason: '', notes: '', closedAt: '', ...stamp(6) },
    { id: 'DL-DEMO0003', dealName: 'Абонамент 2026', companyId: 'CO-DEMO0001', contactId: '', stage: 'Спечелена', amount: 3000, expectedClose: day(-20), owner: 'sales@buladmin.eu', lostReason: '', notes: '', closedAt: at(20), ...stamp(40) },
    { id: 'DL-DEMO0004', dealName: 'Обучение по ТРЗ', companyId: 'CO-DEMO0002', contactId: '', stage: 'Нова', amount: 800, expectedClose: '', owner: 'sales@buladmin.eu', lostReason: '', notes: '', closedAt: '', ...stamp(2) },
  ],
  activities: [
    { id: 'AC-DEMO0001', subject: 'Обаждане за обратна връзка по офертата', activityType: 'Обаждане', dueDate: day(0), activityStatus: 'Предстои', assignedTo: 'admin@buladmin.eu', companyId: 'CO-DEMO0002', dealId: 'DL-DEMO0001', notes: '', doneAt: '', createdBy: 'admin@buladmin.eu', ...stamp(3) },
    { id: 'AC-DEMO0002', subject: 'Изпращане на документи за ДДС', activityType: 'Имейл', dueDate: day(-2), activityStatus: 'Предстои', assignedTo: 'admin@buladmin.eu', companyId: 'CO-DEMO0001', dealId: 'DL-DEMO0002', notes: '', doneAt: '', createdBy: 'sales@buladmin.eu', ...stamp(5) },
    { id: 'AC-DEMO0003', subject: 'Среща в офиса на клиента', activityType: 'Среща', dueDate: day(3), activityStatus: 'Предстои', assignedTo: 'sales@buladmin.eu', companyId: 'CO-DEMO0001', dealId: '', notes: '', doneAt: '', createdBy: 'sales@buladmin.eu', ...stamp(1) },
  ],
  products: [
    { id: 'PR-DEMO0001', code: 'SRV-001', name: 'Абонаментно счетоводно обслужване', itemType: 'Услуга', unit: 'мес.', price: 250, vatRate: '20', stock: '', isActive: 'Да', description: '', ...stamp(60) },
    { id: 'PR-DEMO0002', code: 'SRV-002', name: 'Подаване на годишна декларация', itemType: 'Услуга', unit: 'бр.', price: 120, vatRate: '20', stock: '', isActive: 'Да', description: '', ...stamp(60) },
    { id: 'PR-DEMO0003', code: 'GD-001', name: 'Папка класьор', itemType: 'Стока', unit: 'бр.', price: 4.5, vatRate: '20', stock: 120, isActive: 'Да', description: '', ...stamp(60) },
  ],
  documents: [
    doc('DOC-DEMO0001', 'Фактура', '0000000001', 'Издаден', 'CO-DEMO0001', 25, { paidAmount: totals.total, paymentStatus: 'Платен' }),
    doc('DOC-DEMO0002', 'Фактура', '0000000002', 'Издаден', 'CO-DEMO0001', 12),
    doc('DOC-DEMO0003', 'Оферта', `OF-${new Date().getFullYear()}-0001`, 'Издаден', 'CO-DEMO0002', 8, { dealId: 'DL-DEMO0001', dueDate: day(20) }),
    doc('DOC-DEMO0004', 'Фактура', '', 'Чернова', 'CO-DEMO0001', 0),
  ],
  payments: [
    { id: 'PAY-DEMO0001', documentId: 'DOC-DEMO0001', companyId: 'CO-DEMO0001', paidAt: day(-20), amount: totals.total, method: 'Банков превод', reference: 'Плащане по ф-ра 1', createdBy: 'admin@buladmin.eu', createdAt: at(20) },
  ],
};

// Всички демо записи са на първата фирма. Втората е на безплатния план, за да се вижда превключването и ограниченията.
const ORG = 'ORG-DEMO0001';
for (const table of ['companies', 'contacts', 'deals', 'activities', 'products', 'documents', 'payments']) {
  for (const row of seed[table]) row.orgId = ORG;
}
delete seed.settings;
seed.users = seed.users.map(({ role, ...u }) => u);
seed.users[0].platformRole = 'Администратор на БУЛАДМИН';
seed.orgs = [
  {
    id: ORG, ...company, planId: 'eop', orgStatus: 'Активна', createdBy: 'admin@buladmin.eu', createdAt: at(60), updatedAt: at(60),
    bankAccounts: JSON.stringify([
      { iban: company.iban, bic: company.bic, bank: company.bank, currency: 'EUR', label: 'Основна' },
      { iban: 'BG18RZBB91550123456789', bic: 'RZBBBGSF', bank: 'Демо банка 2', currency: 'USD', label: 'Доларова' },
    ]),
  },
  { id: 'ORG-DEMO0002', ...company, name: 'Втора фирма ЕООД', eik: '202020204', vatRegistered: 'Не', vatNumber: '', planId: 'free', orgStatus: 'Активна', createdBy: 'admin@buladmin.eu', createdAt: at(5), updatedAt: at(5) },
];
const member = (orgId, userId, role) => ({ id: `${orgId}:${userId}`, orgId, userId, role, isActive: 'Да', createdAt: at(30) });
seed.members = [
  member(ORG, 'admin@buladmin.eu', 'Администратор'), member(ORG, 'sales@buladmin.eu', 'Потребител'),
  member(ORG, 'viewer@buladmin.eu', 'Наблюдател'), member(ORG, 'nov@buladmin.eu', 'Потребител'),
  member('ORG-DEMO0002', 'admin@buladmin.eu', 'Администратор'), member('ORG-DEMO0002', 'sales@buladmin.eu', 'Администратор'),
];
const inDays = (d, hour) => { const x = new Date(Date.now() + d * 864e5); x.setUTCHours(hour, 0, 0, 0); return x.toISOString().replace(/.d+Z$/, 'Z'); };
seed.tenders = [
  {
    id: 'TN-DEMO0001', orgId: ORG, tenderName: 'Счетоводно обслужване на общинско предприятие', eopNumber: '00123-2026-0045', authority: 'Община Пример',
    procedureType: 'Публично състезание', stage: 'Подготовка', eopUrl: 'https://app.eop.bg/', cpv: '79211000', lots: 'Обособена позиция 1',
    estimatedValue: 24000, questionsDeadline: inDays(1, 14), submissionDeadline: inDays(6, 15), openingDate: inDays(7, 8),
    guaranteeType: 'Няма', guaranteeReturned: 'Неприложимо', owner: 'admin@buladmin.eu', createdAt: at(4), updatedAt: at(4),
    checklist: JSON.stringify(defaultChecklist()),
  },
];
const store = new MemoryStore(seed);
const app = createApp({ env, store });

const devUsers = { admin: 'admin@buladmin.eu', user: 'sales@buladmin.eu', viewer: 'viewer@buladmin.eu' };
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.webp': 'image/webp',
  '.png': 'image/png', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.svg': 'image/svg+xml', '.json': 'application/json', '.txt': 'text/plain',
};

createServer(async (req, res) => {
  const url = new URL(req.url, ORIGIN);
  if (url.pathname.startsWith('/api/auth/') && url.pathname.endsWith('/start')) {
    // Бутоните за Google и Microsoft влизат като администратор.
    url.pathname = '/dev/login';
    url.searchParams.set('as', 'admin');
  }
  if (url.pathname === '/dev/mail') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(store.sentMail, null, 2));
  }
  if (url.pathname === '/dev/login') {
    const uid = devUsers[url.searchParams.get('as')] || devUsers.admin;
    const token = await signToken({ uid, ver: '0' }, env.SESSION_SECRET, 3600);
    res.writeHead(302, { location: '/app.html', 'set-cookie': `${SESSION_COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=3600` });
    return res.end();
  }
  if (url.pathname.startsWith('/api/')) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const response = await app(new Request(url, { method: req.method, headers: req.headers, body }));
    res.writeHead(response.status, Object.fromEntries(response.headers));
    return res.end(await response.text());
  }
  const rel = normalize(url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1)));
  if (rel.startsWith('..')) { res.writeHead(403); return res.end(); }
  try {
    const data = await readFile(join(ROOT, rel));
    res.writeHead(200, { 'content-type': MIME[extname(rel)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': MIME['.html'] });
    res.end(await readFile(join(ROOT, '404.html')));
  }
}).listen(PORT, () => console.log(`${ORIGIN}\n  /dev/login?as=admin | user | viewer`));
