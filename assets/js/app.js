import {
  api, confirmDialog, downloadCsv, emptyState, fatal, field, formatDate, formatTime, formDialog, formValues, h, icon, linkBox,
  money, mountShell, norm, num, pageHead, parseNum, pill, round2, selectField, showError, showFieldErrors, timeAgo, toast, today,
} from './core.js?v=3806c5bf79';

let shell;
let main;
let meta;
let me;
let data;

const PAGE_SIZE = 50;
const OPEN_STAGES = ['Нова', 'Квалифицирана', 'Оферта', 'Преговори'];
const ENTITY_ICONS = { companies: 'building', contacts: 'users', deals: 'handshake', activities: 'check', products: 'box', documents: 'doc', payments: 'wallet' };
// Колоната, по която се филтрира с бутони в списъка на всеки раздел.
const CHIP_COLUMN = { companies: 'relation', deals: 'stage', activities: 'activityStatus', products: 'itemType' };
const PAYMENT_METHODS = ['Банков превод', 'В брой', 'С карта', 'Наложен платеж'];

const role = () => me.user.role;
const isAdmin = () => role() === 'Администратор';
const canEdit = () => role() !== 'Наблюдател';
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

function page(...children) {
  main.replaceChildren(h('div', { class: 'page page--wide' }, children));
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
  data = await api('/data');
  syncBadges();
}

const isOverdue = (a) => a.activityStatus === 'Предстои' && a.dueDate && a.dueDate < today();
const myOpenTasks = () => data.activities.filter((a) => a.assignedTo === me.user.email && a.activityStatus === 'Предстои');
function syncBadges() {
  shell.setBadges({ activities: myOpenTasks().filter((a) => a.dueDate && a.dueDate <= today()).length });
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
    const type = { email: 'email', tel: 'tel', url: 'url' }[column.input] || (column.kind === 'day' ? 'date' : 'text');
    const display = column.kind === 'number' && value !== '' && value !== undefined ? String(value).replace('.', ',') : value;
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
  if (!record && entity === 'activities') {
    values.assignedTo ??= me.user.email;
    values.dueDate ??= today();
  }
  const fields = h('div', { class: 'form__grid' }, def.columns.filter((c) => !c.system).map((c) => inputFor(entity, c, values[c.name])));
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
    .reduce((sum, d) => sum + d.subtotal, 0);
  const won = data.deals.filter((d) => d.stage === 'Спечелена' && String(d.closedAt).startsWith(month));

  page(
    pageHead(`Здравейте, ${me.user.name}`, 'Какво се случва днес в CRM и ERP.'),
    overdueDocs.length > 0 && h('a', { class: 'alert alert--error banner banner--link', href: '#/documents?type=Фактура&pay=unpaid' }, icon('alert'),
      h('div', { class: 'banner__text' },
        h('strong', {}, `Просрочени фактури: ${overdueDocs.length} за ${money(overdueDocs.reduce((s, d) => s + outstanding(d), 0))}`),
        h('p', {}, 'Падежът им е минал, а не са платени изцяло.'))),
    h('div', { class: 'kpis' },
      kpi('check', 'Мои задачи за днес и просрочени', dueNow.length, '#/activities', overdueTasks.length ? 'kpi--danger' : dueNow.length ? 'kpi--warn' : ''),
      kpi('handshake', `Отворени сделки · ${money(openDeals.reduce((s, d) => s + (Number(d.amount) || 0), 0))}`, openDeals.length, '#/deals', 'kpi--accent'),
      kpi('chart', `Спечелени този месец · ${money(won.reduce((s, d) => s + (Number(d.amount) || 0), 0))}`, won.length, '#/deals'),
      kpi('doc', 'Фактурирано този месец без ДДС', money(invoiced), '#/documents?type=Фактура'),
      kpi('wallet', 'Неплатени фактури', money(unpaidDocs.reduce((s, d) => s + outstanding(d), 0)), '#/documents?type=Фактура&pay=unpaid', overdueDocs.length ? 'kpi--warn' : '')),
    h('div', { class: 'grid-2' },
      panel('Моите задачи', '#/activities', tasks.slice(0, 8).map(taskRow), 'Нямате предстоящи задачи.'),
      panel('Неплатени фактури', '#/documents?type=Фактура&pay=unpaid', unpaidDocs.slice(0, 8).map((d) => compactRow(`#/documents/${d.id}`,
        `№ ${d.number} · ${d.companyName}`, `Падеж ${formatDate(d.dueDate)}`,
        h('span', { class: d.dueDate < today() ? 'text-error' : '' }, money(outstanding(d))))), 'Няма неплатени фактури.')),
    h('div', { class: 'grid-2' },
      panel('Сделки в процес', '#/deals', [...openDeals].sort((a, b) => (Number(b.amount) || 0) - (Number(a.amount) || 0)).slice(0, 8)
        .map((d) => compactRow(`#/deals/${d.id}`, d.title, `${titleOf('companies', find('companies', d.companyId))} · ${d.stage}`, h('span', {}, money(d.amount)))),
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
        h('td', { 'data-label': 'Сума', class: 'num' }, money(d.total)),
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
      relatedCard('Сделки', 'deals', data.deals.filter((d) => d.companyId === id), ['title', 'stage', 'amount', 'expectedClose'],
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
    const due = docs.filter((d) => d.docType === 'Фактура' && d.paymentStatus !== 'Платен').reduce((s, d) => s + outstanding(d), 0);
    const turnover = docs.filter((d) => TAX.includes(d.docType)).reduce((s, d) => s + d.subtotal, 0);
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
        h('a', { class: 'deal-card__title', href: `#/deals/${d.id}` }, d.title),
        h('span', { class: 'small muted' }, titleOf('companies', find('companies', d.companyId))),
        h('div', { class: 'deal-card__foot' },
          h('strong', {}, money(d.amount)),
          d.expectedClose && h('span', { class: `small ${OPEN_STAGES.includes(d.stage) && d.expectedClose < today() ? 'text-error' : 'muted'}` }, formatDate(d.expectedClose))),
        canEdit() && h('select', {
          class: 'deal-card__move', 'aria-label': `Етап на „${d.title}“`,
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
    const sum = rows.filter((d) => d.docStatus !== 'Анулиран' && d.docStatus !== 'Чернова').reduce((s, d) => s + d.total, 0);
    fill(results,
      rows.length > 0 && h('p', { class: 'small muted' }, `${rows.length} документа · издадени за ${money(sum)} с ДДС`),
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
          ['Вид', 'Номер', 'Дата', 'Данъчно събитие', 'Контрагент', 'ЕИК', 'ДДС номер', 'Основа', 'ДДС', 'Общо', 'Платено', 'Статус', 'Плащане'],
          filtered().map((d) => [d.docType, d.number, formatDate(d.issueDate), formatDate(d.taxEventDate), d.companyName || titleOf('companies', find('companies', d.companyId)),
            d.buyer?.eik || '', d.buyer?.vatNumber || '', String(d.subtotal).replace('.', ','), String(d.vatAmount).replace('.', ','), String(d.total).replace('.', ','),
            String(d.paidAmount).replace('.', ','), d.docStatus, d.paymentStatus])),
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
function linesEditor(initial, onChange) {
  const products = data.products.filter((p) => p.isActive !== 'Не');
  let lines = initial.map((l) => ({ ...l }));
  const body = h('tbody');
  const lineTotal = (l) => round2(parseNum(l.qty) * parseNum(l.price) * (1 - parseNum(l.discount) / 100));

  const render = () => {
    body.replaceChildren(...lines.map((line, i) => {
      const totalCell = h('td', { class: 'num', 'data-label': 'Стойност' }, money(lineTotal(line)));
      const update = (key) => (event) => {
        line[key] = event.target.value;
        totalCell.textContent = money(lineTotal(line));
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

function totalsBlock(t) {
  return h('dl', { class: 'totals' },
    t.byRate.flatMap((r) => [h('dt', {}, `Данъчна основа ${r.rate}%`), h('dd', {}, money(r.base)), h('dt', {}, `ДДС ${r.rate}%`), h('dd', {}, money(r.vat))]),
    h('dt', { class: 'totals__grand' }, 'Сума за плащане'), h('dd', { class: 'totals__grand' }, money(t.total)));
}

function documentEditor(doc, query) {
  const docType = doc?.docType || query.get('type') || 'Фактура';
  const values = doc || {
    companyId: query.get('company') || '', dealId: query.get('deal') || '', issueDate: today(), dueDate: '', paymentMethod: 'Банков превод',
    vatExemptReason: data.company.vatRegistered === 'Не' ? 'чл. 113, ал. 9 от ЗДДС' : '', notes: '', lines: [],
  };
  if (!doc && values.dealId && !values.lines.length) {
    const deal = find('deals', values.dealId);
    if (deal?.amount) values.lines = [{ productId: '', name: deal.title, qty: 1, unit: 'бр.', price: deal.amount, discount: '', vatRate: data.company.vatRegistered === 'Не' ? 0 : 20 }];
  }
  const totalsBox = h('div');
  const showTotals = (lines) => totalsBox.replaceChildren(totalsBlock(totalsOf(lines, docType)));
  const editor = linesEditor(values.lines.length ? values.lines : [{ productId: '', name: '', qty: 1, unit: 'бр.', price: '', discount: '', vatRate: data.company.vatRegistered === 'Не' ? 0 : 20 }], showTotals);
  showTotals(editor.get());
  const alert = h('div', { 'aria-live': 'polite' });
  const companies = [...data.companies].sort((a, b) => a.name.localeCompare(b.name, 'bg'));
  const dealSelect = h('select', { id: 'f-dealId', name: 'dealId' });
  const fillDeals = (companyId) => dealSelect.replaceChildren(h('option', { value: '' }, '—'),
    data.deals.filter((d) => !companyId || d.companyId === companyId).map((d) => h('option', { value: d.id, selected: d.id === values.dealId }, d.title)));
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
  p.eik && `ЕИК: ${p.eik}`, p.vatNumber && `ДДС №: ${p.vatNumber}`, [p.city, p.address].filter(Boolean).join(', '), p.mol && `МОЛ: ${p.mol}`,
].filter(Boolean);

function documentPrint(doc) {
  const seller = doc.seller || data.company;
  const company = find('companies', doc.companyId) || {};
  const buyer = doc.buyer || { name: company.name, eik: company.eik, vatNumber: company.vatNumber, mol: company.mol, city: company.city, address: company.address };
  const t = totalsOf(doc.lines, doc.docType);
  const related = doc.relatedId && find('documents', doc.relatedId);
  return h('article', { class: 'doc-print', 'aria-label': `${doc.docType} ${doc.number}` },
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
        h('td', { class: 'num' }, money(l.price)), h('td', { class: 'num' }, l.discount ? `${num(l.discount)}%` : ''), h('td', { class: 'num' }, `${l.vatRate}%`),
        h('td', { class: 'num' }, money(round2(l.qty * l.price * (1 - (l.discount || 0) / 100)))))))),
    h('div', { class: 'doc-print__foot' },
      h('div', { class: 'doc-print__pay' },
        h('p', {}, h('strong', {}, 'Начин на плащане: '), doc.paymentMethod || '—'),
        doc.paymentMethod === 'Банков превод' && seller.iban && h('p', {}, `IBAN: ${seller.iban}${seller.bic ? ` · BIC: ${seller.bic}` : ''}${seller.bank ? ` · ${seller.bank}` : ''}`),
        doc.vatExemptReason && h('p', {}, h('strong', {}, 'Основание за неначисляване на ДДС: '), doc.vatExemptReason),
        doc.notes && h('p', { class: 'pre' }, doc.notes),
        h('p', { class: 'small' }, `Съставил: ${doc.issuedBy || userName(doc.createdBy)}`)),
      totalsBlock(t)));
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
    h('div', { class: 'no-print' }, pageHead(`${doc.docType} ${doc.number}`, `${doc.companyName} · ${money(doc.total)}`,
      h('button', { class: 'btn btn--ghost', type: 'button', onclick: () => window.print() }, icon('printer', 18), 'Печат / PDF'))),
    h('div', { class: 'row no-print' }, pill(doc.docStatus, 'doc'), payable && pill(doc.paymentStatus, 'pay'), actions),
    h('div', { class: 'split' },
      h('div', { class: 'card doc-sheet' }, documentPrint(doc)),
      h('div', { class: 'stack no-print' },
        payable && h('section', { class: 'card stack-tight' },
          h('h2', { class: 'card__title' }, 'Плащания'),
          h('dl', { class: 'details' }, h('dt', {}, 'Платено'), h('dd', {}, money(doc.paidAmount)), h('dt', {}, 'Остатък'), h('dd', { class: outstanding(doc) > 0 ? 'text-error' : '' }, money(outstanding(doc)))),
          payments.length ? h('ul', { class: 'pay-list' }, payments.map((p) => h('li', {},
            h('span', {}, `${formatDate(p.paidAt)} · ${p.method}${p.reference ? ` · ${p.reference}` : ''}`),
            h('strong', {}, money(p.amount)),
            isAdmin() && h('button', {
              class: 'icon-btn', type: 'button', 'aria-label': 'Изтрийте плащането', title: 'Изтрийте плащането',
              onclick: async () => { if (await confirmDialog({ title: 'Изтриване на плащане', text: `${money(p.amount)} от ${formatDate(p.paidAt)}`, confirmLabel: 'Изтрийте', danger: true })) act(() => api(`/payments/${p.id}`, { method: 'DELETE' }), 'Плащането е изтрито.').then(route); },
            }, icon('trash', 16))))) : h('p', { class: 'small muted' }, 'Няма плащания.')),
        children.length > 0 && h('section', { class: 'card card--list' }, h('div', { class: 'card__head' }, h('h2', {}, 'Свързани документи')), documentsTable(children)),
        h('section', { class: 'card' }, h('dl', { class: 'details details--stacked' },
          h('dt', {}, 'Контрагент'), h('dd', {}, refLink('companies', doc.companyId)),
          doc.dealId && [h('dt', {}, 'Сделка'), h('dd', {}, refLink('deals', doc.dealId))],
          h('dt', {}, 'Издаден'), h('dd', {}, `${formatTime(doc.issuedAt)} · ${doc.issuedBy}`))),
        await historyCard('documents', id))));
}

async function addPayment(doc) {
  const result = await formDialog({
    title: `Плащане по ${doc.docType.toLowerCase()} № ${doc.number}`,
    fields: h('div', { class: 'form__grid' },
      field({ name: 'amount', label: 'Сума (EUR)', value: String(outstanding(doc)).replace('.', ','), inputmode: 'decimal', required: true }),
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
  const thisMonth = rows.filter((p) => p.paidAt.startsWith(month)).reduce((s, p) => s + p.amount, 0);
  const columns = [
    { name: 'paidAt', label: 'Дата', kind: 'day' }, { name: 'documentId', label: 'Документ' }, { name: 'companyId', label: 'Контрагент', input: 'ref', ref: 'companies' },
    { name: 'amount', label: 'Сума', kind: 'number', input: 'money' }, { name: 'method', label: 'Начин' }, { name: 'reference', label: 'Основание' },
  ];
  const docLabel = (p) => { const d = find('documents', p.documentId); return d ? `${d.docType} № ${d.number}` : ''; };
  page(
    pageHead('Плащания', `Постъпления този месец: ${money(thisMonth)}`,
      h('button', {
        class: 'btn btn--ghost', type: 'button',
        onclick: () => downloadCsv(`payments-${today()}.csv`, columns.map((c) => c.label),
          rows.map((p) => [formatDate(p.paidAt), docLabel(p), titleOf('companies', find('companies', p.companyId)), String(p.amount).replace('.', ','), p.method, p.reference])),
      }, icon('download', 18), 'CSV')),
    rows.length ? h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, columns.map((c) => h('th', { scope: 'col' }, c.label)))),
      h('tbody', {}, rows.map((p) => h('tr', {},
        h('td', { 'data-label': 'Дата' }, formatDate(p.paidAt)),
        h('td', { 'data-label': 'Документ' }, h('a', { href: `#/documents/${p.documentId}` }, docLabel(p))),
        h('td', { 'data-label': 'Контрагент' }, refLink('companies', p.companyId)),
        h('td', { 'data-label': 'Сума', class: 'num' }, money(p.amount)),
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
  page(
    pageHead('Моят профил', `${me.user.email} · ${me.user.role}`),
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

// --- Потребители (администратор) ---

function showDelivery(result, note) {
  if (result.emailed) {
    toast(`Изпратихме имейл до ${result.to}.`);
    return;
  }
  const box = main.querySelector('#delivery');
  box?.replaceChildren(linkBox(result.link, note));
  window.scrollTo(0, 0);
}

function viewUsers() {
  const roleSelect = (value) => selectField({ name: 'role', label: 'Роля', options: meta.roles, value });
  const roleHelp = h('ul', { class: 'bullets small muted' },
    h('li', {}, 'Администратор: всичко, включително потребители, настройки, изтриване и анулиране на фактури.'),
    h('li', {}, 'Потребител: въвежда и променя данни, издава документи и отбелязва плащания.'),
    h('li', {}, 'Наблюдател: само преглед и експорт.'));
  const invite = async () => {
    const result = await formDialog({
      title: 'Поканете потребител',
      fields: [
        field({ name: 'email', label: 'Имейл', type: 'email', required: true, maxlength: 200 }),
        field({ name: 'fullName', label: 'Име и фамилия', required: true, maxlength: 120 }),
        field({ name: 'jobTitle', label: 'Длъжност', hint: 'по желание', maxlength: 120 }),
        roleSelect('Потребител'), roleHelp,
        h('p', { class: 'small muted' }, 'Човекът ще може да влиза с Google или Microsoft акаунт с този имейл или с парола от линка в поканата.')],
      submitLabel: 'Поканете',
      onSubmit: (body) => api('/admin/users', { method: 'POST', body }),
    });
    if (!result) return;
    await refresh();
    viewUsers();
    showDelivery(result, 'Имейлите са изключени. Изпратете този линк на новия потребител лично:');
  };
  const edit = async (u) => {
    const result = await formDialog({
      title: u.name,
      fields: [field({ name: 'fullName', label: 'Име и фамилия', value: u.name, maxlength: 120 }), field({ name: 'jobTitle', label: 'Длъжност', value: u.jobTitle, maxlength: 120 }), roleSelect(u.role), roleHelp],
      onSubmit: (body) => api(`/admin/users/${encodeURIComponent(u.email)}`, { method: 'PATCH', body }),
    });
    if (result) { await refresh(); toast('Запазено.'); viewUsers(); }
  };
  const rows = [...data.users].sort((a, b) => (a.isActive === b.isActive ? a.name.localeCompare(b.name, 'bg') : a.isActive === 'Да' ? -1 : 1));
  page(
    h('div', { id: 'delivery' }),
    pageHead('Потребители', `${rows.filter((u) => u.isActive === 'Да').length} активни`, h('button', { class: 'btn', type: 'button', onclick: invite }, icon('plus', 18), 'Поканете')),
    h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Име', 'Имейл', 'Роля', 'Вход', 'Последен вход', ''].map((t) => h('th', { scope: 'col' }, t)))),
      h('tbody', {}, rows.map((u) => h('tr', { class: u.isActive === 'Да' ? '' : 'is-muted' },
        h('td', { 'data-label': 'Име' }, h('span', { class: `dot ${u.isActive === 'Да' ? (u.pendingSetup && !u.google && !u.microsoft ? 'dot--wait' : 'dot--on') : 'dot--off'}` }), h('strong', {}, u.name), u.jobTitle && h('div', { class: 'small muted' }, u.jobTitle)),
        h('td', { 'data-label': 'Имейл' }, u.email),
        h('td', { 'data-label': 'Роля' }, u.role, u.isActive !== 'Да' && h('div', { class: 'small text-error' }, 'деактивиран')),
        h('td', { 'data-label': 'Вход' }, [u.pendingSetup ? null : 'парола', u.google && 'Google', u.microsoft && 'Microsoft'].filter(Boolean).join(', ') || h('span', { class: 'muted' }, 'чака първи вход')),
        h('td', { 'data-label': 'Последен вход' }, u.lastLoginAt ? timeAgo(u.lastLoginAt) : '—'),
        h('td', { class: 'td-actions' }, u.email !== me.user.email && h('div', { class: 'row-tight' },
          h('button', { class: 'btn btn--ghost btn--small', type: 'button', onclick: () => edit(u) }, 'Промяна'),
          u.isActive === 'Да' && h('button', {
            class: 'btn btn--ghost btn--small', type: 'button',
            onclick: async () => {
              const result = await act(() => api(`/admin/users/${encodeURIComponent(u.email)}/reset`, { method: 'POST' }));
              if (result) { viewUsers(); showDelivery(result, `Линк за парола за ${u.name}:`); }
            },
          }, 'Линк за парола'),
          h('button', {
            class: 'btn btn--ghost btn--small', type: 'button',
            onclick: async () => {
              if (u.isActive === 'Да' && !(await confirmDialog({ title: 'Деактивиране', text: `${u.name} няма да може да влиза. Отворените сесии спират веднага.`, confirmLabel: 'Деактивирайте', danger: true }))) return;
              await act(() => api(`/admin/users/${encodeURIComponent(u.email)}`, { method: 'PATCH', body: { isActive: u.isActive !== 'Да' } }), 'Запазено.');
              viewUsers();
            },
          }, u.isActive === 'Да' ? 'Деактивирайте' : 'Активирайте')))))))));
}

// --- Настройки (администратор) ---

function viewSettings() {
  const c = data.company;
  const alert = h('div', { 'aria-live': 'polite' });
  const f = (name, label, opts = {}) => field({ name, label, value: c[name], maxlength: name === 'address' ? 255 : 120, ...opts });
  const form = h('form', { class: 'form card', novalidate: true },
    h('h2', {}, 'Данни на фирмата за документите'),
    h('p', { class: 'small muted' }, 'Тези данни се отпечатват като доставчик във всяка оферта и фактура. Издадените документи пазят данните към момента на издаване.'),
    h('div', { class: 'form__grid' },
      f('name', 'Наименование', { wrapClass: 'full' }), f('eik', 'ЕИК', { inputmode: 'numeric' }),
      selectField({ name: 'vatRegistered', label: 'Регистрирана по ДДС', options: ['Да', 'Не'], value: c.vatRegistered }),
      f('vatNumber', 'ДДС номер', { placeholder: 'BG123456789' }), f('mol', 'МОЛ'),
      f('city', 'Населено място'), f('address', 'Адрес'),
      f('phone', 'Телефон', { type: 'tel' }), f('email', 'Имейл', { type: 'email' }),
      f('iban', 'IBAN'), f('bic', 'BIC'), f('bank', 'Банка', { wrapClass: 'full' })),
    h('h2', {}, 'Номерация и срокове'),
    h('div', { class: 'form__grid' },
      f('invoiceStart', 'Начален номер на фактурите', { inputmode: 'numeric', hint: 'ако продължавате от друга програма' }),
      f('dueDays', 'Срок за плащане по подразбиране (дни)', { inputmode: 'numeric' })),
    h('p', { class: 'small muted' }, 'Валута: EUR. Фактурите и кредитните известия са с обща поредица от 10 цифри. Офертите и проформите са с номер OF-/PF-година-пореден.'),
    alert,
    h('div', {}, h('button', { class: 'btn', type: 'submit' }, 'Запазете')));
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    alert.replaceChildren();
    try {
      await api('/admin/settings', { method: 'PUT', body: formValues(form) });
      showFieldErrors(form, {});
      await refresh();
      toast('Настройките са запазени.');
    } catch (err) {
      showFieldErrors(form, err.fields);
      showError(alert, err.message);
    }
  });
  page(pageHead('Настройки', 'Данни на фирмата, номерация и срокове.'), h('div', { class: 'narrow' }, form));
}

// --- Маршрути ---

function nav() {
  return [
    { key: 'home', href: '#/', label: 'Табло', icon: 'home', match: /^\/$/ },
    { group: 'CRM' },
    { key: 'companies', href: '#/companies', label: 'Контрагенти', icon: 'building', match: /^\/companies/ },
    { key: 'deals', href: '#/deals', label: 'Сделки', icon: 'handshake', match: /^\/deals/ },
    { key: 'activities', href: '#/activities', label: 'Задачи', icon: 'check', match: /^\/activities/ },
    { key: 'contacts', href: '#/contacts', label: 'Лица за контакт', icon: 'users', match: /^\/contacts/ },
    { group: 'ERP' },
    { key: 'documents', href: '#/documents', label: 'Оферти и фактури', icon: 'doc', match: /^\/documents/ },
    { key: 'payments', href: '#/payments', label: 'Плащания', icon: 'wallet', match: /^\/payments/ },
    { key: 'products', href: '#/products', label: 'Артикули', icon: 'box', match: /^\/products/ },
    isAdmin() && { group: 'Администрация' },
    isAdmin() && { key: 'users', href: '#/users', label: 'Потребители', icon: 'team', match: /^\/users/ },
    isAdmin() && { key: 'settings', href: '#/settings', label: 'Настройки', icon: 'settings', match: /^\/settings/ },
    { key: 'me', href: '#/me', label: 'Профил', icon: 'user', match: /^\/me/ },
  ].filter(Boolean);
}

async function route() {
  const [path, qs = ''] = location.hash.replace(/^#/, '').split('?');
  const query = new URLSearchParams(qs);
  const parts = (path || '/').split('/').filter(Boolean).map(decodeURIComponent);
  const [section, id] = parts;
  document.title = 'BulAdmin CRM / ERP';
  try {
    if (!section) return viewDashboard();
    if (section === 'documents') return id ? await viewDocument(id, query) : viewDocuments(query);
    if (section === 'payments') return viewPayments();
    if (section === 'deals' && !id) return viewDeals(query);
    if (section === 'activities' && !id) return viewActivities();
    if (section === 'me') return viewMe();
    if (section === 'users' && isAdmin()) return viewUsers();
    if (section === 'settings' && isAdmin()) return viewSettings();
    if (meta.entities[section]?.generic) return id ? await viewRecord(section, id) : viewList(section, query);
    page(emptyState('alert', 'Страницата не е намерена', null, h('a', { class: 'btn', href: '#/' }, 'Към таблото')));
  } catch (err) {
    fatal(main, err);
  }
}

async function init() {
  try {
    me = await api('/me');
    if (!me.authenticated) {
      location.replace('/');
      return;
    }
    [meta, data] = await Promise.all([api('/meta'), api('/data')]);
  } catch (err) {
    fatal(document.body, err);
    return;
  }
  shell = mountShell({ user: me.user.name, detail: me.user.role, nav });
  main = shell.main;
  syncBadges();
  window.addEventListener('hashchange', () => { loading(); route(); });
  // Данните се опресняват, когато потребителят се върне в раздела.
  document.addEventListener('visibilitychange', async () => {
    if (document.hidden || document.querySelector('dialog[open]') || document.activeElement?.matches('input, textarea, select')) return;
    try {
      await refresh();
      if (!location.hash.startsWith('#/documents/') && !location.hash.startsWith('#/settings') && !location.hash.startsWith('#/me')) route();
    } catch (err) {
      if (err.status === 401) location.replace('/');
    }
  });
  route();
}

init();
