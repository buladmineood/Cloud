import schema from './schema.json' with { type: 'json' };

export const MAX_TEXT = 255;
export const MAX_MULTILINE = 8000;

export function clean(value, max, { multiline = false } = {}) {
  if (typeof value === 'number') value = String(value);
  if (typeof value !== 'string') return '';
  const pattern = multiline ? /[\u0000-\u0009\u000B\u000C\u000E-\u001F\u007F]/g : /[\u0000-\u001F\u007F]/g;
  return value.replace(pattern, multiline ? '' : ' ').trim().slice(0, max);
}

export function isValidEik(eik) {
  if (!/^(\d{9}|\d{13})$/.test(eik)) return false;
  const d = [...eik].map(Number);
  const check = (weights, offset = 0) => weights.reduce((sum, w, i) => sum + w * d[i + offset], 0) % 11;
  let ninth = check([1, 2, 3, 4, 5, 6, 7, 8]);
  if (ninth === 10) ninth = check([3, 4, 5, 6, 7, 8, 9, 10]) % 10;
  if (ninth !== d[8]) return false;
  if (eik.length === 9) return true;
  let last = check([2, 7, 3, 5], 8);
  if (last === 10) last = check([4, 9, 5, 7], 8) % 10;
  return last === d[12];
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export const isValidEmail = (email) => EMAIL.test(email);
const PHONE = /^\+?[0-9][0-9 ()/-]{5,19}$/;
const URL_RE = /^https?:\/\/[^\s]+\.[^\s]{2,}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function isValidDay(value) {
  if (!DAY.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function passwordError(password) {
  if (password.length < 10) return 'Паролата трябва да е поне 10 знака.';
  if (password.length > 128) return 'Паролата трябва да е до 128 знака.';
  return null;
}

// Приема и десетична запетая, както се пише на български.
export function parseNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  const text = String(value ?? '').replace(/\s/g, '').replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(text)) return NaN;
  return Number(text);
}

export const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

// Проверява и нормализира полетата на запис от общите раздели според schema.json.
// При частична промяна (partial) се проверяват само подадените полета.
export function validateRecord(entity, body, { partial = false } = {}) {
  const def = schema[entity];
  const values = {};
  const errors = {};
  for (const column of def.columns) {
    if (column.system) continue;
    const provided = Object.hasOwn(body, column.name);
    if (partial && !provided) continue;
    let raw = provided ? body[column.name] : '';
    if ((raw === '' || raw === null || raw === undefined) && column.default !== undefined && !partial) raw = column.default;
    const value = column.kind === 'multiline' ? clean(raw, MAX_MULTILINE, { multiline: true }) : clean(raw, MAX_TEXT);
    if (!value) {
      if (column.required) errors[column.name] = 'Задължително поле.';
      values[column.name] = '';
      continue;
    }
    if (column.kind === 'choice' && !column.choices.includes(value)) errors[column.name] = 'Изберете стойност от списъка.';
    else if (column.kind === 'day' && !isValidDay(value)) errors[column.name] = 'Невалидна дата.';
    else if (column.input === 'email' && !isValidEmail(value)) errors[column.name] = 'Невалиден имейл.';
    else if (column.input === 'tel' && !PHONE.test(value)) errors[column.name] = 'Невалиден телефон.';
    else if (column.input === 'url' && !URL_RE.test(value)) errors[column.name] = 'Адресът трябва да започва с https://';
    else if (column.input === 'eik' && !isValidEik(value)) errors[column.name] = 'Невалиден ЕИК/БУЛСТАТ (9 или 13 цифри).';
    if (column.kind === 'number') {
      const n = parseNumber(value);
      if (Number.isNaN(n) || Math.abs(n) > 1e12) errors[column.name] = 'Въведете число.';
      else values[column.name] = column.input === 'money' ? round2(n) : n;
      continue;
    }
    values[column.name] = value;
  }
  return { values, errors };
}
