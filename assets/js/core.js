// Целият текст влиза в страницата през textContent, никога като HTML,
// за да не може въведено от потребител съдържание да се изпълни у друг.
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key === 'class') el.className = value;
    else if (key === 'value') el.value = value;
    else if (['checked', 'selected', 'disabled', 'required', 'hidden', 'readOnly'].includes(key)) el[key] = !!value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat(Infinity)) {
    if (child === undefined || child === null || child === false) continue;
    el.append(child);
  }
  return el;
}

export class ApiError extends Error {
  constructor(status, message, fields) {
    super(message);
    this.status = status;
    this.fields = fields || {};
  }
}

// Избраната организация отива като заглавка към всяка заявка.
let currentOrg = '';
export const setOrg = (id) => { currentOrg = id || ''; };

export async function api(path, { method = 'GET', body, bytes, type, raw = false } = {}) {
  let res;
  const headers = {};
  if (currentOrg) headers['x-org'] = currentOrg;
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (bytes !== undefined) headers['content-type'] = type;
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers,
      body: bytes !== undefined ? bytes : body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'Няма връзка със сървъра. Проверете интернета и опитайте отново.');
  }
  const isJson = (res.headers.get('content-type') || '').includes('application/json');
  if (res.ok && raw) return new Uint8Array(await res.arrayBuffer());
  const data = isJson ? await res.json() : null;
  if (!res.ok) {
    throw new ApiError(res.status, data?.error?.message || 'Услугата временно не е достъпна. Опитайте отново след малко.', data?.error?.fields);
  }
  return data;
}

// --- Формати ---

const dateFormat = new Intl.DateTimeFormat('bg-BG', { day: '2-digit', month: '2-digit', year: 'numeric' });
const timeFormat = new Intl.DateTimeFormat('bg-BG', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const parse = (iso) => {
  if (!iso) return null;
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T12:00:00Z` : iso);
  return Number.isNaN(d.getTime()) ? null : d;
};
export const formatDate = (iso) => { const d = parse(iso); return d ? dateFormat.format(d) : ''; };
export const formatTime = (iso) => { const d = parse(iso); return d ? timeFormat.format(d) : ''; };

const moneyFormats = new Map();
const moneyFormat = (currency) => {
  // Евро е със знака €, а другите валути — с кода си (USD, GBP), както е прието във фактурите.
  if (!moneyFormats.has(currency)) moneyFormats.set(currency, new Intl.NumberFormat('bg-BG', { style: 'currency', currency, currencyDisplay: currency === 'EUR' ? 'symbol' : 'code', minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  return moneyFormats.get(currency);
};
const numberFormat = new Intl.NumberFormat('bg-BG', { maximumFractionDigits: 3 });
export const money = (n, currency = 'EUR') => (n === '' || n === null || n === undefined || Number.isNaN(Number(n)) ? '' : moneyFormat(currency || 'EUR').format(Number(n)));
export const num = (n) => (n === '' || n === null || n === undefined ? '' : numberFormat.format(Number(n)));
export const parseNum = (value) => {
  const n = Number(String(value ?? '').replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
};
export const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

// Днешна дата по българско време във формат ГГГГ-ММ-ДД.
export const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Sofia' }).format(new Date());

const relative = new Intl.RelativeTimeFormat('bg', { numeric: 'auto' });
export function timeAgo(iso) {
  const then = parse(iso)?.getTime();
  if (!then) return '';
  const minutes = Math.round((then - Date.now()) / 60000);
  if (Math.abs(minutes) < 60) return relative.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return relative.format(hours, 'hour');
  const days = Math.round(hours / 24);
  if (Math.abs(days) < 30) return relative.format(days, 'day');
  return formatDate(iso);
}

export const norm = (s) => String(s ?? '').toLocaleLowerCase('bg');

// --- Формуляри и грешки ---

export function showError(container, message) {
  container.replaceChildren(h('div', { class: 'alert alert--error', role: 'alert' }, message));
}

// Изписва грешките под съответните полета.
export function showFieldErrors(form, fields) {
  form.querySelectorAll('.field__error').forEach((el) => el.remove());
  form.querySelectorAll('[aria-invalid]').forEach((el) => el.removeAttribute('aria-invalid'));
  let first = null;
  for (const [name, message] of Object.entries(fields || {})) {
    const input = form.elements[name];
    const target = input instanceof RadioNodeList ? input[0] : input;
    if (!target) continue;
    const id = `err-${name}`;
    target.setAttribute('aria-invalid', 'true');
    target.setAttribute('aria-describedby', id);
    (target.closest('.field') || target.parentElement).append(h('div', { class: 'field__error', id }, message));
    first ??= target;
  }
  first?.focus();
}

export const formValues = (form) => Object.fromEntries(new FormData(form).entries());

export function field({ name, label, hint, type = 'text', value = '', required = false, autocomplete, inputmode, maxlength, placeholder, wrapClass }) {
  const id = `f-${name}`;
  return h('div', { class: `field ${wrapClass || ''}` },
    h('label', { for: id }, label, hint && h('span', { class: 'field__hint' }, ` (${hint})`)),
    h('input', { id, name, type, value, required, autocomplete, inputmode, maxlength, placeholder }));
}

export function selectField({ name, label, options, value = '', wrapClass, empty }) {
  const id = `f-${name}`;
  return h('div', { class: `field ${wrapClass || ''}` },
    h('label', { for: id }, label),
    h('select', { id, name },
      empty !== undefined && h('option', { value: '' }, empty),
      options.map((o) => {
        const [v, text] = Array.isArray(o) ? o : [o, o];
        return h('option', { value: v, selected: String(v) === String(value) }, text);
      })));
}

// --- Икони ---

const ICONS = {
  home: 'M3 11l9-8 9 8M5 9.5V21h5v-6h4v6h5V9.5',
  users: 'M16 20v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M22 20v-1a4 4 0 0 0-3-3.8M16 3.2a4 4 0 0 1 0 7.6',
  check: 'M9 11l3 3 8-8M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9',
  team: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8M4 21a8 8 0 0 1 16 0M18 8h4M20 6v4',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8M4 21a8 8 0 0 1 16 0',
  plus: 'M12 5v14M5 12h14',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
  doc: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 13h8M8 17h6',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16M21 21l-4.3-4.3',
  phone: 'M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3 19.5 19.5 0 0 1-6-6 19.8 19.8 0 0 1-3-8.7A2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2',
  mail: 'M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2M22 6l-10 7L2 6',
  clock: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20M12 6v6l4 2',
  alert: 'M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0',
  menu: 'M4 7h16M4 12h16M4 17h16',
  close: 'M18 6L6 18M6 6l12 12',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  back: 'M19 12H5M11 18l-6-6 6-6',
  copy: 'M9 9h11a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2zM5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1',
  building: 'M3 21h18M5 21V7l7-4 7 4v14M9 9h1M14 9h1M9 13h1M14 13h1M9 17h1M14 17h1',
  handshake: 'M3 7l5-3 4 3 4-3 5 3v8l-9 6-9-6zM12 7l-4 4 2 2 3-2 4 4',
  box: 'M21 8l-9-5-9 5v8l9 5 9-5zM3 8l9 5 9-5M12 13v8',
  wallet: 'M3 7a2 2 0 0 1 2-2h13v4M3 7v11a2 2 0 0 0 2 2h15V9H5a2 2 0 0 1-2-2M16 14h.01',
  printer: 'M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2M6 14h12v8H6z',
  download: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3',
  trash: 'M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6',
  edit: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z',
  chart: 'M3 3v18h18M7 15l4-4 3 3 5-6',
  send: 'M22 2L11 13M22 2l-7 20-4-9-9-4z',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  board: 'M3 3h7v18H3zM14 3h7v10h-7z',
  scale: 'M12 3v18M7 21h10M5 7h14M5 7l-3 7a3.5 3.5 0 0 0 6 0zM19 7l-3 7a3.5 3.5 0 0 0 6 0z',
  bell: 'M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0',
  link: 'M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7',
  arrow: 'M5 12h14M13 6l6 6-6 6',
};

export function icon(name, size = 20) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [k, v] of Object.entries({
    viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8',
    'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true',
  })) svg.setAttribute(k, v);
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICONS[name] || '');
  svg.append(path);
  return svg;
}

// --- Известия и диалози ---

let toastRegion;
export function toast(message, kind = 'ok') {
  if (!toastRegion?.isConnected) {
    toastRegion = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.append(toastRegion);
  }
  const item = h('div', { class: `toast toast--${kind}` }, icon(kind === 'error' ? 'alert' : 'check', 18), h('span', {}, message));
  toastRegion.append(item);
  setTimeout(() => item.remove(), kind === 'error' ? 7000 : 4000);
}

export function confirmDialog({ title, text, confirmLabel = 'Потвърдете', danger = false }) {
  return new Promise((resolve) => {
    const finish = (value) => {
      dialog.close();
      dialog.remove();
      resolve(value);
    };
    const dialog = h('dialog', { class: 'dialog', 'aria-labelledby': 'dialog-title' },
      h('h2', { id: 'dialog-title' }, title),
      h('p', { class: 'muted' }, text),
      h('div', { class: 'row dialog__actions' },
        h('button', { class: 'btn btn--ghost', type: 'button', onclick: () => finish(false) }, 'Отказ'),
        h('button', { class: `btn ${danger ? 'btn--danger' : ''}`, type: 'button', onclick: () => finish(true) }, confirmLabel)));
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      finish(false);
    });
    document.body.append(dialog);
    dialog.showModal();
  });
}

// Диалог с формуляр. Връща резултата от onSubmit или null при отказ.
export function formDialog({ title, fields, submitLabel = 'Запазете', onSubmit, wide = false }) {
  return new Promise((resolve) => {
    const alert = h('div', { 'aria-live': 'polite' });
    const close = (value) => {
      dialog.close();
      dialog.remove();
      resolve(value);
    };
    const submit = h('button', { class: 'btn', type: 'submit' }, submitLabel);
    const form = h('form', { class: 'form', novalidate: true },
      h('h2', { id: 'dialog-title' }, title),
      fields,
      alert,
      h('div', { class: 'row dialog__actions' },
        h('button', { class: 'btn btn--ghost', type: 'button', onclick: () => close(null) }, 'Отказ'),
        submit));
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      submit.disabled = true;
      try {
        const values = formValues(form);
        const result = onSubmit ? await onSubmit(values, form) : values;
        close(result ?? values);
      } catch (err) {
        showFieldErrors(form, err.fields);
        showError(alert, err.message);
        submit.disabled = false;
      }
    });
    const dialog = h('dialog', { class: `dialog ${wide ? 'dialog--wide' : ''}`, 'aria-labelledby': 'dialog-title' }, form);
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      close(null);
    });
    document.body.append(dialog);
    dialog.showModal();
    form.querySelector('input, select, textarea')?.focus();
  });
}

// Еднократен линк, който администраторът изпраща сам, когато имейлите са изключени.
export function linkBox(link, note) {
  const input = h('input', { type: 'text', value: link, readonly: true, 'aria-label': 'Еднократен линк' });
  const copy = h('button', {
    class: 'btn btn--small', type: 'button',
    onclick: async () => {
      input.select();
      try {
        await navigator.clipboard.writeText(link);
        copy.textContent = 'Копирано';
      } catch { /* текстът остава маркиран за ръчно копиране */ }
    },
  }, 'Копирайте');
  return h('div', { class: 'alert alert--ok link-box', role: 'status' },
    h('p', {}, note),
    h('div', { class: 'link-box__row' }, input, copy),
    h('p', { class: 'small' }, 'Линкът е валиден 72 часа и се показва само сега. Изпратете го лично на човека.'));
}

export const emptyState = (iconName, title, text, action) => h('div', { class: 'empty' },
  h('span', { class: 'empty__icon' }, icon(iconName, 26)),
  h('h3', {}, title),
  text && h('p', { class: 'muted' }, text),
  action);

export const pageHead = (title, subtitle, ...actions) => h('header', { class: 'page-head' },
  h('div', { class: 'page-head__text' }, h('h1', {}, title), subtitle && h('p', { class: 'muted' }, subtitle)),
  actions.filter(Boolean).length > 0 && h('div', { class: 'row' }, actions));

export const pill = (value, kind = 'status') => value && h('span', { class: 'pill', [`data-${kind}`]: value }, value);

// Изтегля CSV файл, който Excel отваря правилно с кирилица (UTF-8 с BOM и точка и запетая).
export function downloadCsv(filename, header, rows) {
  const cell = (v) => {
    const s = String(v ?? '');
    return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const text = [header, ...rows].map((r) => r.map(cell).join(';')).join('\r\n');
  const url = URL.createObjectURL(new Blob(['﻿', text], { type: 'text/csv;charset=utf-8' }));
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// --- Рамка на приложението ---

// На телефон изборът на организация е в горната лента: копие на падащото меню, свързано със същото действие.
function mobileSwitcher(switcher) {
  const select = switcher.querySelector('select');
  if (!select) return null;
  const copy = select.cloneNode(true);
  copy.className = 'org-switch__select org-switch__select--top';
  copy.removeAttribute('id');
  copy.addEventListener('change', () => {
    select.value = copy.value;
    select.dispatchEvent(new Event('change'));
  });
  return copy;
}

export function mountShell({ user, detail, nav, switcher }) {
  const main = h('main', { class: 'app__main', id: 'main', tabindex: '-1' });
  const navList = h('ul', { class: 'app__nav-list' });
  const logout = async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => {});
    location.href = '/';
  };
  const brand = () => h('a', { class: 'brand brand--light', href: '#/' },
    h('span', { class: 'brand__tile' }, h('img', { src: '/assets/img/logo-mark.webp', alt: '', width: 28, height: 28 })),
    h('span', { class: 'brand__word' }, 'БУЛ', h('b', {}, 'АДМИН')));
  const shell = h('div', { class: 'app' },
    h('header', { class: 'app__top' },
      brand(),
      switcher?.cloneNode && switcher.dataset.mobile !== 'no' && mobileSwitcher(switcher),
      h('div', { class: 'app__top-actions' },
        window.baTheme?.button('icon-btn icon-btn--light'),
        h('button', { class: 'icon-btn icon-btn--light', type: 'button', 'aria-label': 'Изход', title: 'Изход', onclick: logout }, icon('logout', 20)))),
    h('aside', { class: 'app__side' },
      h('div', { class: 'app__brand' }, brand(), h('span', { class: 'app__tag' }, 'CRM · ERP')),
      switcher,
      h('nav', { class: 'app__nav', 'aria-label': 'Основно меню' }, navList),
      h('div', { class: 'app__user' },
        h('a', { class: 'app__user-text', href: '#/me' }, h('strong', {}, user), detail && h('span', {}, detail)),
        h('div', { class: 'app__user-actions' },
          window.baTheme?.button('icon-btn icon-btn--light'),
          h('button', { class: 'icon-btn icon-btn--light', type: 'button', 'aria-label': 'Изход', title: 'Изход', onclick: logout }, icon('logout', 20))))),
    main);
  document.body.replaceChildren(shell);

  let badges = {};
  const currentPath = () => location.hash.replace(/^#/, '').split('?')[0] || '/';
  const countBadge = (count) => count > 0 && h('span', { class: 'badge', 'aria-label': `${count} чакащи` }, String(count));

  // На телефон се виждат до 4 раздела; останалите са в „Още“.
  function openMore(items) {
    const close = () => {
      sheet.close();
      sheet.remove();
    };
    const sheet = h('dialog', { class: 'sheet', 'aria-label': 'Още раздели' },
      h('div', { class: 'sheet__head' },
        h('span', {}, 'Още'),
        h('button', { class: 'icon-btn icon-btn--light', type: 'button', 'aria-label': 'Затвори', onclick: close }, icon('close', 20))),
      h('ul', {}, items.map((item) => {
        const active = item.match.test(currentPath());
        return h('li', {}, h('a', { href: item.href, class: active ? 'is-active' : '', 'aria-current': active ? 'page' : null, onclick: close },
          icon(item.icon), h('span', {}, item.label), countBadge(badges[item.key])));
      })));
    sheet.addEventListener('click', (event) => {
      if (event.target === sheet) close();
    });
    sheet.addEventListener('cancel', (event) => {
      event.preventDefault();
      close();
    });
    document.body.append(sheet);
    sheet.showModal();
  }

  const render = () => {
    const path = currentPath();
    const items = nav();
    const links = items.filter((i) => !i.group);
    const secondary = links.length > 5 ? links.slice(4) : [];
    const rows = items.map((item) => {
      if (item.group) return h('li', { class: 'app__nav-group', 'aria-hidden': 'true' }, item.group);
      const active = item.match.test(path);
      return h('li', { class: secondary.includes(item) ? 'is-secondary' : '' }, h('a', { href: item.href, class: active ? 'is-active' : '', 'aria-current': active ? 'page' : null },
        icon(item.icon),
        h('span', { class: 'app__nav-label' }, item.label),
        countBadge(badges[item.key])));
    });
    if (secondary.length) {
      const waiting = secondary.reduce((sum, item) => sum + (badges[item.key] || 0), 0);
      rows.push(h('li', { class: 'app__nav-more' }, h('button', {
        type: 'button', class: secondary.some((item) => item.match.test(path)) ? 'is-active' : '', 'aria-haspopup': 'dialog',
        onclick: () => openMore(secondary),
      }, icon('menu'), h('span', {}, 'Още'), countBadge(waiting))));
    }
    navList.replaceChildren(...rows);
  };
  render();
  window.addEventListener('hashchange', render);
  return {
    main,
    setBadges: (next) => {
      badges = next;
      render();
    },
  };
}

export function fatal(container, err) {
  container.replaceChildren(h('div', { class: 'wrap wrap--narrow section' },
    h('div', { class: 'alert alert--error', role: 'alert' }, err.message || 'Възникна грешка.'),
    h('p', { style: 'margin-top:12px' }, h('a', { href: '/' }, 'Към входа'))));
}

// Адрес в един ред: „4000 Пловдив, ул. Примерна 1“; държавата се добавя, ако не е България.
export function addressLine(p) {
  const country = p.country && !/^(българия|bg|bulgaria)$/i.test(p.country.trim()) ? p.country : '';
  return [[p.postcode, p.city].filter(Boolean).join(' '), p.address, country].filter(Boolean).join(', ');
}

// Сума с думи (за касови ордери и ценови предложения): 1234,56 → „хиляда двеста тридесет и четири евро и петдесет и шест евроцента“.
const W_ONES = { m: ['', 'един', 'два'], n: ['', 'едно', 'две'], f: ['', 'една', 'две'] };
const W_UNITS = ['', '', '', 'три', 'четири', 'пет', 'шест', 'седем', 'осем', 'девет'];
const W_TEENS = ['десет', 'единадесет', 'дванадесет', 'тринадесет', 'четиринадесет', 'петнадесет', 'шестнадесет', 'седемнадесет', 'осемнадесет', 'деветнадесет'];
const W_TENS = ['', '', 'двадесет', 'тридесет', 'четиридесет', 'петдесет', 'шестдесет', 'седемдесет', 'осемдесет', 'деветдесет'];
const W_HUNDREDS = ['', 'сто', 'двеста', 'триста', 'четиристотин', 'петстотин', 'шестстотин', 'седемстотин', 'осемстотин', 'деветстотин'];
const wordParts = (n, gender) => {
  const out = [];
  if (Math.floor(n / 100)) out.push(W_HUNDREDS[Math.floor(n / 100)]);
  const r = n % 100;
  if (r >= 10 && r < 20) out.push(W_TEENS[r - 10]);
  else {
    if (Math.floor(r / 10)) out.push(W_TENS[Math.floor(r / 10)]);
    const u = r % 10;
    if (u) out.push(u <= 2 ? W_ONES[gender][u] : W_UNITS[u]);
  }
  return out;
};
const joinAnd = (parts) => (parts.length < 2 ? parts.join(' ') : `${parts.slice(0, -1).join(' ')} и ${parts.at(-1)}`);
export function numberWords(value, gender = 'm') {
  const n = Math.floor(Math.abs(Number(value) || 0));
  if (n === 0) return 'нула';
  const millions = Math.floor(n / 1e6);
  const thousands = Math.floor(n / 1000) % 1000;
  const parts = [];
  if (millions) parts.push(millions === 1 ? 'един милион' : `${joinAnd(wordParts(millions, 'm'))} милиона`);
  if (thousands) parts.push(thousands === 1 ? 'хиляда' : `${joinAnd(wordParts(thousands, 'f'))} хиляди`);
  parts.push(...wordParts(n % 1000, gender));
  // „и“ стои пред последната част, освен ако тя вече съдържа „и“ („два милиона триста и четиридесет хиляди“).
  return parts.at(-1).includes(' и ') ? parts.join(' ') : joinAnd(parts);
}
export function amountWords(value, currency = 'EUR') {
  const total = Math.round(Math.abs(Number(value) || 0) * 100);
  const whole = Math.floor(total / 100);
  const cents = total % 100;
  if (currency !== 'EUR') return `${numberWords(whole)} ${currency}${cents ? ` и ${String(cents).padStart(2, '0')}/100` : ''}`;
  const centWords = cents === 1 ? 'един евроцент' : `${numberWords(cents, 'm')} евроцента`;
  return `${numberWords(whole, 'n')} евро${cents ? ` и ${centWords}` : ''}`;
}
