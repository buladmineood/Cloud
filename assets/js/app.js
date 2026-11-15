import {
  addressLine, api, confirmDialog, downloadCsv, emptyState, fatal, field, formatDate, formatTime, formDialog, formValues, h, icon, linkBox,
  money, mountShell, norm, num, pageHead, parseNum, pill, round2, selectField, setOrg, showError, showFieldErrors, timeAgo, toast, today,
} from './core.js?v=3f2e5a7770';
import { buildPdf, saveFile } from './pdf.js?v=3f2e5a7770';
import { DEFAULT_COUNTRY, placeAutocomplete } from './places.js?v=3f2e5a7770';

let shell;
let main;
let meta;
let me;
let data; // данните на избраната организация; null, ако потребителят още няма организация
let orgId = '';
const ORG_KEY = 'bc_org';
const PLATFORM_ADMIN = 'Администратор на БУЛАДМИН';

const PAGE_SIZE = 50;
const OPEN_STAGES = ['Нова', 'Квалифицирана', 'Оферта', 'Преговори'];
const ENTITY_ICONS = { companies: 'building', contacts: 'users', deals: 'handshake', activities: 'check', tenders: 'scale', products: 'box', documents: 'doc', payments: 'wallet' };
// Колоната, по която се филтрира с бутони в списъка на всеки раздел.
const CHIP_COLUMN = { companies: 'relation', deals: 'stage', activities: 'activityStatus', tenders: 'stage', products: 'itemType' };
const PAYMENT_METHODS = ['Банков превод', 'В брой', 'С карта', 'Наложен платеж'];

const role = () => data?.role || '';
const isAdmin = () => role() === 'Администратор';
// Спряна или неплатена фирма е само за преглед: данните се виждат и изтеглят, но не се въвеждат нови.
const canEdit = () => !!data && !data.readOnly && role() !== 'Наблюдател';
const isPlatform = () => me.user.platformRole === PLATFORM_ADMIN;
const limitText = (key) => {
  const limit = data.plan[key];
  return limit === '' ? `${data.usage[key]}` : `${data.usage[key]} от ${limit}`;
};
const atLimit = (key) => data.plan[key] !== '' && data.usage[key] >= data.plan[key];
const cols = (entity) => meta.entities[entity].columns;
const col = (entity, name) => cols(entity).find((c) => c.name === name);

const find = (entity, id) => (id ? data[entity]?.find((r) => r.id === id) : undefined);
const userName = (email) => data.users.find((u) => u.email === email)?.name || email || '';
function titleOf(entity, record) {
  if (!record) return '';
  if (entity === 'documents') return `${record.docType} ${record.number || '(чернова)'}`;
  const display = meta.entities[entity]?.display;
  if (Array.isArray(display)) return display.map((k) => record[k]).filter(Boolean).join(' ');
  return record[display] || record.id;
}
const refLink = (entity, id) => {
  const record = find(entity, id);
  return record ? h('a', { href: `#/${entity}/${id}` }, titleOf(entity, record)) : (id ? h('span', { class: 'muted' }, 'изтрит запис') : '');
};

function readOnlyBanner() {
  if (!data?.readOnly) return null;
  return h('div', { class: 'alert alert--warn', role: 'status' }, h('strong', {}, 'Само за преглед. '), data.readOnlyReason,
    isAdmin() && h('span', {}, ' ', h('a', { href: 'mailto:call@buladmin.eu' }, 'Пишете на БУЛАДМИН')));
}

function page(...children) {
  main.replaceChildren(h('div', { class: 'page page--wide' }, readOnlyBanner(), children));
  main.focus({ preventScroll: true });
}
const loading = () => main.replaceChildren(h('div', { class: 'loading' }, 'Зареждане…'));
// Като replaceChildren, но пропуска празните части (null/false), вместо да ги изпише като текст.
const fill = (el, ...children) => el.replaceChildren(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
// Отваря адреса; ако вече сме на него, само опреснява изгледа.
const go = (hash) => {
  if (location.hash === hash) route();
  else location.hash = hash;
};

async function refresh() {
  data = orgId ? await api('/data') : null;
  syncBadges();
}

const isOverdue = (a) => a.activityStatus === 'Предстои' && a.dueDate && a.dueDate < today();
const myOpenTasks = () => data.activities.filter((a) => a.assignedTo === me.user.email && a.activityStatus === 'Предстои');
function syncBadges() {
  shell?.setBadges(data ? { activities: myOpenTasks().filter((a) => a.dueDate && a.dueDate <= today()).length } : {});
}

// Изпълнява действие към сървъра, презарежда данните и показва грешката, ако има.
async function act(work, success) {
  try {
    const result = await work();
    await refresh();
    if (success) toast(success);
    return result;
  } catch (err) {
    toast(err.message, 'error');
    return null;
  }
}

// --- Показване на стойности ---

function cellValue(entity, column, record) {
  const value = record[column.name];
  if (value === '' || value === null || value === undefined) return '';
  if (column.input === 'ref') return refLink(column.ref, value);
  if (column.input === 'user') return userName(value);
  if (column.input === 'money') return money(value);
  if (column.kind === 'number') return num(value);
  if (column.kind === 'day') return formatDate(value);
  if (column.kind === 'date') return formatTime(value);
  if (column.kind === 'choice' && ['stage', 'activityStatus', 'relation'].includes(column.name)) return pill(value, column.name);
  if (column.name === 'vatRate') return `${value}%`;
  if (column.input === 'email') return h('a', { href: `mailto:${value}` }, value);
  if (column.input === 'tel') return h('a', { href: `tel:${value.replace(/[^\d+]/g, '')}` }, value);
  if (column.input === 'url') return h('a', { href: value, target: '_blank', rel: 'noopener noreferrer' }, value);
  return String(value);
}

const plainValue = (column, record) => {
  const value = record[column.name];
  if (column.input === 'ref') return titleOf(column.ref, find(column.ref, value));
  if (column.input === 'user') return userName(value);
  if (column.kind === 'number') return value === '' ? '' : String(value).replace('.', ',');
  if (column.kind === 'day') return formatDate(value);
  return value ?? '';
};

// --- Общ формуляр за запис според схемата ---

// Раздел, който планът включва (обществените поръчки са само в някои планове).
const sectionAllowed = (entity) => !meta.entities[entity]?.feature || data?.plan?.[meta.entities[entity].feature] === 'Да';
// Връзка към раздел, който планът не включва, не се показва във формулярите.
const refAllowed = (column) => !column.ref || sectionAllowed(column.ref);

// Дата и час от сървъра (UTC) към полето datetime-local по местното време на браузъра.
function toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function inputFor(entity, column, value) {
  const id = `f-${column.name}`;
  const wrapClass = column.wide || column.kind === 'multiline' ? 'full' : '';
  const label = h('label', { for: id }, column.label, !column.required && column.kind !== 'choice' && h('span', { class: 'field__hint' }, ' (по желание)'));
  let input;
  if (column.kind === 'choice') {
    input = h('select', { id, name: column.name }, column.choices.map((c) => h('option', { value: c, selected: c === (value || column.default) }, column.name === 'vatRate' ? `${c}%` : c)));
  } else if (column.input === 'ref') {
    const options = [...data[column.ref]].sort((a, b) => titleOf(column.ref, a).localeCompare(titleOf(column.ref, b), 'bg'));
    input = h('select', { id, name: column.name },
      h('option', { value: '' }, column.required ? 'Изберете…' : '—'),
      options.map((r) => h('option', { value: r.id, selected: r.id === value }, titleOf(column.ref, r))));
  } else if (column.input === 'user') {
    input = h('select', { id, name: column.name },
      h('option', { value: '' }, '—'),
      data.users.filter((u) => u.isActive === 'Да' || u.email === value).map((u) => h('option', { value: u.email, selected: u.email === value }, u.name)));
  } else if (column.kind === 'multiline') {
    input = h('textarea', { id, name: column.name, maxlength: 8000, rows: 4 });
    input.value = value || '';
  } else {
    const type = { email: 'email', tel: 'tel', url: 'url', datetime: 'datetime-local' }[column.input] || (column.kind === 'day' ? 'date' : 'text');
    const display = column.kind === 'number' && value !== '' && value !== undefined ? String(value).replace('.', ',') : column.input === 'datetime' ? toLocalInput(value) : value;
    input = h('input', {
      id, name: column.name, type, value: display ?? '', maxlength: 255,
      inputmode: column.kind === 'number' ? 'decimal' : column.input === 'eik' ? 'numeric' : undefined,
      placeholder: column.input === 'url' ? 'https://' : undefined,
    });
  }
  return h('div', { class: `field ${wrapClass}` }, label, input);
}

async function editRecord(entity, record = null, presets = {}) {
  const def = meta.entities[entity];
  const values = { ...presets, ...(record || {}) };
  if (!record && ['companies', 'deals'].includes(entity)) values.owner ??= me.user.email;
  if (!record && entity === 'companies') values.country ??= DEFAULT_COUNTRY;
  if (!record && entity === 'activities') {
    values.assignedTo ??= me.user.email;
    values.dueDate ??= today();
  }
  const fields = h('div', { class: 'form__grid' }, def.columns.filter((c) => !c.system && refAllowed(c)).map((c) => inputFor(entity, c, values[c.name])));
  placeAutocomplete(fields);
  const saved = await formDialog({
    title: record ? `${def.single}: промяна` : `Нов запис: ${def.single.toLowerCase()}`,
    fields,
    wide: true,
    submitLabel: record ? 'Запазете' : 'Създайте',
    onSubmit: (body) => (record
      ? api(`/data/${entity}/${record.id}`, { method: 'PATCH', body })
      : api(`/data/${entity}`, { method: 'POST', body })),
  });
  if (!saved) return null;
  await refresh();
  toast(record ? 'Промените са запазени.' : 'Записът е създаден.');
  return saved;
}

async function deleteRecord(entity, record) {
  const ok = await confirmDialog({
    title: 'Изтриване', text: `„${titleOf(entity, record)}“ ще бъде изтрит окончателно.`, confirmLabel: 'Изтрийте', danger: true,
  });
  if (!ok) return false;
  return !!(await act(() => api(`/data/${entity}/${record.id}`, { method: 'DELETE' }), 'Записът е изтрит.'));
}

// --- Табло ---

function kpi(iconName, label, value, href, tone = '') {
  return h('a', { class: `kpi ${tone}`, href },
    h('span', { class: 'kpi__icon' }, icon(iconName, 20)),
    h('span', { class: 'kpi__value' }, String(value)),
    h('span', { class: 'kpi__label' }, label));
}

const panel = (title, href, rows, emptyText) => h('section', { class: 'card card--list' },
  h('div', { class: 'card__head' }, h('h2', {}, title), href && h('a', { class: 'small', href }, 'Всички')),
  rows.length ? h('div', { class: 'compact-list' }, rows) : h('p', { class: 'muted small card__empty' }, emptyText));

const compactRow = (href, title, sub, right) => h('a', { class: 'compact-row', href },
  h('span', { class: 'compact-row__main' }, h('strong', {}, title), sub && h('span', { class: 'small muted' }, sub)),
  right);

function taskRow(a) {
  const overdue = isOverdue(a);
  return compactRow(`#/activities/${a.id}`, a.subject,
    [a.activityType, titleOf('companies', find('companies', a.companyId))].filter(Boolean).join(' · '),
    h('span', { class: `deadline ${overdue ? 'deadline--over' : a.dueDate === today() ? 'deadline--soon' : ''}` }, a.dueDate ? formatDate(a.dueDate) : 'без срок'));
}

const unpaid = () => data.documents.filter((d) => d.docType === 'Фактура' && d.docStatus === 'Издаден' && d.paymentStatus !== 'Платен');
const outstanding = (d) => round2(d.total - d.paidAmount);
// Равностойност в евро: сумите в документи в чужда валута се превръщат по курса на документа.
const outstandingEur = (d) => round2((d.totalEur ?? d.total) - (d.paidAmountEur ?? d.paidAmount));

function viewDashboard() {
  const month = today().slice(0, 7);
  const openDeals = data.deals.filter((d) => OPEN_STAGES.includes(d.stage));
  const tasks = myOpenTasks().sort((a, b) => String(a.dueDate || '9').localeCompare(String(b.dueDate || '9')));
  const dueNow = tasks.filter((a) => a.dueDate && a.dueDate <= today());
  const overdueTasks = tasks.filter(isOverdue);
  const unpaidDocs = unpaid().sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  const overdueDocs = unpaidDocs.filter((d) => d.dueDate < today());
  const invoiced = data.documents
    .filter((d) => TAX.includes(d.docType) && d.docStatus === 'Издаден' && d.issueDate.startsWith(month))
    .reduce((sum, d) => sum + (d.subtotalEur ?? d.subtotal), 0);
  const won = data.deals.filter((d) => d.stage === 'Спечелена' && String(d.closedAt).startsWith(month));

  const limited = Object.keys(meta.limits).filter((k) => data.plan[k] !== '');
  const near = limited.filter((k) => data.usage[k] >= Number(data.plan[k]) * 0.8);
  page(
    pageHead(`Здравейте, ${me.user.name}`, `${data.org.name} · план „${data.plan.name}“`),
    data.viaPlatform && h('div', { class: 'alert alert--warn', role: 'status' }, 'Работите в тази организация като администратор на БУЛАДМИН. Всяко действие се записва в историята.'),
    near.length > 0 && h('a', { class: 'alert alert--warn banner banner--link', href: '#/settings' }, icon('alert'),
      h('div', { class: 'banner__text' },
        h('strong', {}, `Наближавате ограничението на плана „${data.plan.name}“`),
        h('p', {}, near.map((k) => `${meta.limits[k].label}: ${limitText(k)}`).join(' · ')))),
    overdueDocs.length > 0 && h('a', { class: 'alert alert--error banner banner--link', href: '#/documents?type=Фактура&pay=unpaid' }, icon('alert'),
      h('div', { class: 'banner__text' },
        h('strong', {}, `Просрочени фактури: ${overdueDocs.length} за ${money(overdueDocs.reduce((s, d) => s + outstandingEur(d), 0))}`),
        h('p', {}, 'Падежът им е минал, а не са платени изцяло.'))),
    h('div', { class: 'kpis' },
      kpi('check', 'Мои задачи за днес и просрочени', dueNow.length, '#/activities', overdueTasks.length ? 'kpi--danger' : dueNow.length ? 'kpi--warn' : ''),
      kpi('handshake', `Отворени сделки · ${money(openDeals.reduce((s, d) => s + (Number(d.amount) || 0), 0))}`, openDeals.length, '#/deals', 'kpi--accent'),
      kpi('chart', `Спечелени този месец · ${money(won.reduce((s, d) => s + (Number(d.amount) || 0), 0))}`, won.length, '#/deals'),
      kpi('doc', 'Фактурирано този месец без ДДС', money(invoiced), '#/documents?type=Фактура'),
      kpi('wallet', 'Неплатени фактури', money(unpaidDocs.reduce((s, d) => s + outstandingEur(d), 0)), '#/documents?type=Фактура&pay=unpaid', overdueDocs.length ? 'kpi--warn' : '')),
    h('div', { class: 'grid-2' },
      panel('Моите задачи', '#/activities', tasks.slice(0, 8).map(taskRow), 'Нямате предстоящи задачи.'),
      sectionAllowed('tenders') && panel('Срокове по обществени поръчки', '#/tenders', data.tenders
        .filter((t) => TENDER_OPEN.includes(t.stage) && t.submissionDeadline && Date.parse(t.submissionDeadline) > Date.now())
        .sort((a, b) => a.submissionDeadline.localeCompare(b.submissionDeadline)).slice(0, 6)
        .map((t) => compactRow(`#/tenders/${t.id}`, t.tenderName, `${t.authority} · ${t.stage}`, h('span', { class: `deadline ${Date.parse(t.submissionDeadline) - Date.now() < 3 * 864e5 ? 'deadline--soon' : ''}` }, formatTime(t.submissionDeadline)))),
      'Няма предстоящи срокове за подаване.'),
      panel('Неплатени фактури', '#/documents?type=Фактура&pay=unpaid', unpaidDocs.slice(0, 8).map((d) => compactRow(`#/documents/${d.id}`,
        `№ ${d.number} · ${d.companyName}`, `Падеж ${formatDate(d.dueDate)}`,
        h('span', { class: d.dueDate < today() ? 'text-error' : '' }, money(outstanding(d), d.currency)))), 'Няма неплатени фактури.')),
    h('div', { class: 'grid-2' },
      panel('Сделки в процес', '#/deals', [...openDeals].sort((a, b) => (Number(b.amount) || 0) - (Number(a.amount) || 0)).slice(0, 8)
        .map((d) => compactRow(`#/deals/${d.id}`, d.dealName, `${titleOf('companies', find('companies', d.companyId))} · ${d.stage}`, h('span', {}, money(d.amount)))),
      'Няма отворени сделки.'),
      panel('Нови контрагенти', '#/companies', [...data.companies].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 8)
        .map((c) => compactRow(`#/companies/${c.id}`, c.name, [c.relation, c.city].filter(Boolean).join(' · '), h('span', { class: 'small muted' }, timeAgo(c.createdAt)))),
      'Още няма контрагенти.')),
  );
}

// --- Общ списък ---

const listState = {};
function stateFor(entity, query) {
  listState[entity] ??= { q: '', chip: '', page: 1, sort: '', dir: 1 };
  const s = listState[entity];
  if (query.has('chip')) s.chip = query.get('chip');
  return s;
}

function dataTable(entity, rows, columns, { state, rerender, href = (r) => `#/${entity}/${r.id}`, extra } = {}) {
  if (!rows.length) return null;
  const sortBy = (name) => {
    if (state.sort === name) state.dir *= -1;
    else { state.sort = name; state.dir = 1; }
    rerender();
  };
  const head = h('tr', {}, columns.map((c) => h('th', { scope: 'col', 'aria-sort': state?.sort === c.name ? (state.dir > 0 ? 'ascending' : 'descending') : null },
    state ? h('button', { class: 'th-btn', type: 'button', onclick: () => sortBy(c.name) }, c.label, state.sort === c.name ? (state.dir > 0 ? ' ↑' : ' ↓') : '') : c.label)),
  extra && h('th', {}));
  const body = rows.map((r) => {
    const tr = h('tr', { 'data-href': href(r) },
      columns.map((c, i) => h('td', { 'data-label': c.label, class: c.kind === 'number' ? 'num' : c.kind === 'day' || c.kind === 'date' ? 'nowrap' : null },
        i === 0
          ? h('a', { href: href(r) }, ([meta.entities[entity]?.display].flat().includes(c.name) ? titleOf(entity, r) : plainValue(c, r)) || titleOf(entity, r))
          : cellValue(entity, c, r))),
      extra && h('td', { class: 'td-actions' }, extra(r)));
    tr.addEventListener('click', (event) => {
      if (!event.target.closest('a, button, select')) location.hash = href(r);
    });
    return tr;
  });
  return h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, head), h('tbody', {}, body)));
}

function sortRows(entity, rows, state) {
  if (!state.sort) return rows;
  const column = col(entity, state.sort);
  return [...rows].sort((a, b) => {
    const x = a[state.sort];
    const y = b[state.sort];
    if (column?.kind === 'number') return ((Number(x) || 0) - (Number(y) || 0)) * state.dir;
    return String(plainValue(column, a)).localeCompare(String(plainValue(column, b)), 'bg') * state.dir;
  });
}

function searchBox(state, rerender, placeholder = 'Търсене') {
  const input = h('input', { type: 'search', value: state.q, placeholder, 'aria-label': placeholder });
  input.addEventListener('input', () => {
    state.q = input.value;
    state.page = 1;
    rerender(true);
  });
  return { el: h('label', { class: 'search' }, icon('search', 18), input), input };
}

function chips(options, current, onPick, counts = {}) {
  return h('div', { class: 'chips', role: 'group', 'aria-label': 'Филтър' }, options.map(([value, label]) => h('button', {
    class: 'chip', type: 'button', 'aria-pressed': String(current === value), onclick: () => onPick(value),
  }, label, counts[value] !== undefined && h('span', { class: 'chip__count' }, String(counts[value])))));
}

function pager(state, total, rerender) {
  const pages = Math.ceil(total / PAGE_SIZE);
  if (pages <= 1) return null;
  return h('div', { class: 'pager' },
    h('span', { class: 'small muted' }, `Страница ${state.page} от ${pages} · ${total} записа`),
    h('div', { class: 'row-tight' },
      h('button', { class: 'btn btn--ghost btn--small', type: 'button', disabled: state.page <= 1, onclick: () => { state.page -= 1; rerender(); } }, 'Назад'),
      h('button', { class: 'btn btn--ghost btn--small', type: 'button', disabled: state.page >= pages, onclick: () => { state.page += 1; rerender(); } }, 'Напред')));
}

function viewList(entity, query) {
  const def = meta.entities[entity];
  const state = stateFor(entity, query);
  const listColumns = def.columns.filter((c) => c.list);
  const chipColumn = CHIP_COLUMN[entity] && col(entity, CHIP_COLUMN[entity]);
  const results = h('div', { class: 'stack' });
  const filtered = () => data[entity].filter((r) => {
    if (state.chip && chipColumn && r[chipColumn.name] !== state.chip) return false;
    if (!state.q) return true;
    return norm(def.columns.map((c) => plainValue(c, r)).join(' ')).includes(norm(state.q));
  });

  const render = () => {
    const rows = sortRows(entity, filtered(), state);
    const shown = rows.slice((state.page - 1) * PAGE_SIZE, state.page * PAGE_SIZE);
    fill(results,
      dataTable(entity, shown, listColumns, { state, rerender: render })
        || emptyState(ENTITY_ICONS[entity], data[entity].length ? 'Няма съвпадения' : 'Още няма записи',
          data[entity].length ? 'Променете търсенето или филтъра.' : null),
      pager(state, rows.length, render));
  };

  const search = searchBox(state, render, `Търсене в „${def.label}“`);
  const counts = chipColumn ? Object.fromEntries(chipColumn.choices.map((c) => [c, data[entity].filter((r) => r[chipColumn.name] === c).length])) : {};
  page(
    pageHead(def.label, `${data[entity].length} записа`,
      h('button', {
        class: 'btn btn--ghost', type: 'button',
        onclick: () => downloadCsv(`${entity}-${today()}.csv`, def.columns.map((c) => c.label), filtered().map((r) => def.columns.map((c) => plainValue(c, r)))),
      }, icon('download', 18), 'CSV'),
      entity === 'tenders' && h('a', { class: 'btn btn--ghost', href: '#/tenders/eop' }, icon('search', 18), 'Обявления в ЦАИС ЕОП'),
      canEdit() && h('button', { class: 'btn', type: 'button', onclick: async () => { const r = await editRecord(entity); if (r) location.hash = `#/${entity}/${r.id}`; } }, icon('plus', 18), 'Нов запис')),
    h('div', { class: 'toolbar' },
      search.el,
      chipColumn && chips([['', 'Всички'], ...chipColumn.choices.map((c) => [c, c])], state.chip, (v) => { state.chip = v; state.page = 1; route(); }, counts)),
    results);
  render();
}

// --- Детайли на запис ---

function detailsList(entity, record, skip = []) {
  const rows = cols(entity).filter((c) => !skip.includes(c.name) && record[c.name] !== '' && record[c.name] !== undefined && c.kind !== 'multiline')
    .flatMap((c) => [h('dt', {}, c.label), h('dd', {}, cellValue(entity, c, record))]);
  return h('dl', { class: 'details' }, rows);
}

async function historyCard(entity, id) {
  const box = h('section', { class: 'card stack-tight' }, h('h2', { class: 'card__title' }, 'История'), h('p', { class: 'small muted' }, 'Зареждане…'));
  api(`/history/${entity}/${encodeURIComponent(id)}`).then((events) => {
    box.replaceChildren(h('h2', { class: 'card__title' }, 'История'),
      events.length ? h('ol', { class: 'timeline' }, events.map((e) => h('li', {},
        h('div', { class: 'timeline__head' }, h('strong', {}, e.action), h('span', {}, `${e.actorName} · ${formatTime(e.occurredAt)}`)),
        e.summary && h('p', { class: 'timeline__msg small' }, e.summary)))) : h('p', { class: 'small muted' }, 'Няма записи.'));
  }).catch(() => box.replaceChildren(h('p', { class: 'small muted' }, 'Историята не може да се зареди.')));
  return box;
}

function relatedCard(title, entity, rows, columns, action) {
  return h('section', { class: 'card card--list' },
    h('div', { class: 'card__head' }, h('h2', {}, `${title} (${rows.length})`), action),
    rows.length ? dataTable(entity, rows, columns.map((n) => col(entity, n)).filter(Boolean)) : h('p', { class: 'muted small card__empty' }, 'Няма записи.'));
}

const addButton = (label, onclick) => canEdit() && h('button', { class: 'btn btn--ghost btn--small', type: 'button', onclick }, icon('plus', 16), label);

const docColumns = [
  { name: 'number', label: 'Номер' }, { name: 'docType', label: 'Вид' }, { name: 'issueDate', label: 'Дата', kind: 'day' },
  { name: 'total', label: 'Сума', kind: 'number', input: 'money' }, { name: 'docStatus', label: 'Статус' }, { name: 'paymentStatus', label: 'Плащане' },
];
function documentsTable(rows, state, rerender) {
  if (!rows.length) return null;
  const columns = [...docColumns.slice(0, 3), { name: 'companyName', label: 'Контрагент' }, ...docColumns.slice(3)];
  const label = (d) => d.number || 'Чернова';
  return h('div', { class: 'table-wrap' }, h('table', {},
    h('thead', {}, h('tr', {}, columns.map((c) => h('th', { scope: 'col' },
      state ? h('button', { class: 'th-btn', type: 'button', onclick: () => { state.dir = state.sort === c.name ? -state.dir : 1; state.sort = c.name; rerender(); } }, c.label) : c.label)))),
    h('tbody', {}, rows.map((d) => {
      const href = `#/documents/${d.id}`;
      const tr = h('tr', { 'data-href': href },
        h('td', { 'data-label': 'Номер' }, h('a', { href }, label(d))),
        h('td', { 'data-label': 'Вид' }, d.docType),
        h('td', { 'data-label': 'Дата' }, formatDate(d.issueDate)),
        h('td', { 'data-label': 'Контрагент' }, d.companyName || titleOf('companies', find('companies', d.companyId))),
        h('td', { 'data-label': 'Сума', class: 'num' }, money(d.total, d.currency)),
        h('td', { 'data-label': 'Статус' }, pill(d.docStatus, 'doc')),
        h('td', { 'data-label': 'Плащане' }, d.docType === 'Фактура' || d.docType === 'Проформа фактура' ? (d.docStatus === 'Издаден' ? pill(d.paymentStatus, 'pay') : '') : ''));
      tr.addEventListener('click', (event) => { if (!event.target.closest('a, button')) location.hash = href; });
      return tr;
    }))));
}

function recordActions(entity, record) {
  return [
    canEdit() && h('button', { class: 'btn btn--ghost', type: 'button', onclick: async () => { if (await editRecord(entity, record)) route(); } }, icon('edit', 18), 'Редакция'),
    isAdmin() && h('button', { class: 'icon-btn', type: 'button', title: 'Изтриване', 'aria-label': 'Изтриване', onclick: async () => { if (await deleteRecord(entity, record)) location.hash = `#/${entity}`; } }, icon('trash', 18)),
  ];
}

async function viewRecord(entity, id) {
  const record = find(entity, id);
  if (!record) {
    page(h('a', { class: 'back', href: `#/${entity}` }, icon('back', 16), meta.entities[entity].label), emptyState('alert', 'Записът не е намерен', 'Може да е изтрит.'));
    return;
  }
  const def = meta.entities[entity];
  const notes = cols(entity).filter((c) => c.kind === 'multiline' && record[c.name]);
  const content = [
    h('section', { class: 'card stack' },
      detailsList(entity, record, [def.display].flat()),
      notes.map((c) => h('div', {}, h('h3', { class: 'small muted' }, c.label), h('p', { class: 'pre' }, record[c.name])))),
  ];
  const side = [];

  if (entity === 'companies') {
    const presets = { companyId: id };
    content.push(
      relatedCard('Лица за контакт', 'contacts', data.contacts.filter((c) => c.companyId === id), ['firstName', 'position', 'phone', 'email'],
        addButton('Ново лице', async () => { if (await editRecord('contacts', null, presets)) route(); })),
      relatedCard('Сделки', 'deals', data.deals.filter((d) => d.companyId === id), ['dealName', 'stage', 'amount', 'expectedClose'],
        addButton('Нова сделка', async () => { if (await editRecord('deals', null, presets)) route(); })),
      relatedCard('Задачи', 'activities', data.activities.filter((a) => a.companyId === id), ['subject', 'dueDate', 'activityStatus', 'assignedTo'],
        addButton('Нова задача', async () => { if (await editRecord('activities', null, presets)) route(); })),
      h('section', { class: 'card card--list' },
        h('div', { class: 'card__head' }, h('h2', {}, 'Документи'),
          canEdit() && h('div', { class: 'row-tight' },
            h('a', { class: 'btn btn--ghost btn--small', href: `#/documents/new?type=Оферта&company=${id}` }, icon('plus', 16), 'Оферта'),
            h('a', { class: 'btn btn--ghost btn--small', href: `#/documents/new?type=Фактура&company=${id}` }, icon('plus', 16), 'Фактура'))),
        documentsTable(data.documents.filter((d) => d.companyId === id).sort((a, b) => b.issueDate.localeCompare(a.issueDate)))
          || h('p', { class: 'muted small card__empty' }, 'Няма документи.')));
    const docs = data.documents.filter((d) => d.companyId === id && d.docStatus === 'Издаден');
    const due = docs.filter((d) => d.docType === 'Фактура' && d.paymentStatus !== 'Платен').reduce((s, d) => s + outstandingEur(d), 0);
    const turnover = docs.filter((d) => TAX.includes(d.docType)).reduce((s, d) => s + (d.subtotalEur ?? d.subtotal), 0);
    side.push(h('section', { class: 'card' }, h('dl', { class: 'details details--stacked' },
      h('dt', {}, 'Оборот без ДДС'), h('dd', { class: 'big-num' }, money(turnover)),
      h('dt', {}, 'Дължимо'), h('dd', { class: `big-num ${due > 0 ? 'text-error' : ''}` }, money(due)))));
  }

  if (entity === 'deals') {
    if (canEdit()) {
      content.unshift(h('section', { class: 'card' },
        h('h2', { class: 'card__title' }, 'Етап'),
        h('div', { class: 'stage-bar', role: 'group', 'aria-label': 'Етап на сделката' }, col('deals', 'stage').choices.map((stage) => h('button', {
          type: 'button', class: 'stage-bar__step', 'aria-pressed': String(record.stage === stage), 'data-stage': stage,
          onclick: () => record.stage !== stage && act(() => api(`/data/deals/${id}`, { method: 'PATCH', body: { stage } }), `Етап: ${stage}`).then(route),
        }, stage)))));
    }
    content.push(
      relatedCard('Задачи', 'activities', data.activities.filter((a) => a.dealId === id), ['subject', 'dueDate', 'activityStatus', 'assignedTo'],
        addButton('Нова задача', async () => { if (await editRecord('activities', null, { dealId: id, companyId: record.companyId })) route(); })),
      h('section', { class: 'card card--list' },
        h('div', { class: 'card__head' }, h('h2', {}, 'Оферти и фактури'),
          canEdit() && h('a', { class: 'btn btn--ghost btn--small', href: `#/documents/new?type=Оферта&company=${record.companyId}&deal=${id}` }, icon('plus', 16), 'Оферта')),
        documentsTable(data.documents.filter((d) => d.dealId === id)) || h('p', { class: 'muted small card__empty' }, 'Няма документи.')));
  }

  if (entity === 'tenders') tenderSections(record, content, side);

  if (entity === 'activities' && canEdit() && record.activityStatus === 'Предстои') {
    side.push(h('section', { class: 'card stack-tight' },
      h('button', { class: 'btn btn--wide', type: 'button', onclick: () => act(() => api(`/data/activities/${id}`, { method: 'PATCH', body: { activityStatus: 'Изпълнена' } }), 'Задачата е изпълнена.').then(route) }, icon('check', 18), 'Изпълнена')));
  }

  if (entity === 'products') {
    const used = data.documents.filter((d) => d.lines.some((l) => l.productId === id));
    content.push(h('section', { class: 'card card--list' }, h('div', { class: 'card__head' }, h('h2', {}, `Документи с този артикул (${used.length})`)),
      documentsTable(used) || h('p', { class: 'muted small card__empty' }, 'Не е използван.')));
  }

  side.push(await historyCard(entity, id));
  page(
    h('a', { class: 'back', href: `#/${entity}` }, icon('back', 16), def.label),
    pageHead(titleOf(entity, record), def.single, ...recordActions(entity, record)),
    h('div', { class: 'split' }, h('div', { class: 'stack' }, content), h('div', { class: 'stack' }, side)));
}

// Раздел, който планът не включва: какво дава и как се получава.
function viewUpsell(entity) {
  const feature = meta.entities[entity].feature;
  page(pageHead(meta.entities[entity].label, `Не е включено в плана „${data.plan.name}“.`),
    h('section', { class: 'card stack narrow' },
      h('h2', {}, 'Модул „ЦАИС ЕОП — Стопански субект“'),
      h('p', {}, 'За фирми, които участват в обществени поръчки по ЗОП чрез Централизираната автоматизирана информационна система „Електронни обществени поръчки“ (ЦАИС ЕОП):'),
      h('ul', { class: 'bullets' },
        h('li', {}, 'регистър на поръчките: номер в ЦАИС ЕОП, възложител, вид процедура, CPV, обособени позиции, прогнозна стойност;'),
        h('li', {}, 'срокове за въпроси, подаване и отваряне с напомняне по имейл 3 дни преди тях;'),
        h('li', {}, 'списък с документите за участие (ЕЕДОП, техническо и ценово предложение и др.) и за сключване на договор;'),
        h('li', {}, 'гаранции за участие и изпълнение, етапи до договор, връзка със сделки, оферти и задачи.')),
      h('p', { class: 'small muted' }, `Модулът е в плана „ЦАИС ЕОП“ и в „Професионален“. ${FEATURE_HELP}`),
      h('div', {}, h('a', { class: 'btn', href: 'mailto:call@buladmin.eu?subject=План ЦАИС ЕОП' }, 'Поискайте план „ЦАИС ЕОП“'))));
  return feature;
}
const FEATURE_HELP = 'Плановете се сменят от администраторите на БУЛАДМИН.';

// --- ЦАИС ЕОП: участие в обществени поръчки ---

// Курсът се показва с 4 до 6 знака, както го публикува ЕЦБ.
const rateText = (rate) => new Intl.NumberFormat('bg-BG', { minimumFractionDigits: 4, maximumFractionDigits: 6 }).format(rate);

const TENDER_OPEN = ['Проучване', 'Подготовка', 'Подадена', 'Оценка', 'Класирана първа'];

// Колко остава до срока, по-четимо от точния час.
function countdown(iso) {
  const ms = Date.parse(iso) - Date.now();
  if (Number.isNaN(ms)) return '';
  if (ms < 0) return 'изтекъл';
  const hours = Math.floor(ms / 3600000);
  if (hours < 48) return `остават ${hours} ч`;
  return `остават ${Math.floor(hours / 24)} дни`;
}

function deadlineRow(label, iso) {
  if (!iso) return null;
  const ms = Date.parse(iso) - Date.now();
  const tone = ms < 0 ? 'deadline--over' : ms < 3 * 864e5 ? 'deadline--soon' : '';
  return [h('dt', {}, label), h('dd', {}, h('strong', {}, formatTime(iso)), ' ', h('span', { class: `deadline ${tone}` }, countdown(iso)))];
}

function tenderSections(record, content, side) {
  const id = record.id;
  if (canEdit()) {
    content.unshift(h('section', { class: 'card' },
      h('h2', { class: 'card__title' }, 'Етап'),
      h('div', { class: 'stage-bar stage-bar--wrap', role: 'group', 'aria-label': 'Етап на поръчката' }, col('tenders', 'stage').choices.map((stage) => h('button', {
        type: 'button', class: 'stage-bar__step', 'aria-pressed': String(record.stage === stage), 'data-stage': stage,
        onclick: () => record.stage !== stage && act(() => api(`/data/tenders/${id}`, { method: 'PATCH', body: { stage } }), `Етап: ${stage}`).then(route),
      }, stage)))));
  }

  // Списък с документи: състояние на всеки и бележка; точките са редактируеми за конкретната поръчка.
  let items = (record.checklist || []).map((i) => ({ ...i }));
  const list = h('div', { class: 'checklist' });
  const progress = h('span', { class: 'small muted' });
  const save = h('button', { class: 'btn btn--small', type: 'button', hidden: true }, 'Запазете промените');
  const dirty = () => { save.hidden = false; };
  const render = () => {
    const needed = items.filter((i) => i.state !== 'Неприложим');
    progress.textContent = `готови ${needed.filter((i) => i.state === 'Готов').length} от ${needed.length}`;
    const groups = [...new Set(items.map((i) => i.group))];
    fill(list, groups.map((group) => h('div', { class: 'checklist__group' },
      h('h3', {}, group),
      items.filter((i) => i.group === group).map((item) => h('div', { class: `checklist__item checklist__item--${item.state === 'Готов' ? 'done' : item.state === 'Неприложим' ? 'na' : 'todo'}` },
        h('select', {
          'aria-label': `Състояние: ${item.label}`, disabled: !canEdit(),
          onchange: (e) => { item.state = e.target.value; dirty(); render(); },
        }, meta.checklistStates.map((s) => h('option', { value: s, selected: s === item.state }, s))),
        h('div', { class: 'checklist__text' },
          h('span', {}, item.label),
          canEdit()
            ? h('input', { class: 'checklist__note', value: item.note || '', placeholder: 'бележка (по желание)', maxlength: 300, 'aria-label': `Бележка: ${item.label}`, oninput: (e) => { item.note = e.target.value; dirty(); } })
            : item.note && h('span', { class: 'small muted' }, item.note)),
        canEdit() && h('button', {
          class: 'icon-btn', type: 'button', title: 'Махнете от списъка', 'aria-label': `Махнете „${item.label}“`,
          onclick: () => { items = items.filter((x) => x !== item); dirty(); render(); },
        }, icon('trash', 16)))))));
  };
  render();
  save.addEventListener('click', async () => {
    const saved = await act(() => api(`/tenders/${id}/checklist`, { method: 'PUT', body: { items } }), 'Документите са запазени.');
    if (saved) route();
  });
  const addItem = async () => {
    const result = await formDialog({
      title: 'Нов документ в списъка',
      fields: [field({ name: 'label', label: 'Документ', required: true, maxlength: 300 }),
        selectField({ name: 'group', label: 'Кога', options: ['Оферта', 'Преди договор'], value: 'Оферта' })],
      submitLabel: 'Добавете',
    });
    if (result?.label) {
      items.push({ id: `u${Date.now()}`, label: result.label, group: result.group, state: 'Предстои', note: '' });
      dirty();
      render();
    }
  };
  content.push(h('section', { class: 'card stack' },
    h('div', { class: 'row row--between' }, h('h2', {}, 'Документи за участие'), progress),
    h('p', { class: 'small muted' }, 'Типичните документи по ЗОП. Конкретните изисквания са в документацията на поръчката — отбележете ненужните като „Неприложим“ и добавете липсващите.'),
    list,
    canEdit() && h('div', { class: 'row' }, h('button', { class: 'btn btn--ghost btn--small', type: 'button', onclick: addItem }, icon('plus', 16), 'Добавете документ'), save)));

  content.push(
    relatedCard('Задачи', 'activities', data.activities.filter((a) => a.tenderId === id), ['subject', 'dueDate', 'activityStatus', 'assignedTo'],
      addButton('Нова задача', async () => {
        if (await editRecord('activities', null, { companyId: record.companyId, dealId: record.dealId, tenderId: id })) route();
      })));

  side.unshift(
    h('section', { class: 'card stack-tight' },
      h('h2', { class: 'card__title' }, 'Срокове'),
      h('dl', { class: 'details details--stacked' },
        deadlineRow('Въпроси до', record.questionsDeadline),
        deadlineRow('Подаване на офертата до', record.submissionDeadline),
        deadlineRow('Отваряне на офертите', record.openingDate),
        record.validUntil && [h('dt', {}, 'Офертата е валидна до'), h('dd', {}, formatDate(record.validUntil))]),
      !record.questionsDeadline && !record.submissionDeadline && h('p', { class: 'small muted' }, 'Въведете сроковете от обявлението в ЦАИС ЕОП, за да получавате напомняния.')),
    h('section', { class: 'card stack-tight' },
      h('h2', { class: 'card__title' }, 'ЦАИС ЕОП'),
      record.eopUrl
        ? h('a', { class: 'btn btn--wide', href: record.eopUrl, target: '_blank', rel: 'noopener noreferrer' }, icon('link', 18), 'Отворете поръчката')
        : h('a', { class: 'btn btn--ghost btn--wide', href: 'https://app.eop.bg/', target: '_blank', rel: 'noopener noreferrer' }, icon('link', 18), 'app.eop.bg'),
      h('p', { class: 'small muted' }, 'Офертата се подава само в ЦАИС ЕОП, подписана с КЕП на лицата, които представляват фирмата. Тук водите сроковете, документите и решенията.')));
}

// --- Сделки: табло по етапи ---

let dealsMode = 'board';
function viewDeals(query) {
  if (dealsMode === 'list') {
    viewList('deals', query);
    main.querySelector('.page-head .row')?.prepend(modeSwitch());
    return;
  }
  const stages = col('deals', 'stage').choices;
  const board = h('div', { class: 'board' }, stages.map((stage) => {
    const deals = data.deals.filter((d) => d.stage === stage).sort((a, b) => String(a.expectedClose || '9').localeCompare(String(b.expectedClose || '9')));
    return h('section', { class: 'board__col', 'data-stage': stage, 'aria-label': stage },
      h('header', { class: 'board__head' }, h('strong', {}, stage), h('span', { class: 'small muted' }, `${deals.length} · ${money(deals.reduce((s, d) => s + (Number(d.amount) || 0), 0))}`)),
      h('div', { class: 'board__cards' }, deals.map((d) => h('article', { class: 'deal-card' },
        h('a', { class: 'deal-card__title', href: `#/deals/${d.id}` }, d.dealName),
        h('span', { class: 'small muted' }, titleOf('companies', find('companies', d.companyId))),
        h('div', { class: 'deal-card__foot' },
          h('strong', {}, money(d.amount)),
          d.expectedClose && h('span', { class: `small ${OPEN_STAGES.includes(d.stage) && d.expectedClose < today() ? 'text-error' : 'muted'}` }, formatDate(d.expectedClose))),
        canEdit() && h('select', {
          class: 'deal-card__move', 'aria-label': `Етап на „${d.dealName}“`,
          onchange: (event) => act(() => api(`/data/deals/${d.id}`, { method: 'PATCH', body: { stage: event.target.value } }), `Етап: ${event.target.value}`).then(() => viewDeals(query)),
        }, stages.map((s) => h('option', { value: s, selected: s === d.stage }, s)))))));
  }));
  page(
    pageHead('Сделки', `${data.deals.filter((d) => OPEN_STAGES.includes(d.stage)).length} отворени`,
      modeSwitch(),
      canEdit() && h('button', { class: 'btn', type: 'button', onclick: async () => { if (await editRecord('deals')) viewDeals(query); } }, icon('plus', 18), 'Нова сделка')),
    board);
}
function modeSwitch() {
  return h('div', { class: 'segmented segmented--inline', role: 'group', 'aria-label': 'Изглед' },
    h('button', { type: 'button', 'aria-pressed': String(dealsMode === 'board'), onclick: () => { dealsMode = 'board'; route(); } }, icon('board', 16), 'Табло'),
    h('button', { type: 'button', 'aria-pressed': String(dealsMode === 'list'), onclick: () => { dealsMode = 'list'; route(); } }, icon('list', 16), 'Списък'));
}

// --- Задачи ---

let taskFilter = 'mine';
function viewActivities() {
  const filters = {
    mine: ['Мои предстоящи', (a) => a.assignedTo === me.user.email && a.activityStatus === 'Предстои'],
    overdue: ['Просрочени', isOverdue],
    open: ['Всички предстоящи', (a) => a.activityStatus === 'Предстои'],
    done: ['Изпълнени', (a) => a.activityStatus === 'Изпълнена'],
    all: ['Всички', () => true],
  };
  const rows = data.activities.filter(filters[taskFilter][1])
    .sort((a, b) => (taskFilter === 'done' ? String(b.doneAt).localeCompare(String(a.doneAt)) : String(a.dueDate || '9').localeCompare(String(b.dueDate || '9'))));
  const counts = Object.fromEntries(Object.entries(filters).map(([k, [, fn]]) => [k, data.activities.filter(fn).length]));
  const list = rows.length ? h('ul', { class: 'task-list' }, rows.map((a) => h('li', { class: `task ${isOverdue(a) ? 'task--overdue' : ''} ${a.activityStatus !== 'Предстои' ? 'task--done' : ''}` },
    canEdit() && a.activityStatus === 'Предстои'
      ? h('button', {
        class: 'task__check', type: 'button', title: 'Отбележете като изпълнена', 'aria-label': `Изпълнена: ${a.subject}`,
        onclick: () => act(() => api(`/data/activities/${a.id}`, { method: 'PATCH', body: { activityStatus: 'Изпълнена' } }), 'Задачата е изпълнена.').then(viewActivities),
      })
      : h('span', { class: 'task__check task__check--static', 'aria-hidden': 'true' }, a.activityStatus === 'Изпълнена' ? icon('check', 14) : ''),
    h('div', { class: 'task__body' },
      h('a', { class: 'task__title', href: `#/activities/${a.id}` }, a.subject),
      h('span', { class: 'small muted' }, [a.activityType, titleOf('companies', find('companies', a.companyId)), titleOf('deals', find('deals', a.dealId)), userName(a.assignedTo)].filter(Boolean).join(' · '))),
    h('span', { class: `deadline ${isOverdue(a) ? 'deadline--over' : a.dueDate === today() ? 'deadline--soon' : ''}` }, a.dueDate ? formatDate(a.dueDate) : '')))) : emptyState('check', 'Няма задачи', 'Всичко е свършено.');
  page(
    pageHead('Задачи', 'Обаждания, срещи и задачи по клиенти и сделки.',
      canEdit() && h('button', { class: 'btn', type: 'button', onclick: async () => { if (await editRecord('activities')) viewActivities(); } }, icon('plus', 18), 'Нова задача')),
    chips(Object.entries(filters).map(([k, [label]]) => [k, label]), taskFilter, (v) => { taskFilter = v; viewActivities(); }, counts),
    list);
}

// --- Търговски документи ---

const TAX = ['Фактура', 'Кредитно известие'];
const docState = { type: '', status: '', pay: '', q: '', page: 1, sort: 'issueDate', dir: -1 };

function viewDocuments(query) {
  if (query.has('type')) docState.type = query.get('type');
  if (query.has('pay')) docState.pay = query.get('pay');
  const results = h('div', { class: 'stack' });
  const filtered = () => data.documents.filter((d) => {
    if (docState.type && d.docType !== docState.type) return false;
    if (docState.status && d.docStatus !== docState.status) return false;
    if (docState.pay === 'unpaid' && !(d.docStatus === 'Издаден' && ['Фактура', 'Проформа фактура'].includes(d.docType) && d.paymentStatus !== 'Платен')) return false;
    if (docState.q && !norm(`${d.number} ${d.companyName} ${titleOf('companies', find('companies', d.companyId))} ${d.lines.map((l) => l.name).join(' ')}`).includes(norm(docState.q))) return false;
    return true;
  });
  const render = () => {
    const rows = [...filtered()].sort((a, b) => {
      const k = docState.sort;
      const x = a[k];
      const y = b[k];
      const cmp = typeof x === 'number' ? x - y : String(x || '').localeCompare(String(y || ''), 'bg');
      return (cmp || String(a.number).localeCompare(String(b.number))) * docState.dir;
    });
    const shown = rows.slice((docState.page - 1) * PAGE_SIZE, docState.page * PAGE_SIZE);
    const sum = rows.filter((d) => d.docStatus !== 'Анулиран' && d.docStatus !== 'Чернова').reduce((s, d) => s + (d.totalEur ?? d.total), 0);
    fill(results,
      rows.length > 0 && h('p', { class: 'small muted' }, `${rows.length} документа · издадени за ${money(sum)} с ДДС (в евро)`),
      documentsTable(shown, docState, render) || emptyState('doc', 'Няма документи', 'Създайте оферта или фактура.'),
      pager(docState, rows.length, render));
  };
  const search = searchBox(docState, render, 'Номер, контрагент или артикул');
  const typeCounts = Object.fromEntries(meta.docTypes.map((t) => [t, data.documents.filter((d) => d.docType === t).length]));
  page(
    pageHead('Оферти и фактури', 'Търговски документи с автоматична номерация и ДДС.',
      h('button', {
        class: 'btn btn--ghost', type: 'button',
        onclick: () => downloadCsv(`documents-${today()}.csv`,
          ['Вид', 'Номер', 'Дата', 'Данъчно събитие', 'Контрагент', 'ЕИК', 'ДДС номер', 'Валута', 'Курс за 1 EUR', 'Основа', 'ДДС', 'Общо', 'Платено', 'Основа в EUR', 'ДДС в EUR', 'Общо в EUR', 'Статус', 'Плащане'],
          filtered().map((d) => [d.docType, d.number, formatDate(d.issueDate), formatDate(d.taxEventDate), d.companyName || titleOf('companies', find('companies', d.companyId)),
            d.buyer?.eik || '', d.buyer?.vatNumber || '', d.currency, String(d.exchangeRate).replace('.', ','),
            ...[d.subtotal, d.vatAmount, d.total, d.paidAmount, d.subtotalEur, d.vatAmountEur, d.totalEur].map((n) => String(n ?? '').replace('.', ',')), d.docStatus, d.paymentStatus])),
      }, icon('download', 18), 'CSV'),
      canEdit() && h('a', { class: 'btn btn--ghost', href: '#/documents/new?type=Оферта' }, icon('plus', 18), 'Оферта'),
      canEdit() && h('a', { class: 'btn', href: '#/documents/new?type=Фактура' }, icon('plus', 18), 'Фактура')),
    h('div', { class: 'toolbar' }, search.el,
      chips([['', 'Всички'], ...meta.docTypes.map((t) => [t, t])], docState.type, (v) => { docState.type = v; docState.page = 1; viewDocuments(new URLSearchParams()); }, typeCounts)),
    h('div', { class: 'toolbar' },
      chips([['', 'Всеки статус'], ['Чернова', 'Чернови'], ['Издаден', 'Издадени'], ['Анулиран', 'Анулирани']], docState.status, (v) => { docState.status = v; docState.page = 1; viewDocuments(new URLSearchParams()); }),
      chips([['', 'Всички плащания'], ['unpaid', 'Неплатени']], docState.pay, (v) => { docState.pay = v; docState.page = 1; viewDocuments(new URLSearchParams()); })),
    results);
  render();
}

// Редове на документа: редактират се на място, а сумите се преизчисляват веднага.
function linesEditor(initial, onChange, currency = () => 'EUR') {
  const products = data.products.filter((p) => p.isActive !== 'Не');
  let lines = initial.map((l) => ({ ...l }));
  const body = h('tbody');
  const lineTotal = (l) => round2(parseNum(l.qty) * parseNum(l.price) * (1 - parseNum(l.discount) / 100));

  const render = () => {
    body.replaceChildren(...lines.map((line, i) => {
      const totalCell = h('td', { class: 'num', 'data-label': 'Стойност' }, money(lineTotal(line), currency()));
      const update = (key) => (event) => {
        line[key] = event.target.value;
        totalCell.textContent = money(lineTotal(line), currency());
        onChange(lines);
      };
      const product = h('select', {
        'aria-label': `Артикул, ред ${i + 1}`,
        onchange: (event) => {
          const p = products.find((x) => x.id === event.target.value);
          line.productId = event.target.value;
          if (p) Object.assign(line, { name: p.name, unit: p.unit || 'бр.', price: p.price === '' ? 0 : p.price, vatRate: Number(p.vatRate) });
          render();
          onChange(lines);
        },
      }, h('option', { value: '' }, 'Свободен текст'), products.map((p) => h('option', { value: p.id, selected: p.id === line.productId }, [p.code, p.name].filter(Boolean).join(' · '))));
      const input = (key, attrs) => h('input', { value: line[key] ?? '', oninput: update(key), ...attrs });
      return h('tr', {},
        h('td', { 'data-label': 'Артикул' }, product, input('name', { 'aria-label': `Наименование, ред ${i + 1}`, maxlength: 255, class: 'line-name', placeholder: 'Наименование' })),
        h('td', { 'data-label': 'Количество' }, input('qty', { 'aria-label': 'Количество', inputmode: 'decimal', class: 'line-num' })),
        h('td', { 'data-label': 'Мярка' }, input('unit', { 'aria-label': 'Мярка', maxlength: 20, class: 'line-unit' })),
        h('td', { 'data-label': 'Цена без ДДС' }, input('price', { 'aria-label': 'Единична цена', inputmode: 'decimal', class: 'line-num' })),
        h('td', { 'data-label': 'Отстъпка %' }, input('discount', { 'aria-label': 'Отстъпка %', inputmode: 'decimal', class: 'line-num', placeholder: '0' })),
        h('td', { 'data-label': 'ДДС' }, h('select', { 'aria-label': 'ДДС ставка', class: 'line-vat', onchange: (event) => { line.vatRate = Number(event.target.value); onChange(lines); } },
          [20, 9, 0].map((r) => h('option', { value: r, selected: Number(line.vatRate) === r }, `${r}%`)))),
        totalCell,
        h('td', {}, h('button', {
          class: 'icon-btn', type: 'button', title: 'Премахнете реда', 'aria-label': `Премахнете ред ${i + 1}`,
          onclick: () => { lines.splice(i, 1); render(); onChange(lines); },
        }, icon('trash', 16))));
    }));
  };
  render();
  const add = h('button', {
    class: 'btn btn--ghost btn--small', type: 'button',
    onclick: () => { lines.push({ productId: '', name: '', qty: 1, unit: 'бр.', price: '', discount: '', vatRate: data.company.vatRegistered === 'Не' ? 0 : 20 }); render(); onChange(lines); body.lastChild?.querySelector('select')?.focus(); },
  }, icon('plus', 16), 'Добавете ред');
  return {
    el: h('div', { class: 'stack-tight' },
      h('div', { class: 'table-wrap lines' }, h('table', {},
        h('thead', {}, h('tr', {}, ['Артикул / услуга', 'Кол.', 'Мярка', 'Цена без ДДС', 'Отст. %', 'ДДС', 'Стойност', ''].map((t) => h('th', { scope: 'col' }, t)))),
        body)),
      add),
    get: () => lines.map((l) => ({ ...l, qty: parseNum(l.qty), price: parseNum(l.price), discount: parseNum(l.discount), vatRate: Number(l.vatRate) })),
    refresh: render,
  };
}

function totalsOf(lines, docType) {
  const bases = new Map();
  for (const l of lines) {
    const net = round2(parseNum(l.qty) * parseNum(l.price) * (1 - parseNum(l.discount) / 100));
    bases.set(Number(l.vatRate), round2((bases.get(Number(l.vatRate)) || 0) + net));
  }
  const sign = docType === 'Кредитно известие' ? -1 : 1;
  const byRate = [...bases].sort((a, b) => b[0] - a[0]).map(([rate, base]) => ({ rate, base: sign * base, vat: sign * round2((base * rate) / 100) }));
  const subtotal = round2(byRate.reduce((s, r) => s + r.base, 0));
  const vat = round2(byRate.reduce((s, r) => s + r.vat, 0));
  return { byRate, subtotal, vat, total: round2(subtotal + vat) };
}

// Суми по ставки. При документ в чужда валута данъчната основа и ДДС се показват и в евро по курса на документа.
function totalsBlock(t, currency = 'EUR', rate = 1, rateDate = '') {
  const foreign = currency !== 'EUR' && rate > 0;
  const eur = (n) => round2(n / rate);
  return h('dl', { class: 'totals' },
    t.byRate.flatMap((r) => [h('dt', {}, `Данъчна основа ${r.rate}%`), h('dd', {}, money(r.base, currency)), h('dt', {}, `ДДС ${r.rate}%`), h('dd', {}, money(r.vat, currency))]),
    h('dt', { class: 'totals__grand' }, 'Сума за плащане'), h('dd', { class: 'totals__grand' }, money(t.total, currency)),
    foreign && [
      h('dt', { class: 'totals__note' }, `В евро по курс 1 EUR = ${rateText(rate)} ${currency}${rateDate ? ` (ЕЦБ, ${formatDate(rateDate)})` : ''}`), h('dd', {}),
      ...t.byRate.flatMap((r) => [h('dt', {}, `Данъчна основа ${r.rate}% в EUR`), h('dd', {}, money(eur(r.base))), h('dt', {}, `ДДС ${r.rate}% в EUR`), h('dd', {}, money(eur(r.vat)))]),
      h('dt', {}, 'Общо в EUR'), h('dd', {}, money(eur(t.total)))]);
}

function documentEditor(doc, query) {
  const docType = doc?.docType || query.get('type') || 'Фактура';
  const values = doc || {
    companyId: query.get('company') || '', dealId: query.get('deal') || '', issueDate: today(), dueDate: '', paymentMethod: 'Банков превод',
    vatExemptReason: data.company.vatRegistered === 'Не' ? 'чл. 113, ал. 9 от ЗДДС' : '', notes: '', lines: [],
  };
  if (!doc && values.dealId && !values.lines.length) {
    const deal = find('deals', values.dealId);
    // Документ към сделка е винаги към нейния контрагент.
    if (deal) values.companyId = deal.companyId;
    if (deal?.amount) values.lines = [{ productId: '', name: deal.dealName, qty: 1, unit: 'бр.', price: deal.amount, discount: '', vatRate: data.company.vatRegistered === 'Не' ? 0 : 20 }];
  }
  // Валута, курс и сметка. Другите валути са само при план с тази възможност.
  const canForeign = data.plan.allowCurrencies === 'Да';
  const accounts = data.company.bankAccounts || [];
  let currency = values.currency || 'EUR';
  const currencySelect = h('select', { id: 'f-currency', name: 'currency', disabled: !canForeign && currency === 'EUR' },
    (canForeign ? meta.currencies : ['EUR']).map((c) => h('option', { value: c, selected: c === currency }, c)));
  const rateInput = h('input', { id: 'f-exchangeRate', name: 'exchangeRate', type: 'text', inputmode: 'decimal', value: values.exchangeRate && currency !== 'EUR' ? String(values.exchangeRate).replace('.', ',') : '' });
  const rateDateInput = h('input', { type: 'hidden', name: 'rateDate', value: values.rateDate || '' });
  const rateNote = h('span', { class: 'field__hint' });
  const accountSelect = h('select', { id: 'f-bankAccount', name: 'bankAccount' },
    accounts.length ? accounts.map((a) => h('option', { value: a.iban, selected: a.iban === values.bankAccount }, `${a.label ? `${a.label} · ` : ''}${a.iban} (${a.currency})`))
      : h('option', { value: '' }, 'Няма въведена сметка — добавете от „Настройки“'));
  const currentRate = () => (currency === 'EUR' ? 1 : parseNum(rateInput.value));
  const totalsBox = h('div');
  const showTotals = (lines) => totalsBox.replaceChildren(totalsBlock(totalsOf(lines, docType), currency, currentRate(), rateDateInput.value));
  const editor = linesEditor(values.lines.length ? values.lines : [{ productId: '', name: '', qty: 1, unit: 'бр.', price: '', discount: '', vatRate: data.company.vatRegistered === 'Не' ? 0 : 20 }], showTotals, () => currency);
  const rateField = h('div', { class: 'field', hidden: currency === 'EUR' },
    h('label', { for: 'f-exchangeRate' }, 'Курс: единици валута за 1 EUR ', rateNote),
    h('div', { class: 'row-tight' }, rateInput, h('button', {
      class: 'btn btn--ghost btn--small', type: 'button',
      onclick: async () => {
        const issueDate = form.elements.taxEventDate?.value || form.elements.issueDate.value || today();
        try {
          const r = await api(`/rates?currency=${currency}&date=${issueDate}`);
          rateInput.value = String(r.rate).replace('.', ',');
          rateDateInput.value = r.rateDate;
          rateNote.textContent = `(ЕЦБ към ${formatDate(r.rateDate)})`;
          showTotals(editor.get());
        } catch (err) {
          toast(err.message, 'error');
        }
      },
    }, 'Курс на ЕЦБ')), rateDateInput);
  if (values.rateDate) rateNote.textContent = `(ЕЦБ към ${formatDate(values.rateDate)})`;
  currencySelect.addEventListener('change', () => {
    currency = currencySelect.value;
    rateField.hidden = currency === 'EUR';
    if (currency === 'EUR') { rateInput.value = ''; rateDateInput.value = ''; rateNote.textContent = ''; }
    // Сметка във валутата на документа, ако има такава.
    const match = accounts.find((a) => a.currency === currency);
    if (match) accountSelect.value = match.iban;
    editor.refresh();
    showTotals(editor.get());
  });
  rateInput.addEventListener('input', () => { rateDateInput.value = ''; rateNote.textContent = '(въведен ръчно)'; showTotals(editor.get()); });
  showTotals(editor.get());
  const alert = h('div', { 'aria-live': 'polite' });
  const companies = [...data.companies].sort((a, b) => a.name.localeCompare(b.name, 'bg'));
  const dealSelect = h('select', { id: 'f-dealId', name: 'dealId' });
  const fillDeals = (companyId) => fill(dealSelect, h('option', { value: '' }, '—'),
    data.deals.filter((d) => !companyId || d.companyId === companyId).map((d) => h('option', { value: d.id, selected: d.id === values.dealId }, d.dealName)));
  fillDeals(values.companyId);
  const companySelect = h('select', { id: 'f-companyId', name: 'companyId', onchange: (e) => fillDeals(e.target.value) },
    h('option', { value: '' }, 'Изберете контрагент…'), companies.map((c) => h('option', { value: c.id, selected: c.id === values.companyId }, c.name)));

  const form = h('form', { class: 'form', novalidate: true },
    h('section', { class: 'card stack' },
      h('div', { class: 'form__grid' },
        h('div', { class: 'field' }, h('label', { for: 'f-companyId' }, 'Контрагент'), companySelect),
        h('div', { class: 'field' }, h('label', { for: 'f-dealId' }, 'Сделка', h('span', { class: 'field__hint' }, ' (по желание)')), dealSelect),
        field({ name: 'issueDate', label: 'Дата на издаване', type: 'date', value: values.issueDate }),
        field({ name: 'dueDate', label: docType === 'Оферта' ? 'Валидна до' : 'Падеж', type: 'date', value: values.dueDate, hint: 'празно = по подразбиране' }),
        TAX.includes(docType) && field({ name: 'taxEventDate', label: 'Дата на данъчно събитие', type: 'date', value: values.taxEventDate, hint: 'ако е различна' }),
        selectField({ name: 'paymentMethod', label: 'Начин на плащане', options: PAYMENT_METHODS, value: values.paymentMethod }),
        h('div', { class: 'field' }, h('label', { for: 'f-bankAccount' }, 'Банкова сметка'), accountSelect),
        h('div', { class: 'field' }, h('label', { for: 'f-currency' }, 'Валута',
          !canForeign && h('span', { class: 'field__hint' }, ' (други валути — с платен план)')), currencySelect),
        rateField,
        field({ name: 'vatExemptReason', label: 'Основание за 0% ДДС', value: values.vatExemptReason, hint: 'при нулева ставка', wrapClass: 'full', maxlength: 255 }),
        h('div', { class: 'field full' }, h('label', { for: 'f-notes' }, 'Забележки', h('span', { class: 'field__hint' }, ' (по желание)')),
          h('textarea', { id: 'f-notes', name: 'notes', rows: 3, maxlength: 8000 }, values.notes || '')))),
    h('section', { class: 'card stack' }, h('h2', { class: 'card__title' }, 'Редове'), h('div', { 'data-field': 'lines' }, editor.el), totalsBox),
    alert);
  // Полето „lines“ няма input: грешката му се показва под таблицата.
  const linesError = (message) => {
    form.querySelector('[data-field=lines] .field__error')?.remove();
    if (message) form.querySelector('[data-field=lines]').append(h('div', { class: 'field__error' }, message));
  };

  const save = async () => {
    alert.replaceChildren();
    linesError('');
    const body = { ...formValues(form), docType, lines: editor.get(), relatedId: doc?.relatedId };
    try {
      const saved = doc
        ? await api(`/documents/${doc.id}`, { method: 'PATCH', body })
        : await api('/documents', { method: 'POST', body });
      await refresh();
      return saved;
    } catch (err) {
      showFieldErrors(form, err.fields);
      linesError(err.fields?.lines);
      showError(alert, err.message);
      return null;
    }
  };

  const actions = [
    h('button', { class: 'btn btn--ghost', type: 'button', onclick: async () => { const s = await save(); if (s) { toast('Черновата е запазена.'); go(`#/documents/${s.id}`); } } }, 'Запазете чернова'),
    h('button', {
      class: 'btn', type: 'button',
      onclick: async () => {
        const s = await save();
        if (!s) return;
        const ok = await confirmDialog({
          title: `Издаване: ${docType}`,
          text: TAX.includes(docType) ? 'Документът ще получи пореден номер и след това не може да се променя, а само да се анулира.' : 'Документът ще получи номер и няма да може да се променя.',
          confirmLabel: 'Издайте',
        });
        if (!ok) { go(`#/documents/${s.id}`); return; }
        const issued = await act(() => api(`/documents/${s.id}/issue`, { method: 'POST' }), `Издаден ${docType}.`);
        if (issued) go(`#/documents/${s.id}`);
      },
    }, icon('send', 18), 'Издайте'),
    doc && h('button', {
      class: 'icon-btn', type: 'button', title: 'Изтрийте черновата', 'aria-label': 'Изтрийте черновата',
      onclick: async () => {
        if (!(await confirmDialog({ title: 'Изтриване на чернова', text: 'Черновата ще бъде изтрита.', confirmLabel: 'Изтрийте', danger: true }))) return;
        if (await act(() => api(`/documents/${doc.id}`, { method: 'DELETE' }), 'Черновата е изтрита.')) location.hash = '#/documents';
      },
    }, icon('trash', 18)),
  ];
  const related = doc?.relatedId && find('documents', doc.relatedId);
  page(
    h('a', { class: 'back', href: '#/documents' }, icon('back', 16), 'Оферти и фактури'),
    pageHead(doc ? `${docType}: чернова` : `Нов документ: ${docType.toLowerCase()}`,
      related ? `Към ${related.docType.toLowerCase()} № ${related.number}` : 'Номерът се дава при издаване.', ...(canEdit() ? actions : [])),
    form);
}

const partyLines = (p) => [
  p.eik && `ЕИК: ${p.eik}`, p.vatNumber && `ДДС №: ${p.vatNumber}`, addressLine(p), p.mol && `МОЛ: ${p.mol}`,
].filter(Boolean);

// Издаденият документ пази данните на страните към момента на издаване; черновата показва текущите.
function buyerOf(doc) {
  if (doc.buyer) return doc.buyer;
  const c = find('companies', doc.companyId) || {};
  return { name: c.name, eik: c.eik, vatNumber: c.vatNumber, mol: c.mol, city: c.city, address: c.address };
}

// Доставчикът: при издаден документ — както е записан при издаването; при чернова — фирмата с избраната сметка.
function sellerOf(doc) {
  if (doc.seller) return doc.seller;
  const { bankAccounts = [], ...company } = data.company;
  const account = bankAccounts.find((a) => a.iban === doc.bankAccount) || bankAccounts[0];
  return account ? { ...company, iban: account.iban, bic: account.bic, bank: account.bank } : company;
}

// Логото е платена възможност: показва се само ако планът го позволява.
const showLogo = () => !!data?.org.hasLogo && data.plan.allowLogo === 'Да';
let logoVersion = Date.now();
let logoCache = null;
const logoSrc = () => `/api/orgs/${encodeURIComponent(orgId)}/logo?v=${logoVersion}`;
function logoBytes() {
  if (!showLogo()) return Promise.resolve(null);
  logoCache ??= api(`/orgs/${encodeURIComponent(orgId)}/logo`, { raw: true })
    .then((bytes) => ({ bytes, type: bytes[0] === 0x89 ? 'image/png' : 'image/jpeg' }))
    .catch(() => null);
  return logoCache;
}

async function makePdf(doc) {
  return buildPdf({
    doc,
    seller: sellerOf(doc),
    buyer: buyerOf(doc),
    logo: await logoBytes(),
    related: doc.relatedId && find('documents', doc.relatedId),
    issuedBy: doc.issuedBy || userName(doc.createdBy),
  });
}
const pdfName = (doc) => `${doc.docType} ${doc.number || 'чернова'}.pdf`;

function documentPrint(doc) {
  const seller = sellerOf(doc);
  const cur = doc.currency || 'EUR';
  const buyer = buyerOf(doc);
  const t = totalsOf(doc.lines, doc.docType);
  const related = doc.relatedId && find('documents', doc.relatedId);
  return h('article', { class: 'doc-print', 'aria-label': `${doc.docType} ${doc.number}` },
    showLogo() && h('img', { class: 'doc-print__logo', src: logoSrc(), alt: seller.name || 'Лого' }),
    h('header', { class: 'doc-print__head' },
      h('div', {},
        h('h2', { class: 'doc-print__type' }, doc.docType.toUpperCase()),
        h('p', { class: 'doc-print__number' }, doc.number ? `№ ${doc.number}` : 'ЧЕРНОВА'),
        TAX.includes(doc.docType) && doc.number && h('p', { class: 'small' }, 'ОРИГИНАЛ'),
        related && h('p', { class: 'small' }, `Към ${related.docType.toLowerCase()} № ${related.number} от ${formatDate(related.issueDate)}`)),
      h('dl', { class: 'doc-print__dates' },
        h('dt', {}, 'Дата на издаване'), h('dd', {}, formatDate(doc.issueDate)),
        TAX.includes(doc.docType) && [h('dt', {}, 'Дата на данъчно събитие'), h('dd', {}, formatDate(doc.taxEventDate || doc.issueDate))],
        doc.dueDate && [h('dt', {}, doc.docType === 'Оферта' ? 'Валидна до' : 'Падеж'), h('dd', {}, formatDate(doc.dueDate))])),
    h('div', { class: 'doc-print__parties' },
      h('section', {}, h('h3', {}, 'Получател'), h('p', { class: 'doc-print__party' }, buyer.name), partyLines(buyer).map((l) => h('p', {}, l))),
      h('section', {}, h('h3', {}, 'Доставчик'), h('p', { class: 'doc-print__party' }, seller.name), partyLines(seller).map((l) => h('p', {}, l)))),
    h('table', { class: 'doc-print__lines' },
      h('thead', {}, h('tr', {}, ['№', 'Наименование', 'Кол.', 'Мярка', 'Ед. цена', 'Отст.', 'ДДС', 'Стойност'].map((x) => h('th', { scope: 'col' }, x)))),
      h('tbody', {}, doc.lines.map((l, i) => h('tr', {},
        h('td', {}, String(i + 1)), h('td', {}, l.name), h('td', { class: 'num' }, num(l.qty)), h('td', {}, l.unit),
        h('td', { class: 'num' }, money(l.price, cur)), h('td', { class: 'num' }, l.discount ? `${num(l.discount)}%` : ''), h('td', { class: 'num' }, `${l.vatRate}%`),
        h('td', { class: 'num' }, money(round2(l.qty * l.price * (1 - (l.discount || 0) / 100)), cur)))))),
    h('div', { class: 'doc-print__foot' },
      h('div', { class: 'doc-print__pay' },
        h('p', {}, h('strong', {}, 'Начин на плащане: '), doc.paymentMethod || '—'),
        doc.paymentMethod === 'Банков превод' && seller.iban && h('p', {}, `IBAN: ${seller.iban}${seller.bic ? ` · BIC: ${seller.bic}` : ''}${seller.bank ? ` · ${seller.bank}` : ''}`),
        doc.vatExemptReason && h('p', {}, h('strong', {}, 'Основание за неначисляване на ДДС: '), doc.vatExemptReason),
        doc.notes && h('p', { class: 'pre' }, doc.notes),
        h('p', { class: 'small' }, `Съставил: ${doc.issuedBy || userName(doc.createdBy)}`)),
      totalsBlock(t, cur, doc.exchangeRate || 1, doc.rateDate)),
    h('p', { class: 'doc-print__made' }, 'Създадено с BulAdmin Cloud · cloud.buladmin.eu'));
}

async function viewDocument(id, query) {
  if (id === 'new') return documentEditor(null, query);
  const doc = find('documents', id);
  if (!doc) {
    page(h('a', { class: 'back', href: '#/documents' }, icon('back', 16), 'Оферти и фактури'), emptyState('alert', 'Документът не е намерен'));
    return;
  }
  if (doc.docStatus === 'Чернова' && canEdit()) return documentEditor(doc, query);

  const payments = data.payments.filter((p) => p.documentId === id).sort((a, b) => a.paidAt.localeCompare(b.paidAt));
  const payable = doc.docStatus === 'Издаден' && ['Фактура', 'Проформа фактура'].includes(doc.docType);
  const derive = (docType) => h('button', {
    class: 'btn btn--ghost', type: 'button',
    onclick: async () => {
      const created = await act(() => api(`/documents/${id}/derive`, { method: 'POST', body: { docType } }), `Създадена чернова: ${docType.toLowerCase()}.`);
      if (created) location.hash = `#/documents/${created.id}`;
    },
  }, icon('plus', 18), docType);
  const actions = canEdit() ? [
    payable && doc.paymentStatus !== 'Платен' && h('button', { class: 'btn', type: 'button', onclick: () => addPayment(doc) }, icon('wallet', 18), 'Плащане'),
    doc.docType === 'Оферта' && ['Издаден', 'Приета'].includes(doc.docStatus) && [derive('Проформа фактура'), derive('Фактура')],
    doc.docType === 'Проформа фактура' && doc.docStatus === 'Издаден' && derive('Фактура'),
    doc.docType === 'Фактура' && doc.docStatus === 'Издаден' && derive('Кредитно известие'),
    doc.docType === 'Оферта' && doc.docStatus === 'Издаден' && [
      h('button', { class: 'btn btn--ghost', type: 'button', onclick: () => act(() => api(`/documents/${id}/status`, { method: 'POST', body: { status: 'Приета' } }), 'Офертата е приета.').then(route) }, 'Приета'),
      h('button', { class: 'btn btn--ghost', type: 'button', onclick: () => act(() => api(`/documents/${id}/status`, { method: 'POST', body: { status: 'Отказана' } }), 'Офертата е отказана.').then(route) }, 'Отказана')],
    ['Издаден', 'Приета', 'Отказана'].includes(doc.docStatus) && (!TAX.includes(doc.docType) || isAdmin()) && h('button', {
      class: 'btn btn--ghost', type: 'button',
      onclick: async () => {
        const ok = await confirmDialog({ title: 'Анулиране', text: `${doc.docType} № ${doc.number} ще бъде анулиран. Номерът не се използва повторно.`, confirmLabel: 'Анулирайте', danger: true });
        if (ok) act(() => api(`/documents/${id}/cancel`, { method: 'POST' }), 'Документът е анулиран.').then(route);
      },
    }, 'Анулирайте'),
  ] : [];
  const children = data.documents.filter((d) => d.relatedId === id);

  page(
    h('a', { class: 'back no-print', href: '#/documents' }, icon('back', 16), 'Оферти и фактури'),
    h('div', { class: 'no-print' }, pageHead(`${doc.docType} ${doc.number}`, `${doc.companyName} · ${money(doc.total, doc.currency)}`,
      h('button', {
        class: 'btn', type: 'button', title: 'PDF се създава наново от данните на документа',
        onclick: async (event) => {
          const button = event.currentTarget;
          button.disabled = true;
          try {
            saveFile(await makePdf(doc), pdfName(doc));
          } catch (err) {
            toast(err.message, 'error');
          }
          button.disabled = false;
        },
      }, icon('download', 18), 'Изтеглете PDF'),
      canEdit() && ['Издаден', 'Приета', 'Отказана'].includes(doc.docStatus) && h('button', { class: 'btn', type: 'button', onclick: () => sendDialog(doc) }, icon('send', 18), 'Изпратете по имейл'))),
    h('div', { class: 'row no-print' }, pill(doc.docStatus, 'doc'), payable && pill(doc.paymentStatus, 'pay'), actions),
    h('div', { class: 'split' },
      h('div', { class: 'card doc-sheet' }, documentPrint(doc)),
      h('div', { class: 'stack no-print' },
        payable && h('section', { class: 'card stack-tight' },
          h('h2', { class: 'card__title' }, 'Плащания'),
          h('dl', { class: 'details' }, h('dt', {}, 'Платено'), h('dd', {}, money(doc.paidAmount, doc.currency)), h('dt', {}, 'Остатък'), h('dd', { class: outstanding(doc) > 0 ? 'text-error' : '' }, money(outstanding(doc), doc.currency))),
          payments.length ? h('ul', { class: 'pay-list' }, payments.map((p) => h('li', {},
            h('span', {}, `${formatDate(p.paidAt)} · ${p.method}${p.reference ? ` · ${p.reference}` : ''}`),
            h('strong', {}, money(p.amount, doc.currency)),
            isAdmin() && h('button', {
              class: 'icon-btn', type: 'button', 'aria-label': 'Изтрийте плащането', title: 'Изтрийте плащането',
              onclick: async () => { if (await confirmDialog({ title: 'Изтриване на плащане', text: `${money(p.amount, doc.currency)} от ${formatDate(p.paidAt)}`, confirmLabel: 'Изтрийте', danger: true })) act(() => api(`/payments/${p.id}`, { method: 'DELETE' }), 'Плащането е изтрито.').then(route); },
            }, icon('trash', 16))))) : h('p', { class: 'small muted' }, 'Няма плащания.')),
        children.length > 0 && h('section', { class: 'card card--list' }, h('div', { class: 'card__head' }, h('h2', {}, 'Свързани документи')), documentsTable(children)),
        h('section', { class: 'card' }, h('dl', { class: 'details details--stacked' },
          h('dt', {}, 'Контрагент'), h('dd', {}, refLink('companies', doc.companyId)),
          doc.dealId && [h('dt', {}, 'Сделка'), h('dd', {}, refLink('deals', doc.dealId))],
          h('dt', {}, 'Издаден'), h('dd', {}, `${formatTime(doc.issuedAt)} · ${doc.issuedBy}`),
          doc.sentAt && [h('dt', {}, 'Изпратен по имейл'), h('dd', {}, `${formatTime(doc.sentAt)} до ${doc.sentTo}`)],
          doc.docType === 'Оферта' && doc.sentAt && doc.docStatus === 'Издаден' && [h('dt', {}, 'Линк за клиента'), h('dd', {}, 'Клиентът може да приеме или откаже офертата от имейла.')],
          doc.decisionAt && [h('dt', {}, 'Отговор на клиента'), h('dd', {}, `${doc.docStatus} от ${doc.decisionBy} на ${formatTime(doc.decisionAt)}`)],
          doc.decisionNote && [h('dt', {}, 'Коментар на клиента'), h('dd', { class: 'pre' }, doc.decisionNote)])),
        await historyCard('documents', id))));
}

const toBase64 = (bytes) => {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};

// Изпраща документа като PDF на контрагента. Отговорът му отива на имейла на фирмата.
async function sendDialog(doc) {
  if (!meta.mailEnabled) { toast('Имейлите са изключени в системата.', 'error'); return; }
  const company = find('companies', doc.companyId) || {};
  const contactEmails = data.contacts.filter((c) => c.companyId === doc.companyId && c.email).map((c) => c.email);
  const suggested = company.email || contactEmails[0] || '';
  const isOffer = doc.docType === 'Оферта';
  const result = await formDialog({
    title: `Изпратете ${doc.docType.toLowerCase()} № ${doc.number}`,
    wide: true,
    fields: [
      field({ name: 'to', label: 'До', type: 'text', value: suggested, required: true, placeholder: 'имейл, няколко — със запетая', maxlength: 500 }),
      contactEmails.length > 0 && h('p', { class: 'small muted' }, `Лица за контакт: ${[company.email, ...contactEmails].filter(Boolean).join(', ')}`),
      field({ name: 'cc', label: 'Копие до', hint: 'по желание', maxlength: 500 }),
      field({ name: 'subject', label: 'Тема', value: `${doc.docType} № ${doc.number} от ${data.org.name}`, maxlength: 200 }),
      h('div', { class: 'field' }, h('label', { for: 'f-message' }, 'Съобщение'),
        h('textarea', { id: 'f-message', name: 'message', rows: 5, maxlength: 4000 },
          `Здравейте,\n\nизпращаме Ви ${doc.docType.toLowerCase()} № ${doc.number} от ${formatDate(doc.issueDate)} на стойност ${money(doc.total, doc.currency)}. Документът е прикачен като PDF.${isOffer && doc.dueDate ? ` Офертата е валидна до ${formatDate(doc.dueDate)}.` : ''}\n\nПоздрави,\n${me.user.name}\n${data.org.name}`)),
      h('p', { class: 'small muted' }, [
        isOffer && doc.docStatus === 'Издаден' && !(doc.dueDate && doc.dueDate < today()) ? 'Клиентът ще получи и линк, през който да приеме или откаже офертата. ' : '',
        isOffer && doc.dueDate && doc.dueDate < today() ? `Внимание: офертата е валидна до ${formatDate(doc.dueDate)} и клиентът вече не може да я приеме през линка. ` : '',
        `Отговорите на клиента отиват до ${data.company.email || me.user.email}. `,
        data.plan.maxEmails !== '' ? `Изпратени този месец: ${limitText('maxEmails')}.` : '',
      ].join('')),
    ].filter(Boolean),
    submitLabel: 'Изпратете',
    onSubmit: async (body) => {
      const pdf = toBase64(await makePdf(doc));
      return api(`/documents/${doc.id}/send`, { method: 'POST', body: { ...body, pdf } });
    },
  });
  if (result) {
    await refresh();
    toast(`Изпратено до ${result.sentTo}.`);
    route();
  }
}

async function addPayment(doc) {
  const result = await formDialog({
    title: `Плащане по ${doc.docType.toLowerCase()} № ${doc.number}`,
    fields: h('div', { class: 'form__grid' },
      field({ name: 'amount', label: `Сума (${doc.currency || 'EUR'})`, value: String(outstanding(doc)).replace('.', ','), inputmode: 'decimal', required: true }),
      field({ name: 'paidAt', label: 'Дата', type: 'date', value: today() }),
      selectField({ name: 'method', label: 'Начин', options: PAYMENT_METHODS, value: doc.paymentMethod || 'Банков превод' }),
      field({ name: 'reference', label: 'Основание / референция', hint: 'по желание', maxlength: 255 })),
    submitLabel: 'Запишете',
    onSubmit: (body) => api('/payments', { method: 'POST', body: { ...body, documentId: doc.id } }),
  });
  if (result) {
    await refresh();
    toast('Плащането е записано.');
    route();
  }
}

function viewPayments() {
  const rows = [...data.payments].sort((a, b) => b.paidAt.localeCompare(a.paidAt));
  const month = today().slice(0, 7);
  // Плащанията са във валутата на документа; сборът е в евро по курса на документа.
  const docOf = (p) => find('documents', p.documentId);
  const curOf = (p) => docOf(p)?.currency || 'EUR';
  const eurOf = (p) => p.amount / (docOf(p)?.exchangeRate || 1);
  const thisMonth = rows.filter((p) => p.paidAt.startsWith(month)).reduce((s, p) => s + eurOf(p), 0);
  const columns = [
    { name: 'paidAt', label: 'Дата', kind: 'day' }, { name: 'documentId', label: 'Документ' }, { name: 'companyId', label: 'Контрагент', input: 'ref', ref: 'companies' },
    { name: 'amount', label: 'Сума', kind: 'number', input: 'money' }, { name: 'currency', label: 'Валута' }, { name: 'method', label: 'Начин' }, { name: 'reference', label: 'Основание' },
  ];
  const docLabel = (p) => { const d = find('documents', p.documentId); return d ? `${d.docType} № ${d.number}` : ''; };
  page(
    pageHead('Плащания', `Постъпления този месец: ${money(thisMonth)}`,
      h('button', {
        class: 'btn btn--ghost', type: 'button',
        onclick: () => downloadCsv(`payments-${today()}.csv`, columns.map((c) => c.label),
          rows.map((p) => [formatDate(p.paidAt), docLabel(p), titleOf('companies', find('companies', p.companyId)), String(p.amount).replace('.', ','), curOf(p), p.method, p.reference])),
      }, icon('download', 18), 'CSV')),
    rows.length ? h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, columns.map((c) => h('th', { scope: 'col' }, c.label)))),
      h('tbody', {}, rows.map((p) => h('tr', {},
        h('td', { 'data-label': 'Дата' }, formatDate(p.paidAt)),
        h('td', { 'data-label': 'Документ' }, h('a', { href: `#/documents/${p.documentId}` }, docLabel(p))),
        h('td', { 'data-label': 'Контрагент' }, refLink('companies', p.companyId)),
        h('td', { 'data-label': 'Сума', class: 'num' }, money(p.amount, curOf(p))),
        h('td', { 'data-label': 'Валута' }, curOf(p)),
        h('td', { 'data-label': 'Начин' }, p.method),
        h('td', { 'data-label': 'Основание' }, p.reference)))))) : emptyState('wallet', 'Няма плащания', 'Плащанията се отбелязват от страницата на издадена фактура.'));
}

// --- Профил ---

const PROVIDERS = { google: 'Google', microsoft: 'Microsoft' };
function viewMe() {
  const status = new URLSearchParams(location.search).get('linked');
  if (status) history.replaceState(null, '', `${location.pathname}${location.hash}`);
  const linkAlert = h('div', { 'aria-live': 'polite' });
  const providerRow = (provider) => {
    const linked = me.security[provider];
    return h('li', { class: 'row row--between' },
      h('span', {}, h('strong', {}, PROVIDERS[provider]), ' ', h('span', { class: 'muted small' }, linked ? 'свързан' : 'не е свързан')),
      h('button', {
        class: 'btn btn--ghost btn--small', type: 'button',
        onclick: async () => {
          try {
            if (linked) {
              await api(`/account/unlink/${provider}`, { method: 'POST' });
              me = await api('/me');
              viewMe();
            } else {
              location.href = (await api(`/account/link/${provider}`, { method: 'POST' })).url;
            }
          } catch (err) {
            showError(linkAlert, err.message);
          }
        },
      }, linked ? 'Премахнете' : 'Свържете'));
  };
  const pwAlert = h('div', { 'aria-live': 'polite' });
  const form = h('form', { class: 'form', novalidate: true },
    me.security.password && field({ name: 'current', label: 'Текуща парола', type: 'password', autocomplete: 'current-password', maxlength: 128 }),
    field({ name: 'password', label: 'Нова парола', hint: 'поне 10 знака', type: 'password', autocomplete: 'new-password', maxlength: 128 }),
    pwAlert,
    h('div', {}, h('button', { class: 'btn', type: 'submit' }, me.security.password ? 'Сменете паролата' : 'Задайте парола')));
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    pwAlert.replaceChildren();
    try {
      await api('/account/password', { method: 'POST', body: formValues(form) });
      showFieldErrors(form, {});
      me = await api('/me');
      toast('Паролата е запазена.');
      viewMe();
    } catch (err) {
      showFieldErrors(form, err.fields);
      showError(pwAlert, err.message);
    }
  });
  const nameAlert = h('div', { 'aria-live': 'polite' });
  const nameForm = h('form', { class: 'form', novalidate: true },
    field({ name: 'fullName', label: 'Име и фамилия', value: me.user.name, maxlength: 120 }),
    field({ name: 'jobTitle', label: 'Длъжност', hint: 'по желание', value: me.user.jobTitle, maxlength: 120 }),
    selectField({ name: 'notifyEmail', label: 'Известия по имейл', options: [['Да', 'Да — възложени задачи, отговори по оферти и сутрешни напомняния'], ['Не', 'Не']], value: me.user.notifyEmail === false ? 'Не' : 'Да' }),
    nameAlert,
    h('div', {}, h('button', { class: 'btn', type: 'submit' }, 'Запазете')));
  nameForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await api('/account', { method: 'PATCH', body: formValues(nameForm) });
      me = await api('/me');
      toast('Запазено.');
    } catch (err) {
      showFieldErrors(nameForm, err.fields);
      showError(nameAlert, err.message);
    }
  });
  page(
    pageHead('Моят профил', [me.user.email, isPlatform() && PLATFORM_ADMIN].filter(Boolean).join(' · ')),
    h('div', { class: 'grid-2' },
      h('section', { class: 'card' }, h('h2', { style: 'margin-bottom:16px' }, 'Лични данни'), nameForm),
      h('section', { class: 'card stack' },
        h('h2', {}, 'Моите организации'),
        me.orgs.length
          ? h('ul', { class: 'linked-list' }, me.orgs.map((o) => h('li', { class: 'row row--between' },
            h('span', {}, h('strong', {}, o.name), ' ', h('span', { class: 'muted small' }, `${o.role} · ${o.plan}`)),
            o.id === orgId ? h('span', { class: 'small muted' }, 'текуща')
              : h('button', { class: 'btn btn--ghost btn--small', type: 'button', onclick: () => selectOrg(o.id) }, 'Отворете'))))
          : h('p', { class: 'small muted' }, 'Още не сте в организация.'),
        h('a', { class: 'btn btn--ghost btn--small', href: '#/new-org' }, icon('plus', 16), 'Регистрирайте нова фирма'))),
    h('div', { class: 'grid-2' },
      h('section', { class: 'card stack' },
        h('h2', {}, 'Вход с Google и Microsoft'),
        h('p', { class: 'small muted' }, 'Свържете акаунт, за да влизате с него, без парола.'),
        status && h('div', { class: `alert ${status === 'ok' ? 'alert--ok' : 'alert--error'}`, role: 'status' },
          status === 'ok' ? 'Акаунтът е свързан.' : 'Този акаунт вече е свързан с друг потребител.'),
        h('ul', { class: 'linked-list' }, providerRow('google'), providerRow('microsoft')),
        linkAlert),
      h('section', { class: 'card' }, h('h2', { style: 'margin-bottom:16px' }, me.security.password ? 'Смяна на парола' : 'Парола за вход'), form)));
}

// --- Членове на организацията (администратор) ---

function showDelivery(result, note) {
  if (result.emailed || !result.link) {
    toast(result.emailed ? `Изпратихме имейл до ${result.to}.` : 'Добавен. Ще види организацията при следващия вход.');
    return;
  }
  main.querySelector('#delivery')?.replaceChildren(linkBox(result.link, note));
  window.scrollTo(0, 0);
}

const ROLE_HELP = () => h('ul', { class: 'bullets small muted' },
  h('li', {}, 'Администратор: всичко, включително хора, настройки, лого, изтриване и анулиране на фактури.'),
  h('li', {}, 'Потребител: въвежда и променя данни, издава документи и отбелязва плащания.'),
  h('li', {}, 'Наблюдател: само преглед и експорт.'));

function viewUsers() {
  const roleSelect = (value) => selectField({ name: 'role', label: 'Роля', options: meta.roles, value });
  const invite = async () => {
    const result = await formDialog({
      title: `Поканете в ${data.org.name}`,
      fields: [
        field({ name: 'email', label: 'Имейл', type: 'email', required: true, maxlength: 200 }),
        field({ name: 'fullName', label: 'Име и фамилия', hint: 'ако още няма профил', maxlength: 120 }),
        roleSelect('Потребител'), ROLE_HELP(),
        h('p', { class: 'small muted' }, 'Ако човекът вече има профил в BulAdmin Cloud, организацията се появява в неговото меню. Иначе получава линк за парола и може да влиза и с Google или Microsoft.')],
      submitLabel: 'Поканете',
      onSubmit: (body) => api('/org/members', { method: 'POST', body }),
    });
    if (!result) return;
    await refresh();
    viewUsers();
    showDelivery(result, 'Имейлите са изключени. Изпратете този линк на новия потребител лично:');
  };
  const edit = async (u) => {
    const result = await formDialog({
      title: u.name,
      fields: [roleSelect(u.role), ROLE_HELP()],
      onSubmit: (body) => api(`/org/members/${encodeURIComponent(u.email)}`, { method: 'PATCH', body }),
    });
    if (result) { await refresh(); toast('Запазено.'); viewUsers(); }
  };
  const rows = [...data.users].sort((a, b) => (a.isActive === b.isActive ? a.name.localeCompare(b.name, 'bg') : a.isActive === 'Да' ? -1 : 1));
  page(
    h('div', { id: 'delivery' }),
    pageHead('Потребители', `${data.org.name} · ${limitText('maxUsers')} потребители по плана`,
      h('button', { class: 'btn', type: 'button', disabled: atLimit('maxUsers'), title: atLimit('maxUsers') ? 'Достигнато е ограничението на плана' : null, onclick: invite }, icon('plus', 18), 'Поканете')),
    atLimit('maxUsers') && h('div', { class: 'alert alert--warn', role: 'status' }, `Планът „${data.plan.name}“ позволява до ${data.plan.maxUsers} потребители. За повече се свържете с БУЛАДМИН.`),
    h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Име', 'Имейл', 'Роля', 'Вход', 'Последен вход', ''].map((t) => h('th', { scope: 'col' }, t)))),
      h('tbody', {}, rows.map((u) => h('tr', { class: u.isActive === 'Да' ? '' : 'is-muted' },
        h('td', { 'data-label': 'Име' }, h('span', { class: `dot ${u.isActive === 'Да' ? (u.pendingSetup ? 'dot--wait' : 'dot--on') : 'dot--off'}` }), h('strong', {}, u.name), u.jobTitle && h('div', { class: 'small muted' }, u.jobTitle)),
        h('td', { 'data-label': 'Имейл' }, u.email),
        h('td', { 'data-label': 'Роля' }, u.role, u.isActive !== 'Да' && h('div', { class: 'small text-error' }, 'без достъп')),
        h('td', { 'data-label': 'Вход' }, [u.pendingSetup ? null : u.google || u.microsoft ? null : 'парола', u.google && 'Google', u.microsoft && 'Microsoft'].filter(Boolean).join(', ') || h('span', { class: 'muted' }, 'чака първи вход')),
        h('td', { 'data-label': 'Последен вход' }, u.lastLoginAt ? timeAgo(u.lastLoginAt) : '—'),
        h('td', { class: 'td-actions' }, u.email !== me.user.email && h('div', { class: 'row-tight' },
          h('button', { class: 'btn btn--ghost btn--small', type: 'button', onclick: () => edit(u) }, 'Роля'),
          h('button', {
            class: 'btn btn--ghost btn--small', type: 'button',
            onclick: async () => {
              if (u.isActive === 'Да' && !(await confirmDialog({ title: 'Спиране на достъпа', text: `${u.name} вече няма да вижда „${data.org.name}“. Профилът и другите му организации остават.`, confirmLabel: 'Спрете', danger: true }))) return;
              await act(() => api(`/org/members/${encodeURIComponent(u.email)}`, { method: 'PATCH', body: { isActive: u.isActive !== 'Да' } }), 'Запазено.');
              viewUsers();
            },
          }, u.isActive === 'Да' ? 'Спрете достъпа' : 'Върнете достъпа')))))))));
}

// --- Настройки на организацията (администратор) ---

function planCard() {
  return h('section', { class: 'card stack' },
    h('div', { class: 'row row--between' },
      h('h2', {}, `План „${data.plan.name}“`),
      data.org.planUntil && h('span', { class: 'small muted' }, `платен до ${formatDate(data.org.planUntil)}`)),
    data.plan.description && h('p', { class: 'small muted' }, data.plan.description),
    h('table', { class: 'usage' },
      h('tbody', {}, Object.entries(meta.limits).map(([key, { label }]) => {
        const limit = data.plan[key];
        const used = data.usage[key];
        const ratio = limit === '' ? 0 : Math.min(1, used / Math.max(1, limit));
        return h('tr', {},
          h('th', { scope: 'row' }, label[0].toUpperCase() + label.slice(1)),
          h('td', { class: 'num' }, limit === '' ? `${used} · без ограничение` : `${used} от ${limit}`),
          h('td', { class: 'usage__bar' }, limit !== '' && h('span', { class: `meter ${ratio >= 1 ? 'meter--full' : ratio >= 0.8 ? 'meter--near' : ''}` },
            h('span', { style: `width:${Math.round(ratio * 100)}%` }))));
      }),
      Object.entries(meta.features).map(([key, label]) => h('tr', {}, h('th', { scope: 'row' }, label[0].toUpperCase() + label.slice(1)),
        h('td', {}, data.plan[key] === 'Да' ? 'включено' : 'не е включено'), h('td', {}))))),
    h('p', { class: 'small muted' }, 'За по-голям план пишете на ', h('a', { href: 'mailto:call@buladmin.eu' }, 'call@buladmin.eu'), '. Плановете се сменят от администраторите на БУЛАДМИН.'));
}

function logoCard() {
  const allowed = data.plan.allowLogo === 'Да';
  const input = h('input', { type: 'file', accept: 'image/png,image/jpeg', id: 'logo-file', class: 'sr-only' });
  input.addEventListener('change', async () => {
    const file = input.files[0];
    if (!file) return;
    if (!['image/png', 'image/jpeg'].includes(file.type)) { toast('Логото трябва да е PNG или JPG.', 'error'); return; }
    if (file.size > 300 * 1024) { toast('Логото трябва да е до 300 KB.', 'error'); return; }
    const ok = await act(() => api('/org/logo', { method: 'PUT', bytes: file, type: file.type }), 'Логото е качено.');
    if (ok) { logoVersion = Date.now(); logoCache = null; viewSettings(); }
  });
  return h('section', { class: `card stack ${allowed ? '' : 'card--muted'}` },
    h('h2', {}, 'Лого в офертите и фактурите'),
    allowed
      ? [
        data.org.hasLogo
          ? h('img', { class: 'logo-preview', src: logoSrc(), alt: `Лого на ${data.org.name}` })
          : h('p', { class: 'small muted' }, 'Още няма лого. PNG или JPG до 300 KB, за предпочитане с прозрачен фон и ширина поне 400 px.'),
        h('div', { class: 'row' },
          input, h('label', { for: 'logo-file', class: 'btn btn--ghost' }, icon('download', 18), data.org.hasLogo ? 'Сменете логото' : 'Качете лого'),
          data.org.hasLogo && h('button', {
            class: 'btn btn--ghost', type: 'button',
            onclick: async () => { if (await act(() => api('/org/logo', { method: 'DELETE' }), 'Логото е премахнато.')) { logoCache = null; viewSettings(); } },
          }, 'Премахнете'))]
      : h('p', { class: 'small muted' }, `Логото е платена възможност и не е включено в плана „${data.plan.name}“. В документите вместо него стои името на фирмата.`));
}

// Банковите сметки на фирмата. Броят им и сметките в други валути зависят от плана.
function accountsEditor(initial) {
  const max = data.plan.maxBankAccounts === '' ? Infinity : Number(data.plan.maxBankAccounts);
  const currencies = data.plan.allowCurrencies === 'Да' ? meta.currencies : ['EUR'];
  let rows = initial.length ? initial.map((a) => ({ ...a })) : [{ iban: '', bic: '', bank: '', currency: 'EUR', label: '' }];
  const list = h('div', { class: 'stack-tight' });
  const addButton = h('button', { class: 'btn btn--ghost btn--small', type: 'button', onclick: () => { rows.push({ iban: '', bic: '', bank: '', currency: currencies[0], label: '' }); render(); } }, icon('plus', 16), 'Добавете сметка');
  const render = () => {
    fill(list, rows.map((row, i) => {
      const input = (key, attrs) => h('input', { value: row[key] || '', oninput: (e) => { row[key] = e.target.value; }, ...attrs });
      return h('div', { class: 'account-row' },
        h('div', { class: 'field' }, h('label', {}, `Сметка ${i + 1}${i === 0 ? ' (основна)' : ''}`), input('iban', { placeholder: 'IBAN', 'aria-label': `IBAN ${i + 1}`, class: 'mono', maxlength: 40 })),
        h('div', { class: 'account-row__grid' },
          input('bic', { placeholder: 'BIC', 'aria-label': 'BIC', maxlength: 11 }),
          input('bank', { placeholder: 'Банка', 'aria-label': 'Банка', maxlength: 120 }),
          h('select', { 'aria-label': 'Валута', onchange: (e) => { row.currency = e.target.value; } }, currencies.map((c) => h('option', { value: c, selected: c === row.currency }, c))),
          input('label', { placeholder: 'Етикет (по желание)', 'aria-label': 'Етикет', maxlength: 60 })),
        rows.length > 1 && h('button', { class: 'icon-btn', type: 'button', title: 'Премахнете сметката', 'aria-label': `Премахнете сметка ${i + 1}`, onclick: () => { rows.splice(i, 1); render(); } }, icon('trash', 16)));
    }));
    addButton.hidden = rows.length >= max;
  };
  render();
  return {
    el: h('fieldset', { class: 'form-section', name: 'bankAccounts' },
      h('legend', {}, 'Банкови сметки'),
      h('p', { class: 'small muted' }, max === Infinity ? 'Изберете сметката за всяка фактура; по подразбиране е тази във валутата на документа.' : `Планът „${data.plan.name}“ позволява до ${max} ${max === 1 ? 'сметка' : 'сметки'}${data.plan.allowCurrencies === 'Да' ? '' : ' в евро'}.`),
      list, h('div', {}, addButton)),
    get: () => rows.filter((r) => r.iban.trim()).map((r) => ({ ...r, iban: r.iban.replace(/\s/g, '').toUpperCase() })),
  };
}

function viewSettings() {
  const c = data.company;
  const accounts = accountsEditor(c.bankAccounts || []);
  const alert = h('div', { 'aria-live': 'polite' });
  const f = (name, label, opts = {}) => field({ name, label, value: c[name], maxlength: name === 'address' ? 255 : 120, ...opts });
  const form = h('form', { class: 'form card', novalidate: true },
    h('h2', {}, 'Данни на фирмата за документите'),
    h('p', { class: 'small muted' }, 'Тези данни се отпечатват като доставчик във всяка оферта и фактура. Издадените документи пазят данните към момента на издаване.'),
    h('div', { class: 'form__grid' },
      f('name', 'Наименование', { wrapClass: 'full' }), f('eik', 'ЕИК', { inputmode: 'numeric' }),
      selectField({ name: 'vatRegistered', label: 'Регистрирана по ДДС', options: ['Да', 'Не'], value: c.vatRegistered }),
      f('vatNumber', 'ДДС номер', { placeholder: 'BG123456789' }), f('mol', 'МОЛ'),
      f('country', 'Държава'), f('city', 'Населено място', { hint: 'започнете да пишете' }),
      f('postcode', 'Пощенски код', { inputmode: 'numeric' }), f('region', 'Област / регион'),
      f('address', 'Адрес', { wrapClass: 'full' }),
      f('phone', 'Телефон', { type: 'tel' }), f('email', 'Имейл', { type: 'email', hint: 'на него идват отговорите на клиентите' })),
    accounts.el,
    h('h2', {}, 'Номерация и срокове'),
    h('div', { class: 'form__grid' },
      f('invoiceStart', 'Начален номер на фактурите', { inputmode: 'numeric', hint: 'ако продължавате от друга програма' }),
      f('dueDays', 'Срок за плащане по подразбиране (дни)', { inputmode: 'numeric' })),
    h('p', { class: 'small muted' }, `Основна валута: EUR${data.plan.allowCurrencies === 'Да' ? '; документите могат да са и в друга валута с курс на ЕЦБ' : ''}. Фактурите и кредитните известия са с обща поредица от 10 цифри. Офертите и проформите са с номер OF-/PF-година-пореден.`),
    alert,
    h('div', {}, h('button', { class: 'btn', type: 'submit' }, 'Запазете')));
  placeAutocomplete(form);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    alert.replaceChildren();
    try {
      const { iban, bic, bank, currency, label, ...values } = formValues(form);
      await api('/org/settings', { method: 'PUT', body: { ...values, bankAccounts: accounts.get() } });
      showFieldErrors(form, {});
      await refresh();
      me = await api('/me');
      toast('Настройките са запазени.');
    } catch (err) {
      showFieldErrors(form, err.fields);
      showError(alert, err.message);
    }
  });
  page(pageHead('Настройки', `${data.org.name}: план, лого, данни на фирмата и номерация.`),
    h('div', { class: 'split' }, form, h('div', { class: 'stack' }, planCard(), logoCard())));
}

// --- Регистрация на фирма ---

// Карта за избор на план: цена и основните ограничения.
function planOption(p, checked) {
  const limits = Object.entries(meta.limits).filter(([key]) => ['maxUsers', 'maxCompanies', 'maxInvoices', 'maxOffers'].includes(key))
    .map(([key, { label }]) => `${p[key] === '' ? 'без ограничение' : p[key]} ${label}`);
  return h('label', { class: 'plan-option' },
    h('input', { type: 'radio', name: 'planId', value: p.id, checked }),
    h('span', { class: 'plan-option__body' },
      h('span', { class: 'plan-option__head' }, h('strong', {}, p.name), h('span', { class: 'plan-option__price' }, p.price === '' ? 'цена по договаряне' : `${money(p.price)} / месец`)),
      p.description && h('span', { class: 'small muted' }, p.description),
      h('span', { class: 'small' }, [...limits, p.allowLogo === 'Да' ? 'лого в документите' : null].filter(Boolean).join(' · '))));
}

function companyForm(options, onCreated) {
  const alert = h('div', { 'aria-live': 'polite' });
  const free = options.defaultPlan;
  const planBlock = options.platform
    ? h('fieldset', { class: 'field' }, h('legend', {}, 'План'), h('p', { class: 'small muted' }, 'Като администратор на БУЛАДМИН избирате плана свободно.'),
      h('div', { class: 'plan-options' }, [free, ...options.paidPlans].map((p, i) => planOption(p, i === 0))))
    : options.freeAllowed
      ? h('p', { class: 'small muted' }, `Първата фирма в профила е безплатна: план „${free.name}“ — ${free.maxUsers} потребител, до ${free.maxCompanies} контрагента, ${free.maxInvoices} фактури и ${free.maxOffers} оферти на месец. По-голям план и лого в документите — от администраторите на БУЛАДМИН.`)
      : h('fieldset', { class: 'field' },
        h('legend', {}, 'Абонамент'),
        h('div', { class: 'alert alert--warn' }, 'Безплатният план е само за първата фирма в профила. Тази фирма е с платен абонамент: изберете план. След регистрацията БУЛАДМИН ще Ви изпрати проформа фактура и ще активира фирмата след плащането.'),
        options.paidPlans.length
          ? h('div', { class: 'plan-options' }, options.paidPlans.map((p, i) => planOption(p, i === 0)))
          : h('p', { class: 'small text-error' }, 'В момента няма платени планове. Свържете се с БУЛАДМИН на call@buladmin.eu.'));
  const form = h('form', { class: 'form', novalidate: true },
    h('div', { class: 'form__grid' },
      field({ name: 'name', label: 'Наименование на фирмата', required: true, maxlength: 120, wrapClass: 'full', placeholder: 'Пример ЕООД' }),
      field({ name: 'eik', label: 'ЕИК/БУЛСТАТ', required: true, inputmode: 'numeric', maxlength: 13 }),
      selectField({ name: 'vatRegistered', label: 'Регистрирана по ДДС', options: ['Не', 'Да'], value: 'Не' }),
      field({ name: 'vatNumber', label: 'ДДС номер', hint: 'ако е регистрирана', placeholder: 'BG123456789', maxlength: 12 }),
      field({ name: 'mol', label: 'МОЛ', hint: 'по желание', maxlength: 120 }),
      field({ name: 'country', label: 'Държава', value: DEFAULT_COUNTRY, maxlength: 120 }),
      field({ name: 'city', label: 'Населено място', hint: 'започнете да пишете', maxlength: 120 }),
      field({ name: 'postcode', label: 'Пощенски код', inputmode: 'numeric', maxlength: 20 }),
      field({ name: 'region', label: 'Област / регион', maxlength: 120 }),
      field({ name: 'address', label: 'Адрес', maxlength: 255, wrapClass: 'full' })),
    planBlock,
    alert,
    h('div', {}, h('button', { class: 'btn', type: 'submit' }, options.freeAllowed || options.platform ? 'Регистрирайте фирмата' : 'Регистрирайте и поискайте абонамент')));
  placeAutocomplete(form);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    alert.replaceChildren();
    const button = form.querySelector('button[type=submit]');
    button.disabled = true;
    try {
      const org = await api('/orgs', { method: 'POST', body: formValues(form) });
      await onCreated(org);
    } catch (err) {
      showFieldErrors(form, err.fields);
      showError(alert, err.message);
      button.disabled = false;
    }
  });
  return form;
}

async function viewNewOrg() {
  const options = await api('/orgs/options');
  page(
    pageHead(me.orgs.length ? 'Нова фирма' : `Добре дошли, ${me.user.name}`,
      me.orgs.length ? 'Регистрирайте още една фирма. Ще можете да превключвате между тях от менюто.' : 'Регистрирайте фирмата си, за да започнете. Ще бъдете неин администратор.'),
    h('div', { class: 'split' },
      h('section', { class: 'card' }, companyForm(options, async (org) => {
        me = await api('/me');
        if (org.status === 'Чака плащане') {
          toast(`„${org.name}“ е регистрирана и чака плащане на абонамент „${org.plan}“.`);
          await selectOrg(org.id, '#/');
          return;
        }
        toast(`„${org.name}“ е регистрирана.`);
        await selectOrg(org.id, '#/settings');
      })),
      h('section', { class: 'card card--tint stack' },
        h('h2', {}, 'Фирмата Ви вече е тук?'),
        h('p', { class: 'small' }, 'Ако колега вече е регистрирал фирмата, помолете го да Ви покани от „Потребители“ с имейла, с който влизате: ', h('strong', {}, me.user.email), '. Поканата е безплатна и не изисква абонамент.'),
        h('p', { class: 'small muted' }, 'Една фирма (ЕИК) може да се регистрира само веднъж.'))));
}

// --- Обявления от ЦАИС ЕОП (отворени данни на АОП в data.egov.bg) ---

async function viewEopNotices(query) {
  const params = new URLSearchParams();
  for (const key of ['q', 'cpv', 'category', 'region', 'minValue', 'page']) if (query.get(key)) params.set(key, query.get(key));
  const res = await api(`/eop/notices?${params}`);
  const go2 = (patch) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) { if (v) next.set(k, v); else next.delete(k); }
    if (!('page' in patch)) next.delete('page');
    location.hash = `#/tenders/eop?${next}`;
  };
  const form = h('form', { class: 'eop-filters', role: 'search' },
    h('label', { class: 'search' }, icon('search', 18), h('input', { type: 'search', name: 'q', value: query.get('q') || '', placeholder: 'Предмет, възложител, ЕИК или номер', 'aria-label': 'Търсене в обявленията' })),
    h('input', { name: 'cpv', value: query.get('cpv') || '', placeholder: 'CPV, напр. 45, 79211', 'aria-label': 'CPV кодове', inputmode: 'numeric' }),
    h('select', { name: 'category', 'aria-label': 'Вид' }, h('option', { value: '' }, 'Всички видове'),
      Object.entries(res.categories).map(([v, l]) => h('option', { value: v, selected: query.get('category') === v }, l))),
    h('select', { name: 'region', 'aria-label': 'Област' }, h('option', { value: '' }, 'Всички области'),
      Object.entries(res.regions).sort((a, b) => a[1].localeCompare(b[1], 'bg')).map(([v, l]) => h('option', { value: v, selected: query.get('region') === v }, l))),
    h('input', { name: 'minValue', value: query.get('minValue') || '', placeholder: 'Стойност от (EUR)', 'aria-label': 'Минимална прогнозна стойност', inputmode: 'numeric' }),
    h('button', { class: 'btn', type: 'submit' }, 'Търсете'));
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const v = formValues(form);
    go2({ q: v.q, cpv: v.cpv, category: v.category, region: v.region, minValue: v.minValue });
  });
  form.querySelectorAll('select').forEach((s) => s.addEventListener('change', () => form.requestSubmit()));

  const follow = async (n, button) => {
    button.disabled = true;
    try {
      const tender = await api(`/eop/notices/${n.id}/follow`, { method: 'POST' });
      await refresh();
      toast('Поръчката е добавена към Вашите поръчки.');
      location.hash = `#/tenders/${tender.id}`;
    } catch (err) {
      button.disabled = false;
      if (err.status === 409 && err.fields?.id) { location.hash = `#/tenders/${err.fields.id}`; return; }
      toast(err.message);
    }
  };
  const card = (n) => {
    const soon = n.deadline && Date.parse(n.deadline) - Date.now() < 5 * 864e5;
    const action = n.followedId
      ? h('a', { class: 'btn btn--ghost btn--small', href: `#/tenders/${n.followedId}` }, icon('check', 16), 'Следите я')
      : canEdit() && h('button', { class: 'btn btn--small', type: 'button', onclick: (e) => follow(n, e.currentTarget) }, icon('plus', 16), 'Следете');
    return h('article', { class: 'card eop-card' },
      h('div', { class: 'eop-card__head' },
        h('h2', { class: 'eop-card__title' }, h('a', { href: n.url, target: '_blank', rel: 'noopener' }, n.title)),
        action),
      h('p', { class: 'small' }, h('strong', {}, n.buyer), n.buyerEik && ` · ЕИК ${n.buyerEik}`, (n.city || res.regions[n.region]) && ` · ${[n.city, res.regions[n.region]].filter(Boolean).join(', ')}`),
      n.description && h('p', { class: 'small muted eop-card__desc' }, n.description),
      h('div', { class: 'eop-card__meta small' },
        h('span', {}, h('span', { class: 'muted' }, 'Срок за оферти: '), h('strong', { class: soon ? 'text-warn' : '' }, n.deadline ? formatTime(n.deadline) : '—')),
        n.value !== '' && h('span', {}, h('span', { class: 'muted' }, 'Прогнозна стойност: '), money(n.value)),
        h('span', {}, [res.categories[n.category], n.procedure, n.eu && 'над праговете на ЕС'].filter(Boolean).join(' · ')),
        n.cpv.length > 0 && h('span', {}, h('span', { class: 'muted' }, 'CPV: '), n.cpv.join(', ')),
        n.lots.length > 0 && h('span', {}, `${n.lots.length} обособени позиции`),
        h('span', { class: 'muted' }, `ID ${n.id}`)));
  };

  const pages = Math.ceil(res.total / res.pageSize);
  const pagerEl = pages > 1 && h('div', { class: 'pager' },
    h('span', { class: 'small muted' }, `Страница ${res.page} от ${pages} · ${res.total} обявления`),
    h('div', { class: 'row-tight' },
      h('button', { class: 'btn btn--ghost btn--small', type: 'button', disabled: res.page <= 1, onclick: () => go2({ page: String(res.page - 1) }) }, 'Назад'),
      h('button', { class: 'btn btn--ghost btn--small', type: 'button', disabled: res.page >= pages, onclick: () => go2({ page: String(res.page + 1) }) }, 'Напред')));

  const alertCard = () => {
    if (!isAdmin()) return null;
    const input = h('input', { id: 'f-eopCpv', name: 'cpv', value: res.cpvAlert, placeholder: 'напр. 45, 71000000, 79211' });
    const save = h('button', { class: 'btn btn--ghost btn--small', type: 'button', disabled: !canEdit() }, 'Запазете');
    save.addEventListener('click', async () => {
      const r = await act(() => api('/eop/alert', { method: 'PUT', body: { cpv: input.value } }), 'Известията са запазени.');
      if (r) input.value = r.cpvAlert;
    });
    return h('section', { class: 'card stack-tight' },
      h('h2', { class: 'card__title' }, 'Известия по имейл'),
      h('p', { class: 'small muted' }, 'При нови обявления с тези CPV кодове (или започващи с тях) хората във фирмата получават имейл всяка сутрин. Празно = без известия.'),
      h('div', { class: 'eop-alert' }, input, save));
  };

  page(
    h('a', { class: 'back', href: '#/tenders' }, icon('back', 16), 'Нашите поръчки'),
    pageHead('Обявления в ЦАИС ЕОП', `${res.open} открити поръчки със срок за оферти в бъдещето${res.total !== res.open ? ` · ${res.total} отговарят на търсенето` : ''}`),
    form,
    h('div', { class: 'split split--wide-main' },
      h('div', { class: 'stack' },
        res.items.length ? res.items.map(card) : emptyState('scale', res.open ? 'Няма съвпадения' : 'Още няма внесени обявления', res.open ? 'Променете търсенето или филтрите.' : 'Обявленията се внасят всяка сутрин.'),
        pagerEl),
      h('div', { class: 'stack' },
        alertCard(),
        h('section', { class: 'card stack-tight' },
          h('h2', { class: 'card__title' }, 'Източник'),
          h('p', { class: 'small' }, res.source, '.'),
          h('p', { class: 'small muted' }, res.importedAt ? `Обновено ${formatTime(res.importedAt)}${res.lastResourceName ? `; последни данни: ${res.lastResourceName.replace(/^.*публикувани в ЦАИС ЕОП /, '').replace(/, съгласно.*$/, '')}` : ''}.` : 'Още не е обновявано.'),
          h('p', { class: 'small muted' }, 'АОП публикува данните с няколко дни закъснение. Меродавни са обявлението и документацията в ЦАИС ЕОП; офертите се подават само там, с КЕП.')))));
}

// --- БУЛАДМИН: организации, планове, потребители ---

let platform = null;
async function loadPlatform() {
  platform = await api('/platform');
  return platform;
}
const planName = (id) => platform.plans.find((p) => p.id === id)?.name || id;

function usageSummary(o) {
  const plan = platform.plans.find((p) => p.id === o.effectivePlan) || {};
  return Object.entries(meta.limits).map(([key, { label }]) => `${label}: ${o.usage[key]}${plan[key] === '' || plan[key] === undefined ? '' : `/${plan[key]}`}`).join(' · ');
}

async function viewPlatformOrgs(query) {
  await loadPlatform();
  const q = norm(query.get('q') || '');
  const status = query.get('status') || '';
  const rows = platform.orgs
    .filter((o) => (!status || o.status === status || (status === 'paid' && o.effectivePlan !== platform.plans.find((p) => p.isDefault === 'Да')?.id)))
    .filter((o) => !q || norm(`${o.name} ${o.eik} ${o.members.map((m) => m.email).join(' ')}`).includes(q))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const search = h('input', { type: 'search', value: query.get('q') || '', placeholder: 'Име, ЕИК или имейл', 'aria-label': 'Търсене' });
  search.addEventListener('change', () => { location.hash = `#/platform?q=${encodeURIComponent(search.value)}&status=${encodeURIComponent(status)}`; });
  page(
    pageHead('Организации', `${platform.orgs.length} регистрирани · ${platform.orgs.filter((o) => o.status === 'Чака плащане').length} чакат плащане · ${platform.orgs.filter((o) => o.status === 'Спряна').length} спрени`),
    h('div', { class: 'toolbar' },
      h('label', { class: 'search' }, icon('search', 18), search),
      chips([['', 'Всички'], ['Активна', 'Активни'], ['Чака плащане', 'Чакат плащане'], ['Спряна', 'Спрени'], ['paid', 'На платен план']], status,
        (v) => { location.hash = `#/platform?q=${encodeURIComponent(search.value)}&status=${encodeURIComponent(v)}`; })),
    rows.length ? h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Организация', 'ЕИК', 'План', 'Администратори', 'Използване този месец', 'Регистрирана'].map((t) => h('th', { scope: 'col' }, t)))),
      h('tbody', {}, rows.map((o) => {
        const href = `#/platform/orgs/${o.id}`;
        const tr = h('tr', { 'data-href': href, class: o.status === 'Спряна' ? 'is-muted' : '' },
          h('td', { 'data-label': 'Организация' }, h('a', { href }, o.name), o.status === 'Спряна' && h('div', { class: 'small text-error' }, 'спряна'), o.status === 'Чака плащане' && h('div', { class: 'small text-warn' }, 'чака плащане'), o.dbStatus && !['Готова', 'Обща'].includes(o.dbStatus) && h('div', { class: 'small text-warn' }, `база: ${o.dbStatus.toLowerCase()}`)),
          h('td', { 'data-label': 'ЕИК' }, o.eik),
          h('td', { 'data-label': 'План' }, planName(o.effectivePlan), o.planUntil && h('div', { class: 'small muted' }, `до ${formatDate(o.planUntil)}`)),
          h('td', { 'data-label': 'Администратори' }, o.members.filter((m) => m.role === 'Администратор' && m.isActive === 'Да').map((m) => m.email).join(', ')),
          h('td', { 'data-label': 'Използване', class: 'small' }, `фактури ${o.usage.maxInvoices}, оферти ${o.usage.maxOffers}, контрагенти ${o.usage.maxCompanies}, хора ${o.usage.maxUsers}`),
          h('td', { 'data-label': 'Регистрирана', class: 'nowrap' }, formatDate(o.createdAt)));
        tr.addEventListener('click', (event) => { if (!event.target.closest('a')) location.hash = href; });
        return tr;
      })))) : emptyState('building', 'Няма организации'));
}

async function viewPlatformOrg(id) {
  await loadPlatform();
  const o = platform.orgs.find((x) => x.id === id);
  if (!o) { page(emptyState('alert', 'Организацията не е намерена')); return; }
  const alert = h('div', { 'aria-live': 'polite' });
  const form = h('form', { class: 'form', novalidate: true },
    h('div', { class: 'form__grid' },
      selectField({ name: 'planId', label: 'План', options: platform.plans.map((p) => [p.id, `${p.name}${p.isActive === 'Да' ? '' : ' (не се предлага)'}`]), value: o.planId }),
      field({ name: 'planUntil', label: 'Платен до', type: 'date', value: o.planUntil, hint: 'празно = без край' }),
      selectField({ name: 'status', label: 'Статус', options: ['Активна', 'Чака плащане', 'Спряна'], value: o.status }),
      selectField({ name: 'paidOnly', label: 'Само с платен план', options: [['Не', 'Не (може да е безплатна)'], ['Да', 'Да (не е първата фирма в профил)']], value: o.paidOnly ? 'Да' : 'Не' }),
      h('div', { class: 'field full' }, h('label', { for: 'f-adminNotes' }, 'Бележки на БУЛАДМИН', h('span', { class: 'field__hint' }, ' (виждат ги само администраторите на БУЛАДМИН)')),
        h('textarea', { id: 'f-adminNotes', name: 'adminNotes', rows: 3, maxlength: 8000 }, o.adminNotes))),
    h('p', { class: 'small muted' }, 'Спряната или неплатена организация е само за преглед: хората в нея виждат и изтеглят данните си, но не могат да въвеждат нови. След „Платен до“ втора фирма в профил чака плащане, а първата минава на плана по подразбиране.'),
    alert,
    h('div', {}, h('button', { class: 'btn', type: 'submit' }, 'Запазете')));
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await api(`/platform/orgs/${id}`, { method: 'PATCH', body: formValues(form) });
      toast('Запазено.');
      if (id === orgId) await refresh();
      viewPlatformOrg(id);
    } catch (err) {
      showFieldErrors(form, err.fields);
      showError(alert, err.message);
    }
  });
  const addMember = async () => {
    const result = await formDialog({
      title: `Добавете човек в ${o.name}`,
      fields: [field({ name: 'email', label: 'Имейл', type: 'email', required: true }), field({ name: 'fullName', label: 'Име', hint: 'ако още няма профил' }),
        selectField({ name: 'role', label: 'Роля', options: meta.roles, value: 'Администратор' }),
        h('p', { class: 'small muted' }, 'Ограничението на плана за брой потребители не важи, когато добавя БУЛАДМИН.')],
      submitLabel: 'Добавете',
      onSubmit: (body) => api(`/platform/orgs/${id}/members`, { method: 'POST', body }),
    });
    if (result) { await viewPlatformOrg(id); showDelivery(result, 'Изпратете този линк на човека лично:'); }
  };
  page(
    h('div', { id: 'delivery' }),
    h('a', { class: 'back', href: '#/platform' }, icon('back', 16), 'Организации'),
    pageHead(o.name, `ЕИК ${o.eik} · регистрирана ${formatDate(o.createdAt)} от ${o.createdBy}`,
      h('button', { class: 'btn btn--ghost', type: 'button', onclick: () => selectOrg(o.id) }, icon('arrow', 18), 'Влезте като администратор')),
    h('div', { class: 'split' },
      h('div', { class: 'stack' },
        h('section', { class: 'card' }, h('h2', { class: 'card__title' }, 'План и статус'), form),
        h('section', { class: 'card card--list' },
          h('div', { class: 'card__head' }, h('h2', {}, `Хора (${o.members.length})`), h('button', { class: 'btn btn--ghost btn--small', type: 'button', onclick: addMember }, icon('plus', 16), 'Добавете')),
          h('div', { class: 'table-wrap' }, h('table', {}, h('tbody', {}, o.members.map((m) => h('tr', { class: m.isActive === 'Да' ? '' : 'is-muted' },
            h('td', {}, h('strong', {}, m.name), h('div', { class: 'small muted' }, m.email)),
            h('td', {}, h('select', {
              'aria-label': `Роля на ${m.name}`,
              onchange: (e) => act(() => api(`/platform/orgs/${id}/members/${encodeURIComponent(m.email)}`, { method: 'PATCH', body: { role: e.target.value } }), 'Ролята е сменена.'),
            }, meta.roles.map((r) => h('option', { value: r, selected: r === m.role }, r)))),
            h('td', { class: 'td-actions' }, h('button', {
              class: 'btn btn--ghost btn--small', type: 'button',
              onclick: async () => { await act(() => api(`/platform/orgs/${id}/members/${encodeURIComponent(m.email)}`, { method: 'PATCH', body: { isActive: m.isActive !== 'Да' } }), 'Запазено.'); viewPlatformOrg(id); },
            }, m.isActive === 'Да' ? 'Спрете достъпа' : 'Върнете достъпа'))))))))),
      h('div', { class: 'stack' },
        h('section', { class: 'card stack-tight' },
          h('h2', { class: 'card__title' }, 'Използване'),
          h('p', { class: 'small' }, usageSummary(o)),
          h('p', { class: 'small muted' }, `Лого: ${o.hasLogo ? 'качено' : 'няма'}`)),
        dbCard(o),
        h('section', { class: 'card' }, h('h2', { class: 'card__title' }, 'Данни на фирмата'),
          h('dl', { class: 'details details--stacked' },
            [['ДДС', o.vatRegistered === 'Да' ? o.vatNumber : 'не е регистрирана'], ['МОЛ', o.mol], ['Адрес', addressLine(o)], ['Телефон', o.phone], ['Имейл', o.email]]
              .filter(([, v]) => v).flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]))),
        await historyCardFor('orgs', id))));
}

// Отделната база данни (SharePoint сайт) на организацията.
function dbCard(o) {
  const shared = o.dbStatus === 'Обща';
  const retry = async () => {
    const res = await act(() => api(`/orgs/${encodeURIComponent(o.id)}/provision`, { method: 'POST' }));
    if (res) { toast(res.dbStatus === 'Готова' ? 'Базата данни е готова.' : 'Подготовката продължава. Проверете след минута.'); viewPlatformOrg(o.id); }
  };
  return h('section', { class: 'card stack-tight' },
    h('h2', { class: 'card__title' }, 'База данни'),
    shared
      ? h('p', { class: 'small' }, 'В общия сайт на cloud (регистрирана преди отделните бази). Преместете я със scripts/migrate-org-sites.mjs.')
      : h('p', { class: 'small' }, h('span', { class: o.dbStatus === 'Готова' ? 'tag' : 'tag tag--warn' }, o.dbStatus), ' ',
        o.siteUrl ? h('a', { href: o.siteUrl, target: '_blank', rel: 'noopener' }, o.sitePath) : o.sitePath),
    o.dbError && h('p', { class: 'small text-error' }, o.dbError),
    !shared && o.dbStatus !== 'Готова' && h('div', {}, h('button', { class: 'btn btn--ghost btn--small', type: 'button', onclick: retry }, 'Подгответе базата отново')));
}

// Историята на организация се вижда от БУЛАДМИН, затова се чете в контекста на самата организация.
async function historyCardFor(entity, id) {
  const box = h('section', { class: 'card stack-tight' }, h('h2', { class: 'card__title' }, 'История'));
  const saved = orgId;
  try {
    setOrg(id);
    const events = await api(`/history/${entity}/${encodeURIComponent(id)}`);
    box.append(events.length ? h('ol', { class: 'timeline' }, events.slice(0, 20).map((e) => h('li', {},
      h('div', { class: 'timeline__head' }, h('strong', {}, e.action), h('span', {}, `${e.actorName} · ${formatTime(e.occurredAt)}`)),
      e.summary && h('p', { class: 'timeline__msg small' }, e.summary)))) : h('p', { class: 'small muted' }, 'Няма записи.'));
  } catch {
    box.append(h('p', { class: 'small muted' }, 'Историята не може да се зареди.'));
  } finally {
    setOrg(saved);
  }
  return box;
}

async function viewPlatformPlans() {
  await loadPlatform();
  const edit = async (plan) => {
    const isNew = !plan;
    const p = plan || { id: '', name: '', description: '', price: '', allowLogo: 'Да', isDefault: 'Не', isActive: 'Да', sortOrder: platform.plans.length + 1 };
    const result = await formDialog({
      title: isNew ? 'Нов план' : `План „${p.name}“`,
      wide: true,
      fields: [
        h('div', { class: 'form__grid' },
          field({ name: 'id', label: 'Код', value: p.id, hint: 'латиница, напр. standard', maxlength: 30 }),
          field({ name: 'name', label: 'Име', value: p.name, maxlength: 80 }),
          h('div', { class: 'field full' }, h('label', { for: 'f-description' }, 'Описание'), h('textarea', { id: 'f-description', name: 'description', rows: 2, maxlength: 1000 }, p.description || '')),
          field({ name: 'price', label: 'Цена на месец (EUR)', value: p.price === '' ? '' : String(p.price), inputmode: 'decimal', hint: 'за сведение' }),
          field({ name: 'sortOrder', label: 'Подредба', value: String(p.sortOrder ?? ''), inputmode: 'numeric' }),
          ...Object.entries(meta.limits).map(([key, { label }]) => field({ name: key, label: label[0].toUpperCase() + label.slice(1), value: p[key] === '' ? '' : String(p[key] ?? ''), inputmode: 'numeric', hint: 'празно = без ограничение' })),
          ...Object.entries(meta.features).map(([key, label]) => selectField({ name: key, label: label[0].toUpperCase() + label.slice(1), options: ['Да', 'Не'], value: p[key] || 'Не' })),
          selectField({ name: 'isActive', label: 'Предлага се', options: ['Да', 'Не'], value: p.isActive }),
          selectField({ name: 'isDefault', label: 'План при регистрация', options: ['Не', 'Да'], value: p.isDefault })),
      ],
      onSubmit: (body) => {
        const code = (isNew ? body.id : p.id).trim();
        return api(`/platform/plans/${encodeURIComponent(code)}`, { method: 'PUT', body });
      },
    });
    if (result) { toast('Планът е запазен.'); if (orgId) await refresh(); viewPlatformPlans(); }
  };
  const count = (id) => platform.orgs.filter((o) => o.effectivePlan === id && o.status === 'Активна').length;
  page(
    pageHead('Планове', 'Ограниченията важат веднага за всички организации на съответния план. Празно поле = без ограничение.',
      h('button', { class: 'btn', type: 'button', onclick: () => edit(null) }, icon('plus', 18), 'Нов план')),
    h('div', { class: 'plan-grid' }, platform.plans.map((p) => h('section', { class: `card stack-tight plan ${p.isActive === 'Да' ? '' : 'card--muted'}` },
      h('div', { class: 'row row--between' }, h('h2', {}, p.name), p.isDefault === 'Да' && h('span', { class: 'tag' }, 'при регистрация')),
      h('p', { class: 'small muted' }, `${p.id} · ${p.price === '' ? 'цена не е зададена' : money(p.price)} на месец · ${count(p.id)} активни организации`),
      p.description && h('p', { class: 'small' }, p.description),
      h('dl', { class: 'details' }, Object.entries(meta.limits).flatMap(([key, { label }]) => [h('dt', {}, label), h('dd', {}, p[key] === '' ? 'без ограничение' : String(p[key]))]),
        Object.entries(meta.features).flatMap(([key, label]) => [h('dt', {}, label), h('dd', {}, p[key] === 'Да' ? 'да' : 'не')])),
      h('div', {}, h('button', { class: 'btn btn--ghost btn--small', type: 'button', onclick: () => edit(p) }, icon('edit', 16), 'Промяна'))))));
}

async function viewPlatformUsers(query) {
  await loadPlatform();
  const q = norm(query.get('q') || '');
  const orgName = (id) => platform.orgs.find((o) => o.id === id)?.name || id;
  const rows = platform.users.filter((u) => !q || norm(`${u.name} ${u.email}`).includes(q))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const search = h('input', { type: 'search', value: query.get('q') || '', placeholder: 'Име или имейл', 'aria-label': 'Търсене' });
  search.addEventListener('change', () => { location.hash = `#/platform/users?q=${encodeURIComponent(search.value)}`; });
  page(
    h('div', { id: 'delivery' }),
    pageHead('Всички потребители', `${platform.users.length} профила · ${platform.users.filter((u) => u.platformRole).length} администратори на БУЛАДМИН`),
    h('label', { class: 'search' }, icon('search', 18), search),
    h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Име', 'Организации', 'Вход', 'Регистриран', ''].map((t) => h('th', { scope: 'col' }, t)))),
      h('tbody', {}, rows.map((u) => h('tr', { class: u.isActive === 'Да' ? '' : 'is-muted' },
        h('td', { 'data-label': 'Име' }, h('strong', {}, u.name), h('div', { class: 'small muted' }, u.email),
          u.platformRole && h('span', { class: 'tag' }, 'БУЛАДМИН'), !u.emailVerified && h('div', { class: 'small text-error' }, 'непотвърден имейл')),
        h('td', { 'data-label': 'Организации' }, u.orgs.map((id) => h('a', { href: `#/platform/orgs/${id}`, class: 'tag' }, orgName(id)))),
        h('td', { 'data-label': 'Вход' }, [u.pendingSetup ? 'чака първи вход' : null, u.google && 'Google', u.microsoft && 'Microsoft'].filter(Boolean).join(', ') || 'парола',
          u.lastLoginAt && h('div', { class: 'small muted' }, timeAgo(u.lastLoginAt))),
        h('td', { 'data-label': 'Регистриран', class: 'nowrap' }, formatDate(u.createdAt)),
        h('td', { class: 'td-actions' }, u.email !== me.user.email && h('div', { class: 'row-tight' },
          h('button', {
            class: 'btn btn--ghost btn--small', type: 'button',
            onclick: async () => {
              const result = await act(() => api(`/platform/users/${encodeURIComponent(u.email)}/reset`, { method: 'POST' }));
              if (result) { await viewPlatformUsers(query); showDelivery(result, `Линк за парола за ${u.name}:`); }
            },
          }, 'Линк за парола'),
          h('button', {
            class: 'btn btn--ghost btn--small', type: 'button',
            onclick: async () => {
              const making = !u.platformRole;
              if (!(await confirmDialog({ title: making ? 'Администратор на БУЛАДМИН' : 'Премахване на правата', text: making ? `${u.name} ще управлява всички организации, планове и потребители.` : `${u.name} вече няма да е администратор на БУЛАДМИН.`, confirmLabel: 'Потвърдете', danger: !making }))) return;
              await act(() => api(`/platform/users/${encodeURIComponent(u.email)}`, { method: 'PATCH', body: { platformRole: making } }), 'Запазено.');
              viewPlatformUsers(query);
            },
          }, u.platformRole ? 'Махнете БУЛАДМИН' : 'Направете БУЛАДМИН'),
          h('button', {
            class: 'btn btn--ghost btn--small', type: 'button',
            onclick: async () => {
              if (u.isActive === 'Да' && !(await confirmDialog({ title: 'Блокиране на профила', text: `${u.name} няма да може да влиза в нито една организация.`, confirmLabel: 'Блокирайте', danger: true }))) return;
              await act(() => api(`/platform/users/${encodeURIComponent(u.email)}`, { method: 'PATCH', body: { isActive: u.isActive !== 'Да' } }), 'Запазено.');
              viewPlatformUsers(query);
            },
          }, u.isActive === 'Да' ? 'Блокирайте' : 'Отблокирайте')))))))));
}

// --- Подготовка на отделната база данни (SharePoint сайт) на нова фирма ---

let provisionTimer = 0;
function viewProvisioning() {
  const status = h('p', { class: 'small muted', 'aria-live': 'polite' }, 'Създаваме отделен защитен сайт в Microsoft 365 за данните на фирмата. Обикновено отнема до минута.');
  const bar = h('div', { class: 'progress', role: 'progressbar', 'aria-label': 'Подготовка на базата данни' }, h('span', {}));
  page(h('section', { class: 'card stack narrow-card' },
    h('h1', {}, 'Подготвяме базата данни'),
    h('p', {}, 'Данните на всяка фирма се пазят в отделна база (SharePoint сайт), до която имат достъп само хората във фирмата.'),
    bar, status));
  const id = orgId;
  let step = 0;
  const tick = async () => {
    // Спира, ако потребителят е избрал друга фирма или е напуснал екрана.
    if (orgId !== id || !status.isConnected) return;
    try {
      const res = await api(`/orgs/${encodeURIComponent(id)}/provision`, { method: 'POST' });
      if (res.dbStatus === 'Готова') {
        toast('Базата данни е готова.');
        await selectOrg(id, me.orgs.find((o) => o.id === id)?.status === 'Чака плащане' ? '#/' : '#/settings');
        return;
      }
      if (res.dbStatus === 'Грешка') {
        fill(status, h('span', { class: 'text-error' }, 'Базата данни не беше създадена. Администраторите на БУЛАДМИН са уведомени и ще се свържат с Вас.'));
        bar.remove();
        return;
      }
      step += 1;
      fill(status, res.step === 'lists' ? 'Сайтът е създаден, добавяме таблиците…' : `Създаваме сайта… (${step * 5} сек.)`);
    } catch (err) {
      fill(status, h('span', { class: 'text-error' }, err.message));
    }
    clearTimeout(provisionTimer);
    provisionTimer = setTimeout(tick, 5000);
  };
  tick();
}

// --- Избор на организация и маршрути ---

let orgError = '';
let orgErrorStatus = 0;
async function selectOrg(id, hash = '#/') {
  orgId = id || '';
  setOrg(orgId);
  try { localStorage.setItem(ORG_KEY, orgId); } catch { /* изборът важи до презареждане */ }
  logoCache = null;
  logoVersion = Date.now();
  orgError = '';
  try {
    await refresh();
  } catch (err) {
    data = null;
    orgError = err.message;
    orgErrorStatus = err.status;
    syncBadges();
  }
  mount();
  go(hash);
}

function switcher() {
  if (!me.orgs.length && !isPlatform()) return null;
  const select = h('select', { id: 'org-switch', class: 'org-switch__select', 'aria-label': 'Организация' },
    !me.orgs.some((o) => o.id === orgId) && h('option', { value: orgId, selected: true }, data?.org.name || (orgId ? 'Организация' : 'Изберете организация')),
    me.orgs.map((o) => h('option', { value: o.id, selected: o.id === orgId }, o.dbStatus && o.dbStatus !== 'Готова' ? `${o.name} (подготвя се)` : (o.status === 'Активна' ? o.name : `${o.name} (${o.status.toLowerCase()})`))),
    h('option', { value: '__new' }, '+ Нова фирма'));
  select.addEventListener('change', () => {
    if (select.value === '__new') {
      select.value = orgId;
      location.hash = '#/new-org';
    } else selectOrg(select.value);
  });
  return h('div', { class: 'org-switch' }, select);
}

function nav() {
  return [
    data && { key: 'home', href: '#/', label: 'Табло', icon: 'home', match: /^\/$/ },
    data && { group: 'CRM' },
    data && { key: 'companies', href: '#/companies', label: 'Контрагенти', icon: 'building', match: /^\/companies/ },
    data && { key: 'deals', href: '#/deals', label: 'Сделки', icon: 'handshake', match: /^\/deals/ },
    data && { key: 'activities', href: '#/activities', label: 'Задачи', icon: 'check', match: /^\/activities/ },
    data && { key: 'contacts', href: '#/contacts', label: 'Лица за контакт', icon: 'users', match: /^\/contacts/ },
    data && sectionAllowed('tenders') && { group: 'Обществени поръчки' },
    data && sectionAllowed('tenders') && { key: 'tenders', href: '#/tenders', label: 'ЦАИС ЕОП', icon: 'scale', match: /^\/tenders/ },
    data && { group: 'ERP' },
    data && { key: 'documents', href: '#/documents', label: 'Оферти и фактури', icon: 'doc', match: /^\/documents/ },
    data && { key: 'payments', href: '#/payments', label: 'Плащания', icon: 'wallet', match: /^\/payments/ },
    data && { key: 'products', href: '#/products', label: 'Артикули', icon: 'box', match: /^\/products/ },
    isAdmin() && { group: 'Организация' },
    isAdmin() && { key: 'users', href: '#/users', label: 'Потребители', icon: 'team', match: /^\/users/ },
    isAdmin() && { key: 'settings', href: '#/settings', label: 'Настройки и план', icon: 'settings', match: /^\/settings/ },
    isPlatform() && { group: 'БУЛАДМИН' },
    isPlatform() && { key: 'p-orgs', href: '#/platform', label: 'Организации', icon: 'building', match: /^\/platform(\/orgs.*)?$/ },
    isPlatform() && { key: 'p-plans', href: '#/platform/plans', label: 'Планове', icon: 'chart', match: /^\/platform\/plans/ },
    isPlatform() && { key: 'p-users', href: '#/platform/users', label: 'Всички потребители', icon: 'team', match: /^\/platform\/users/ },
    !data && !me.orgs.length && { key: 'new-org', href: '#/new-org', label: 'Регистрация на фирма', icon: 'plus', match: /^\/new-org/ },
    { key: 'me', href: '#/me', label: 'Профил', icon: 'user', match: /^\/me/ },
  ].filter(Boolean);
}

async function route() {
  const [path, qs = ''] = location.hash.replace(/^#/, '').split('?');
  const query = new URLSearchParams(qs);
  const parts = (path || '/').split('/').filter(Boolean).map(decodeURIComponent);
  const [section, id, sub] = parts;
  document.title = data ? `${data.org.name} | BulAdmin CRM / ERP` : 'BulAdmin CRM / ERP';
  try {
    if (section === 'me') return viewMe();
    if (section === 'new-org') return await viewNewOrg();
    if (section === 'platform' && isPlatform()) {
      if (!id) return await viewPlatformOrgs(query);
      if (id === 'orgs' && sub) return await viewPlatformOrg(sub);
      if (id === 'plans') return await viewPlatformPlans();
      if (id === 'users') return await viewPlatformUsers(query);
    }
    if (!data) {
      if (orgErrorStatus === 409) return viewProvisioning();
      if (orgError) {
        return page(emptyState(orgErrorStatus === 402 ? 'wallet' : 'alert', orgErrorStatus === 402 ? 'Фирмата чака плащане на абонамент' : 'Няма достъп до организацията', orgError,
          h('div', { class: 'row' }, h('a', { class: 'btn', href: 'mailto:call@buladmin.eu' }, 'Пишете на БУЛАДМИН'), h('a', { class: 'btn btn--ghost', href: '#/me' }, 'Към профила'))));
      }
      if (isPlatform() && !section) return await viewPlatformOrgs(query);
      return await viewNewOrg();
    }
    if (!section) return viewDashboard();
    if (section === 'documents') return id ? await viewDocument(id, query) : viewDocuments(query);
    if (section === 'payments') return viewPayments();
    if (section === 'deals' && !id) return viewDeals(query);
    if (section === 'activities' && !id) return viewActivities();
    if (section === 'users' && isAdmin()) return viewUsers();
    if (section === 'settings' && isAdmin()) return viewSettings();
    if (meta.entities[section]?.generic && !sectionAllowed(section)) return viewUpsell(section);
    if (section === 'tenders' && id === 'eop') return await viewEopNotices(query);
    if (meta.entities[section]?.generic) return id ? await viewRecord(section, id) : viewList(section, query);
    page(emptyState('alert', 'Страницата не е намерена', null, h('a', { class: 'btn', href: '#/' }, 'Към таблото')));
  } catch (err) {
    fatal(main, err);
  }
}

function mount() {
  shell = mountShell({
    user: me.user.name,
    detail: data ? `${data.role}${data.viaPlatform ? ' (БУЛАДМИН)' : ''}` : (isPlatform() ? 'БУЛАДМИН' : ''),
    nav,
    switcher: switcher(),
  });
  main = shell.main;
  syncBadges();
}

// Профил с непотвърден имейл вижда само молба да го потвърди.
function verifyScreen() {
  const alert = h('div', { 'aria-live': 'polite' });
  document.body.replaceChildren(h('main', { id: 'main' }, h('div', { class: 'wrap wrap--narrow section' },
    h('section', { class: 'card stack' },
      h('h1', {}, 'Потвърдете имейла си'),
      h('p', {}, 'Изпратихме линк на ', h('strong', {}, me.user.email), '. Отворете го, за да започнете работа. Проверете и папката за нежелана поща.'),
      alert,
      h('div', { class: 'row' },
        h('button', {
          class: 'btn', type: 'button',
          onclick: async () => {
            try {
              await api('/auth/resend-verification', { method: 'POST' });
              alert.replaceChildren(h('div', { class: 'alert alert--ok', role: 'status' }, 'Изпратихме нов линк.'));
            } catch (err) { showError(alert, err.message); }
          },
        }, 'Изпратете нов линк'),
        h('button', { class: 'btn btn--ghost', type: 'button', onclick: async () => { await api('/auth/logout', { method: 'POST' }).catch(() => {}); location.href = '/'; } }, 'Изход'))))));
}

async function init() {
  try {
    me = await api('/me');
    if (!me.authenticated) {
      location.replace('/');
      return;
    }
    if (me.needsEmailVerification) {
      verifyScreen();
      return;
    }
    meta = await api('/meta');
  } catch (err) {
    fatal(document.body, err);
    return;
  }
  let stored = '';
  try { stored = localStorage.getItem(ORG_KEY) || ''; } catch { /* без запомнен избор */ }
  const initial = me.orgs.find((o) => o.id === stored)?.id || (isPlatform() && stored) || me.orgs[0]?.id || '';
  orgId = initial;
  setOrg(orgId);
  try {
    data = orgId ? await api('/data') : null;
  } catch (err) {
    if (err.status === 401) { location.replace('/'); return; }
    data = null;
    orgError = err.message;
    orgErrorStatus = err.status;
  }
  mount();
  window.addEventListener('hashchange', () => { loading(); route(); });
  // Данните се опресняват, когато потребителят се върне в раздела.
  document.addEventListener('visibilitychange', async () => {
    if (document.hidden || !data || document.querySelector('dialog[open]') || document.activeElement?.matches('input, textarea, select')) return;
    try {
      await refresh();
      if (!/^#\/(documents\/|settings|me|platform|new-org)/.test(location.hash)) route();
    } catch (err) {
      if (err.status === 401) location.replace('/');
    }
  });
  route();
}

init();
