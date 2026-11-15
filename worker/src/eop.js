// Обявления от ЦАИС ЕОП: отворени данни на Агенцията по обществени поръчки (АОП) във формат
// Open Contracting Data Standard (OCDS), лиценз CC0. АОП публикува по един JSON файл за всеки ден
// с всички обявления от деня на две места:
//   1. ЦАИС ЕОП → „Отворени данни“ (https://app.eop.bg/today/reporting/open-data): файлът е на постоянен
//      адрес в storage.eop.bg и излиза около 08:00 българско време на следващия ден. Основен източник.
//   2. Портал за отворени данни (data.egov.bg, организация 502): същите данни, понякога със закъснение
//      от седмици. Резервен източник, ако файлът в ЦАИС ЕОП липсва или сървърът не отговаря.
// Системата пази само откритите поръчки със срок за оферти в бъдещето.
import { clean } from './validate.js';

export const EGOV_API = 'https://data.egov.bg/api';
export const AOP_ORG_ID = 502;
export const EOP_FILE = 'ЦАИС ЕОП/обявления.json';
export const EOP_STORAGE = 'https://storage.eop.bg';
export const EOP_SOURCE = 'ЦАИС ЕОП — Отворени данни (app.eop.bg) и Портал за отворени данни (data.egov.bg), Агенция по обществени поръчки, OCDS, CC0';
const DATASET_NAME = /обявления, публикувани в ЦАИС ЕОП/i;
const BGN_PER_EUR = 1.95583; // фиксиран курс; от 1.1.2026 г. стойностите са в евро
const MAX_RESOURCES_PER_RUN = 3; // ~2–5 MB всеки; останалите се взимат при следващото пускане
const WAIT_DAYS = 3; // ден, който липсва и в двата източника, се чака толкова дни, после се пропуска

export const eopUrl = (id) => `https://app.eop.bg/today/${encodeURIComponent(id)}`;

// Области по NUTS 3 (адресът на възложителя).
export const REGIONS = {
  BG311: 'Видин', BG312: 'Монтана', BG313: 'Враца', BG314: 'Плевен', BG315: 'Ловеч',
  BG321: 'Велико Търново', BG322: 'Габрово', BG323: 'Русе', BG324: 'Разград', BG325: 'Силистра',
  BG331: 'Варна', BG332: 'Добрич', BG333: 'Шумен', BG334: 'Търговище',
  BG341: 'Бургас', BG342: 'Сливен', BG343: 'Ямбол', BG344: 'Стара Загора',
  BG411: 'София (столица)', BG412: 'София (област)', BG413: 'Благоевград', BG414: 'Перник', BG415: 'Кюстендил',
  BG421: 'Пловдив', BG422: 'Хасково', BG423: 'Пазарджик', BG424: 'Смолян', BG425: 'Кърджали',
};
export const CATEGORIES = { works: 'Строителство', goods: 'Доставки', services: 'Услуги' };

const toEur = (value) => {
  const amount = Number(value?.amount);
  if (!Number.isFinite(amount) || amount <= 0) return '';
  return Math.round((value.currency === 'BGN' ? amount / BGN_PER_EUR : amount) * 100) / 100;
};

// Вид процедура по нашия списък, само когато е еднозначно.
function procedureOf(tender) {
  const eu = tender.legalBasis?.scheme === 'CELEX';
  if (tender.procurementMethod === 'open') return eu ? 'Открита процедура' : 'Публично състезание';
  if (tender.procurementMethod === 'selective') return 'Ограничена процедура';
  return '';
}

// Компактен запис за откритата поръчка от едно OCDS издание (release).
export function compactNotice(release) {
  const t = release.tender || {};
  if (!t.id) return null;
  const buyerRef = release.buyer?.id;
  const buyer = (release.parties || []).find((p) => p.id === buyerRef || p.roles?.includes('buyer')) || {};
  const lots = (t.lots || []).map((l) => ({
    id: clean(l.id, 20),
    title: clean(l.title, 300),
    value: toEur(l.value),
    deadline: l.tenderPeriod?.endDate || '',
  }));
  const deadlines = lots.map((l) => l.deadline).filter(Boolean).sort();
  const cpv = [...new Set((t.items || []).map((i) => i.classification?.scheme === 'CPV' && i.classification.id).filter(Boolean))];
  return {
    id: String(t.id),
    title: clean(t.title, 400),
    description: clean(String(t.description || '').replace(/\s+/g, ' '), 400),
    buyer: clean(buyer.identifier?.legalName || buyer.name || release.buyer?.name, 300),
    buyerEik: clean(buyer.identifier?.scheme === 'BG-EIK' ? buyer.identifier.id : '', 13),
    city: clean(buyer.address?.locality, 80),
    region: REGIONS[buyer.address?.region] ? buyer.address.region : '',
    category: CATEGORIES[t.mainProcurementCategory] ? t.mainProcurementCategory : '',
    procedure: procedureOf(t),
    eu: t.legalBasis?.scheme === 'CELEX',
    value: toEur(t.value),
    cpv,
    lots: lots.length > 1 ? lots : [],
    deadline: deadlines[0] || '',
    lastDeadline: deadlines[deadlines.length - 1] || '',
    published: release.date || '',
  };
}

// Прилага изданията от един ден към списъка с откритите поръчки.
// Връща и събитията за поръчките, които фирмите следят (промени, класиране, договор).
export function applyReleases(notices, releases) {
  const byId = new Map(notices.map((n) => [n.id, n]));
  const events = [];
  for (const r of releases) {
    const t = r.tender || {};
    const id = t.id && String(t.id);
    if (!id) continue;
    const tags = r.tag || [];
    if ((tags.includes('tender') || tags.includes('tenderAmendment')) && t.status === 'active') {
      const notice = compactNotice(r);
      const previous = byId.get(id);
      if (notice) byId.set(id, previous ? { ...notice, published: previous.published } : notice);
      if (previous && notice && previous.deadline !== notice.deadline) events.push({ id, kind: 'deadline', deadline: notice.deadline, previous: previous.deadline });
      continue;
    }
    if (['cancelled', 'unsuccessful', 'complete', 'withdrawn'].includes(t.status) || tags.includes('award') || tags.includes('contract')) byId.delete(id);
    if (tags.includes('award') || tags.includes('contract')) {
      const suppliers = (r.parties || []).filter((p) => p.roles?.includes('supplier'))
        .map((p) => ({ name: clean(p.identifier?.legalName || p.name, 200), eik: p.identifier?.scheme === 'BG-EIK' ? String(p.identifier.id) : '' }));
      const contract = (r.contracts || [])[0];
      events.push({
        id,
        kind: tags.includes('contract') ? 'contract' : 'award',
        date: r.date || '',
        suppliers,
        contractValue: contract ? toEur(contract.value) : '',
        contractDate: contract?.dateSigned ? contract.dateSigned.slice(0, 10) : '',
      });
    } else if (['cancelled', 'unsuccessful'].includes(t.status)) {
      events.push({ id, kind: 'cancelled', date: r.date || '' });
    }
  }
  return { notices: [...byId.values()], events };
}

// Оставя само поръчките с поне един срок за оферти в бъдещето.
export const stillOpen = (notices, nowIso) => notices.filter((n) => Date.parse(n.lastDeadline || n.deadline) > Date.parse(nowIso));

const norm = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е');

export function filterNotices(notices, { q = '', cpv = '', category = '', region = '', minValue = '' } = {}) {
  const words = norm(q).split(/\s+/).filter(Boolean);
  const prefixes = String(cpv).split(/[\s,;]+/).map((c) => c.replace(/\D/g, '')).filter(Boolean);
  const min = Number(minValue) || 0;
  return notices.filter((n) => {
    if (category && n.category !== category) return false;
    if (region && n.region !== region) return false;
    if (min && !(Number(n.value) >= min)) return false;
    if (prefixes.length && !n.cpv.some((code) => prefixes.some((p) => code.startsWith(p)))) return false;
    if (words.length) {
      const text = norm(`${n.title} ${n.description} ${n.buyer} ${n.city} ${n.id} ${n.buyerEik} ${n.cpv.join(' ')}`);
      if (!words.every((w) => text.includes(w))) return false;
    }
    return true;
  });
}

// --- Портал за отворени данни ---

async function egov(fetchImpl, method, body) {
  const res = await fetchImpl(`${EGOV_API}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok && res.status !== 500) throw new Error(`data.egov.bg ${method}: ${res.status}`);
  const data = await res.json();
  if (!data.success) throw new Error(`data.egov.bg ${method}: ${data.error?.message || res.status}`);
  return data;
}

// Ресурсите (дни), публикувани след последния обработен; най-старите първо.
export async function pendingResources(fetchImpl, after = '') {
  const { datasets } = await egov(fetchImpl, 'listDatasets', { criteria: { org_ids: [AOP_ORG_ID], locale: 'bg' }, records_per_page: 100 });
  const recent = datasets
    .filter((d) => DATASET_NAME.test(d.name) && (!after || d.updated_at > after))
    .sort((a, b) => a.updated_at.localeCompare(b.updated_at))
    .slice(-3);
  const resources = [];
  for (const d of recent) {
    const { resources: list } = await egov(fetchImpl, 'listResources', { criteria: { dataset_uri: d.uri }, locale: 'bg' });
    for (const r of list) if (!after || r.created_at > after) resources.push({ uri: r.uri, name: r.name, createdAt: r.created_at });
  }
  return resources.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function resourceReleases(fetchImpl, uri) {
  const { data } = await egov(fetchImpl, 'getResourceData', { resource_uri: uri });
  return Array.isArray(data?.releases) ? data.releases : [];
}

// --- ЦАИС ЕОП → Отворени данни ---

const dmy = (iso) => iso.split('-').reverse().join('.');
export const dayName = (iso) => `Автоматично генерирани данни за обявления, публикувани в ЦАИС ЕОП на ${dmy(iso)} г., съгласно стандарт OCDS`;
export const eopDayUrl = (iso) => `${EOP_STORAGE}/open-data-${iso}/${encodeURIComponent(dayName(iso))}.json`;

// Releases за деня или null, ако файлът още не е публикуван (хранилището връща 403/404).
export async function eopDayReleases(fetchImpl, iso) {
  const res = await fetchImpl(eopDayUrl(iso), { headers: { accept: 'application/json' } });
  if (res.status === 403 || res.status === 404) return null;
  if (!res.ok) throw new Error(`storage.eop.bg ${iso}: ${res.status}`);
  const data = await res.json();
  return Array.isArray(data.releases) ? data.releases : [];
}

const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const sofiaDay = (nowIso) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Sofia' }).format(new Date(nowIso));

// Последният обработен ден; по-старите файлове пазеха само името на ресурса от data.egov.bg.
function lastDay(state, nowIso) {
  if (state.lastDate) return state.lastDate;
  const m = String(state.lastResourceName || '').match(/на (\d\d)\.(\d\d)\.(\d{4})/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  // Първият внос взима последните 45 дни: колкото обикновено е срокът за оферти.
  return addDays(sofiaDay(nowIso), -46);
}

// Една стъпка от вноса: до max нови дни. Безопасно е да се пуска многократно.
export async function importStep(fetchImpl, state, nowIso, { max = MAX_RESOURCES_PER_RUN } = {}) {
  const current = state || { notices: [] };
  const yesterday = addDays(sofiaDay(nowIso), -1);
  let day = lastDay(current, nowIso);
  let notices = current.notices;
  const events = [];
  const sources = [];
  let imported = 0;
  let skipped = 0;
  let egovList = null;
  const fromEgov = async (iso) => {
    egovList ??= await pendingResources(fetchImpl, `${addDays(iso, -1)} 00:00:00`).catch(() => []);
    const resource = egovList.find((r) => r.name.includes(`на ${dmy(iso)} г.`));
    return resource ? resourceReleases(fetchImpl, resource.uri) : null;
  };
  while (day < yesterday && imported < max) {
    const next = addDays(day, 1);
    let releases = await eopDayReleases(fetchImpl, next).catch(() => null);
    let source = 'ЦАИС ЕОП';
    if (!releases) {
      releases = await fromEgov(next).catch(() => null);
      source = 'data.egov.bg';
    }
    if (!releases) {
      // Още не е публикуван: опитва се при следващото пускане. По-стар ден без данни се пропуска.
      if (next >= addDays(yesterday, -WAIT_DAYS)) break;
      skipped += 1;
      day = next;
      continue;
    }
    const result = applyReleases(notices, releases);
    notices = result.notices;
    events.push(...result.events);
    sources.push(source);
    imported += 1;
    day = next;
  }
  notices = stillOpen(notices, nowIso);
  const remaining = Math.max(0, Math.round((Date.parse(yesterday) - Date.parse(day)) / 864e5));
  return {
    state: {
      notices,
      lastDate: day,
      lastResourceName: imported || skipped ? dayName(day) : current.lastResourceName || dayName(day),
      lastSource: sources.at(-1) || current.lastSource || '',
      importedAt: nowIso,
    },
    events,
    imported,
    skipped,
    sources,
    remaining,
  };
}
