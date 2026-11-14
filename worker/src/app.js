import {
  b64url, hashPassword, randomCode, randomToken, safeEqual, sha256, signToken, verifyPassword, verifyToken,
} from './crypto.js';
import {
  addDays, computeTotals, DEFAULT_COMPANY, DOC_TYPES, nextNumber, parseJson, paymentStatusOf, TAX_DOCS, validateLines,
} from './documents.js';
import { renderEmail } from './email.js';
import { beginLogin, completeLogin, isProvider } from './oauth.js';
import schema from './schema.json' with { type: 'json' };
import {
  clean, isValidDay, isValidEik, isValidEmail, MAX_MULTILINE, MAX_TEXT, parseNumber, passwordError, round2, validateRecord,
} from './validate.js';

export const SESSION_COOKIE = '__Host-bc_session';
const FLOW_COOKIE = '__Host-bc_oauth';
const SESSION_TTL = 12 * 3600;
const FLOW_TTL = 600;
const MAX_BODY = 256 * 1024;
const MAX_FAILED_LOGINS = 5;
const LOCK_MS = 15 * 60 * 1000;
const LINK_TTL_MS = 72 * 3600 * 1000;
const RESET_TTL_MS = 3600 * 1000;
const MAIL_THROTTLE_MS = 5 * 60 * 1000;
const PROVIDER_COLUMN = { google: 'googleId', microsoft: 'microsoftId' };
export const ROLES = ['Администратор', 'Потребител', 'Наблюдател'];
const ADMIN = 'Администратор';
const VIEWER = 'Наблюдател';

const GENERIC = Object.keys(schema).filter((key) => schema[key].generic);
const LABELS = Object.fromEntries(
  Object.entries(schema).map(([key, def]) => [key, Object.fromEntries(def.columns.map((c) => [c.name, c.label]))]),
);

// Кои записи сочат към даден раздел: изтриването е забранено, докато има такива.
const REFERENCES = [
  ...GENERIC.flatMap((entity) => schema[entity].columns.filter((c) => c.ref).map((c) => ({ entity, field: c.name, target: c.ref }))),
  { entity: 'documents', field: 'companyId', target: 'companies' },
  { entity: 'documents', field: 'dealId', target: 'deals' },
  { entity: 'payments', field: 'companyId', target: 'companies' },
];

class HttpError extends Error {
  constructor(status, message, fields) {
    super(message);
    this.status = status;
    this.fields = fields;
  }
}

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'x-robots-tag': 'noindex, nofollow',
      ...headers,
    },
  });

const redirect = (location, cookies = []) => {
  const headers = new Headers({ location, 'cache-control': 'no-store' });
  for (const cookie of cookies) headers.append('set-cookie', cookie);
  return new Response(null, { status: 302, headers });
};

const cookieHeader = (name, value, maxAge) =>
  `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;

function readCookie(request, name) {
  for (const part of (request.headers.get('cookie') || '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}

const publicUser = (u, full = false) => ({
  email: u.id,
  name: u.fullName || u.id,
  role: u.role,
  isActive: u.isActive,
  jobTitle: u.jobTitle || '',
  ...(full && {
    pendingSetup: !u.passwordHash,
    google: !!u.googleId,
    microsoft: !!u.microsoftId,
    lastLoginAt: u.lastLoginAt || '',
    createdAt: u.createdAt || '',
  }),
});

function publicDocument(d) {
  return {
    ...d,
    lines: parseJson(d.lines, []),
    buyer: parseJson(d.buyer, null),
    seller: parseJson(d.seller, null),
    subtotal: Number(d.subtotal) || 0,
    vatAmount: Number(d.vatAmount) || 0,
    total: Number(d.total) || 0,
    paidAmount: Number(d.paidAmount) || 0,
  };
}

const toNumber = (value) => (value === '' || value === null || value === undefined ? '' : Number(value));
function publicRecord(entity, r) {
  const out = { ...r };
  for (const c of schema[entity].columns) if (c.kind === 'number') out[c.name] = toNumber(r[c.name]);
  return out;
}

export function createApp({ env, store, fetchImpl = (...args) => fetch(...args), now = () => new Date() }) {
  const nowIso = () => now().toISOString().replace(/\.\d+Z$/, 'Z');
  // Датите в документите са по българско време.
  const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Sofia' }).format(now());
  const mailEnabled = env.MAIL_ENABLED === 'true';

  async function sendMail(to, subject, message) {
    if (!mailEnabled || !to) return false;
    try {
      await store.sendMail(env.MAIL_FROM, to, subject, renderEmail({ origin: env.APP_ORIGIN, preheader: subject, ...message }));
      return true;
    } catch (err) {
      console.error('mail failed', err.message);
      return false;
    }
  }

  async function rateLimit(request, bucket) {
    if (!env.LOGIN_LIMITER) return;
    const ip = request.headers.get('cf-connecting-ip') || 'unknown';
    const { success } = await env.LOGIN_LIMITER.limit({ key: `${bucket}:${ip}` });
    if (!success) throw new HttpError(429, 'Твърде много опити. Изчакайте минута и опитайте отново.');
  }

  // --- Сесии ---

  // Сесията се сверява с таблицата при всяка заявка: смяна на парола или деактивиране я спират веднага.
  async function getUser(request) {
    const session = await verifyToken(readCookie(request, SESSION_COOKIE), env.SESSION_SECRET, now().getTime());
    if (!session?.uid) return null;
    const [user] = await store.find('users', 'id', session.uid);
    if (!user || user.isActive !== 'Да' || String(user.sessionVersion || '0') !== session.ver) return null;
    return user;
  }

  async function requireUser(request) {
    const user = await getUser(request);
    if (!user) throw new HttpError(401, 'Моля, влезте в системата.');
    return user;
  }

  async function requireEditor(request) {
    const user = await requireUser(request);
    if (user.role === VIEWER) throw new HttpError(403, 'Вашият достъп е само за преглед.');
    return user;
  }

  async function requireAdmin(request) {
    const user = await requireUser(request);
    if (user.role !== ADMIN) throw new HttpError(403, 'Това действие е само за администратор.');
    return user;
  }

  const sessionCookie = async (user) => cookieHeader(
    SESSION_COOKIE,
    await signToken({ uid: user.id, ver: String(user.sessionVersion || '0') }, env.SESSION_SECRET, SESSION_TTL, now().getTime()),
    SESSION_TTL,
  );

  async function readBody(request) {
    if (!(request.headers.get('content-type') || '').startsWith('application/json')) {
      throw new HttpError(415, 'Невалидна заявка.');
    }
    const text = await request.text();
    if (text.length > MAX_BODY) throw new HttpError(413, 'Данните са твърде много.');
    try {
      const body = JSON.parse(text);
      if (body && typeof body === 'object' && !Array.isArray(body)) return body;
    } catch { /* обработва се по-долу */ }
    throw new HttpError(400, 'Невалидна заявка.');
  }

  const failIfErrors = (errors) => {
    if (Object.keys(errors).length) throw new HttpError(422, 'Проверете маркираните полета.', errors);
  };

  const audit = (user, entity, recordId, action, summary = '') => store.create('audit', {
    id: `E-${crypto.randomUUID()}`,
    entity,
    recordId,
    occurredAt: nowIso(),
    actor: user?.id || 'system',
    actorName: user?.fullName || user?.id || 'Система',
    action,
    summary,
  });

  const changedLabels = (entity, before, after) => Object.keys(after)
    .filter((key) => String(before[key] ?? '') !== String(after[key] ?? ''))
    .map((key) => LABELS[entity][key] || key);

  const newId = (entity) => `${schema[entity].prefix}-${randomCode(8)}`;

  async function getRecord(entity, id) {
    const [record] = await store.find(entity, 'id', id);
    if (!record) throw new HttpError(404, 'Записът не е намерен.');
    return record;
  }

  async function loadCompanySettings() {
    const [row] = await store.find('settings', 'id', 'company');
    return { ...DEFAULT_COMPANY, ...parseJson(row?.value, {}) };
  }

  // --- Вход с Google и Microsoft ---

  async function flowStart(provider, link) {
    const { flow, url } = await beginLogin(env, provider);
    const token = await signToken({ ...flow, link }, env.SESSION_SECRET, FLOW_TTL, now().getTime());
    return { url, cookie: cookieHeader(FLOW_COOKIE, token, FLOW_TTL) };
  }

  async function authStart(provider) {
    const { url, cookie } = await flowStart(provider);
    return redirect(url, [cookie]);
  }

  // POST, а не линк: чужд сайт не може да започне свързване от името на потребителя.
  async function linkStart(request, provider) {
    const user = await requireUser(request);
    const { url, cookie } = await flowStart(provider, user.id);
    return json({ url }, 200, { 'set-cookie': cookie });
  }

  async function unlink(request, provider) {
    const user = await requireUser(request);
    const other = provider === 'google' ? 'microsoftId' : 'googleId';
    if (!user.passwordHash && !user[other]) {
      throw new HttpError(409, 'Това е единственият Ви начин за вход. Първо задайте парола или свържете друг акаунт.');
    }
    await store.update('users', user.id, { [PROVIDER_COLUMN[provider]]: '' });
    await audit(user, 'users', user.id, `Премахнат вход с ${provider === 'google' ? 'Google' : 'Microsoft'}`);
    return json({ ok: true });
  }

  // Потребителят се открива по свързания акаунт. Ако още не е свързан, се приема само адрес, доказан от доставчика:
  // потвърден имейл в Google или служебен акаунт в нашия Microsoft 365 tenant.
  async function findUserFor(provider, identity) {
    const column = PROVIDER_COLUMN[provider];
    const [linked] = await store.find('users', column, identity.sub);
    if (linked) return linked;
    let email = '';
    if (provider === 'google') email = identity.email;
    if (provider === 'microsoft' && identity.tid === env.GRAPH_TENANT_ID) email = identity.upn;
    email = String(email || '').toLowerCase();
    if (!email) return null;
    const [user] = await store.find('users', 'id', email);
    if (!user || user[column]) return null;
    await store.update('users', user.id, { [column]: identity.sub });
    await audit(user, 'users', user.id, `Свързан вход с ${provider === 'google' ? 'Google' : 'Microsoft'}`);
    return { ...user, [column]: identity.sub };
  }

  async function authCallback(request, provider, url) {
    const clearFlow = cookieHeader(FLOW_COOKIE, '', 0);
    const failed = (code = 'login') => redirect(`/?error=${code}`, [clearFlow]);
    const flow = await verifyToken(readCookie(request, FLOW_COOKIE), env.SESSION_SECRET, now().getTime());
    const state = url.searchParams.get('state');
    const code = url.searchParams.get('code');
    if (!flow || flow.provider !== provider || !code || !safeEqual(state, flow.state)) return failed();

    let identity;
    try {
      identity = await completeLogin(env, provider, flow, code, fetchImpl, now().getTime());
    } catch (err) {
      console.error('login failed', provider, err.message);
      return failed();
    }

    if (flow.link) {
      const user = await getUser(request);
      if (!user || user.id !== flow.link) return failed();
      const [taken] = await store.find('users', PROVIDER_COLUMN[provider], identity.sub);
      if (taken && taken.id !== user.id) return redirect('/app.html?linked=used#/me', [clearFlow]);
      await store.update('users', user.id, { [PROVIDER_COLUMN[provider]]: identity.sub });
      await audit(user, 'users', user.id, `Свързан вход с ${provider === 'google' ? 'Google' : 'Microsoft'}`);
      return redirect('/app.html?linked=ok#/me', [clearFlow]);
    }

    const user = await findUserFor(provider, identity);
    if (!user) return failed('noaccount');
    if (user.isActive !== 'Да') return failed('inactive');
    await store.update('users', user.id, { lastLoginAt: nowIso() });
    return redirect('/app.html', [clearFlow, await sessionCookie(user)]);
  }

  // --- Вход с парола ---

  async function passwordLogin(request) {
    const body = await readBody(request);
    const email = clean(body.email, 200).toLowerCase();
    const password = typeof body.password === 'string' ? body.password.slice(0, 128) : '';
    const [user] = email ? await store.find('users', 'id', email) : [];
    const rejected = new HttpError(401, 'Грешен имейл или парола.');

    if (user?.lockedUntil && Date.parse(user.lockedUntil) > now().getTime()) {
      throw new HttpError(429, 'Твърде много грешни опити. Опитайте отново след 15 минути.');
    }
    const ok = await verifyPassword(password, user?.passwordHash, env.PASSWORD_PEPPER);
    if (!user) throw rejected;
    if (!ok) {
      const failures = Number(user.failedLogins || 0) + 1;
      await store.update('users', user.id, failures >= MAX_FAILED_LOGINS
        ? { failedLogins: '0', lockedUntil: new Date(now().getTime() + LOCK_MS).toISOString() }
        : { failedLogins: String(failures) });
      throw rejected;
    }
    if (user.isActive !== 'Да') throw rejected;
    await store.update('users', user.id, { failedLogins: '0', lockedUntil: '', lastLoginAt: nowIso() });
    return json({ ok: true }, 200, { 'set-cookie': await sessionCookie(user) });
  }

  const hashToken = async (token) => b64url(await sha256(token));

  // Еднократен линк за покана или нова парола. В таблицата стои само хешът му.
  async function issueSetupLink(userId, ttlMs = LINK_TTL_MS) {
    const token = `u.${randomToken()}`;
    await store.update('users', userId, {
      resetTokenHash: await hashToken(token),
      resetExpires: new Date(now().getTime() + ttlMs).toISOString(),
      resetSentAt: now().toISOString(),
    });
    return `${env.APP_ORIGIN}/set-password.html#t=${token}`;
  }

  // Отговорът е еднакъв и работата е на заден план, за да не издава дали имейлът е регистриран.
  async function forgotPassword(request, ctx) {
    const body = await readBody(request);
    const email = clean(body.email, 200).toLowerCase();
    const work = (async () => {
      const [user] = email ? await store.find('users', 'id', email) : [];
      if (!user || user.isActive !== 'Да') return;
      if (Date.parse(user.resetSentAt) > now().getTime() - MAIL_THROTTLE_MS) return;
      const link = await issueSetupLink(user.id, RESET_TTL_MS);
      await sendMail(email, 'Нова парола за BulAdmin CRM / ERP', {
        title: 'Нова парола',
        paragraphs: ['Получихме заявка за нова парола за Вашия профил в BulAdmin CRM / ERP.'],
        action: { label: 'Задайте нова парола', url: link },
        note: 'Линкът важи 1 час и може да се използва веднъж. Ако не сте поискали нова парола, не правете нищо.',
      });
    })().catch((err) => console.error('forgot failed', err.message));
    if (ctx?.waitUntil) ctx.waitUntil(work);
    else await work;
    return json({ ok: true });
  }

  async function setPasswordWithToken(request) {
    const body = await readBody(request);
    const token = typeof body.token === 'string' ? body.token : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const weak = passwordError(password);
    if (weak) throw new HttpError(422, weak, { password: weak });
    const invalid = new HttpError(400, 'Линкът е невалиден или изтекъл. Поискайте нов.');
    if (!token.startsWith('u.')) throw invalid;
    const [user] = await store.find('users', 'resetTokenHash', await hashToken(token));
    if (!user || !(Date.parse(user.resetExpires) > now().getTime()) || user.isActive !== 'Да') throw invalid;
    const patch = {
      passwordHash: await hashPassword(password, env.PASSWORD_PEPPER),
      sessionVersion: String(Number(user.sessionVersion || 0) + 1),
      failedLogins: '0',
      lockedUntil: '',
      resetTokenHash: '',
      resetExpires: '',
      lastLoginAt: nowIso(),
    };
    await store.update('users', user.id, patch);
    await audit(user, 'users', user.id, 'Зададена парола');
    return json({ destination: '/app.html' }, 200, { 'set-cookie': await sessionCookie({ ...user, ...patch }) });
  }

  async function changePassword(request) {
    const user = await requireUser(request);
    const body = await readBody(request);
    const password = typeof body.password === 'string' ? body.password : '';
    const weak = passwordError(password);
    if (weak) throw new HttpError(422, weak, { password: weak });
    if (user.passwordHash) {
      const ok = await verifyPassword(String(body.current || '').slice(0, 128), user.passwordHash, env.PASSWORD_PEPPER);
      if (!ok) throw new HttpError(422, 'Текущата парола не е вярна.', { current: 'Текущата парола не е вярна.' });
    }
    const patch = {
      passwordHash: await hashPassword(password, env.PASSWORD_PEPPER),
      sessionVersion: String(Number(user.sessionVersion || 0) + 1),
    };
    await store.update('users', user.id, patch);
    await audit(user, 'users', user.id, 'Сменена парола');
    return json({ ok: true }, 200, { 'set-cookie': await sessionCookie({ ...user, ...patch }) });
  }

  async function me(request) {
    const user = await getUser(request);
    if (!user) return json({ authenticated: false });
    return json({
      authenticated: true,
      user: publicUser(user),
      security: { password: !!user.passwordHash, google: !!user.googleId, microsoft: !!user.microsoftId },
    });
  }

  // --- Метаданни за интерфейса ---

  function meta() {
    const entities = Object.fromEntries(Object.entries(schema)
      .filter(([, def]) => def.label)
      .map(([key, def]) => [key, {
        label: def.label,
        single: def.single,
        display: def.display,
        generic: !!def.generic,
        columns: def.columns.map(({ indexed, ...c }) => c),
      }]));
    return json({ entities, roles: ROLES, docTypes: DOC_TYPES, mailEnabled });
  }

  // --- Всички данни наведнъж: таблиците са малки, а интерфейсът филтрира на място ---

  async function bootstrap(request) {
    const user = await requireUser(request);
    const [lists, users, company] = await Promise.all([
      Promise.all([...GENERIC, 'documents', 'payments'].map((e) => store.list(e))),
      store.list('users'),
      loadCompanySettings(),
    ]);
    const data = {};
    [...GENERIC, 'documents', 'payments'].forEach((entity, i) => {
      data[entity] = entity === 'documents' ? lists[i].map(publicDocument) : lists[i].map((r) => publicRecord(entity, r));
    });
    data.users = users.map((u) => publicUser(u, user.role === ADMIN));
    data.company = company;
    return json(data);
  }

  async function history(request, entity, id) {
    await requireUser(request);
    if (!schema[entity] || entity === 'settings' || entity === 'audit') throw new HttpError(404, 'Няма такъв раздел.');
    // Новите първо. SharePoint връща записите по реда на създаване, затова при еднакво време по-късният е по-нов.
    const events = (await store.find('audit', 'recordId', id))
      .map((e, i) => ({ e, i }))
      .filter(({ e }) => e.entity === entity)
      .sort((a, b) => String(b.e.occurredAt).localeCompare(String(a.e.occurredAt)) || b.i - a.i);
    return json(events.map(({ e: { actor, ...e } }) => e));
  }

  // --- Общи раздели: контрагенти, контакти, сделки, задачи, артикули ---

  async function checkRefs(entity, values, errors) {
    const users = new Set((await store.list('users')).map((u) => u.id));
    for (const column of schema[entity].columns) {
      const value = values[column.name];
      if (!value || errors[column.name]) continue;
      if (column.input === 'ref' && !(await store.find(column.ref, 'id', value)).length) errors[column.name] = 'Записът не съществува.';
      if (column.input === 'user' && !users.has(value)) errors[column.name] = 'Няма такъв потребител.';
    }
  }

  // Полета, които системата попълва сама при определени промени.
  function derived(entity, values, before = {}) {
    const extra = {};
    if (entity === 'deals' && values.stage !== undefined && values.stage !== before.stage) {
      extra.closedAt = ['Спечелена', 'Загубена'].includes(values.stage) ? nowIso() : '';
    }
    if (entity === 'activities' && values.activityStatus !== undefined && values.activityStatus !== before.activityStatus) {
      extra.doneAt = values.activityStatus === 'Изпълнена' ? nowIso() : '';
    }
    return extra;
  }

  async function createGeneric(request, entity) {
    const user = await requireEditor(request);
    const { values, errors } = validateRecord(entity, await readBody(request));
    await checkRefs(entity, values, errors);
    failIfErrors(errors);
    const stamp = nowIso();
    const record = {
      id: newId(entity),
      ...values,
      ...derived(entity, values),
      createdAt: stamp,
      updatedAt: stamp,
      ...(schema[entity].columns.some((c) => c.name === 'createdBy') && { createdBy: user.id }),
    };
    if (entity === 'activities' && !record.assignedTo) record.assignedTo = user.id;
    if (['companies', 'deals'].includes(entity) && !record.owner) record.owner = user.id;
    await store.create(entity, record);
    await audit(user, entity, record.id, 'Създаване');
    return json(publicRecord(entity, record), 201);
  }

  async function updateGeneric(request, entity, id) {
    const user = await requireEditor(request);
    const before = await getRecord(entity, id);
    const { values, errors } = validateRecord(entity, await readBody(request), { partial: true });
    await checkRefs(entity, values, errors);
    failIfErrors(errors);
    const changed = changedLabels(entity, before, values);
    if (!changed.length) return json(publicRecord(entity, before));
    const patch = { ...values, ...derived(entity, values, before), updatedAt: nowIso() };
    await store.update(entity, id, patch);
    await audit(user, entity, id, 'Промяна', changed.join(', '));
    return json(publicRecord(entity, { ...before, ...patch }));
  }

  async function deleteGeneric(request, entity, id) {
    const user = await requireAdmin(request);
    await getRecord(entity, id);
    for (const ref of REFERENCES.filter((r) => r.target === entity)) {
      if ((await store.find(ref.entity, ref.field, id)).length) {
        throw new HttpError(409, `Записът се използва в „${schema[ref.entity].label}“. Първо премахнете връзките.`);
      }
    }
    // Артикулите в издадени документи са записани в самите документи, затова тук няма проверка за тях.
    await store.remove(entity, id);
    await audit(user, entity, id, 'Изтриване');
    return json({ ok: true });
  }

  // --- Търговски документи ---

  async function documentInput(body, docType) {
    const errors = {};
    const values = {};
    const products = new Map((await store.list('products')).map((p) => [p.id, p]));
    const { lines, error } = validateLines(body.lines, products);
    if (error) errors.lines = error;

    values.companyId = clean(body.companyId, 40);
    if (!values.companyId) errors.companyId = 'Изберете контрагент.';
    else if (!(await store.find('companies', 'id', values.companyId)).length) errors.companyId = 'Контрагентът не съществува.';
    values.dealId = clean(body.dealId, 40);
    if (values.dealId && !(await store.find('deals', 'id', values.dealId)).length) errors.dealId = 'Сделката не съществува.';

    for (const field of ['issueDate', 'taxEventDate', 'dueDate']) {
      values[field] = clean(body[field], 10);
      if (values[field] && !isValidDay(values[field])) errors[field] = 'Невалидна дата.';
    }
    values.paymentMethod = clean(body.paymentMethod, 40);
    const methods = schema.documents.columns.find((c) => c.name === 'paymentMethod').choices;
    if (values.paymentMethod && !methods.includes(values.paymentMethod)) errors.paymentMethod = 'Изберете от списъка.';
    values.vatExemptReason = clean(body.vatExemptReason, MAX_TEXT);
    values.notes = clean(body.notes, MAX_MULTILINE, { multiline: true });
    values.currency = 'EUR';

    if (lines) {
      const totals = computeTotals(lines, docType);
      Object.assign(values, { lines: JSON.stringify(lines), subtotal: totals.subtotal, vatAmount: totals.vatAmount, total: totals.total });
    }
    return { values, errors, lines };
  }

  async function createDocument(request) {
    const user = await requireEditor(request);
    const body = await readBody(request);
    const docType = clean(body.docType, 40);
    if (!DOC_TYPES.includes(docType)) throw new HttpError(422, 'Невалиден вид документ.');
    const { values, errors } = await documentInput(body, docType);
    let relatedId = '';
    if (docType === 'Кредитно известие') {
      relatedId = clean(body.relatedId, 40);
      const [invoice] = relatedId ? await store.find('documents', 'id', relatedId) : [];
      if (!invoice || invoice.docType !== 'Фактура' || invoice.docStatus !== 'Издаден') {
        errors.relatedId = 'Кредитното известие трябва да е към издадена фактура.';
      }
    }
    failIfErrors(errors);
    const company = await loadCompanySettings();
    const stamp = nowIso();
    const record = {
      id: newId('documents'),
      docType,
      number: '',
      docStatus: 'Чернова',
      ...values,
      issueDate: values.issueDate || today(),
      dueDate: values.dueDate || addDays(values.issueDate || today(), docType === 'Оферта' ? 30 : Number(company.dueDays) || 7),
      relatedId,
      paidAmount: 0,
      paymentStatus: 'Неплатен',
      createdBy: user.id,
      createdAt: stamp,
      updatedAt: stamp,
    };
    await store.create('documents', record);
    await audit(user, 'documents', record.id, `Създадена чернова: ${docType}`);
    return json(publicDocument(record), 201);
  }

  async function getDraft(id) {
    const doc = await getRecord('documents', id);
    if (doc.docStatus !== 'Чернова') {
      throw new HttpError(409, 'Издаден документ не може да се променя. Анулирайте го или издайте кредитно известие.');
    }
    return doc;
  }

  async function updateDocument(request, id) {
    const user = await requireEditor(request);
    const doc = await getDraft(id);
    const { values, errors } = await documentInput(await readBody(request), doc.docType);
    failIfErrors(errors);
    const patch = { ...values, issueDate: values.issueDate || doc.issueDate, updatedAt: nowIso() };
    await store.update('documents', id, patch);
    await audit(user, 'documents', id, 'Промяна на чернова');
    return json(publicDocument({ ...doc, ...patch }));
  }

  async function deleteDocument(request, id) {
    const user = await requireEditor(request);
    const doc = await getDraft(id);
    if (user.role !== ADMIN && doc.createdBy !== user.id) throw new HttpError(403, 'Може да изтриете само свои чернови.');
    await store.remove('documents', id);
    await audit(user, 'documents', id, 'Изтрита чернова');
    return json({ ok: true });
  }

  // Наличностите се движат при издаване на фактура (намаляват) и кредитно известие (връщат се).
  async function moveStock(doc, direction) {
    if (!TAX_DOCS.includes(doc.docType)) return;
    const sign = (doc.docType === 'Фактура' ? -1 : 1) * direction;
    for (const line of parseJson(doc.lines, [])) {
      if (!line.productId) continue;
      const [product] = await store.find('products', 'id', line.productId);
      if (product?.itemType !== 'Стока') continue;
      const stock = Math.round(((Number(product.stock) || 0) + sign * line.qty) * 1000) / 1000;
      await store.update('products', product.id, { stock, updatedAt: nowIso() });
    }
  }

  // Номерът се взима при издаване. Ако двама издадат едновременно, вторият вижда дублирания номер и опитва отново.
  async function assignNumber(doc, company) {
    const year = (doc.issueDate || today()).slice(0, 4);
    for (let attempt = 0; attempt < 5; attempt++) {
      const number = nextNumber(await store.list('documents'), doc.docType, { year, invoiceStart: company.invoiceStart });
      await store.update('documents', doc.id, { number });
      const same = (await store.find('documents', 'number', number))
        .filter((d) => d.docType === doc.docType || (TAX_DOCS.includes(d.docType) && TAX_DOCS.includes(doc.docType)));
      if (same.length === 1) return number;
      await store.update('documents', doc.id, { number: '' });
    }
    throw new HttpError(409, 'Не успяхме да запазим номер. Опитайте отново.');
  }

  async function issueDocument(request, id) {
    const user = await requireEditor(request);
    const doc = await getDraft(id);
    const company = await loadCompanySettings();
    const lines = parseJson(doc.lines, []);
    if (!lines.length) throw new HttpError(422, 'Документът няма редове.');
    if (!company.name || !isValidEik(company.eik)) {
      throw new HttpError(422, 'Попълнете данните на фирмата в „Настройки“ (наименование и ЕИК), преди да издавате документи.');
    }
    const [buyer] = await store.find('companies', 'id', doc.companyId);
    if (!buyer) throw new HttpError(422, 'Контрагентът вече не съществува.');
    if (TAX_DOCS.includes(doc.docType)) {
      if (!buyer.address && !buyer.city) throw new HttpError(422, 'Попълнете адреса на контрагента, преди да издадете фактура.');
      if (company.vatRegistered === 'Не' && lines.some((l) => l.vatRate > 0)) {
        throw new HttpError(422, 'Фирмата не е регистрирана по ДДС: всички редове трябва да са с 0% ДДС.');
      }
      if (lines.some((l) => l.vatRate === 0) && !doc.vatExemptReason) {
        throw new HttpError(422, company.vatRegistered === 'Не'
          ? 'Посочете основание за неначисляване на ДДС, например „чл. 113, ал. 9 от ЗДДС“.'
          : 'При ставка 0% посочете основание за неначисляване на ДДС.');
      }
    }
    const issueDate = doc.issueDate || today();
    const number = await assignNumber({ ...doc, issueDate }, company);
    const patch = {
      number,
      docStatus: 'Издаден',
      issueDate,
      taxEventDate: doc.taxEventDate || issueDate,
      companyName: buyer.name,
      buyer: JSON.stringify({
        name: buyer.name, eik: buyer.eik, vatNumber: buyer.vatNumber, mol: buyer.mol, city: buyer.city, address: buyer.address,
      }),
      seller: JSON.stringify(company),
      issuedBy: user.fullName || user.id,
      issuedAt: nowIso(),
      updatedAt: nowIso(),
    };
    await store.update('documents', id, patch);
    const issued = { ...doc, ...patch };
    await moveStock(issued, 1);
    await audit(user, 'documents', id, `Издаден ${doc.docType} № ${number}`);
    return json(publicDocument(issued));
  }

  async function setOfferStatus(request, id) {
    const user = await requireEditor(request);
    const doc = await getRecord('documents', id);
    const { status } = await readBody(request);
    if (doc.docType !== 'Оферта' || !['Издаден', 'Приета', 'Отказана'].includes(doc.docStatus) || !['Приета', 'Отказана'].includes(status)) {
      throw new HttpError(409, 'Само издадена оферта може да се отбележи като приета или отказана.');
    }
    await store.update('documents', id, { docStatus: status, updatedAt: nowIso() });
    await audit(user, 'documents', id, `Офертата е ${status.toLowerCase()}`);
    return json(publicDocument({ ...doc, docStatus: status }));
  }

  async function cancelDocument(request, id) {
    const user = await requireEditor(request);
    const doc = await getRecord('documents', id);
    if (doc.docStatus === 'Чернова' || doc.docStatus === 'Анулиран') throw new HttpError(409, 'Документът не е издаден.');
    if (Number(doc.paidAmount) > 0) throw new HttpError(409, 'Документът има плащания. Първо ги изтрийте или издайте кредитно известие.');
    if (TAX_DOCS.includes(doc.docType) && user.role !== ADMIN) throw new HttpError(403, 'Фактури и известия се анулират само от администратор.');
    await store.update('documents', id, { docStatus: 'Анулиран', updatedAt: nowIso() });
    if (doc.docStatus === 'Издаден') await moveStock(doc, -1);
    await audit(user, 'documents', id, 'Анулиран');
    return json(publicDocument({ ...doc, docStatus: 'Анулиран' }));
  }

  // Нова чернова от съществуващ документ: оферта → проформа/фактура, фактура → кредитно известие.
  async function deriveDocument(request, id) {
    const user = await requireEditor(request);
    const source = await getRecord('documents', id);
    const { docType } = await readBody(request);
    const allowed = {
      'Оферта': ['Проформа фактура', 'Фактура'],
      'Проформа фактура': ['Фактура'],
      'Фактура': ['Кредитно известие'],
    }[source.docType] || [];
    if (!allowed.includes(docType) || ['Чернова', 'Анулиран'].includes(source.docStatus)) {
      throw new HttpError(409, 'От този документ не може да се създаде такъв.');
    }
    const lines = parseJson(source.lines, []);
    const totals = computeTotals(lines, docType);
    const company = await loadCompanySettings();
    const stamp = nowIso();
    const record = {
      id: newId('documents'),
      docType,
      number: '',
      docStatus: 'Чернова',
      issueDate: today(),
      dueDate: addDays(today(), Number(company.dueDays) || 7),
      companyId: source.companyId,
      dealId: source.dealId,
      relatedId: source.id,
      lines: source.lines,
      currency: 'EUR',
      subtotal: totals.subtotal,
      vatAmount: totals.vatAmount,
      total: totals.total,
      paidAmount: 0,
      paymentStatus: 'Неплатен',
      paymentMethod: source.paymentMethod,
      vatExemptReason: source.vatExemptReason,
      notes: docType === 'Кредитно известие' ? `Към фактура № ${source.number} от ${source.issueDate}` : '',
      createdBy: user.id,
      createdAt: stamp,
      updatedAt: stamp,
    };
    await store.create('documents', record);
    if (source.docType === 'Оферта' && source.docStatus === 'Издаден') {
      await store.update('documents', source.id, { docStatus: 'Приета', updatedAt: stamp });
    }
    await audit(user, 'documents', record.id, `Създадена чернова от ${source.docType} № ${source.number}`);
    return json(publicDocument(record), 201);
  }

  // --- Плащания ---

  async function recalcPaid(documentId) {
    const doc = await getRecord('documents', documentId);
    const paid = round2((await store.find('payments', 'documentId', documentId)).reduce((sum, p) => sum + (Number(p.amount) || 0), 0));
    const patch = { paidAmount: paid, paymentStatus: paymentStatusOf(Number(doc.total) || 0, paid), updatedAt: nowIso() };
    await store.update('documents', documentId, patch);
    return { ...doc, ...patch };
  }

  async function createPayment(request) {
    const user = await requireEditor(request);
    const body = await readBody(request);
    const errors = {};
    const documentId = clean(body.documentId, 40);
    const [doc] = documentId ? await store.find('documents', 'id', documentId) : [];
    if (!doc || doc.docStatus !== 'Издаден' || !['Фактура', 'Проформа фактура'].includes(doc.docType)) {
      errors.documentId = 'Плащане се отбелязва по издадена фактура или проформа.';
    }
    const amount = round2(parseNumber(body.amount));
    if (!(amount > 0)) errors.amount = 'Въведете положителна сума.';
    const paidAt = clean(body.paidAt, 10) || today();
    if (!isValidDay(paidAt)) errors.paidAt = 'Невалидна дата.';
    const method = clean(body.method, 40) || 'Банков превод';
    if (!schema.payments.columns.find((c) => c.name === 'method').choices.includes(method)) errors.method = 'Изберете от списъка.';
    if (doc && amount > 0 && amount > round2(Number(doc.total) - Number(doc.paidAmount || 0)) + 0.004) {
      errors.amount = `Сумата е по-голяма от остатъка (${round2(Number(doc.total) - Number(doc.paidAmount || 0)).toFixed(2)}).`;
    }
    failIfErrors(errors);
    const payment = {
      id: newId('payments'),
      documentId,
      companyId: doc.companyId,
      paidAt,
      amount,
      method,
      reference: clean(body.reference, MAX_TEXT),
      createdBy: user.id,
      createdAt: nowIso(),
    };
    await store.create('payments', payment);
    const updated = await recalcPaid(documentId);
    await audit(user, 'documents', documentId, 'Плащане', `${amount.toFixed(2)} EUR, ${method}`);
    return json({ payment: publicRecord('payments', payment), document: publicDocument(updated) }, 201);
  }

  async function deletePayment(request, id) {
    const user = await requireAdmin(request);
    const payment = await getRecord('payments', id);
    await store.remove('payments', id);
    const updated = await recalcPaid(payment.documentId);
    await audit(user, 'documents', payment.documentId, 'Изтрито плащане', `${Number(payment.amount).toFixed(2)} EUR`);
    return json({ document: publicDocument(updated) });
  }

  // --- Потребители и настройки (администратор) ---

  async function inviteUser(request) {
    const admin = await requireAdmin(request);
    const body = await readBody(request);
    const email = clean(body.email, 200).toLowerCase();
    const fullName = clean(body.fullName, 120);
    const role = clean(body.role, 40);
    const errors = {};
    if (!isValidEmail(email)) errors.email = 'Въведете валиден имейл.';
    if (!fullName) errors.fullName = 'Въведете име.';
    if (!ROLES.includes(role)) errors.role = 'Изберете роля.';
    failIfErrors(errors);
    if ((await store.find('users', 'id', email)).length) throw new HttpError(409, 'Вече има потребител с този имейл.', { email: 'Вече съществува.' });
    await store.create('users', {
      id: email, fullName, role, isActive: 'Да', jobTitle: clean(body.jobTitle, 120), sessionVersion: '0', failedLogins: '0', createdAt: nowIso(),
    });
    const link = await issueSetupLink(email);
    await audit(admin, 'users', email, 'Покана', role);
    const emailed = await sendMail(email, 'Покана за BulAdmin CRM / ERP', {
      title: 'Добре дошли в BulAdmin CRM / ERP',
      paragraphs: [
        `${admin.fullName || admin.id} Ви покани в BulAdmin CRM / ERP с роля „${role}“.`,
        'Можете да влизате с Google или Microsoft акаунт с този имейл, или да зададете парола от бутона по-долу.',
      ],
      action: { label: 'Задайте парола', url: link },
      note: 'Линкът може да се използва веднъж и важи 72 часа.',
    });
    return json(emailed ? { emailed: true, to: email } : { emailed: false, link }, 201);
  }

  async function updateUser(request, email) {
    const admin = await requireAdmin(request);
    const user = await getRecord('users', email);
    const body = await readBody(request);
    const patch = {};
    if (body.fullName !== undefined) patch.fullName = clean(body.fullName, 120) || user.fullName;
    if (body.jobTitle !== undefined) patch.jobTitle = clean(body.jobTitle, 120);
    if (body.role !== undefined) {
      if (!ROLES.includes(body.role)) throw new HttpError(422, 'Невалидна роля.');
      patch.role = body.role;
    }
    if (body.isActive !== undefined) patch.isActive = body.isActive ? 'Да' : 'Не';
    if (email === admin.id && ((patch.role && patch.role !== ADMIN) || patch.isActive === 'Не')) {
      throw new HttpError(409, 'Не можете да отнемете собствения си администраторски достъп.');
    }
    // Спрени или понижени потребители излизат веднага.
    if (patch.isActive === 'Не' || (patch.role && patch.role !== user.role)) {
      patch.sessionVersion = String(Number(user.sessionVersion || 0) + 1);
    }
    await store.update('users', email, patch);
    const changed = changedLabels('users', user, patch).filter((l) => l !== 'Версия на сесията');
    if (changed.length) await audit(admin, 'users', email, 'Промяна', changed.join(', '));
    return json(publicUser({ ...user, ...patch }, true));
  }

  async function userResetLink(request, email) {
    const admin = await requireAdmin(request);
    const user = await getRecord('users', email);
    if (user.isActive !== 'Да') throw new HttpError(409, 'Потребителят е деактивиран.');
    const link = await issueSetupLink(email);
    await audit(admin, 'users', email, 'Линк за парола');
    const emailed = await sendMail(email, 'Линк за парола за BulAdmin CRM / ERP', {
      title: 'Задайте парола',
      paragraphs: [`${admin.fullName || admin.id} Ви изпрати линк за задаване на парола.`],
      action: { label: 'Задайте парола', url: link },
      note: 'Линкът може да се използва веднъж и важи 72 часа.',
    });
    return json(emailed ? { emailed: true, to: email } : { emailed: false, link });
  }

  async function saveCompanySettings(request) {
    const admin = await requireAdmin(request);
    const body = await readBody(request);
    const values = {};
    const errors = {};
    for (const key of Object.keys(DEFAULT_COMPANY)) values[key] = clean(body[key], key === 'address' ? MAX_TEXT : 120);
    if (!values.name) errors.name = 'Задължително поле.';
    if (!isValidEik(values.eik)) errors.eik = 'Невалиден ЕИК.';
    if (!['Да', 'Не'].includes(values.vatRegistered)) errors.vatRegistered = 'Изберете.';
    if (values.vatRegistered === 'Да' && !/^BG\d{9,10}$/.test(values.vatNumber)) errors.vatNumber = 'ДДС номерът е BG и 9 или 10 цифри.';
    if (!/^\d{1,10}$/.test(values.invoiceStart || '1')) errors.invoiceStart = 'Цяло положително число.';
    if (!/^\d{1,3}$/.test(values.dueDays || '7')) errors.dueDays = 'Брой дни.';
    if (values.iban && !/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(values.iban.replace(/\s/g, ''))) errors.iban = 'Невалиден IBAN.';
    failIfErrors(errors);
    values.iban = values.iban.replace(/\s/g, '');
    values.currency = 'EUR';
    values.invoiceStart ||= '1';
    values.dueDays ||= '7';
    const row = { value: JSON.stringify(values), updatedAt: nowIso(), updatedBy: admin.id };
    if ((await store.find('settings', 'id', 'company')).length) await store.update('settings', 'company', row);
    else await store.create('settings', { id: 'company', ...row });
    await audit(admin, 'settings', 'company', 'Промяна на данните на фирмата');
    return json(values);
  }

  // --- Маршрутизиране ---

  async function route(request, url, ctx) {
    const { pathname: path } = url;
    const method = request.method;
    let m;

    if (method === 'GET' && path === '/api/meta') return meta();
    if (method === 'GET' && path === '/api/me') return me(request);
    if (method === 'GET' && (m = path.match(/^\/api\/auth\/(\w+)\/start$/)) && isProvider(m[1])) return authStart(m[1]);
    if (method === 'GET' && (m = path.match(/^\/api\/auth\/(\w+)\/callback$/)) && isProvider(m[1])) return authCallback(request, m[1], url);
    // Всичко, което проверява пароли или линкове, минава през ограничението на опитите.
    if (method === 'POST' && /^\/api\/auth\/(login|set-password|forgot)$/.test(path)) await rateLimit(request, path.split('/').pop());
    if (method === 'POST' && path === '/api/auth/login') return passwordLogin(request);
    if (method === 'POST' && path === '/api/auth/forgot') return forgotPassword(request, ctx);
    if (method === 'POST' && path === '/api/auth/set-password') return setPasswordWithToken(request);
    if (method === 'POST' && path === '/api/auth/logout') return json({ ok: true }, 200, { 'set-cookie': cookieHeader(SESSION_COOKIE, '', 0) });
    if (method === 'POST' && path === '/api/account/password') return changePassword(request);
    if (method === 'POST' && (m = path.match(/^\/api\/account\/link\/(\w+)$/)) && isProvider(m[1])) return linkStart(request, m[1]);
    if (method === 'POST' && (m = path.match(/^\/api\/account\/unlink\/(\w+)$/)) && isProvider(m[1])) return unlink(request, m[1]);

    if (method === 'GET' && path === '/api/data') return bootstrap(request);
    if (method === 'GET' && (m = path.match(/^\/api\/history\/(\w+)\/([^/]{1,200})$/))) return history(request, m[1], decodeURIComponent(m[2]));
    if ((m = path.match(/^\/api\/data\/(\w+)(?:\/([\w-]{1,40}))?$/)) && GENERIC.includes(m[1])) {
      if (method === 'POST' && !m[2]) return createGeneric(request, m[1]);
      if (method === 'PATCH' && m[2]) return updateGeneric(request, m[1], m[2]);
      if (method === 'DELETE' && m[2]) return deleteGeneric(request, m[1], m[2]);
    }

    if (method === 'POST' && path === '/api/documents') return createDocument(request);
    if ((m = path.match(/^\/api\/documents\/([\w-]{1,40})$/))) {
      if (method === 'PATCH') return updateDocument(request, m[1]);
      if (method === 'DELETE') return deleteDocument(request, m[1]);
    }
    if (method === 'POST' && (m = path.match(/^\/api\/documents\/([\w-]{1,40})\/(issue|cancel|status|derive)$/))) {
      const action = { issue: issueDocument, cancel: cancelDocument, status: setOfferStatus, derive: deriveDocument }[m[2]];
      return action(request, m[1]);
    }
    if (method === 'POST' && path === '/api/payments') return createPayment(request);
    if (method === 'DELETE' && (m = path.match(/^\/api\/payments\/([\w-]{1,40})$/))) return deletePayment(request, m[1]);

    if (method === 'POST' && path === '/api/admin/users') return inviteUser(request);
    if ((m = path.match(/^\/api\/admin\/users\/([^/]{1,200})(\/reset)?$/))) {
      const email = decodeURIComponent(m[1]).toLowerCase();
      if (method === 'PATCH' && !m[2]) return updateUser(request, email);
      if (method === 'POST' && m[2]) return userResetLink(request, email);
    }
    if (method === 'PUT' && path === '/api/admin/settings') return saveCompanySettings(request);
    throw new HttpError(404, 'Няма такъв адрес.');
  }

  return async function handle(request, ctx) {
    try {
      // SameSite=Lax пази сесията, а тази проверка спира междусайтови заявки за промяна.
      if (!['GET', 'HEAD'].includes(request.method) && request.headers.get('origin') !== env.APP_ORIGIN) {
        throw new HttpError(403, 'Заявката е отказана.');
      }
      return await route(request, new URL(request.url), ctx);
    } catch (err) {
      const known = err instanceof HttpError;
      if (!known) console.error('unhandled', err.message);
      // Браузър, отворил адреса директно, вижда страница, а не суров отговор.
      if (request.method === 'GET' && (request.headers.get('accept') || '').includes('text/html')) {
        const status = known ? err.status : 500;
        const pages = { 401: '/', 403: '/403.html', 404: '/404.html' };
        return redirect(pages[status] || '/500.html');
      }
      if (known) return json({ error: { message: err.message, fields: err.fields } }, err.status);
      return json({ error: { message: 'Възникна грешка. Опитайте отново след малко.' } }, 500);
    }
  };
}
