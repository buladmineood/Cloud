// Автоматично попълване на адреси: държава, населено място, пощенски код и област в България и ЕС.
// Данните са статични файлове (assets/data/places/<код>.json от GeoNames, CC BY 4.0), които се зареждат
// при първото писане в полето — без сървъра. Изборът попълва града, пощенския код и областта; всичко
// остава свободен текст, така че може да се въведе и място, което липсва в списъка.
import { h } from './core.js?v=c0e092ac04';

export const COUNTRIES = {
  BG: 'България', AT: 'Австрия', BE: 'Белгия', GR: 'Гърция', DE: 'Германия', DK: 'Дания', EE: 'Естония', IE: 'Ирландия',
  ES: 'Испания', IT: 'Италия', CY: 'Кипър', LV: 'Латвия', LT: 'Литва', LU: 'Люксембург', MT: 'Малта', NL: 'Нидерландия',
  PL: 'Полша', PT: 'Португалия', RO: 'Румъния', SK: 'Словакия', SI: 'Словения', HU: 'Унгария', FI: 'Финландия', FR: 'Франция',
  HR: 'Хърватия', CZ: 'Чехия', SE: 'Швеция',
};
// Държави без данни в GeoNames: там остава ръчното въвеждане.
const NO_DATA = new Set(['GR']);
export const DEFAULT_COUNTRY = COUNTRIES.BG;

const fold = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss').replace(/[-–'’.]/g, ' ').replace(/\s+/g, ' ').trim();
const byName = new Map(Object.entries(COUNTRIES).flatMap(([code, name]) => [[fold(name), code], [fold(code), code]]));
export const countryCode = (value) => (value ? byName.get(fold(value)) || '' : 'BG');

// Обтекаема транслитерация (Закон за транслитерацията), за да се намира „Боровец“ и с „borovets“.
const LAT = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sht', ъ: 'a', ь: 'y', ю: 'yu', я: 'ya' };
const translit = (s) => String(s).toLowerCase().replace(/[а-я]/g, (c) => LAT[c] ?? c);

const cache = new Map();
function load(code) {
  if (!code || NO_DATA.has(code)) return Promise.resolve(null);
  if (!cache.has(code)) {
    cache.set(code, fetch(`/assets/data/places/${code}.json`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && {
        ...d,
        // Индекс за търсене: име (и латиница за България) без диакритика.
        keys: d.p.map((p) => fold(d.c === 'BG' ? `${p[1]} ${p[4] || ''} ${translit(p[1])}` : p[1])),
      })
      .catch(() => { cache.delete(code); return null; }));
  }
  return cache.get(code);
}

function search(d, query, mode) {
  const q = fold(query);
  if (!q) return [];
  const hits = [];
  const later = [];
  if (mode === 'postcode' || /^\d/.test(q)) {
    const digits = q.replace(/\s/g, '');
    for (const p of d.p) if (p[0].replace(/[\s-]/g, '').toLowerCase().startsWith(digits.replace(/-/g, ''))) hits.push(p);
    hits.sort((a, b) => a[0].localeCompare(b[0]));
  } else {
    for (let i = 0; i < d.p.length && hits.length < 200; i += 1) {
      const key = d.keys[i];
      if (key.startsWith(q) || key.includes(` ${q}`)) hits.push(d.p[i]);
      else if (later.length < 50 && key.includes(q)) later.push(d.p[i]);
    }
    // Първо точното име, после по-кратките (градовете преди „Пловдивци“).
    hits.sort((a, b) => (fold(b[1]) === q) - (fold(a[1]) === q) || a[1].length - b[1].length || a[1].localeCompare(b[1]));
  }
  return [...hits, ...later].slice(0, 8);
}

let seq = 0;
// Свързва полетата country, city, postcode и region във формата (които има).
export function placeAutocomplete(form) {
  const input = (name) => form.querySelector(`[name="${name}"]`);
  const country = input('country');
  const city = input('city');
  const postcode = input('postcode');
  const region = input('region');
  if (!city && !postcode) return;
  const code = () => (country ? countryCode(country.value) : 'BG');

  if (country) {
    const id = `countries-${++seq}`;
    country.setAttribute('list', id);
    country.setAttribute('autocomplete', 'off');
    country.after(h('datalist', { id }, Object.values(COUNTRIES).sort((a, b) => a.localeCompare(b, 'bg')).map((n) => h('option', { value: n }))));
  }
  if (region) {
    const id = `regions-${++seq}`;
    const list = h('datalist', { id });
    region.setAttribute('list', id);
    region.setAttribute('autocomplete', 'off');
    region.after(list);
    const fill = async () => {
      const d = await load(code());
      list.replaceChildren(...(d ? [...d.r].sort((a, b) => a.localeCompare(b, 'bg')).map((r) => h('option', { value: r })) : []));
    };
    region.addEventListener('focus', fill);
    country?.addEventListener('change', fill);
  }

  const choose = (d, p) => {
    if (city) city.value = p[1];
    // Не се затрива по-точен код, който вече започва с избрания (напр. 1000- → 1000-205 в Португалия).
    if (postcode && !(p[0].endsWith('-') && postcode.value.startsWith(p[0]))) postcode.value = p[0];
    if (region && d.r[p[2]] !== undefined) region.value = d.r[p[2]];
    for (const el of [city, postcode, region]) el?.dispatchEvent(new Event('change', { bubbles: true }));
  };
  for (const [el, mode] of [[city, 'city'], [postcode, 'postcode']]) if (el) combobox(el, mode, code, choose);
}

function combobox(el, mode, code, choose) {
  const id = `place-list-${++seq}`;
  const list = h('ul', { class: 'place-list', id, role: 'listbox', hidden: true });
  el.setAttribute('role', 'combobox');
  el.setAttribute('aria-autocomplete', 'list');
  el.setAttribute('aria-expanded', 'false');
  el.setAttribute('aria-controls', id);
  el.setAttribute('autocomplete', 'off');
  el.parentElement.classList.add('place-field');
  el.after(list);
  let items = [];
  let data = null;
  let active = -1;
  let picking = false;

  const close = () => {
    list.hidden = true;
    el.setAttribute('aria-expanded', 'false');
    el.removeAttribute('aria-activedescendant');
    active = -1;
  };
  const highlight = (i) => {
    active = i;
    [...list.children].forEach((li, n) => li.setAttribute('aria-selected', String(n === i)));
    if (i >= 0) {
      el.setAttribute('aria-activedescendant', list.children[i].id);
      list.children[i].scrollIntoView({ block: 'nearest' });
    }
  };
  const pick = (i) => {
    if (!items[i]) return;
    picking = true;
    choose(data, items[i]);
    picking = false;
    close();
  };
  const update = async () => {
    if (picking) return;
    const value = el.value;
    data = await load(code());
    if (value !== el.value) return;
    items = data ? search(data, value, mode) : [];
    if (!items.length) return close();
    list.replaceChildren(...items.map((p, i) => h('li', {
      id: `${id}-${i}`, role: 'option', 'aria-selected': 'false',
      onmousedown: (e) => { e.preventDefault(); pick(i); },
    },
    h('span', { class: 'place-list__name' }, p[1]),
    h('span', { class: 'place-list__meta' }, [p[0], data.m[p[3]] && (data.c === 'BG' ? `общ. ${data.m[p[3]]}` : data.m[p[3]]), data.r[p[2]] && (data.c === 'BG' ? `обл. ${data.r[p[2]]}` : data.r[p[2]])].filter(Boolean).join(' · ')))),
    h('li', { class: 'place-list__src', role: 'presentation', onmousedown: (e) => e.preventDefault() }, 'Данни: GeoNames, CC BY 4.0'));
    list.hidden = false;
    el.setAttribute('aria-expanded', 'true');
    highlight(-1);
  };
  el.addEventListener('input', update);
  el.addEventListener('blur', close);
  el.addEventListener('keydown', (e) => {
    if (list.hidden) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = items.length;
      highlight(e.key === 'ArrowDown' ? (active + 1) % n : (active - 1 + n) % n);
    } else if (e.key === 'Enter' && active >= 0) {
      e.preventDefault();
      pick(active);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  });
}
