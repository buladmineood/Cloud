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

// Пази данните в Microsoft Lists. Записите имат `id` (колоната Title) и колоните от schema.json.
export class GraphStore {
  constructor(env, fetchImpl = (...args) => fetch(...args)) {
    this.env = env;
    this.fetch = fetchImpl;
    this.token = null;
    this.tokenExpiry = 0;
    this.itemIds = new Map();
  }

  async accessToken() {
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

  itemsUrl(table) {
    const site = `${this.env.SP_HOSTNAME}:${this.env.SP_SITE_PATH}:`;
    return `${GRAPH}/sites/${site}/lists/${encodeURIComponent(schema[table].title)}/items`;
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

  sendMail(from, to, subject, { html }) {
    return this.request(`${GRAPH}/users/${encodeURIComponent(from)}/sendMail`, {
      method: 'POST',
      body: JSON.stringify({
        message: {
          subject,
          body: { contentType: 'HTML', content: html },
          toRecipients: [{ emailAddress: { address: to } }],
        },
        saveToSentItems: false,
      }),
    });
  }
}

// За тестове и локална разработка; не се използва в production.
export class MemoryStore {
  constructor(seed = {}) {
    this.tables = Object.fromEntries(Object.keys(schema).map((key) => [key, []]));
    Object.assign(this.tables, structuredClone(seed));
    this.sentMail = [];
  }
  async sendMail(from, to, subject, { html, text }) { this.sentMail.push({ from, to, subject, text, html }); }
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
