import { CLIENT_ASSERTION_TYPE, clientAssertion } from './crypto.js';
import schema from './schema.json' with { type: 'json' };

const GRAPH = 'https://graph.microsoft.com/v1.0';
const COLUMNS = Object.fromEntries(Object.entries(schema).map(([key, def]) => [key, def.columns]));
const KINDS = Object.fromEntries(
  Object.entries(schema).map(([key, def]) => [key, Object.fromEntries(def.columns.map((c) => [c.name, c.kind]))]),
);

const graphField = (field) => (field === 'id' ? 'Title' : field);
const odataString = (value) => `'${String(value).replace(/'/g, "''")}'`;

// Дата без час се пази по обед UTC, за да не се измести с ден при смяна на часовата зона в SharePoint.
function toGraphValue(kind, value) {
  if (value === '' || value === null || value === undefined) return kind === 'text' || kind === 'multiline' ? '' : null;
  if (kind === 'day') return `${value}T12:00:00Z`;
  if (kind === 'number') return Number(value);
  return value;
}
function fromGraphValue(kind, value) {
  if (value === null || value === undefined) return '';
  if (kind === 'day') return String(value).slice(0, 10);
  if (kind === 'date') return String(value).replace(/\.\d+Z$/, 'Z');
  return value;
}

// Колона от schema.json като дефиниция на колона в SharePoint (за създаване на таблици).
export function columnDefinition(c) {
  const base = { name: c.name, displayName: c.label, indexed: !!c.indexed };
  if (c.kind === 'date') return { ...base, dateTime: { format: 'dateTime' } };
  if (c.kind === 'day') return { ...base, dateTime: { format: 'dateOnly' } };
  if (c.kind === 'number') return { ...base, number: { decimalPlaces: 'automatic' } };
  if (c.kind === 'choice') return { ...base, choice: { choices: c.choices, displayAs: 'dropDownMenu' } };
  if (c.kind === 'multiline') return { ...base, text: { allowMultipleLines: true, linesForEditing: 6 } };
  return { ...base, text: {} };
}

// Пази данните в Microsoft Lists. Записите имат `id` (колоната Title) и колоните от schema.json.
// Централният сайт (SP_SITE_PATH) пази фирмите, плановете и потребителите; всяка фирма има свой сайт
// с нейните данни — forSite() връща хранилище за този сайт със същия токен.
export class GraphStore {
  constructor(env, fetchImpl = (...args) => fetch(...args), { sitePath = env.SP_SITE_PATH, parent = null } = {}) {
    this.env = env;
    this.fetch = fetchImpl;
    this.sitePath = sitePath;
    this.parent = parent;
    this.sites = new Map();
    this.token = null;
    this.tokenExpiry = 0;
    this.itemIds = new Map();
  }

  forSite(sitePath) {
    const root = this.parent || this;
    if (!sitePath || sitePath === root.sitePath) return root;
    if (!root.sites.has(sitePath)) root.sites.set(sitePath, new GraphStore(this.env, this.fetch, { sitePath, parent: root }));
    return root.sites.get(sitePath);
  }

  async accessToken() {
    if (this.parent) return this.parent.accessToken();
    if (this.token && Date.now() < this.tokenExpiry) return this.token;
    const tokenUrl = `https://login.microsoftonline.com/${this.env.GRAPH_TENANT_ID}/oauth2/v2.0/token`;
    const res = await this.fetch(tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.env.MS_CLIENT_ID,
        client_assertion_type: CLIENT_ASSERTION_TYPE,
        client_assertion: await clientAssertion(this.env, tokenUrl),
        scope: 'https://graph.microsoft.com/.default',
      }),
    });
    if (!res.ok) throw new Error(`Graph token request failed: ${res.status}`);
    const data = await res.json();
    this.token = data.access_token;
    this.tokenExpiry = Date.now() + (data.expires_in - 120) * 1000;
    return this.token;
  }

  async request(url, init = {}) {
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetch(url, {
        ...init,
        headers: {
          authorization: `Bearer ${await this.accessToken()}`,
          'content-type': 'application/json',
          ...init.headers,
        },
      });
      if (res.ok) return res.status === 202 || res.status === 204 ? null : res.json();
      if ([429, 503, 504].includes(res.status) && attempt < 3) {
        const wait = Math.min(Number(res.headers.get('retry-after')) || 2 ** attempt, 8);
        await new Promise((resolve) => setTimeout(resolve, wait * 1000));
        continue;
      }
      // Кодът на грешката от Graph помага при диагностика и не съдържа лични данни.
      const code = await res.json().then((b) => b?.error?.code || '').catch(() => '');
      throw new Error(`Graph ${init.method || 'GET'} failed: ${res.status} ${code}`.trim());
    }
  }

  siteRef() {
    return `${this.env.SP_HOSTNAME}:${this.sitePath}:`;
  }

  itemsUrl(table) {
    return `${GRAPH}/sites/${this.siteRef()}/lists/${encodeURIComponent(schema[table].title)}/items`;
  }

  // --- Сайтове на фирмите ---

  // Токен за SharePoint REST: Graph още няма стабилен начин приложение да създава сайтове.
  async sharePointToken() {
    const root = this.parent || this;
    if (root.spToken && Date.now() < root.spTokenExpiry) return root.spToken;
    const tokenUrl = `https://login.microsoftonline.com/${this.env.GRAPH_TENANT_ID}/oauth2/v2.0/token`;
    const res = await this.fetch(tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.env.MS_CLIENT_ID,
        client_assertion_type: CLIENT_ASSERTION_TYPE,
        client_assertion: await clientAssertion(this.env, tokenUrl),
        scope: `https://${this.env.SP_HOSTNAME}/.default`,
      }),
    });
    if (!res.ok) throw new Error(`SharePoint token request failed: ${res.status}`);
    const data = await res.json();
    root.spToken = data.access_token;
    root.spTokenExpiry = Date.now() + (data.expires_in - 120) * 1000;
    return root.spToken;
  }

  async spRequest(path, init = {}) {
    const res = await this.fetch(`https://${this.env.SP_HOSTNAME}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${await this.sharePointToken()}`,
        accept: 'application/json;odata=nometadata',
        'content-type': 'application/json;odata=nometadata',
        ...init.headers,
      },
    });
    if (!res.ok) throw new Error(`SharePoint ${init.method || 'GET'} ${path.split('?')[0]} failed: ${res.status}`);
    return res.status === 204 ? null : res.json();
  }

  // Състояние на сайт: 'missing', 'provisioning', 'ready' или 'error'.
  async siteStatus(sitePath) {
    const url = `https://${this.env.SP_HOSTNAME}${sitePath}`;
    const res = await this.spRequest(`/_api/SPSiteManager/status?url='${encodeURIComponent(url)}'`);
    return { 0: 'missing', 1: 'provisioning', 2: 'ready', 3: 'error' }[res?.SiteStatus] || 'missing';
  }

  // Създава екипен сайт без Microsoft 365 група и без външно споделяне.
  async createSite({ sitePath, title, owner }) {
    const status = await this.siteStatus(sitePath);
    if (status !== 'missing') return status;
    const res = await this.spRequest('/_api/SPSiteManager/create', {
      method: 'POST',
      body: JSON.stringify({
        request: { Title: title, Url: `https://${this.env.SP_HOSTNAME}${sitePath}`, Lcid: 1026, WebTemplate: 'STS#3', Owner: owner, ShareByEmailEnabled: false },
      }),
    });
    return res?.SiteStatus === 2 ? 'ready' : 'provisioning';
  }

  // Създава липсващите таблици в сайта на фирмата; на едно извикване — до limit таблици, за да не се бави заявката.
  async ensureLists(tables, limit = 4) {
    const site = await this.request(`${GRAPH}/sites/${this.siteRef()}?$select=id`);
    const existing = (await this.request(`${GRAPH}/sites/${site.id}/lists?$select=id,displayName&$top=200`)).value;
    let created = 0;
    for (const table of tables) {
      const def = schema[table];
      if (existing.some((l) => l.displayName === def.title)) continue;
      if (created >= limit) return { done: false, siteId: site.id };
      const list = await this.request(`${GRAPH}/sites/${site.id}/lists`, {
        method: 'POST',
        body: JSON.stringify({ displayName: def.title, list: { template: 'genericList' }, columns: def.columns.map(columnDefinition) }),
      });
      // Колоната Title пази уникалния номер: индексира се, за да може да се търси по нея.
      const { value: cols } = await this.request(`${GRAPH}/sites/${site.id}/lists/${list.id}/columns?$select=id,name`);
      const titleCol = cols.find((c) => c.name === 'Title');
      if (titleCol) {
        await this.request(`${GRAPH}/sites/${site.id}/lists/${list.id}/columns/${titleCol.id}`, {
          method: 'PATCH', body: JSON.stringify({ indexed: true, displayName: def.titleLabel }),
        });
      }
      created += 1;
    }
    return { done: true, siteId: site.id };
  }

  toRecord(table, item) {
    const f = item.fields || {};
    const record = { id: f.Title ?? '' };
    for (const c of COLUMNS[table]) record[c.name] = fromGraphValue(c.kind, f[c.name]);
    this.itemIds.set(`${table}:${record.id}`, item.id);
    return record;
  }

  async fetchItems(table, filter) {
    const params = new URLSearchParams({ expand: 'fields', $top: '999' });
    if (filter) params.set('$filter', filter);
    const items = [];
    let url = `${this.itemsUrl(table)}?${params}`;
    while (url) {
      const page = await this.request(url);
      items.push(...page.value);
      url = page['@odata.nextLink'];
    }
    return items;
  }

  async list(table) {
    return (await this.fetchItems(table)).map((item) => this.toRecord(table, item));
  }

  // Полето трябва да е индексирано в schema.json (или да е id), иначе Graph отказва филтъра.
  async find(table, field, value) {
    const items = await this.fetchItems(table, `fields/${graphField(field)} eq ${odataString(value)}`);
    return items.map((item) => this.toRecord(table, item));
  }

  toFields(table, record) {
    const fields = {};
    for (const [key, value] of Object.entries(record)) {
      if (key === 'id') fields.Title = value;
      else if (KINDS[table][key]) fields[key] = toGraphValue(KINDS[table][key], value);
    }
    return fields;
  }

  async create(table, record) {
    const fields = this.toFields(table, record);
    // Празна стойност е невалидна за колона с дата, число или избор.
    for (const key of Object.keys(fields)) if (fields[key] === '' || fields[key] === null) delete fields[key];
    const item = await this.request(this.itemsUrl(table), { method: 'POST', body: JSON.stringify({ fields }) });
    if (item?.id) this.itemIds.set(`${table}:${record.id}`, item.id);
    return record;
  }

  async itemId(table, id) {
    const key = `${table}:${id}`;
    if (!this.itemIds.has(key)) {
      const [item] = await this.fetchItems(table, `fields/Title eq ${odataString(id)}`);
      if (!item) throw new Error('Record not found');
      this.itemIds.set(key, item.id);
    }
    return this.itemIds.get(key);
  }

  async update(table, id, patch) {
    const itemId = await this.itemId(table, id);
    await this.request(`${this.itemsUrl(table)}/${itemId}/fields`, {
      method: 'PATCH',
      body: JSON.stringify(this.toFields(table, patch)),
    });
  }

  async remove(table, id) {
    const itemId = await this.itemId(table, id);
    await this.request(`${this.itemsUrl(table)}/${itemId}`, { method: 'DELETE' });
    this.itemIds.delete(`${table}:${id}`);
  }

  // --- Файлове в библиотеката „Документи“ на сайта (лога и PDF) ---

  // Адресът на сайта с „:“ не може да се комбинира с път на файл с „:“, затова се взима ID на библиотеката.
  async driveUrl() {
    if (!this.driveId) {
      const drive = await this.request(`${GRAPH}/sites/${this.siteRef()}/drive?$select=id`);
      this.driveId = drive.id;
    }
    return `${GRAPH}/drives/${this.driveId}`;
  }

  // Файловете тук са до няколко MB, затова стига обикновено качване; съществуващ файл се заменя.
  async uploadFile(path, bytes, contentType) {
    const encoded = path.split('/').map(encodeURIComponent).join('/');
    const res = await this.fetch(`${await this.driveUrl()}/root:/${encoded}:/content?@microsoft.graph.conflictBehavior=replace`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${await this.accessToken()}`, 'content-type': contentType },
      body: bytes,
    });
    if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
    return (await res.json()).id;
  }

  async downloadFile(itemId) {
    const res = await this.fetch(`${await this.driveUrl()}/items/${encodeURIComponent(itemId)}/content`, {
      headers: { authorization: `Bearer ${await this.accessToken()}` },
    });
    if (!res.ok) throw new Error(`Download failed: ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  async deleteFile(itemId) {
    const res = await this.fetch(`${await this.driveUrl()}/items/${encodeURIComponent(itemId)}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${await this.accessToken()}` },
    });
    if (!res.ok && res.status !== 404) throw new Error(`Delete failed: ${res.status}`);
  }

  // to и cc са адрес или списък от адреси; attachments: [{ name, contentType, bytes }] (до 3 MB общо).
  sendMail(from, to, subject, { html }, { cc = [], replyTo, attachments = [] } = {}) {
    const list = (value) => [value].flat().filter(Boolean).map((address) => ({ emailAddress: { address } }));
    let binary = '';
    const base64 = (bytes) => {
      binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return btoa(binary);
    };
    return this.request(`${GRAPH}/users/${encodeURIComponent(from)}/sendMail`, {
      method: 'POST',
      body: JSON.stringify({
        message: {
          subject,
          body: { contentType: 'HTML', content: html },
          toRecipients: list(to),
          ccRecipients: list(cc),
          ...(replyTo && { replyTo: list(replyTo) }),
          ...(attachments.length && {
            attachments: attachments.map((a) => ({
              '@odata.type': '#microsoft.graph.fileAttachment', name: a.name, contentType: a.contentType, contentBytes: base64(a.bytes),
            })),
          }),
        },
        saveToSentItems: false,
      }),
    });
  }
}

// За тестове и локална разработка; не се използва в production.
export class MemoryStore {
  constructor(seed = {}, root = null) {
    this.tables = Object.fromEntries(Object.keys(schema).map((key) => [key, []]));
    Object.assign(this.tables, structuredClone(seed));
    this.root = root;
    this.sites = new Map();
    this.sentMail = root ? root.sentMail : [];
    this.files = new Map();
  }
  // Всеки сайт е отделно хранилище в паметта, както отделните сайтове в SharePoint.
  forSite(sitePath) {
    const root = this.root || this;
    if (!sitePath) return root;
    if (!root.sites.has(sitePath)) root.sites.set(sitePath, new MemoryStore({}, root));
    return root.sites.get(sitePath);
  }
  async siteStatus(sitePath) { return (this.root || this).sites.has(sitePath) ? 'ready' : 'missing'; }
  async createSite({ sitePath }) { this.forSite(sitePath); return 'ready'; }
  async ensureLists() { return { done: true, siteId: 'memory' }; }
  async uploadFile(path, bytes, contentType) {
    const existing = [...this.files].find(([, f]) => f.path === path);
    const id = existing ? existing[0] : `item-${this.files.size + 1}`;
    this.files.set(id, { path, bytes: new Uint8Array(bytes), contentType });
    return id;
  }
  async downloadFile(itemId) {
    const file = this.files.get(itemId);
    if (!file) throw new Error('missing');
    return file.bytes;
  }
  async deleteFile(itemId) { this.files.delete(itemId); }
  async sendMail(from, to, subject, { html, text }, extra = {}) { this.sentMail.push({ from, to, subject, text, html, ...extra }); }
  async list(table) { return this.tables[table].map((r) => ({ ...r })); }
  async find(table, field, value) { return (await this.list(table)).filter((r) => r[field] === value); }
  async create(table, record) { this.tables[table].push({ ...record }); return record; }
  async update(table, id, patch) {
    const row = this.tables[table].find((r) => r.id === id);
    if (!row) throw new Error('Record not found');
    Object.assign(row, patch);
  }
  async remove(table, id) {
    const index = this.tables[table].findIndex((r) => r.id === id);
    if (index < 0) throw new Error('Record not found');
    this.tables[table].splice(index, 1);
  }
}
