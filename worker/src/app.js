import {
  b64url, hashPassword, randomCode, randomToken, safeEqual, sha256, signToken, verifyPassword, verifyToken,
} from './crypto.js';
import {
  addDays, computeTotals, DEFAULT_COMPANY, DOC_TYPES, nextNumber, parseJson, paymentStatusOf, TAX_DOCS, validateLines,
} from './documents.js';
import { renderEmail } from './email.js';
import { beginLogin, completeLogin, isProvider } from './oauth.js';
import {
  DEFAULT_PLANS, DOC_LIMIT, effectivePlan, ENTITY_LIMIT, LIMITS, limitOf, PLAN_NUMBERS, usageOf,
} from './plans.js';
import schema from './schema.json' with { type: 'json' };
import {
  clean, isValidDay, isValidEik, isValidEmail, MAX_MULTILINE, MAX_TEXT, parseNumber, passwordError, round2, validateRecord,
} from './validate.js';

export const SESSION_COOKIE = '__Host-bc_session';
const FLOW_COOKIE = '__Host-bc_oauth';
const SESSION_TTL = 12 * 3600;
const FLOW_TTL = 600;
const MAX_BODY = 256 * 1024;
const MAX_LOGO_BYTES = 300 * 1024;
const MAX_FAILED_LOGINS = 5;
const LOCK_MS = 15 * 60 * 1000;
const LINK_TTL_MS = 72 * 3600 * 1000;
const RESET_TTL_MS = 3600 * 1000;
const VERIFY_TTL_MS = 7 * 24 * 3600 * 1000;
const MAIL_THROTTLE_MS = 5 * 60 * 1000;
const PROVIDER_COLUMN = { google: 'googleId', microsoft: 'microsoftId' };
const PROVIDER_NAME = { google: 'Google', microsoft: 'Microsoft' };
export const ROLES = ['Администратор', 'Потребител', 'Наблюдател'];
const ADMIN = 'Администратор';
const VIEWER = 'Наблюдател';
const PLATFORM_ADMIN = 'Администратор на БУЛАДМИН';
const ORG_HEADER = 'x-org';

const GENERIC = Object.keys(schema).filter((key) => schema[key].generic);
const LABELS = Object.fromEntries(
  Object.entries(schema).map(([key, def]) => [key, Object.fromEntries(def.columns.map((c) => [c.name, c.label]))]),
);
const COMPANY_FIELDS = Object.keys(DEFAULT_COMPANY).filter((k) => k !== 'currency');

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

const publicUser = (u) => ({
  email: u.id,
  name: u.fullName || u.id,
  isActive: u.isActive,
  jobTitle: u.jobTitle || '',
  platformRole: u.platformRole || '',
  pendingSetup: !u.passwordHash && !u.googleId && !u.microsoftId,
  google: !!u.googleId,
  microsoft: !!u.microsoftId,
  emailVerified: !u.verifyTokenHash || !!u.emailVerifiedAt,
  lastLoginAt: u.lastLoginAt || '',
  createdAt: u.createdAt || '',
});

function publicDocument(d) {
  const { orgId, ...rest } = d;
  return {
    ...rest,
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
  const { orgId, ...out } = r;
  for (const c of schema[entity].columns) if (c.kind === 'number') out[c.name] = toNumber(r[c.name]);
  return out;
}

function publicPlan(p) {
  const out = { ...p };
  for (const key of PLAN_NUMBERS) out[key] = toNumber(p[key]);
  return out;
}

const companyOf = (org) => Object.fromEntries(COMPANY_FIELDS.map((k) => [k, org[k] ?? DEFAULT_COMPANY[k]]));

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

  // Профил, създаден с регистрация или с Microsoft акаунт от друга организация, работи едва след потвърден имейл.
  const needsVerification = (user) => !!user.verifyTokenHash && !user.emailVerifiedAt;
  const isPlatformAdmin = (user) => user.platformRole === PLATFORM_ADMIN;

  async function requireUser(request, { allowUnverified = false } = {}) {
    const user = await getUser(request);
    if (!user) throw new HttpError(401, 'Моля, влезте в системата.');
    if (!allowUnverified && needsVerification(user)) throw new HttpError(403, 'Първо потвърдете имейла си с линка, който Ви изпратихме.');
    return user;
  }

  async function requirePlatformAdmin(request) {
    const user = await requireUser(request);
    if (!isPlatformAdmin(user)) throw new HttpError(403, 'Това е само за администраторите на БУЛАДМИН.');
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

  async function readBytes(request, maxBytes, types) {
    const type = (request.headers.get('content-type') || '').split(';')[0].trim();
    if (!types.includes(type)) throw new HttpError(415, 'Невалиден вид файл.');
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (!bytes.length) throw new HttpError(400, 'Файлът е празен.');
    if (bytes.length > maxBytes) throw new HttpError(413, `Файлът е по-голям от ${Math.round(maxBytes / 1024)} KB.`);
    return { bytes, type };
  }

  const failIfErrors = (errors) => {
    if (Object.keys(errors).length) throw new HttpError(422, 'Проверете маркираните полета.', errors);
  };

  const audit = (ctx, entity, recordId, action, summary = '') => store.create('audit', {
    id: `E-${crypto.randomUUID()}`,
    orgId: ctx.org?.id || '',
    entity,
    recordId,
    occurredAt: nowIso(),
    actor: ctx.user?.id || 'system',
    actorName: ctx.user?.fullName || ctx.user?.id || 'Система',
    action,
    summary,
  });

  const changedLabels = (entity, before, after) => Object.keys(after)
    .filter((key) => String(before[key] ?? '') !== String(after[key] ?? ''))
    .map((key) => LABELS[entity][key] || key);

  const newId = (entity) => `${schema[entity].prefix}-${randomCode(8)}`;

  // --- Планове ---

  async function loadPlans() {
    let plans = await store.list('plans');
    if (!plans.length) {
      for (const plan of DEFAULT_PLANS) await store.create('plans', plan);
      plans = await store.list('plans');
    }
    return plans.sort((a, b) => (Number(a.sortOrder) || 0) - (Number(b.sortOrder) || 0));
  }

  async function orgUsage(orgId) {
    const [members, companies, contacts, products, deals, documents] = await Promise.all(
      ['members', 'companies', 'contacts', 'products', 'deals', 'documents'].map((t) => store.find(t, 'orgId', orgId)),
    );
    return usageOf({ members, companies, contacts, products, deals, documents }, today().slice(0, 7));
  }

  async function assertLimit(ctx, key, extra = 1) {
    const limit = limitOf(ctx.plan, key);
    if (limit === Infinity) return;
    const used = (await orgUsage(ctx.org.id))[key];
    if (used + extra > limit) {
      throw new HttpError(402, `Планът „${ctx.plan.name}“ позволява до ${limit} ${LIMITS[key].label}. За повече се свържете с БУЛАДМИН за по-голям план.`);
    }
  }

  // --- Организации и членства ---

  const memberId = (orgId, userId) => `${orgId}:${userId}`;

  async function membershipsOf(userId) {
    const members = (await store.find('members', 'userId', userId)).filter((m) => m.isActive === 'Да');
    const orgs = await Promise.all(members.map((m) => store.find('orgs', 'id', m.orgId).then(([o]) => o)));
    return members.map((m, i) => ({ member: m, org: orgs[i] })).filter((x) => x.org);
  }

  // Контекстът на заявката: потребител, избрана организация (заглавка x-org), роля и план.
  // Администраторите на БУЛАДМИН влизат във всяка организация като администратор; това остава в историята.
  async function orgContext(request, { role, orgId: explicitOrg } = {}) {
    const user = await requireUser(request);
    const orgId = clean(explicitOrg || request.headers.get(ORG_HEADER), 40);
    if (!orgId) throw new HttpError(400, 'Изберете организация.');
    const [org] = await store.find('orgs', 'id', orgId);
    if (!org) throw new HttpError(404, 'Организацията не е намерена.');
    const [member] = await store.find('members', 'id', memberId(orgId, user.id));
    const platform = isPlatformAdmin(user);
    if ((!member || member.isActive !== 'Да') && !platform) throw new HttpError(403, 'Нямате достъп до тази организация.');
    if (org.orgStatus === 'Спряна' && !platform) {
      throw new HttpError(403, 'Достъпът до организацията е спрян. Свържете се с БУЛАДМИН.');
    }
    const memberRole = member?.isActive === 'Да' ? member.role : ADMIN;
    const ctx = { user, org, role: memberRole, platform: platform && memberRole !== member?.role, plan: effectivePlan(org, await loadPlans(), today()) };
    if (role === 'editor' && ctx.role === VIEWER) throw new HttpError(403, 'Вашият достъп е само за преглед.');
    if (role === 'admin' && ctx.role !== ADMIN) throw new HttpError(403, 'Това действие е само за администратор на организацията.');
    return ctx;
  }

  async function getRecord(entity, id, orgId) {
    const [record] = await store.find(entity, 'id', id);
    if (!record || record.orgId !== orgId) throw new HttpError(404, 'Записът не е намерен.');
    return record;
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
    const user = await requireUser(request, { allowUnverified: true });
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
    await audit({ user }, 'users', user.id, `Премахнат вход с ${PROVIDER_NAME[provider]}`);
    return json({ ok: true });
  }

  // Имейл, доказан от доставчика: потвърден имейл в Google или служебен акаунт в Microsoft 365 на БУЛАДМИН.
  // Имейлът от Microsoft акаунт в друга организация се приема, но трябва да се потвърди с линк.
  function provenEmail(provider, identity) {
    if (provider === 'google') return { email: identity.email.toLowerCase(), proven: !!identity.email };
    const email = String(identity.email || identity.upn || '').toLowerCase();
    return { email, proven: identity.tid === env.GRAPH_TENANT_ID && !!email };
  }

  async function findOrCreateUser(provider, identity) {
    const column = PROVIDER_COLUMN[provider];
    const [linked] = await store.find('users', column, identity.sub);
    if (linked) return { user: linked };
    const { email, proven } = provenEmail(provider, identity);
    if (!isValidEmail(email)) return { error: 'login' };
    const [existing] = await store.find('users', 'id', email);
    if (existing) {
      // Съществуващ профил се свързва само когато доставчикът доказва, че имейлът е на този човек.
      if (!proven || existing[column]) return { error: 'exists' };
      const patch = { [column]: identity.sub };
      if (needsVerification(existing)) Object.assign(patch, { emailVerifiedAt: nowIso(), verifyTokenHash: '', verifyExpires: '' });
      await store.update('users', existing.id, patch);
      await audit({ user: existing }, 'users', existing.id, `Свързан вход с ${PROVIDER_NAME[provider]}`);
      return { user: { ...existing, ...patch } };
    }
    const user = {
      id: email,
      fullName: identity.name || [identity.firstName, identity.lastName].filter(Boolean).join(' ') || email,
      isActive: 'Да',
      sessionVersion: '0',
      failedLogins: '0',
      [column]: identity.sub,
      emailVerifiedAt: proven ? nowIso() : '',
      createdAt: nowIso(),
    };
    await store.create('users', user);
    await audit({ user }, 'users', user.id, `Регистрация с ${PROVIDER_NAME[provider]}`);
    if (!proven) await sendVerification(user);
    return { user: (await store.find('users', 'id', email))[0] || user };
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
      await audit({ user }, 'users', user.id, `Свързан вход с ${PROVIDER_NAME[provider]}`);
      return redirect('/app.html?linked=ok#/me', [clearFlow]);
    }

    const { user, error } = await findOrCreateUser(provider, identity);
    if (error) return failed(error);
    if (user.isActive !== 'Да') return failed('inactive');
    await store.update('users', user.id, { lastLoginAt: nowIso() });
    return redirect('/app.html', [clearFlow, await sessionCookie(user)]);
  }

  // --- Регистрация и вход с парола ---

  const hashToken = async (token) => b64url(await sha256(token));

  async function sendVerification(user) {
    if (!mailEnabled) return false;
    const token = `v.${randomToken()}`;
    await store.update('users', user.id, {
      verifyTokenHash: await hashToken(token),
      verifyExpires: new Date(now().getTime() + VERIFY_TTL_MS).toISOString(),
    });
    return sendMail(user.id, 'Потвърдете имейла си за BulAdmin Cloud', {
      title: 'Потвърдете имейла си',
      paragraphs: ['Благодарим Ви, че се регистрирахте в BulAdmin CRM / ERP.', 'Потвърдете, че този адрес е Ваш, за да започнете работа.'],
      action: { label: 'Потвърдете имейла', url: `${env.APP_ORIGIN}/verify-email.html#t=${token}` },
      note: 'Линкът важи 7 дни. Ако не сте се регистрирали Вие, не правете нищо.',
    });
  }

  async function signup(request) {
    const body = await readBody(request);
    const email = clean(body.email, 200).toLowerCase();
    const fullName = clean(body.fullName, 120);
    const password = typeof body.password === 'string' ? body.password : '';
    const errors = {};
    if (!isValidEmail(email)) errors.email = 'Въведете валиден имейл.';
    if (!fullName) errors.fullName = 'Въведете име и фамилия.';
    const weak = passwordError(password);
    if (weak) errors.password = weak;
    failIfErrors(errors);
    if ((await store.find('users', 'id', email)).length) {
      throw new HttpError(409, 'Вече има профил с този имейл. Влезте в него.', { email: 'Вече има профил с този имейл.' });
    }
    const user = {
      id: email, fullName, isActive: 'Да', sessionVersion: '0', failedLogins: '0',
      passwordHash: await hashPassword(password, env.PASSWORD_PEPPER), createdAt: nowIso(), lastLoginAt: nowIso(),
    };
    await store.create('users', user);
    await audit({ user }, 'users', email, 'Регистрация с имейл и парола');
    await sendVerification(user);
    return json({ ok: true }, 201, { 'set-cookie': await sessionCookie(user) });
  }

  async function verifyEmail(request) {
    const body = await readBody(request);
    const token = typeof body.token === 'string' ? body.token : '';
    const [user] = token ? await store.find('users', 'verifyTokenHash', await hashToken(token)) : [];
    if (!user || !(Date.parse(user.verifyExpires) > now().getTime())) {
      throw new HttpError(400, 'Линкът не е валиден: може да е непълен, вече използван или изтекъл.');
    }
    await store.update('users', user.id, { emailVerifiedAt: nowIso(), verifyTokenHash: '', verifyExpires: '' });
    return json({ ok: true });
  }

  async function resendVerification(request) {
    const user = await requireUser(request, { allowUnverified: true });
    if (!needsVerification(user)) return json({ ok: true });
    if (Date.parse(user.verifyExpires) - VERIFY_TTL_MS > now().getTime() - MAIL_THROTTLE_MS) {
      throw new HttpError(429, 'Вече изпратихме линк. Проверете пощата си или опитайте след 5 минути.');
    }
    await sendVerification(user);
    return json({ ok: true });
  }

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
    // Линкът е стигнал до притежателя на адреса, затова имейлът вече е потвърден.
    if (needsVerification(user)) Object.assign(patch, { emailVerifiedAt: nowIso(), verifyTokenHash: '', verifyExpires: '' });
    await store.update('users', user.id, patch);
    await audit({ user }, 'users', user.id, 'Зададена парола');
    return json({ destination: '/app.html' }, 200, { 'set-cookie': await sessionCookie({ ...user, ...patch }) });
  }

  async function changePassword(request) {
    const user = await requireUser(request, { allowUnverified: true });
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
    await audit({ user }, 'users', user.id, 'Сменена парола');
    return json({ ok: true }, 200, { 'set-cookie': await sessionCookie({ ...user, ...patch }) });
  }

  async function updateOwnProfile(request) {
    const user = await requireUser(request, { allowUnverified: true });
    const body = await readBody(request);
    const fullName = clean(body.fullName, 120);
    if (!fullName) throw new HttpError(422, 'Въведете име.', { fullName: 'Въведете име.' });
    await store.update('users', user.id, { fullName, jobTitle: clean(body.jobTitle, 120) });
    return json({ ok: true });
  }

  async function me(request) {
    const user = await getUser(request);
    if (!user) return json({ authenticated: false });
    const memberships = needsVerification(user) ? [] : await membershipsOf(user.id);
    const plans = memberships.length ? await loadPlans() : [];
    return json({
      authenticated: true,
      needsEmailVerification: needsVerification(user),
      user: publicUser(user),
      security: { password: !!user.passwordHash, google: !!user.googleId, microsoft: !!user.microsoftId },
      orgs: memberships.map(({ member, org }) => ({
        id: org.id, name: org.name, role: member.role, status: org.orgStatus, plan: effectivePlan(org, plans, today()).name,
      })),
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
        columns: def.columns.filter((c) => !c.hidden).map(({ indexed, ...c }) => c),
      }]));
    return json({ entities, roles: ROLES, docTypes: DOC_TYPES, mailEnabled, limits: LIMITS });
  }

  // --- Всички данни на организацията наведнъж: таблиците са малки, а интерфейсът филтрира на място ---

  async function bootstrap(request) {
    const ctx = await orgContext(request);
    const entities = [...GENERIC, 'documents', 'payments'];
    const [lists, members] = await Promise.all([
      Promise.all(entities.map((e) => store.find(e, 'orgId', ctx.org.id))),
      store.find('members', 'orgId', ctx.org.id),
    ]);
    const data = {};
    entities.forEach((entity, i) => {
      data[entity] = entity === 'documents' ? lists[i].map(publicDocument) : lists[i].map((r) => publicRecord(entity, r));
    });
    const users = await Promise.all(members.map((m) => store.find('users', 'id', m.userId).then(([u]) => u)));
    data.users = members.map((m, i) => users[i] && ({
      ...publicUser(users[i]), role: m.role, isActive: m.isActive === 'Да' && users[i].isActive === 'Да' ? 'Да' : 'Не',
    })).filter(Boolean);
    data.company = companyOf(ctx.org);
    data.org = {
      id: ctx.org.id, name: ctx.org.name, status: ctx.org.orgStatus, hasLogo: !!ctx.org.logoItemId, planUntil: ctx.org.planUntil || '',
    };
    data.plan = publicPlan(ctx.plan);
    data.usage = usageOf({ members, ...Object.fromEntries(entities.map((e, i) => [e, lists[i]])) }, today().slice(0, 7));
    data.role = ctx.role;
    data.viaPlatform = ctx.platform;
    return json(data);
  }

  async function history(request, entity, id) {
    const ctx = await orgContext(request);
    if (!schema[entity] || ['settings', 'audit', 'plans'].includes(entity)) throw new HttpError(404, 'Няма такъв раздел.');
    const events = (await store.find('audit', 'recordId', id))
      .map((e, i) => ({ e, i }))
      .filter(({ e }) => e.entity === entity && e.orgId === ctx.org.id)
      .sort((a, b) => String(b.e.occurredAt).localeCompare(String(a.e.occurredAt)) || b.i - a.i);
    return json(events.map(({ e: { actor, orgId, ...e } }) => e));
  }

  // --- Общи раздели: контрагенти, контакти, сделки, задачи, артикули ---

  async function checkRefs(ctx, entity, values, errors) {
    const members = new Set((await store.find('members', 'orgId', ctx.org.id)).filter((m) => m.isActive === 'Да').map((m) => m.userId));
    for (const column of schema[entity].columns) {
      const value = values[column.name];
      if (!value || errors[column.name]) continue;
      if (column.input === 'ref') {
        const [target] = await store.find(column.ref, 'id', value);
        if (!target || target.orgId !== ctx.org.id) errors[column.name] = 'Записът не съществува.';
      }
      if (column.input === 'user' && !members.has(value)) errors[column.name] = 'Няма такъв потребител в организацията.';
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
    const ctx = await orgContext(request, { role: 'editor' });
    const { values, errors } = validateRecord(entity, await readBody(request));
    await checkRefs(ctx, entity, values, errors);
    failIfErrors(errors);
    if (ENTITY_LIMIT[entity] && (entity !== 'deals' || ['Нова', 'Квалифицирана', 'Оферта', 'Преговори'].includes(values.stage))) {
      await assertLimit(ctx, ENTITY_LIMIT[entity]);
    }
    const stamp = nowIso();
    const record = {
      id: newId(entity),
      orgId: ctx.org.id,
      ...values,
      ...derived(entity, values),
      createdAt: stamp,
      updatedAt: stamp,
      ...(schema[entity].columns.some((c) => c.name === 'createdBy') && { createdBy: ctx.user.id }),
    };
    if (entity === 'activities' && !record.assignedTo) record.assignedTo = ctx.user.id;
    if (['companies', 'deals'].includes(entity) && !record.owner) record.owner = ctx.user.id;
    await store.create(entity, record);
    await audit(ctx, entity, record.id, 'Създаване');
    return json(publicRecord(entity, record), 201);
  }

  async function updateGeneric(request, entity, id) {
    const ctx = await orgContext(request, { role: 'editor' });
    const before = await getRecord(entity, id, ctx.org.id);
    const { values, errors } = validateRecord(entity, await readBody(request), { partial: true });
    await checkRefs(ctx, entity, values, errors);
    failIfErrors(errors);
    const changed = changedLabels(entity, before, values);
    if (!changed.length) return json(publicRecord(entity, before));
    const OPEN = ['Нова', 'Квалифицирана', 'Оферта', 'Преговори'];
    if (entity === 'deals' && values.stage && OPEN.includes(values.stage) && !OPEN.includes(before.stage)) await assertLimit(ctx, 'maxDeals');
    const patch = { ...values, ...derived(entity, values, before), updatedAt: nowIso() };
    await store.update(entity, id, patch);
    await audit(ctx, entity, id, 'Промяна', changed.join(', '));
    return json(publicRecord(entity, { ...before, ...patch }));
  }

  async function deleteGeneric(request, entity, id) {
    const ctx = await orgContext(request, { role: 'admin' });
    await getRecord(entity, id, ctx.org.id);
    for (const ref of REFERENCES.filter((r) => r.target === entity)) {
      if ((await store.find(ref.entity, ref.field, id)).length) {
        throw new HttpError(409, `Записът се използва в „${schema[ref.entity].label}“. Първо премахнете връзките.`);
      }
    }
    await store.remove(entity, id);
    await audit(ctx, entity, id, 'Изтриване');
    return json({ ok: true });
  }

  // --- Търговски документи ---

  async function documentInput(ctx, body, docType) {
    const errors = {};
    const values = {};
    const products = new Map((await store.find('products', 'orgId', ctx.org.id)).map((p) => [p.id, p]));
    const { lines, error } = validateLines(body.lines, products);
    if (error) errors.lines = error;

    values.companyId = clean(body.companyId, 40);
    const [company] = values.companyId ? await store.find('companies', 'id', values.companyId) : [];
    if (!values.companyId) errors.companyId = 'Изберете контрагент.';
    else if (!company || company.orgId !== ctx.org.id) errors.companyId = 'Контрагентът не съществува.';
    values.dealId = clean(body.dealId, 40);
    if (values.dealId) {
      const [deal] = await store.find('deals', 'id', values.dealId);
      if (!deal || deal.orgId !== ctx.org.id) errors.dealId = 'Сделката не съществува.';
    }

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
    return { values, errors };
  }

  async function createDocument(request) {
    const ctx = await orgContext(request, { role: 'editor' });
    const body = await readBody(request);
    const docType = clean(body.docType, 40);
    if (!DOC_TYPES.includes(docType)) throw new HttpError(422, 'Невалиден вид документ.');
    const { values, errors } = await documentInput(ctx, body, docType);
    let relatedId = '';
    if (docType === 'Кредитно известие') {
      relatedId = clean(body.relatedId, 40);
      const [invoice] = relatedId ? await store.find('documents', 'id', relatedId) : [];
      if (!invoice || invoice.orgId !== ctx.org.id || invoice.docType !== 'Фактура' || invoice.docStatus !== 'Издаден') {
        errors.relatedId = 'Кредитното известие трябва да е към издадена фактура.';
      }
    }
    failIfErrors(errors);
    const company = companyOf(ctx.org);
    const stamp = nowIso();
    const record = {
      id: newId('documents'),
      orgId: ctx.org.id,
      docType,
      number: '',
      docStatus: 'Чернова',
      ...values,
      issueDate: values.issueDate || today(),
      dueDate: values.dueDate || addDays(values.issueDate || today(), docType === 'Оферта' ? 30 : Number(company.dueDays) || 7),
      relatedId,
      paidAmount: 0,
      paymentStatus: 'Неплатен',
      createdBy: ctx.user.id,
      createdAt: stamp,
      updatedAt: stamp,
    };
    await store.create('documents', record);
    await audit(ctx, 'documents', record.id, `Създадена чернова: ${docType}`);
    return json(publicDocument(record), 201);
  }

  async function getDraft(ctx, id) {
    const doc = await getRecord('documents', id, ctx.org.id);
    if (doc.docStatus !== 'Чернова') {
      throw new HttpError(409, 'Издаден документ не може да се променя. Анулирайте го или издайте кредитно известие.');
    }
    return doc;
  }

  async function updateDocument(request, id) {
    const ctx = await orgContext(request, { role: 'editor' });
    const doc = await getDraft(ctx, id);
    const { values, errors } = await documentInput(ctx, await readBody(request), doc.docType);
    failIfErrors(errors);
    const patch = { ...values, issueDate: values.issueDate || doc.issueDate, updatedAt: nowIso() };
    await store.update('documents', id, patch);
    await audit(ctx, 'documents', id, 'Промяна на чернова');
    return json(publicDocument({ ...doc, ...patch }));
  }

  async function deleteDocument(request, id) {
    const ctx = await orgContext(request, { role: 'editor' });
    const doc = await getDraft(ctx, id);
    if (ctx.role !== ADMIN && doc.createdBy !== ctx.user.id) throw new HttpError(403, 'Може да изтриете само свои чернови.');
    await store.remove('documents', id);
    await audit(ctx, 'documents', id, 'Изтрита чернова');
    return json({ ok: true });
  }

  // Наличностите се движат при издаване на фактура (намаляват) и кредитно известие (връщат се).
  async function moveStock(doc, direction) {
    if (!TAX_DOCS.includes(doc.docType)) return;
    const sign = (doc.docType === 'Фактура' ? -1 : 1) * direction;
    for (const line of parseJson(doc.lines, [])) {
      if (!line.productId) continue;
      const [product] = await store.find('products', 'id', line.productId);
      if (product?.itemType !== 'Стока' || product.orgId !== doc.orgId) continue;
      const stock = Math.round(((Number(product.stock) || 0) + sign * line.qty) * 1000) / 1000;
      await store.update('products', product.id, { stock, updatedAt: nowIso() });
    }
  }

  // Номерацията е отделна за всяка организация. Ако двама издадат едновременно, вторият вижда дублирания номер и опитва отново.
  async function assignNumber(doc, company) {
    const year = (doc.issueDate || today()).slice(0, 4);
    const sameKind = (d) => d.docType === doc.docType || (TAX_DOCS.includes(d.docType) && TAX_DOCS.includes(doc.docType));
    for (let attempt = 0; attempt < 5; attempt++) {
      const number = nextNumber(await store.find('documents', 'orgId', doc.orgId), doc.docType, { year, invoiceStart: company.invoiceStart });
      await store.update('documents', doc.id, { number });
      const same = (await store.find('documents', 'number', number)).filter((d) => d.orgId === doc.orgId && sameKind(d));
      if (same.length === 1) return number;
      await store.update('documents', doc.id, { number: '' });
    }
    throw new HttpError(409, 'Не успяхме да запазим номер. Опитайте отново.');
  }

  async function issueDocument(request, id) {
    const ctx = await orgContext(request, { role: 'editor' });
    const doc = await getDraft(ctx, id);
    const company = companyOf(ctx.org);
    const lines = parseJson(doc.lines, []);
    if (!lines.length) throw new HttpError(422, 'Документът няма редове.');
    if (!company.name || !isValidEik(company.eik)) {
      throw new HttpError(422, 'Попълнете данните на фирмата в „Настройки“ (наименование и ЕИК), преди да издавате документи.');
    }
    const [buyer] = await store.find('companies', 'id', doc.companyId);
    if (!buyer || buyer.orgId !== ctx.org.id) throw new HttpError(422, 'Контрагентът вече не съществува.');
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
    // Ограничението е за документите, издадени през месеца на издаване.
    if (DOC_LIMIT[doc.docType] && issueDate.startsWith(today().slice(0, 7))) await assertLimit(ctx, DOC_LIMIT[doc.docType]);
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
      issuedBy: ctx.user.fullName || ctx.user.id,
      issuedAt: nowIso(),
      updatedAt: nowIso(),
    };
    await store.update('documents', id, patch);
    const issued = { ...doc, ...patch };
    await moveStock(issued, 1);
    await audit(ctx, 'documents', id, `Издаден ${doc.docType} № ${number}`);
    return json(publicDocument(issued));
  }

  async function setOfferStatus(request, id) {
    const ctx = await orgContext(request, { role: 'editor' });
    const doc = await getRecord('documents', id, ctx.org.id);
    const { status } = await readBody(request);
    if (doc.docType !== 'Оферта' || !['Издаден', 'Приета', 'Отказана'].includes(doc.docStatus) || !['Приета', 'Отказана'].includes(status)) {
      throw new HttpError(409, 'Само издадена оферта може да се отбележи като приета или отказана.');
    }
    await store.update('documents', id, { docStatus: status, updatedAt: nowIso() });
    await audit(ctx, 'documents', id, `Офертата е ${status.toLowerCase()}`);
    return json(publicDocument({ ...doc, docStatus: status }));
  }

  async function cancelDocument(request, id) {
    const ctx = await orgContext(request, { role: 'editor' });
    const doc = await getRecord('documents', id, ctx.org.id);
    if (doc.docStatus === 'Чернова' || doc.docStatus === 'Анулиран') throw new HttpError(409, 'Документът не е издаден.');
    if (Number(doc.paidAmount) > 0) throw new HttpError(409, 'Документът има плащания. Първо ги изтрийте или издайте кредитно известие.');
    if (TAX_DOCS.includes(doc.docType) && ctx.role !== ADMIN) throw new HttpError(403, 'Фактури и известия се анулират само от администратор.');
    await store.update('documents', id, { docStatus: 'Анулиран', updatedAt: nowIso() });
    if (doc.docStatus === 'Издаден') await moveStock(doc, -1);
    await audit(ctx, 'documents', id, 'Анулиран');
    return json(publicDocument({ ...doc, docStatus: 'Анулиран' }));
  }

  // Нова чернова от съществуващ документ: оферта → проформа/фактура, фактура → кредитно известие.
  async function deriveDocument(request, id) {
    const ctx = await orgContext(request, { role: 'editor' });
    const source = await getRecord('documents', id, ctx.org.id);
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
    const company = companyOf(ctx.org);
    const stamp = nowIso();
    const record = {
      id: newId('documents'),
      orgId: ctx.org.id,
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
      createdBy: ctx.user.id,
      createdAt: stamp,
      updatedAt: stamp,
    };
    await store.create('documents', record);
    if (source.docType === 'Оферта' && source.docStatus === 'Издаден') {
      await store.update('documents', source.id, { docStatus: 'Приета', updatedAt: stamp });
    }
    await audit(ctx, 'documents', record.id, `Създадена чернова от ${source.docType} № ${source.number}`);
    return json(publicDocument(record), 201);
  }

  // --- Плащания ---

  async function recalcPaid(ctx, documentId) {
    const doc = await getRecord('documents', documentId, ctx.org.id);
    const paid = round2((await store.find('payments', 'documentId', documentId)).reduce((sum, p) => sum + (Number(p.amount) || 0), 0));
    const patch = { paidAmount: paid, paymentStatus: paymentStatusOf(Number(doc.total) || 0, paid), updatedAt: nowIso() };
    await store.update('documents', documentId, patch);
    return { ...doc, ...patch };
  }

  async function createPayment(request) {
    const ctx = await orgContext(request, { role: 'editor' });
    const body = await readBody(request);
    const errors = {};
    const documentId = clean(body.documentId, 40);
    const [doc] = documentId ? await store.find('documents', 'id', documentId) : [];
    if (!doc || doc.orgId !== ctx.org.id || doc.docStatus !== 'Издаден' || !['Фактура', 'Проформа фактура'].includes(doc.docType)) {
      errors.documentId = 'Плащане се отбелязва по издадена фактура или проформа.';
    }
    const amount = round2(parseNumber(body.amount));
    if (!(amount > 0)) errors.amount = 'Въведете положителна сума.';
    const paidAt = clean(body.paidAt, 10) || today();
    if (!isValidDay(paidAt)) errors.paidAt = 'Невалидна дата.';
    const method = clean(body.method, 40) || 'Банков превод';
    if (!schema.payments.columns.find((c) => c.name === 'method').choices.includes(method)) errors.method = 'Изберете от списъка.';
    if (!errors.documentId && amount > 0 && amount > round2(Number(doc.total) - Number(doc.paidAmount || 0)) + 0.004) {
      errors.amount = `Сумата е по-голяма от остатъка (${round2(Number(doc.total) - Number(doc.paidAmount || 0)).toFixed(2)}).`;
    }
    failIfErrors(errors);
    const payment = {
      id: newId('payments'),
      orgId: ctx.org.id,
      documentId,
      companyId: doc.companyId,
      paidAt,
      amount,
      method,
      reference: clean(body.reference, MAX_TEXT),
      createdBy: ctx.user.id,
      createdAt: nowIso(),
    };
    await store.create('payments', payment);
    const updated = await recalcPaid(ctx, documentId);
    await audit(ctx, 'documents', documentId, 'Плащане', `${amount.toFixed(2)} EUR, ${method}`);
    return json({ payment: publicRecord('payments', payment), document: publicDocument(updated) }, 201);
  }

  async function deletePayment(request, id) {
    const ctx = await orgContext(request, { role: 'admin' });
    const payment = await getRecord('payments', id, ctx.org.id);
    await store.remove('payments', id);
    const updated = await recalcPaid(ctx, payment.documentId);
    await audit(ctx, 'documents', payment.documentId, 'Изтрито плащане', `${Number(payment.amount).toFixed(2)} EUR`);
    return json({ document: publicDocument(updated) });
  }

  // --- Регистрация на организация ---

  function validateCompany(body) {
    const values = {};
    const errors = {};
    for (const key of COMPANY_FIELDS) values[key] = clean(body[key], key === 'address' ? MAX_TEXT : 120);
    if (!values.name) errors.name = 'Задължително поле.';
    if (!isValidEik(values.eik)) errors.eik = 'Невалиден ЕИК/БУЛСТАТ.';
    values.vatRegistered ||= 'Не';
    if (!['Да', 'Не'].includes(values.vatRegistered)) errors.vatRegistered = 'Изберете.';
    if (values.vatRegistered === 'Да' && !/^BG\d{9,10}$/.test(values.vatNumber)) errors.vatNumber = 'ДДС номерът е BG и 9 или 10 цифри.';
    if (values.invoiceStart && !/^\d{1,10}$/.test(values.invoiceStart)) errors.invoiceStart = 'Цяло положително число.';
    if (values.dueDays && !/^\d{1,3}$/.test(values.dueDays)) errors.dueDays = 'Брой дни.';
    if (values.email && !isValidEmail(values.email)) errors.email = 'Невалиден имейл.';
    if (values.iban) {
      values.iban = values.iban.replace(/\s/g, '').toUpperCase();
      if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(values.iban)) errors.iban = 'Невалиден IBAN.';
    }
    return { values, errors };
  }

  async function notifyPlatform(subject, paragraphs, url) {
    const admins = (await store.list('users')).filter((u) => isPlatformAdmin(u) && u.isActive === 'Да');
    await Promise.all(admins.map((a) => sendMail(a.id, subject, { title: subject, paragraphs, action: { label: 'Отворете', url } })));
  }

  async function createOrg(request, ctx) {
    const user = await requireUser(request);
    const { values, errors } = validateCompany(await readBody(request));
    failIfErrors(errors);
    const duplicate = (await store.find('orgs', 'eik', values.eik)).find((o) => o.orgStatus !== 'Спряна');
    if (duplicate) {
      throw new HttpError(409, 'Фирма с този ЕИК вече е регистрирана. Помолете нейния администратор да Ви покани.', { eik: 'Вече е регистрирана.' });
    }
    const plans = await loadPlans();
    const plan = plans.find((p) => p.isDefault === 'Да') || plans[0];
    const org = {
      id: newId('orgs'), ...values, invoiceStart: values.invoiceStart || '1', dueDays: values.dueDays || '7',
      planId: plan.id, orgStatus: 'Активна', createdBy: user.id, createdAt: nowIso(), updatedAt: nowIso(),
    };
    await store.create('orgs', org);
    await store.create('members', {
      id: memberId(org.id, user.id), orgId: org.id, userId: user.id, role: ADMIN, isActive: 'Да', invitedBy: user.id, createdAt: nowIso(),
    });
    await audit({ user, org }, 'orgs', org.id, 'Регистрация на организация', `${org.name}, ЕИК ${org.eik}`);
    const work = notifyPlatform(`Нова организация: ${org.name}`, [
      `${user.fullName || user.id} (${user.id}) регистрира „${org.name}“, ЕИК ${org.eik}, на план „${plan.name}“.`,
    ], `${env.APP_ORIGIN}/app.html#/platform/orgs/${org.id}`).catch((err) => console.error('notify failed', err.message));
    if (ctx?.waitUntil) ctx.waitUntil(work);
    else await work;
    return json({ id: org.id, name: org.name }, 201);
  }

  // --- Администрация на организацията ---

  async function saveCompanySettings(request) {
    const ctx = await orgContext(request, { role: 'admin' });
    const { values, errors } = validateCompany(await readBody(request));
    failIfErrors(errors);
    if (values.eik !== ctx.org.eik) {
      const duplicate = (await store.find('orgs', 'eik', values.eik)).find((o) => o.id !== ctx.org.id && o.orgStatus !== 'Спряна');
      if (duplicate) throw new HttpError(409, 'Друга организация вече е регистрирана с този ЕИК.', { eik: 'Вече е регистриран.' });
    }
    values.invoiceStart ||= '1';
    values.dueDays ||= '7';
    await store.update('orgs', ctx.org.id, { ...values, updatedAt: nowIso() });
    await audit(ctx, 'orgs', ctx.org.id, 'Промяна на данните на фирмата', changedLabels('orgs', ctx.org, values).join(', '));
    return json(companyOf({ ...ctx.org, ...values }));
  }

  async function uploadLogo(request) {
    const ctx = await orgContext(request, { role: 'admin' });
    if (ctx.plan.allowLogo !== 'Да') {
      throw new HttpError(402, `Логото в документите е платена възможност. Планът „${ctx.plan.name}“ не я включва — свържете се с БУЛАДМИН.`);
    }
    const { bytes, type } = await readBytes(request, MAX_LOGO_BYTES, ['image/png', 'image/jpeg']);
    const png = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
    const jpg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    if ((type === 'image/png' && !png) || (type === 'image/jpeg' && !jpg)) throw new HttpError(415, 'Логото трябва да е PNG или JPG.');
    const itemId = await store.uploadFile(`Логота/${ctx.org.id}.${png ? 'png' : 'jpg'}`, bytes, type);
    if (ctx.org.logoItemId && ctx.org.logoItemId !== itemId) await store.deleteFile(ctx.org.logoItemId).catch(() => {});
    await store.update('orgs', ctx.org.id, { logoItemId: itemId, logoType: type, updatedAt: nowIso() });
    await audit(ctx, 'orgs', ctx.org.id, 'Ново лого');
    return json({ ok: true });
  }

  async function deleteLogo(request) {
    const ctx = await orgContext(request, { role: 'admin' });
    if (ctx.org.logoItemId) await store.deleteFile(ctx.org.logoItemId).catch(() => {});
    await store.update('orgs', ctx.org.id, { logoItemId: '', logoType: '', updatedAt: nowIso() });
    await audit(ctx, 'orgs', ctx.org.id, 'Премахнато лого');
    return json({ ok: true });
  }

  // Логото се показва само докато планът го позволява. <img> не праща заглавки, затова организацията е в адреса.
  async function getLogo(request, orgId) {
    const ctx = await orgContext(request, { orgId });
    if (!ctx.org.logoItemId || ctx.plan.allowLogo !== 'Да') throw new HttpError(404, 'Няма лого.');
    const bytes = await store.downloadFile(ctx.org.logoItemId);
    return new Response(bytes, {
      headers: { 'content-type': ctx.org.logoType || 'image/png', 'cache-control': 'private, max-age=300', 'x-content-type-options': 'nosniff' },
    });
  }

  async function inviteMember(request) {
    const ctx = await orgContext(request, { role: 'admin' });
    const body = await readBody(request);
    const email = clean(body.email, 200).toLowerCase();
    const fullName = clean(body.fullName, 120);
    const role = clean(body.role, 40);
    const errors = {};
    if (!isValidEmail(email)) errors.email = 'Въведете валиден имейл.';
    if (!ROLES.includes(role)) errors.role = 'Изберете роля.';
    failIfErrors(errors);
    return json(await addMember(ctx, email, fullName, role), 201);
  }

  // Добавя човек в организацията. Ако още няма профил, получава линк за парола; иначе само известие.
  async function addMember(ctx, email, fullName, role) {
    const [existingMember] = await store.find('members', 'id', memberId(ctx.org.id, email));
    if (existingMember?.isActive === 'Да') throw new HttpError(409, 'Този човек вече е в организацията.', { email: 'Вече е член.' });
    await assertLimit(ctx, 'maxUsers');
    let [user] = await store.find('users', 'id', email);
    let link = '';
    if (!user) {
      user = { id: email, fullName: fullName || email, isActive: 'Да', sessionVersion: '0', failedLogins: '0', createdAt: nowIso() };
      await store.create('users', user);
      link = await issueSetupLink(email);
    } else if (!user.passwordHash && !user.googleId && !user.microsoftId) {
      link = await issueSetupLink(email);
    }
    if (existingMember) await store.update('members', existingMember.id, { role, isActive: 'Да', invitedBy: ctx.user.id });
    else {
      await store.create('members', {
        id: memberId(ctx.org.id, email), orgId: ctx.org.id, userId: email, role, isActive: 'Да', invitedBy: ctx.user.id, createdAt: nowIso(),
      });
    }
    await audit(ctx, 'members', email, 'Покана', role);
    const inviter = ctx.user.fullName || ctx.user.id;
    const emailed = await sendMail(email, `Покана за ${ctx.org.name} в BulAdmin Cloud`, {
      title: `Покана за ${ctx.org.name}`,
      paragraphs: [
        `${inviter} Ви покани в „${ctx.org.name}“ в BulAdmin CRM / ERP с роля „${role}“.`,
        link
          ? 'Можете да влизате с Google или Microsoft акаунт с този имейл, или да зададете парола от бутона по-долу.'
          : 'Влезте с профила си и изберете организацията от менюто.',
      ],
      action: { label: link ? 'Задайте парола' : 'Отворете системата', url: link || `${env.APP_ORIGIN}/app.html` },
      note: link ? 'Линкът може да се използва веднъж и важи 72 часа.' : '',
    });
    if (emailed || !link) return { emailed, to: email };
    return { emailed: false, link };
  }

  async function updateMember(request, userId) {
    const ctx = await orgContext(request, { role: 'admin' });
    const [member] = await store.find('members', 'id', memberId(ctx.org.id, userId));
    if (!member) throw new HttpError(404, 'Няма такъв член.');
    const body = await readBody(request);
    const patch = {};
    if (body.role !== undefined) {
      if (!ROLES.includes(body.role)) throw new HttpError(422, 'Невалидна роля.');
      patch.role = body.role;
    }
    if (body.isActive !== undefined) patch.isActive = body.isActive ? 'Да' : 'Не';
    if (patch.isActive === 'Да' && member.isActive !== 'Да') await assertLimit(ctx, 'maxUsers');
    // В организацията трябва да остане поне един активен администратор.
    const losesAdmin = member.role === ADMIN && member.isActive === 'Да' && ((patch.role && patch.role !== ADMIN) || patch.isActive === 'Не');
    if (losesAdmin) {
      const admins = (await store.find('members', 'orgId', ctx.org.id)).filter((m) => m.role === ADMIN && m.isActive === 'Да');
      if (admins.length <= 1) throw new HttpError(409, 'В организацията трябва да остане поне един администратор.');
    }
    await store.update('members', member.id, patch);
    await audit(ctx, 'members', userId, 'Промяна', changedLabels('members', member, patch).join(', '));
    return json({ ok: true });
  }

  // --- БУЛАДМИН: организации, планове и потребители ---

  async function platformOverview(request) {
    await requirePlatformAdmin(request);
    const [orgs, plans, members, users, companies, contacts, products, deals, documents] = await Promise.all(
      ['orgs', 'plans', 'members', 'users', 'companies', 'contacts', 'products', 'deals', 'documents'].map((t) => (t === 'plans' ? loadPlans() : store.list(t))),
    );
    const month = today().slice(0, 7);
    const by = (rows, orgId) => rows.filter((r) => r.orgId === orgId);
    const userMap = new Map(users.map((u) => [u.id, u]));
    return json({
      plans: plans.map(publicPlan),
      orgs: orgs.map((o) => {
        const orgMembers = by(members, o.id);
        const plan = effectivePlan(o, plans, today());
        return {
          ...companyOf(o),
          id: o.id,
          status: o.orgStatus,
          planId: o.planId,
          effectivePlan: plan.id,
          planUntil: o.planUntil || '',
          hasLogo: !!o.logoItemId,
          adminNotes: o.adminNotes || '',
          createdAt: o.createdAt,
          createdBy: o.createdBy,
          members: orgMembers.map((m) => ({
            email: m.userId, name: userMap.get(m.userId)?.fullName || m.userId, role: m.role, isActive: m.isActive,
          })),
          usage: usageOf({
            members: orgMembers, companies: by(companies, o.id), contacts: by(contacts, o.id), products: by(products, o.id),
            deals: by(deals, o.id), documents: by(documents, o.id),
          }, month),
        };
      }),
      users: users.map((u) => ({
        ...publicUser(u), orgs: members.filter((m) => m.userId === u.id && m.isActive === 'Да').map((m) => m.orgId),
      })),
    });
  }

  async function platformUpdateOrg(request, orgId) {
    const user = await requirePlatformAdmin(request);
    const [org] = await store.find('orgs', 'id', orgId);
    if (!org) throw new HttpError(404, 'Организацията не е намерена.');
    const body = await readBody(request);
    const patch = {};
    const errors = {};
    if (body.planId !== undefined) {
      if (!(await loadPlans()).some((p) => p.id === body.planId)) errors.planId = 'Няма такъв план.';
      else patch.planId = body.planId;
    }
    if (body.planUntil !== undefined) {
      patch.planUntil = clean(body.planUntil, 10);
      if (patch.planUntil && !isValidDay(patch.planUntil)) errors.planUntil = 'Невалидна дата.';
    }
    if (body.status !== undefined) {
      if (!['Активна', 'Спряна'].includes(body.status)) errors.status = 'Невалиден статус.';
      else patch.orgStatus = body.status;
    }
    if (body.adminNotes !== undefined) patch.adminNotes = clean(body.adminNotes, MAX_MULTILINE, { multiline: true });
    failIfErrors(errors);
    if (!Object.keys(patch).length) return json({ ok: true });
    patch.updatedAt = nowIso();
    await store.update('orgs', orgId, patch);
    await audit({ user, org }, 'orgs', orgId, 'Промяна от БУЛАДМИН', changedLabels('orgs', org, patch).filter((l) => l !== 'Обновена').join(', '));
    return json({ ok: true });
  }

  async function platformAddMember(request, orgId) {
    const user = await requirePlatformAdmin(request);
    const [org] = await store.find('orgs', 'id', orgId);
    if (!org) throw new HttpError(404, 'Организацията не е намерена.');
    const body = await readBody(request);
    const email = clean(body.email, 200).toLowerCase();
    const role = clean(body.role, 40) || ADMIN;
    if (!isValidEmail(email)) throw new HttpError(422, 'Въведете валиден имейл.', { email: 'Въведете валиден имейл.' });
    if (!ROLES.includes(role)) throw new HttpError(422, 'Невалидна роля.', { role: 'Изберете роля.' });
    // Администраторите на БУЛАДМИН не са ограничени от плана при добавяне на хора.
    const ctx = { user, org, role: ADMIN, plan: { ...effectivePlan(org, await loadPlans(), today()), maxUsers: '' } };
    return json(await addMember(ctx, email, clean(body.fullName, 120), role), 201);
  }

  async function platformUpdateMember(request, orgId, userId) {
    const user = await requirePlatformAdmin(request);
    const [org] = await store.find('orgs', 'id', orgId);
    const [member] = await store.find('members', 'id', memberId(orgId, userId));
    if (!org || !member) throw new HttpError(404, 'Няма такъв член.');
    const body = await readBody(request);
    const patch = {};
    if (body.role !== undefined && ROLES.includes(body.role)) patch.role = body.role;
    if (body.isActive !== undefined) patch.isActive = body.isActive ? 'Да' : 'Не';
    await store.update('members', member.id, patch);
    await audit({ user, org }, 'members', userId, 'Промяна от БУЛАДМИН', changedLabels('members', member, patch).join(', '));
    return json({ ok: true });
  }

  async function platformSavePlan(request, planId) {
    const user = await requirePlatformAdmin(request);
    const body = await readBody(request);
    const plans = await loadPlans();
    const existing = plans.find((p) => p.id === planId);
    if (!/^[a-z0-9-]{2,30}$/.test(planId)) throw new HttpError(422, 'Кодът на плана е с малки латински букви и цифри.', { id: 'Невалиден код.' });
    const values = { name: clean(body.name, 80), description: clean(body.description, 1000, { multiline: true }) };
    const errors = {};
    if (!values.name) errors.name = 'Задължително поле.';
    for (const key of PLAN_NUMBERS) {
      const raw = body[key];
      if (raw === '' || raw === null || raw === undefined) { values[key] = ''; continue; }
      const n = parseNumber(raw);
      if (!(n >= 0) || n > 1e9) errors[key] = 'Положително число или празно (без ограничение).';
      else values[key] = key === 'price' ? round2(n) : Math.floor(n);
    }
    for (const key of ['allowLogo', 'isDefault', 'isActive']) values[key] = body[key] === 'Да' || body[key] === true ? 'Да' : 'Не';
    failIfErrors(errors);
    if (values.isDefault === 'Да') {
      for (const p of plans.filter((p) => p.isDefault === 'Да' && p.id !== planId)) await store.update('plans', p.id, { isDefault: 'Не' });
    } else if (existing?.isDefault === 'Да') {
      throw new HttpError(409, 'Изберете друг план по подразбиране, преди да махнете този.');
    }
    if (existing) await store.update('plans', planId, values);
    else await store.create('plans', { id: planId, ...values });
    await audit({ user }, 'plans', planId, existing ? 'Промяна на план' : 'Нов план', values.name);
    return json(publicPlan({ id: planId, ...values }));
  }

  async function platformUpdateUser(request, email) {
    const admin = await requirePlatformAdmin(request);
    const [user] = await store.find('users', 'id', email);
    if (!user) throw new HttpError(404, 'Няма такъв потребител.');
    const body = await readBody(request);
    const patch = {};
    if (body.platformRole !== undefined) patch.platformRole = body.platformRole ? PLATFORM_ADMIN : '';
    if (body.isActive !== undefined) patch.isActive = body.isActive ? 'Да' : 'Не';
    if (email === admin.id && (patch.platformRole === '' || patch.isActive === 'Не')) {
      throw new HttpError(409, 'Не можете да отнемете собствения си достъп.');
    }
    if (patch.isActive === 'Не' || patch.platformRole !== undefined) patch.sessionVersion = String(Number(user.sessionVersion || 0) + 1);
    await store.update('users', email, patch);
    await audit({ user: admin }, 'users', email, 'Промяна от БУЛАДМИН', changedLabels('users', user, patch).filter((l) => l !== 'Версия на сесията').join(', '));
    return json({ ok: true });
  }

  async function platformResetLink(request, email) {
    const admin = await requirePlatformAdmin(request);
    const [user] = await store.find('users', 'id', email);
    if (!user || user.isActive !== 'Да') throw new HttpError(404, 'Няма такъв активен потребител.');
    const link = await issueSetupLink(email);
    await audit({ user: admin }, 'users', email, 'Линк за парола от БУЛАДМИН');
    const emailed = await sendMail(email, 'Линк за парола за BulAdmin CRM / ERP', {
      title: 'Задайте парола',
      paragraphs: ['Администратор на БУЛАДМИН Ви изпрати линк за задаване на парола.'],
      action: { label: 'Задайте парола', url: link },
      note: 'Линкът може да се използва веднъж и важи 72 часа.',
    });
    return json(emailed ? { emailed: true, to: email } : { emailed: false, link });
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
    // Всичко, което проверява пароли, кодове или линкове, минава през ограничението на опитите.
    if (method === 'POST' && /^\/api\/auth\/(login|signup|set-password|forgot|verify-email|resend-verification)$/.test(path)) {
      await rateLimit(request, path.split('/').pop());
    }
    if (method === 'POST' && path === '/api/auth/login') return passwordLogin(request);
    if (method === 'POST' && path === '/api/auth/signup') return signup(request);
    if (method === 'POST' && path === '/api/auth/verify-email') return verifyEmail(request);
    if (method === 'POST' && path === '/api/auth/resend-verification') return resendVerification(request);
    if (method === 'POST' && path === '/api/auth/forgot') return forgotPassword(request, ctx);
    if (method === 'POST' && path === '/api/auth/set-password') return setPasswordWithToken(request);
    if (method === 'POST' && path === '/api/auth/logout') return json({ ok: true }, 200, { 'set-cookie': cookieHeader(SESSION_COOKIE, '', 0) });
    if (method === 'POST' && path === '/api/account/password') return changePassword(request);
    if (method === 'PATCH' && path === '/api/account') return updateOwnProfile(request);
    if (method === 'POST' && (m = path.match(/^\/api\/account\/link\/(\w+)$/)) && isProvider(m[1])) return linkStart(request, m[1]);
    if (method === 'POST' && (m = path.match(/^\/api\/account\/unlink\/(\w+)$/)) && isProvider(m[1])) return unlink(request, m[1]);

    if (method === 'POST' && path === '/api/orgs') return createOrg(request, ctx);
    if (method === 'GET' && (m = path.match(/^\/api\/orgs\/([\w-]{1,40})\/logo$/))) return getLogo(request, m[1]);

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

    if (method === 'PUT' && path === '/api/org/settings') return saveCompanySettings(request);
    if (path === '/api/org/logo') {
      if (method === 'PUT') return uploadLogo(request);
      if (method === 'DELETE') return deleteLogo(request);
    }
    if (method === 'POST' && path === '/api/org/members') return inviteMember(request);
    if (method === 'PATCH' && (m = path.match(/^\/api\/org\/members\/([^/]{1,200})$/))) return updateMember(request, decodeURIComponent(m[1]).toLowerCase());

    if (method === 'GET' && path === '/api/platform') return platformOverview(request);
    if (method === 'PATCH' && (m = path.match(/^\/api\/platform\/orgs\/([\w-]{1,40})$/))) return platformUpdateOrg(request, m[1]);
    if (method === 'POST' && (m = path.match(/^\/api\/platform\/orgs\/([\w-]{1,40})\/members$/))) return platformAddMember(request, m[1]);
    if (method === 'PATCH' && (m = path.match(/^\/api\/platform\/orgs\/([\w-]{1,40})\/members\/([^/]{1,200})$/))) {
      return platformUpdateMember(request, m[1], decodeURIComponent(m[2]).toLowerCase());
    }
    if (method === 'PUT' && (m = path.match(/^\/api\/platform\/plans\/([^/]{1,40})$/))) return platformSavePlan(request, decodeURIComponent(m[1]));
    if ((m = path.match(/^\/api\/platform\/users\/([^/]{1,200})(\/reset)?$/))) {
      const email = decodeURIComponent(m[1]).toLowerCase();
      if (method === 'PATCH' && !m[2]) return platformUpdateUser(request, email);
      if (method === 'POST' && m[2]) return platformResetLink(request, email);
    }
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
