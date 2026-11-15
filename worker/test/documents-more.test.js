// Допълнителни документи: дебитно известие, протокол по чл. 117 ЗДДС, авансова фактура с приспадане, касови ордери.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nextCashOrder } from '../src/documents.js';
import { LINES, setup, siteOf } from './helpers.js';

const issue = async (call, body) => {
  const draft = await call('POST', '/api/documents', { as: 'user@x.bg', body: { companyId: 'CO-1', ...body } });
  assert.equal(draft.status, 201, JSON.stringify(draft.data));
  return call('POST', `/api/documents/${draft.data.id}/issue`, { as: 'user@x.bg' });
};

test('дебитно известие: към фактура, в общата поредица, без движение на наличности, плаща се', async () => {
  const { call, store } = setup();
  const invoice = await issue(call, { docType: 'Фактура', lines: LINES });
  assert.equal((await store.forSite(siteOf('ORG-A')).find('products', 'id', 'PR-2'))[0].stock, 47);
  assert.equal((await call('POST', '/api/documents', { as: 'user@x.bg', body: { docType: 'Дебитно известие', companyId: 'CO-1', lines: LINES } })).status, 422, 'без фактура');
  const draft = await call('POST', `/api/documents/${invoice.data.id}/derive`, { as: 'user@x.bg', body: { docType: 'Дебитно известие' } });
  assert.equal(draft.status, 201);
  assert.match(draft.data.notes, /Към фактура № 0000000001/);
  const debit = await call('POST', `/api/documents/${draft.data.id}/issue`, { as: 'user@x.bg' });
  assert.equal(debit.data.number, '0000000002');
  assert.ok(debit.data.total > 0);
  assert.equal((await store.forSite(siteOf('ORG-A')).find('products', 'id', 'PR-2'))[0].stock, 47, 'известието променя цена, не количество');
  const paid = await call('POST', '/api/payments', { as: 'user@x.bg', body: { documentId: debit.data.id, amount: String(debit.data.total), method: 'В брой' } });
  assert.equal(paid.status, 201);
  assert.equal(paid.data.document.paymentStatus, 'Платен');
  assert.equal(paid.data.payment.cashOrder, 'ПКО-2026-0001');
});

test('протокол по чл. 117: доставчик от ЕС, начислен ДДС, данни за фактурата на доставчика, без плащане', async () => {
  const { call } = setup({
    companies: [{ id: 'CO-DE', orgId: 'ORG-A', name: 'Lieferant GmbH', relation: 'Доставчик', country: 'Германия', city: 'München', postcode: '80331', address: 'Marienplatz 1', vatNumber: 'DE123456789' }],
  });
  const lines = [{ name: 'Софтуерен лиценз', qty: 1, price: 1000, vatRate: 20 }];
  const missing = await call('POST', '/api/documents', { as: 'user@x.bg', body: { docType: 'Протокол по чл. 117', companyId: 'CO-DE', lines } });
  assert.equal(missing.status, 422);
  assert.ok(missing.data.error.fields.sourceDocNumber && missing.data.error.fields.sourceDocDate);
  const zero = await call('POST', '/api/documents', {
    as: 'user@x.bg', body: { docType: 'Протокол по чл. 117', companyId: 'CO-DE', sourceDocNumber: 'RE-77', sourceDocDate: '2026-11-03', lines: [{ ...lines[0], vatRate: 0 }] },
  });
  assert.match(zero.data.error.fields.lines, /20 или 9%/);
  const draft = await call('POST', '/api/documents', {
    as: 'user@x.bg', body: { docType: 'Протокол по чл. 117', companyId: 'CO-DE', sourceDocNumber: 'RE-77', sourceDocDate: '2026-11-03', lines },
  });
  assert.equal((await call('POST', `/api/documents/${draft.data.id}/issue`, { as: 'user@x.bg' })).status, 422, 'без основание');
  await call('PATCH', `/api/documents/${draft.data.id}`, {
    as: 'user@x.bg', body: { companyId: 'CO-DE', sourceDocNumber: 'RE-77', sourceDocDate: '2026-11-03', vatExemptReason: 'чл. 82, ал. 2 от ЗДДС', lines },
  });
  const issued = await call('POST', `/api/documents/${draft.data.id}/issue`, { as: 'user@x.bg' });
  assert.equal(issued.status, 200);
  assert.equal(issued.data.number, '0000000001', 'в поредицата на фактурите');
  assert.deepEqual([issued.data.vatAmount, issued.data.sourceDocNumber, issued.data.buyer.country], [200, 'RE-77', 'Германия']);
  assert.equal((await call('POST', '/api/payments', { as: 'user@x.bg', body: { documentId: issued.data.id, amount: '1' } })).status, 422);
});

test('протокол по чл. 117 не се издава от фирма без регистрация по ДДС', async () => {
  const { call, store } = setup();
  await store.update('orgs', 'ORG-A', { vatRegistered: 'Не' });
  const draft = await call('POST', '/api/documents', {
    as: 'user@x.bg', body: { docType: 'Протокол по чл. 117', companyId: 'CO-1', sourceDocNumber: '1', sourceDocDate: '2026-11-03', vatExemptReason: 'чл. 82, ал. 2 от ЗДДС', lines: [{ name: 'Услуга', qty: 1, price: 10, vatRate: 20 }] },
  });
  const res = await call('POST', `/api/documents/${draft.data.id}/issue`, { as: 'user@x.bg' });
  assert.equal(res.status, 422);
  assert.match(res.data.error.message, /регистрирана по ДДС/);
});

test('авансова фактура и окончателна фактура с приспадане на аванса', async () => {
  const { call, store } = setup({ companies: [
    { id: 'CO-1', orgId: 'ORG-A', name: 'Клиент ЕООД', relation: 'Клиент', city: 'Варна', address: 'бул. 2' },
    { id: 'CO-2', orgId: 'ORG-A', name: 'Друг клиент', relation: 'Клиент', city: 'Бургас', address: 'ул. 5' },
  ] });
  const advance = await issue(call, { docType: 'Фактура', advance: 'Да', lines: [{ productId: 'PR-2', name: 'Аванс 50%', qty: 1, price: 500, vatRate: 20 }] });
  assert.equal(advance.data.advance, 'Да');
  assert.equal((await store.forSite(siteOf('ORG-A')).find('products', 'id', 'PR-2'))[0].stock, 50, 'авансът не изписва стока');
  const deduct = (price, extra = {}) => ({ name: `Приспадане на аванс по фактура № ${advance.data.number}`, qty: 1, price, vatRate: 20, advanceOf: advance.data.id, ...extra });

  assert.equal((await call('POST', '/api/documents', { as: 'user@x.bg', body: { docType: 'Фактура', companyId: 'CO-1', lines: [{ name: 'X', qty: 1, price: -5, vatRate: 20 }] } })).status, 422, 'отрицателна цена без аванс');
  const tooMuch = await call('POST', '/api/documents', { as: 'user@x.bg', body: { docType: 'Фактура', companyId: 'CO-1', lines: [{ name: 'Работа', qty: 1, price: 2000, vatRate: 20 }, deduct(-600)] } });
  assert.match(tooMuch.data.error.fields.lines, /по-голямо от аванса/);
  const other = await call('POST', '/api/documents', { as: 'user@x.bg', body: { docType: 'Фактура', companyId: 'CO-2', lines: [{ name: 'Работа', qty: 1, price: 2000, vatRate: 20 }, deduct(-500)] } });
  assert.match(other.data.error.fields.lines, /същия контрагент/);
  const negative = await call('POST', '/api/documents', { as: 'user@x.bg', body: { docType: 'Фактура', companyId: 'CO-1', lines: [{ name: 'Работа', qty: 1, price: 100, vatRate: 20 }, deduct(-500)] } });
  assert.match(negative.data.error.fields.lines, /отрицателна/);

  const final = await issue(call, { docType: 'Фактура', lines: [{ name: 'Работа', qty: 1, price: 1000, vatRate: 20 }, deduct(-500)] });
  assert.deepEqual([final.data.subtotal, final.data.vatAmount, final.data.total], [500, 100, 600]);
  assert.equal(final.data.lines[1].advanceOf, advance.data.id);
});

test('касови ордери: ПКО при плащане в брой, РКО при връщане по кредитно известие, отделни поредици', async () => {
  const { call } = setup();
  const invoice = await issue(call, { docType: 'Фактура', lines: LINES });
  const bank = await call('POST', '/api/payments', { as: 'user@x.bg', body: { documentId: invoice.data.id, amount: '10', method: 'Банков превод' } });
  assert.equal(bank.data.payment.cashOrder, '');
  const cash1 = await call('POST', '/api/payments', { as: 'user@x.bg', body: { documentId: invoice.data.id, amount: '10', method: 'В брой' } });
  const cash2 = await call('POST', '/api/payments', { as: 'user@x.bg', body: { documentId: invoice.data.id, amount: '10', method: 'В брой' } });
  assert.deepEqual([cash1.data.payment.cashOrder, cash2.data.payment.cashOrder], ['ПКО-2026-0001', 'ПКО-2026-0002']);

  const credit = await call('POST', `/api/documents/${invoice.data.id}/derive`, { as: 'user@x.bg', body: { docType: 'Кредитно известие' } });
  const creditIssued = await call('POST', `/api/documents/${credit.data.id}/issue`, { as: 'user@x.bg' });
  assert.ok(creditIssued.data.total < 0);
  const tooMuch = await call('POST', '/api/payments', { as: 'user@x.bg', body: { documentId: credit.data.id, amount: '1000', method: 'В брой' } });
  assert.equal(tooMuch.status, 422);
  const refund = await call('POST', '/api/payments', { as: 'user@x.bg', body: { documentId: credit.data.id, amount: String(-creditIssued.data.total), method: 'В брой' } });
  assert.equal(refund.status, 201);
  assert.equal(refund.data.payment.cashOrder, 'РКО-2026-0001');
  assert.equal(refund.data.document.paymentStatus, 'Платен');
});

test('поредица на касовите ордери по години', () => {
  const payments = [{ cashOrder: 'ПКО-2026-0009' }, { cashOrder: 'РКО-2026-0003' }, { cashOrder: 'ПКО-2025-0040' }, { cashOrder: '' }];
  assert.equal(nextCashOrder(payments, 'ПКО', '2026'), 'ПКО-2026-0010');
  assert.equal(nextCashOrder(payments, 'РКО', '2026'), 'РКО-2026-0004');
  assert.equal(nextCashOrder(payments, 'ПКО', '2027'), 'ПКО-2027-0001');
});
