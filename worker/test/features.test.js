// Валути и сметки, изпращане по имейл, оферта през линк, известия и модулът „ЦАИС ЕОП“.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { COMPANY, LINES, setup, siteOf } from './helpers.js';

const pdfBase64 = Buffer.from('%PDF-1.7 тест').toString('base64');
const tokenFrom = (mail) => mail.html.match(/offer\.html#t=([\w.-]+)/)[1];

test('безплатен план: само EUR и една банкова сметка', async () => {
  const { call } = setup({}, { plan: 'free' });
  const usd = await call('POST', '/api/documents', { as: 'admin@x.bg', body: { docType: 'Фактура', companyId: 'CO-1', lines: LINES, currency: 'USD', exchangeRate: '1,08' } });
  assert.equal(usd.status, 422);
  assert.match(usd.data.error.fields.currency, /други валути/);
  const two = await call('PUT', '/api/org/settings', {
    as: 'admin@x.bg',
    body: { ...COMPANY, bankAccounts: [{ iban: 'BG80BNBG96611020345678' }, { iban: 'BG18RZBB91550123456789' }] },
  });
  assert.equal(two.status, 422);
  assert.match(two.data.error.fields.bankAccounts, /до 1 банкови сметки/);
});

test('платен план: няколко сметки, фактура в USD с курс и равностойност в EUR', async () => {
  const { store, call } = setup();
  const saved = await call('PUT', '/api/org/settings', {
    as: 'admin@x.bg',
    body: {
      ...COMPANY,
      bankAccounts: [{ iban: 'BG80 BNBG 9661 1020 3456 78', bank: 'БНБ' }, { iban: 'BG18RZBB91550123456789', currency: 'USD', label: 'Доларова' }],
    },
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal(saved.data.bankAccounts.length, 2);
  assert.equal(saved.data.iban, 'BG80BNBG96611020345678');
  const draft = await call('POST', '/api/documents', {
    as: 'user@x.bg', body: { docType: 'Фактура', companyId: 'CO-1', lines: LINES, currency: 'USD', exchangeRate: '1,0800', rateDate: '2026-11-13' },
  });
  assert.equal(draft.status, 201, JSON.stringify(draft.data));
  assert.equal(draft.data.currency, 'USD');
  assert.equal(draft.data.bankAccount, 'BG18RZBB91550123456789', 'по подразбиране сметката във валутата на документа');
  assert.equal(draft.data.total, 272.4);
  assert.equal(draft.data.totalEur, 252.22);
  const issued = await call('POST', `/api/documents/${draft.data.id}/issue`, { as: 'user@x.bg' });
  assert.equal(issued.data.seller.iban, 'BG18RZBB91550123456789');
  assert.equal(issued.data.seller.bankAccounts, undefined);
  const noRate = await call('POST', '/api/documents', { as: 'user@x.bg', body: { docType: 'Фактура', companyId: 'CO-1', lines: LINES, currency: 'GBP' } });
  assert.ok(noRate.data.error.fields.exchangeRate);
  assert.equal((await store.forSite(siteOf('ORG-A')).find('documents', 'id', draft.data.id))[0].exchangeRate, 1.08);
});

test('курс на ЕЦБ', async () => {
  const fetchImpl = async (url) => {
    assert.match(url, /EXR\/D\.USD\.EUR\.SP00\.A\?endPeriod=2026-11-14/);
    return new Response(JSON.stringify({
      dataSets: [{ series: { '0:0:0:0:0': { observations: { 0: [1.0812] } } } }],
      structure: { dimensions: { observation: [{ values: [{ id: '2026-11-13' }] }] } },
    }));
  };
  const { call } = setup({}, { fetchImpl });
  const res = await call('GET', '/api/rates?currency=USD&date=2026-11-14', { as: 'user@x.bg' });
  assert.deepEqual(res.data, { currency: 'USD', rate: 1.0812, rateDate: '2026-11-13', source: 'ЕЦБ' });
});

test('изпращане на фактура по имейл с PDF; ограничение на имейлите по план', async () => {
  const { store, call } = setup({ orgs: [{ id: 'ORG-A', ...COMPANY, email: 'office@nasha.bg', planId: 'free', orgStatus: 'Активна' }] }, { mail: true });
  const draft = await call('POST', '/api/documents', { as: 'admin@x.bg', body: { docType: 'Фактура', companyId: 'CO-1', lines: LINES } });
  const id = draft.data.id;
  assert.equal((await call('POST', `/api/documents/${id}/send`, { as: 'admin@x.bg', body: { to: 'klient@firma.bg', pdf: pdfBase64 } })).status, 409, 'чернова не се изпраща');
  await call('POST', `/api/documents/${id}/issue`, { as: 'admin@x.bg' });
  const bad = await call('POST', `/api/documents/${id}/send`, { as: 'admin@x.bg', body: { to: 'не-е-имейл', pdf: 'aGVsbG8=' } });
  assert.ok(bad.data.error.fields.to && bad.data.error.fields.pdf);
  const sent = await call('POST', `/api/documents/${id}/send`, {
    as: 'admin@x.bg', body: { to: 'Klient@Firma.bg', cc: 'b@firma.bg', message: 'Здравейте!', pdf: pdfBase64 },
  });
  assert.equal(sent.status, 200, JSON.stringify(sent.data));
  const mail = store.sentMail.at(-1);
  assert.deepEqual([mail.to, mail.cc, mail.replyTo], [['klient@firma.bg'], ['b@firma.bg'], 'office@nasha.bg']);
  assert.equal(mail.attachments[0].name, 'Фактура 0000000001.pdf');
  assert.match(mail.html, /Здравейте!/);
  assert.ok(!mail.html.includes('offer.html'), 'фактурата няма линк за приемане');
  assert.equal(sent.data.sentTo, 'klient@firma.bg, b@firma.bg');
  // Безплатният план: до 20 имейла на месец.
  for (let i = 0; i < 19; i++) await call('POST', `/api/documents/${id}/send`, { as: 'admin@x.bg', body: { to: 'k@firma.bg', pdf: pdfBase64 } });
  const over = await call('POST', `/api/documents/${id}/send`, { as: 'admin@x.bg', body: { to: 'k@firma.bg', pdf: pdfBase64 } });
  assert.equal(over.status, 402);
});

test('оферта: линк в имейла, клиентът я приема, фирмата получава известие', async () => {
  const { store, call } = setup({}, { mail: true });
  const draft = await call('POST', '/api/documents', { as: 'user@x.bg', body: { docType: 'Оферта', companyId: 'CO-1', lines: LINES } });
  await call('POST', `/api/documents/${draft.data.id}/issue`, { as: 'user@x.bg' });
  const sent = await call('POST', `/api/documents/${draft.data.id}/send`, { as: 'user@x.bg', body: { to: 'klient@firma.bg', pdf: pdfBase64 } });
  assert.equal(sent.data.hasLink, true);
  assert.equal(sent.data.publicTokenHash, undefined);
  const token = tokenFrom(store.sentMail.at(-1));

  assert.equal((await call('POST', '/api/public/offer', { org: null, body: { token: `${token}x` } })).status, 404);
  const view = await call('POST', '/api/public/offer', { org: null, body: { token } });
  assert.equal(view.status, 200);
  assert.equal(view.data.offer.number, 'OF-2026-0001');
  assert.equal(view.data.offer.createdBy, undefined);
  assert.equal(view.data.org.name, 'Нашата ООД');

  assert.equal((await call('POST', '/api/public/offer/decision', { org: null, body: { token, decision: 'accept' } })).status, 422, 'трябва име');
  const ok = await call('POST', '/api/public/offer/decision', { org: null, body: { token, decision: 'accept', name: 'Иван Петров', note: 'Съгласни сме' } });
  assert.equal(ok.data.status, 'Приета');
  const [doc] = await store.forSite(siteOf('ORG-A')).find('documents', 'id', draft.data.id);
  assert.deepEqual([doc.docStatus, doc.decisionBy, doc.decisionNote], ['Приета', 'Иван Петров', 'Съгласни сме']);
  assert.ok(store.sentMail.some((m) => m.to === 'user@x.bg' && /приета/.test(m.subject)));
  assert.equal((await call('POST', '/api/public/offer/decision', { org: null, body: { token, decision: 'reject', name: 'Х' } })).status, 409, 'втори отговор не се приема');
});

test('изтекла оферта не може да се приеме', async () => {
  const { store, call } = setup({}, { mail: true });
  const draft = await call('POST', '/api/documents', { as: 'user@x.bg', body: { docType: 'Оферта', companyId: 'CO-1', lines: LINES, dueDate: '2026-11-13' } });
  await call('POST', `/api/documents/${draft.data.id}/issue`, { as: 'user@x.bg' });
  await call('POST', `/api/documents/${draft.data.id}/send`, { as: 'user@x.bg', body: { to: 'klient@firma.bg', pdf: pdfBase64 } });
  const token = tokenFrom(store.sentMail.at(-1));
  assert.equal((await call('POST', '/api/public/offer', { org: null, body: { token } })).data.offer.expired, true);
  assert.equal((await call('POST', '/api/public/offer/decision', { org: null, body: { token, decision: 'accept', name: 'Х' } })).status, 409);
});

test('известие при възложена задача, но не при задача към себе си; изключване от профила', async () => {
  const { store, call } = setup({}, { mail: true });
  await call('POST', '/api/data/activities', { as: 'admin@x.bg', body: { subject: 'Обади се', assignedTo: 'admin@x.bg' } });
  assert.equal(store.sentMail.length, 0);
  await call('POST', '/api/data/activities', { as: 'admin@x.bg', body: { subject: 'Изпрати оферта', assignedTo: 'user@x.bg', dueDate: '2026-11-15' } });
  assert.equal(store.sentMail.at(-1).to, 'user@x.bg');
  assert.match(store.sentMail.at(-1).html, /Изпрати оферта/);
  await call('PATCH', '/api/account', { as: 'user@x.bg', body: { fullName: 'Потребител', notifyEmail: false } });
  await call('POST', '/api/data/activities', { as: 'admin@x.bg', body: { subject: 'Още нещо', assignedTo: 'user@x.bg' } });
  assert.equal(store.sentMail.length, 1);
});

test('ежедневно напомняне: задачи, просрочени фактури, срокове по поръчки', async () => {
  const { store, app } = setup({
    activities: [
      { id: 'AC-1', orgId: 'ORG-A', subject: 'Просрочена', activityStatus: 'Предстои', dueDate: '2026-11-10', assignedTo: 'user@x.bg' },
      { id: 'AC-2', orgId: 'ORG-A', subject: 'Утрешна', activityStatus: 'Предстои', dueDate: '2026-11-15', assignedTo: 'user@x.bg' },
    ],
    documents: [{
      id: 'D1', orgId: 'ORG-A', docType: 'Фактура', docStatus: 'Издаден', number: '0000000007', companyName: 'Клиент ЕООД',
      total: 100, paidAmount: 0, paymentStatus: 'Неплатен', dueDate: '2026-11-01', currency: 'EUR',
    }],
    tenders: [{ id: 'TN-1', orgId: 'ORG-A', tenderName: 'Доставка на хартия', stage: 'Подготовка', owner: 'user@x.bg', submissionDeadline: '2026-11-16T15:00:00Z' }],
  }, { mail: true });
  const result = await app.digest();
  assert.equal(result.sent, 2);
  const forUser = store.sentMail.find((m) => m.to === 'user@x.bg');
  assert.match(forUser.text, /Просрочена задача: Просрочена/);
  assert.ok(!forUser.text.includes('Утрешна'));
  assert.match(forUser.text, /Срок за подаване по обществена поръчка: Доставка на хартия — 16\.11\.2026 г\., 17:00/);
  const forAdmin = store.sentMail.find((m) => m.to === 'admin@x.bg');
  assert.match(forAdmin.text, /Просрочена фактура: № 0000000007/);
});

test('ЦАИС ЕОП: само в плана с модула; списък с документи; срокове по българско време', async () => {
  const standard = setup({}, { plan: 'standard' });
  const denied = await standard.call('POST', '/api/data/tenders', { as: 'admin@x.bg', body: { tenderName: 'Х', authority: 'Община' } });
  assert.equal(denied.status, 402);
  assert.match(denied.data.error.message, /ЦАИС ЕОП/);
  assert.deepEqual((await standard.call('GET', '/api/data', { as: 'admin@x.bg' })).data.tenders, []);

  const { call } = setup({}, { plan: 'eop' });
  const created = await call('POST', '/api/data/tenders', {
    as: 'user@x.bg',
    body: { tenderName: 'Доставка на хартия', authority: 'Община Варна', eopNumber: '00123-2026-0045', submissionDeadline: '2026-11-20T17:00', estimatedValue: '12 000' },
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.equal(created.data.submissionDeadline, '2026-11-20T15:00:00Z', '17:00 българско време = 15:00 UTC през зимата');
  assert.equal(created.data.stage, 'Проучване');
  assert.ok(created.data.checklist.length >= 10);
  assert.match(created.data.checklist[0].label, /ЕЕДОП/);
  const items = created.data.checklist.map((i, n) => ({ ...i, state: n === 0 ? 'Готов' : i.state }));
  items.push({ label: 'Мостри на продукта', group: 'Оферта', state: 'Предстои' });
  const saved = await call('PUT', `/api/tenders/${created.data.id}/checklist`, { as: 'user@x.bg', body: { items } });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.checklist[0].state, 'Готов');
  assert.equal(saved.data.checklist.at(-1).label, 'Мостри на продукта');
  assert.equal((await call('PUT', `/api/tenders/${created.data.id}/checklist`, { as: 'viewer@x.bg', body: { items } })).status, 403);
  const bad = await call('POST', '/api/data/tenders', { as: 'user@x.bg', body: { tenderName: 'Х', authority: 'Y', submissionDeadline: '32.13.2026' } });
  assert.ok(bad.data.error.fields.submissionDeadline);
  // Лятно време: 17:00 българско = 14:00 UTC.
  const summer = await call('POST', '/api/data/tenders', { as: 'user@x.bg', body: { tenderName: 'Лято', authority: 'Y', submissionDeadline: '2027-07-01T17:00' } });
  assert.equal(summer.data.submissionDeadline, '2027-07-01T14:00:00Z');
});

// --- Отделна база данни (SharePoint сайт) за всяка фирма ---

test('новата фирма получава собствен сайт; докато се подготвя, данните не се отварят', async () => {
  const { store, call } = setup();
  // SharePoint създава сайта асинхронно: първо „provisioning“, после „ready“.
  const sites = new Map();
  store.siteStatus = async (path) => sites.get(path) || 'missing';
  store.createSite = async ({ sitePath, owner }) => { sites.set(sitePath, 'provisioning'); store.lastOwner = owner; return 'provisioning'; };
  const created = await call('POST', '/api/orgs', { as: 'viewer@x.bg', org: null, body: { name: 'Нова ЕООД', eik: '202020204' } });
  assert.equal(created.status, 201);
  assert.equal(created.data.dbStatus, 'Подготвя се');
  const [org] = await store.find('orgs', 'id', created.data.id);
  assert.equal(org.sitePath, siteOf(created.data.id));
  assert.equal(store.lastOwner, 'viewer@x.bg');
  const waiting = await call('GET', '/api/data', { as: 'viewer@x.bg', org: created.data.id });
  assert.equal(waiting.status, 409);
  assert.match(waiting.data.error.message, /Подготвяме базата данни/);
  // Чужд потребител не може да движи подготовката.
  assert.equal((await call('POST', `/api/orgs/${created.data.id}/provision`, { as: 'other@y.bg', org: null })).status, 403);
  assert.equal((await call('POST', `/api/orgs/${created.data.id}/provision`, { as: 'viewer@x.bg', org: null })).data.dbStatus, 'Подготвя се');
  sites.set(org.sitePath, 'ready');
  const ready = await call('POST', `/api/orgs/${created.data.id}/provision`, { as: 'viewer@x.bg', org: null });
  assert.equal(ready.data.dbStatus, 'Готова');
  assert.equal((await store.find('orgs', 'id', created.data.id))[0].dbStatus, 'Готова');
  // Данните на новата фирма отиват само в нейния сайт.
  const co = await call('POST', '/api/data/companies', { as: 'viewer@x.bg', org: created.data.id, body: { name: 'Клиент на новата', relation: 'Клиент' } });
  assert.equal(co.status, 201);
  assert.equal((await store.forSite(org.sitePath).find('companies', 'id', co.data.id)).length, 1);
  assert.equal((await store.forSite(siteOf('ORG-A')).find('companies', 'id', co.data.id)).length, 0);
  assert.equal((await store.find('companies', 'id', co.data.id)).length, 0);
});

test('грешка при създаването на сайта: БУЛАДМИН е уведомен и само той пуска подготовката отново', async () => {
  const { store, call } = setup();
  let status = 'error';
  store.siteStatus = async () => status;
  const created = await call('POST', '/api/orgs', { as: 'viewer@x.bg', org: null, body: { name: 'Нова ЕООД', eik: '202020204' } });
  assert.equal(created.data.dbStatus, 'Грешка');
  const failed = await call('GET', '/api/data', { as: 'viewer@x.bg', org: created.data.id });
  assert.equal(failed.status, 409);
  assert.match(failed.data.error.message, /не беше създадена/);
  status = 'ready';
  assert.equal((await call('POST', `/api/orgs/${created.data.id}/provision`, { as: 'viewer@x.bg', org: null })).data.dbStatus, 'Грешка');
  assert.equal((await call('POST', `/api/orgs/${created.data.id}/provision`, { as: 'staff@buladmin.eu', org: null })).data.dbStatus, 'Готова');
  const overview = await call('GET', '/api/platform', { as: 'staff@buladmin.eu', org: null });
  const row = overview.data.orgs.find((o) => o.id === created.data.id);
  assert.deepEqual([row.dbStatus, row.sitePath], ['Готова', siteOf(created.data.id)]);
});

test('данните на всяка фирма са в отделен сайт и не се виждат от друга фирма', async () => {
  const { store, call } = setup();
  const a = await call('GET', '/api/data', { as: 'admin@x.bg' });
  assert.deepEqual(a.data.companies.map((c) => c.id), ['CO-1']);
  const b = await call('GET', '/api/data', { as: 'other@y.bg', org: 'ORG-B' });
  assert.deepEqual(b.data.companies.map((c) => c.id), ['CO-B']);
  assert.equal((await call('GET', '/api/data/companies/CO-B', { as: 'admin@x.bg' })).status, 404);
  assert.equal(store.tables.companies.length, 0);
});
