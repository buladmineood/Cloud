// Внася обявленията от ЦАИС ЕОП (отворени данни на АОП, OCDS) в общия SharePoint сайт — без Worker-а.
// Основен източник: ЦАИС ЕОП → „Отворени данни“ (storage.eop.bg); резервен: data.egov.bg.
// Пуска се всеки ден от GitHub Actions (.github/workflows/eop-import.yml) или ръчно от компютър.
// Освен файла с откритите поръчки обновява следените поръчки във фирмите (нов срок, класиране,
// договор, прекратяване) и праща имейлите по CPV — същата логика като в приложението (src/app.js).
//
//   node scripts/eop-import.mjs            – внася всички чакащи дни
//   node scripts/eop-import.mjs --dry      – само показва колко дни чакат (нищо не записва)
//
// Тайната MS_CERT_PRIVATE_KEY се взема от средата (GitHub Actions secret) или от worker/.dev.vars.
import { existsSync, readFileSync } from 'node:fs';
import { createApp } from '../src/app.js';
import { importStep, EOP_FILE } from '../src/eop.js';
import { GraphStore } from '../src/store.js';

const devVars = new URL('../.dev.vars', import.meta.url);
const vars = existsSync(devVars)
  ? Object.fromEntries(
    readFileSync(devVars, 'utf8')
      .split(/\r?\n/)
      .filter((line) => line.includes('=') && !line.startsWith('#'))
      .map((line) => {
        const i = line.indexOf('=');
        return [line.slice(0, i).trim(), line.slice(i + 1).trim().replace(/^"|"$/g, '')];
      }),
  )
  : {};
// Публичните настройки са в [vars] на wrangler.toml.
const toml = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
const tomlVars = Object.fromEntries([...toml.matchAll(/^([A-Z_]+) = "(.*)"$/gm)].map((m) => [m[1], m[2]]));
const env = { ...tomlVars, MS_CERT_PRIVATE_KEY: process.env.MS_CERT_PRIVATE_KEY || vars.MS_CERT_PRIVATE_KEY };
if (!env.MS_CERT_PRIVATE_KEY) {
  console.error('Липсва MS_CERT_PRIVATE_KEY (в средата или в worker/.dev.vars).');
  process.exit(1);
}
const store = new GraphStore(env);

if (process.argv.includes('--dry')) {
  const bytes = await store.downloadPath(EOP_FILE);
  const state = bytes ? JSON.parse(new TextDecoder().decode(bytes)) : null;
  const { remaining } = await importStep(fetch, state, new Date().toISOString(), { max: 0 });
  console.log(state ? `Във файла: ${state.notices.length} открити поръчки, последен ден ${state.lastResourceName || '—'}` : 'Файлът още го няма: първоначално зареждане (последните 45 дни).');
  console.log(`Чакащи дни: ${remaining}`);
} else {
  const result = await createApp({ env, store }).eopImport({ max: 60 });
  const bySource = Object.entries((result.sources || []).reduce((acc, s) => ({ ...acc, [s]: (acc[s] || 0) + 1 }), {})).map(([s, n]) => `${s}: ${n}`).join(', ');
  console.log(`Внесени дни: ${result.imported}${bySource ? ` (${bySource})` : ''}; открити поръчки: ${result.open}; нови: ${result.new}; обновени следени: ${result.updated}; имейли по CPV: ${result.alerts}; остават: ${result.remaining}`);
}
