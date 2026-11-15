// Обявления от ЦАИС ЕОП: внос от ЦАИС ЕОП / data.egov.bg (OCDS), търсене, „Следете“, промени и известия.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyReleases, compactNotice, eopDayUrl, filterNotices, importStep } from '../src/eop.js';
import { setup, siteOf } from './helpers.js';

const party = (id, roles, eik, name, region = 'BG411', locality = 'София') => ({
  id, roles, name, identifier: { id: eik, legalName: name, scheme: 'BG-EIK' }, address: { region, locality },
});
const tenderRelease = (id, { title = `Поръчка ${id}`, end = '2026-12-09T23:59:59+02:00', cpv = '45212200', value = 195583, currency = 'BGN', category = 'works', tag = 'tender', lots = 1 } = {}) => ({
  ocid: `ocds-e82gsb-${id}`, id: `ocds-e82gsb-${id}/x-${tag}`, date: '2026-11-10T10:00:00+02:00', tag: [tag],
  tender: {
    id: String(id), title, description: 'Описание', status: 'active', procurementMethod: 'open', mainProcurementCategory: category,
    legalBasis: { id: 'ЗОП', scheme: 'BG-ZOP' }, value: { amount: value, currency },
    lots: Array.from({ length: lots }, (_, i) => ({ id: `LOT-000${i + 1}`, title: `Позиция ${i + 1}`, value: { amount: 1000, currency: 'EUR' }, tenderPeriod: { startDate: '2026-11-10', endDate: end } })),
    items: [{ id: 'i1', classification: { id: cpv, scheme: 'CPV' }, relatedLot: 'LOT-0001' }],
  },
  parties: [party('ORG-0001', ['buyer'], '000454145', 'Община Пример', 'BG421', 'Пловдив')],
  buyer: { id: 'ORG-0001', name: 'Община Пример' },
});
const awardRelease = (id, eik, name, tag = 'contract') => ({
  ocid: `ocds-e82gsb-${id}`, date: '2026-11-12T10:00:00+02:00', tag: ['award', tag].filter((x, i, a) => a.indexOf(x) === i),
  tender: { id: String(id), status: 'complete' },
  parties: [party('ORG-0001', ['buyer'], '000454145', 'Община Пример'), party('ORG-0003', ['supplier'], eik, name)],
  contracts: [{ value: { amount: 1000, currency: 'EUR' }, dateSigned: '2026-11-12T00:00:00Z' }],
});

// Фалшиви източници: файлове по дни в storage.eop.bg и един месечен набор в data.egov.bg.
// Ден с onlyEgov липсва в ЦАИС ЕОП (403), ден с onlyEop липсва в data.egov.bg.
function egov(days) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    if (url.startsWith('https://storage.eop.bg/')) {
      const date = url.match(/open-data-(\d{4}-\d\d-\d\d)\//)[1];
      const day = days.find((d) => d.date === date && !d.onlyEgov);
      calls.push(`eop ${date}${day ? '' : ' 403'}`);
      assert.equal(url, eopDayUrl(date));
      return day
        ? new Response(JSON.stringify({ license: 'https://opendefinition.org/licenses/cc-zero/', releases: day.releases }), { headers: { 'content-type': 'application/json' } })
        : new Response('<Error>AccessDenied</Error>', { status: 403 });
    }
    const method = url.split('/api/')[1];
    const body = JSON.parse(init.body);
    calls.push(method);
    const ok = (data) => new Response(JSON.stringify({ success: true, ...data }), { headers: { 'content-type': 'application/json' } });
    if (method === 'listDatasets') {
      assert.deepEqual(body.criteria.org_ids, [502]);
      return ok({ datasets: [{ uri: 'ds-11', name: 'Автоматично генерирани данни за обявления, публикувани в ЦАИС ЕОП през месец 11.2026 г.', updated_at: days.at(-1).createdAt }] });
    }
    if (method === 'listResources') return ok({ resources: days.filter((d) => !d.onlyEop).map((d) => ({ uri: d.uri, name: `Автоматично генерирани данни за обявления, публикувани в ЦАИС ЕОП на ${d.date.split('-').reverse().join('.')} г., съгласно стандарт OCDS`, created_at: d.createdAt })) });
    if (method === 'getResourceData') return ok({ data: { releases: days.find((d) => d.uri === body.resource_uri).releases } });
    throw new Error(`unexpected ${url}`);
  };
  return { fetchImpl, calls };
}

test('OCDS: компактен запис, лева в евро, срок от обособените позиции, търсене', () => {
  const n = compactNotice(tenderRelease(101, { lots: 2 }));
  assert.equal(n.id, '101');
  assert.equal(n.value, 100000);
  assert.deepEqual([n.buyer, n.buyerEik, n.city, n.region, n.category, n.procedure], ['Община Пример', '000454145', 'Пловдив', 'BG421', 'works', 'Публично състезание']);
  assert.equal(n.lots.length, 2);
  assert.equal(n.deadline, '2026-12-09T23:59:59+02:00');
  const list = [n, compactNotice(tenderRelease(102, { cpv: '79211000', category: 'services', title: 'Счетоводни услуги' }))];
  assert.deepEqual(filterNotices(list, { cpv: '792' }).map((x) => x.id), ['102']);
  assert.deepEqual(filterNotices(list, { q: 'счетоводни' }).map((x) => x.id), ['102']);
  assert.deepEqual(filterNotices(list, { category: 'works', region: 'BG421' }).map((x) => x.id), ['101']);
  assert.deepEqual(filterNotices(list, { minValue: 150000 }).map((x) => x.id), []);
  const { notices, events } = applyReleases(list, [awardRelease(101, '130169509', 'Строймонтаж ЕООД')]);
  assert.deepEqual(notices.map((x) => x.id), ['102']);
  assert.equal(events[0].kind, 'contract');
  assert.equal(events[0].suppliers[0].eik, '130169509');
});

test('внос, търсене и „Следете“: поръчката се добавя с данните от ЦАИС ЕОП', async () => {
  const days = [
    { uri: 'r1', date: '2026-11-10', createdAt: '2026-11-11 08:00:00', releases: [tenderRelease(201), tenderRelease(202, { cpv: '79211000', category: 'services', title: 'Счетоводни услуги' }), tenderRelease(203, { end: '2026-11-01T10:00:00+02:00' })] },
  ];
  const { fetchImpl } = egov(days);
  const { call, store, app } = setup({ companies: [{ id: 'CO-9', orgId: 'ORG-A', name: 'Община Пример', relation: 'Клиент', eik: '000454145' }] }, { fetchImpl });
  assert.equal((await call('POST', '/api/platform/eop/import', { as: 'staff@buladmin.eu' })).status, 404, 'вносът не минава през API-то');
  const imported = await app.eopImport();
  assert.deepEqual([imported.imported, imported.open], [1, 2]);
  assert.equal((await app.eopImport()).imported, 0, 'нищо ново при второ пускане');

  const list = await call('GET', '/api/eop/notices?category=services', { as: 'user@x.bg' });
  assert.equal(list.status, 200);
  assert.deepEqual(list.data.items.map((n) => n.id), ['202']);
  assert.equal(list.data.items[0].url, 'https://app.eop.bg/today/202');
  assert.match(list.data.source, /data\.egov\.bg/);

  assert.equal((await call('POST', '/api/eop/notices/201/follow', { as: 'viewer@x.bg' })).status, 403);
  const followed = await call('POST', '/api/eop/notices/201/follow', { as: 'user@x.bg' });
  assert.equal(followed.status, 201);
  const [tender] = await store.forSite(siteOf('ORG-A')).find('tenders', 'id', followed.data.id);
  assert.deepEqual([tender.eopId, tender.companyId, tender.stage, tender.estimatedValue, tender.owner], ['201', 'CO-9', 'Проучване', 100000, 'user@x.bg']);
  assert.equal(tender.submissionDeadline, '2026-12-09T21:59:59.000Z');
  assert.equal(tender.eopUrl, 'https://app.eop.bg/today/201');
  assert.equal((await call('POST', '/api/eop/notices/201/follow', { as: 'user@x.bg' })).status, 409);
  assert.equal((await call('GET', '/api/eop/notices', { as: 'user@x.bg' })).data.items.find((n) => n.id === '201').followedId, followed.data.id);
  assert.equal((await call('POST', '/api/eop/notices/203/follow', { as: 'user@x.bg' })).status, 404, 'изтеклите не се пазят');
});

test('обявленията са само за план с модула „ЦАИС ЕОП“', async () => {
  const { call } = setup({}, { plan: 'free', fetchImpl: egov([{ uri: 'r1', date: '2026-11-10', createdAt: '2026-11-11 08:00:00', releases: [] }]).fetchImpl });
  assert.equal((await call('GET', '/api/eop/notices', { as: 'admin@x.bg' })).status, 402);
});

test('следващ ден: нов срок и договор с нашата фирма обновяват поръчката; известие по CPV', async () => {
  const days = [{ uri: 'r1', date: '2026-11-10', createdAt: '2026-11-11 08:00:00', releases: [tenderRelease(301), tenderRelease(302)] }];
  const { fetchImpl } = egov(days);
  const { call, store, app } = setup({}, { fetchImpl, mail: true });
  await app.eopImport();
  const a = await call('POST', '/api/eop/notices/301/follow', { as: 'user@x.bg' });
  const b = await call('POST', '/api/eop/notices/302/follow', { as: 'user@x.bg' });
  assert.equal((await call('PUT', '/api/eop/alert', { as: 'user@x.bg', body: { cpv: '45' } })).status, 403);
  assert.equal((await call('PUT', '/api/eop/alert', { as: 'admin@x.bg', body: { cpv: '45, 4521; x' } })).data.cpvAlert, '45, 4521');
  // ЕИК на ORG-A е 123456786 (COMPANY в helpers).
  days.push({
    uri: 'r2', date: '2026-11-11', createdAt: '2026-11-12 08:00:00',
    releases: [tenderRelease(301, { tag: 'tenderAmendment', end: '2026-12-20T17:00:00+02:00' }), awardRelease(302, '123456786', 'Нашата ООД'), tenderRelease(303, { title: 'Ремонт на училище' }), tenderRelease(304, { cpv: '79211000' })],
  });
  store.sentMail.length = 0;
  const run = await app.eopImport();
  assert.deepEqual([run.imported, run.new, run.updated], [1, 2, 2]);
  const db = store.forSite(siteOf('ORG-A'));
  const [t1] = await db.find('tenders', 'id', a.data.id);
  assert.equal(t1.submissionDeadline, '2026-12-20T15:00:00.000Z');
  assert.match(t1.notes, /Нов срок за подаване/);
  const [t2] = await db.find('tenders', 'id', b.data.id);
  assert.deepEqual([t2.stage, t2.contractValue, t2.contractDate], ['Договор', 1000, '2026-11-12']);
  const alert = store.sentMail.filter((m) => /нови обществени поръчки/.test(m.subject));
  assert.ok(alert.length >= 1);
  assert.ok(alert.every((m) => m.html.includes('Ремонт на училище') && !m.html.includes('Поръчка 304')));
  assert.ok(store.sentMail.some((m) => m.to === 'user@x.bg' && /ЦАИС ЕОП: Поръчка 302/.test(m.subject)));
});

test('източници: ЦАИС ЕОП е основен, data.egov.bg е резервен; непубликуван ден се чака', async () => {
  const days = [
    { uri: 'r1', date: '2026-11-08', createdAt: '2026-11-09 08:00:00', releases: [tenderRelease(401)], onlyEop: true },
    { uri: 'r2', date: '2026-11-09', createdAt: '2026-11-10 08:00:00', releases: [tenderRelease(402)], onlyEgov: true },
    { uri: 'r3', date: '2026-11-10', createdAt: '2026-11-11 08:00:00', releases: [tenderRelease(403)] },
  ];
  const { fetchImpl, calls } = egov(days);
  const now = '2026-11-14T07:30:00Z';
  // Старо състояние от data.egov.bg (само име на ресурса) продължава от следващия ден.
  const first = await importStep(fetchImpl, { notices: [], lastResourceName: 'Автоматично генерирани данни за обявления, публикувани в ЦАИС ЕОП на 07.11.2026 г., съгласно стандарт OCDS' }, now, { max: 10 });
  assert.deepEqual(first.sources, ['ЦАИС ЕОП', 'data.egov.bg', 'ЦАИС ЕОП']);
  assert.deepEqual(first.state.notices.map((n) => n.id).sort(), ['401', '402', '403']);
  assert.equal(first.state.lastDate, '2026-11-10', '11.11 липсва навсякъде и е скорошен: чака се');
  assert.equal(first.remaining, 3);
  assert.ok(calls.includes('eop 2026-11-08') && calls.includes('eop 2026-11-09 403'));
  // Седмица по-късно 11.11 още липсва: пропуска се, за да не спре вносът.
  days.push({ uri: 'r4', date: '2026-11-13', createdAt: '2026-11-14 08:00:00', releases: [tenderRelease(404)] });
  const later = await importStep(fetchImpl, first.state, '2026-11-18T07:30:00Z', { max: 10 });
  assert.equal(later.skipped, 2);
  assert.equal(later.imported, 1);
  assert.equal(later.state.lastDate, '2026-11-13');
  assert.match(later.state.lastResourceName, /на 13\.11\.2026 г\./);
  assert.ok(!calls.some((c) => c < 'eop 2026-11-08'), 'старото състояние продължава от 08.11, не от 45 дни назад');
});
