// Оферти, проформи, фактури, кредитни и дебитни известия, протоколи по чл. 117 ЗДДС: редове, суми, ДДС и номерация.
import { clean, MAX_TEXT, parseNumber, round2 } from './validate.js';

export const DOC_TYPES = ['Оферта', 'Проформа фактура', 'Фактура', 'Кредитно известие', 'Дебитно известие', 'Протокол по чл. 117'];
export const VAT_RATES = [20, 9, 0];
export const MAX_LINES = 100;
// Фактурите, известията към тях (чл. 115 ЗДДС) и протоколите по чл. 117 ЗДДС са с обща поредица от 10 цифри.
export const TAX_DOCS = ['Фактура', 'Кредитно известие', 'Дебитно известие', 'Протокол по чл. 117'];
// Известията са винаги към издадена фактура.
export const NOTE_TYPES = ['Кредитно известие', 'Дебитно известие'];
// По тези документи клиентът плаща; по кредитно известие фирмата връща сума (разходен касов ордер при плащане в брой).
export const PAYABLE_TYPES = ['Фактура', 'Проформа фактура', 'Дебитно известие'];
export const REFUND_TYPES = ['Кредитно известие'];
const PREFIX = { 'Оферта': 'OF', 'Проформа фактура': 'PF' };

// Валутите за документи. EUR е националната валута; при друга валута документът носи курс на ЕЦБ
// и данъчната основа и ДДС се показват и в евро, защото по ЗДДС данъкът се посочва и в националната валута.
export const CURRENCIES = ['EUR', 'USD', 'GBP', 'CHF', 'RON', 'TRY', 'PLN', 'CZK', 'HUF', 'SEK', 'DKK', 'NOK', 'JPY', 'CNY'];

const IBAN_RE = /^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/;
export function validateBankAccounts(raw, max) {
  if (!Array.isArray(raw)) return { accounts: [] };
  if (raw.length > max) return { error: `Планът позволява до ${max} банкови сметки.` };
  const accounts = [];
  for (const [i, row] of raw.entries()) {
    const iban = String(row?.iban || '').replace(/\s/g, '').toUpperCase();
    if (!IBAN_RE.test(iban)) return { error: `Сметка ${i + 1}: невалиден IBAN.` };
    const currency = CURRENCIES.includes(row.currency) ? row.currency : 'EUR';
    accounts.push({
      iban,
      bic: String(row.bic || '').replace(/\s/g, '').toUpperCase().slice(0, 11),
      bank: String(row.bank || '').trim().slice(0, 120),
      currency,
      label: String(row.label || '').trim().slice(0, 60),
    });
  }
  if (new Set(accounts.map((a) => a.iban)).size !== accounts.length) return { error: 'Една и съща сметка е въведена два пъти.' };
  return { accounts };
}

export const DEFAULT_COMPANY = {
  name: '', eik: '', vatNumber: '', mol: '', country: 'България', city: '', postcode: '', region: '', address: '', phone: '', email: '',
  iban: '', bank: '', bic: '', vatRegistered: 'Да', invoiceStart: '1', dueDays: '7', currency: 'EUR',
};

export function parseJson(text, fallback) {
  if (!text) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

// Връща нормализираните редове или грешка, подходяща за показване на потребителя.
export function validateLines(raw, productsById) {
  if (!Array.isArray(raw) || raw.length === 0) return { error: 'Добавете поне един ред.' };
  if (raw.length > MAX_LINES) return { error: `Документът може да има до ${MAX_LINES} реда.` };
  const lines = [];
  for (const [i, row] of raw.entries()) {
    const n = i + 1;
    if (!row || typeof row !== 'object') return { error: `Ред ${n} е невалиден.` };
    const productId = clean(row.productId, 40);
    // Ред „Приспадане на аванс“ във фактура: отрицателна цена, сочи авансовата фактура.
    const advanceOf = clean(row.advanceOf, 40);
    if (productId && !productsById.has(productId)) return { error: `Ред ${n}: артикулът не съществува.` };
    const name = clean(row.name, MAX_TEXT);
    if (!name) return { error: `Ред ${n}: въведете наименование.` };
    const qty = parseNumber(row.qty);
    const price = parseNumber(row.price);
    const discount = row.discount === '' || row.discount === undefined ? 0 : parseNumber(row.discount);
    const vatRate = parseNumber(row.vatRate);
    if (!(qty > 0) || qty > 1e7) return { error: `Ред ${n}: количеството трябва да е положително число.` };
    if (advanceOf ? !(price < 0 && price > -1e10) : !(price >= 0) || price > 1e10) return { error: `Ред ${n}: невалидна цена.` };
    if (!(discount >= 0 && discount <= 100)) return { error: `Ред ${n}: отстъпката е между 0 и 100%.` };
    if (!VAT_RATES.includes(vatRate)) return { error: `Ред ${n}: ДДС ставката е 20, 9 или 0%.` };
    lines.push({
      productId,
      name,
      unit: clean(row.unit, 20) || 'бр.',
      qty: Math.round(qty * 1000) / 1000,
      price: Math.round(price * 10000) / 10000,
      discount: round2(discount),
      vatRate,
      ...(advanceOf ? { advanceOf } : {}),
    });
  }
  return { lines };
}

export const lineNet = (l) => round2(l.qty * l.price * (1 - l.discount / 100));

// ДДС се смята върху данъчната основа за всяка ставка, а не по редове, за да няма разлика от закръгляне.
export function computeTotals(lines, docType) {
  const bases = new Map();
  for (const line of lines) bases.set(line.vatRate, round2((bases.get(line.vatRate) || 0) + lineNet(line)));
  let subtotal = 0;
  let vatAmount = 0;
  const byRate = [];
  for (const [rate, base] of [...bases].sort((a, b) => b[0] - a[0])) {
    const vat = round2((base * rate) / 100);
    byRate.push({ rate, base, vat });
    subtotal = round2(subtotal + base);
    vatAmount = round2(vatAmount + vat);
  }
  // Кредитното известие намалява оборота, затова сумите му се пазят с минус.
  const sign = docType === 'Кредитно известие' ? -1 : 1;
  return {
    subtotal: sign * subtotal,
    vatAmount: sign * vatAmount,
    total: sign * round2(subtotal + vatAmount),
    byRate: byRate.map((r) => ({ rate: r.rate, base: sign * r.base, vat: sign * r.vat })),
  };
}

// Следващ номер: 10 цифри за фактури и известия, OF-2026-0001 / PF-2026-0001 за оферти и проформи.
export function nextNumber(documents, docType, { year, invoiceStart = 1 }) {
  if (TAX_DOCS.includes(docType)) {
    const used = documents
      .filter((d) => TAX_DOCS.includes(d.docType) && /^\d{10}$/.test(d.number))
      .map((d) => Number(d.number));
    const next = Math.max(Number(invoiceStart) || 1, used.length ? Math.max(...used) + 1 : 1);
    return String(next).padStart(10, '0');
  }
  const prefix = `${PREFIX[docType]}-${year}-`;
  const used = documents
    .filter((d) => d.docType === docType && d.number.startsWith(prefix))
    .map((d) => Number(d.number.slice(prefix.length)) || 0);
  return `${prefix}${String((used.length ? Math.max(...used) : 0) + 1).padStart(4, '0')}`;
}

// Пореден номер на касов ордер за годината: ПКО-2026-0001 / РКО-2026-0001.
export function nextCashOrder(payments, kind, year) {
  const prefix = `${kind}-${year}-`;
  const used = payments.filter((p) => String(p.cashOrder || '').startsWith(prefix)).map((p) => Number(p.cashOrder.slice(prefix.length)) || 0);
  return `${prefix}${String((used.length ? Math.max(...used) : 0) + 1).padStart(4, '0')}`;
}

export function paymentStatusOf(total, paid) {
  if (paid <= 0) return 'Неплатен';
  return paid + 0.004 >= Math.abs(total) ? 'Платен' : 'Частично платен';
}

export const addDays = (day, days) => {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};
