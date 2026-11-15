// Бланки, които се създават като PDF в браузъра и не се пазят:
//  • по Търговския закон (ТЗ) — решение на едноличния собственик, протокол и покана за общо събрание,
//    декларация-съгласие на управител, общо пълномощно;
//  • по Закона за юридическите лица с нестопанска цел (ЗЮЛНЦ) — покана и протокол от общо събрание,
//    решение на управителния съвет, заявление за членство, годишен доклад за дейността;
//  • за счетоводители — протокол за предаване на документи, справка за издадените документи,
//    инвентаризационен опис, авансов отчет, командировъчна заповед, договор за счетоводно обслужване,
//    пълномощно за НАП и НОИ.
// Протоколите на органите, договорите и пълномощните са с място за подпис. Счетоводните документи са без
// подпис и печат: те не са задължителни реквизити по Закона за счетоводството.
import { addressLine, amountWords, field, formatDate, formDialog, h, money, round2, selectField, today, toast } from './core.js?v=c6c5e2e1e0';
import { checkbox, declarant, download, grid, lines, required, signerFields, textarea } from './letters.js?v=c6c5e2e1e0';

const year = () => String(Number(today().slice(0, 4)) - 1);
const companyOptions = (env, empty = 'Изберете контрагент…') => [['', empty], ...[...env.companies].sort((a, b) => a.name.localeCompare(b.name, 'bg')).map((c) => [c.id, c.name])];
const done = (result) => { if (result) toast('PDF файлът е изтеглен.'); };
const num = (v) => Number(String(v ?? '').replace(/\s/g, '').replace(',', '.')) || 0;
const dayAfter = (days) => new Date(Date.now() + days * 864e5).toISOString().slice(0, 10);

// Типични решения на собственика / общото събрание (чл. 137, ал. 1 и чл. 147, ал. 1 ТЗ).
function decisionFields() {
  return [
    checkbox('dGfo', `Приемане на годишния финансов отчет за ${year()} г.`, true),
    checkbox('dProfit', 'Разпределение на печалбата'),
    field({ name: 'profit', label: 'Печалба (EUR)', inputmode: 'decimal', maxlength: 20 }),
    field({ name: 'dividend', label: 'От нея за дивидент (EUR)', inputmode: 'decimal', maxlength: 20 }),
    checkbox('dDischarge', `Освобождаване на управителя от отговорност за ${year()} г.`, true),
    textarea('other', 'Други решения', { rows: 4, hint: 'по едно на ред' }),
  ];
}
function decisionsOf(v, company) {
  const list = [];
  if (v.dGfo) list.push(`Приема годишния финансов отчет на ${company.name} за ${year()} г.`);
  if (v.dProfit) {
    const profit = num(v.profit);
    const dividend = Math.min(num(v.dividend), profit);
    const rest = round2(profit - dividend);
    list.push(`Печалбата за ${year()} г. в размер на ${money(profit)} (${amountWords(profit)}) се разпределя, както следва: ${dividend ? `${money(dividend)} за дивидент на ${v.ownersWord || 'съдружниците'}${rest ? ', ' : ''}` : ''}${rest ? `${money(rest)} остава като неразпределена печалба` : ''}. Дивидентът се изплаща след облагането му по Закона за данъците върху доходите на физическите лица.`);
  }
  if (v.dDischarge) list.push(`Освобождава от отговорност управителя за дейността му през ${year()} г.`);
  list.push(...lines(v.other));
  return list;
}

// ============================ ТЗ ============================

const TZ = {
  async soleDecision(env) {
    const c = env.company;
    done(await formDialog({
      title: 'Решение на едноличния собственик на капитала', wide: true,
      fields: [grid(
        field({ name: 'owner', label: 'Едноличен собственик', value: c.mol || '', maxlength: 200 }),
        field({ name: 'date', label: 'Дата', type: 'date', value: today() }),
        ...decisionFields())],
      submitLabel: 'Изтеглете PDF',
      onSubmit: async (v) => {
        required(v, { owner: 'Въведете собственика.' });
        const decisions = decisionsOf({ ...v, ownersWord: 'едноличния собственик' }, c);
        if (!decisions.length) throw new Error('Изберете или въведете поне едно решение.');
        await download({
          title: 'Решение', subtitle: `на едноличния собственик на капитала на ${c.name}`, issuer: c, logo: await env.logo(),
          blocks: [
            { p: `Днес, ${formatDate(v.date)}, ${v.owner}, в качеството си на едноличен собственик на капитала на ${c.name}, ЕИК ${c.eik}, на основание чл. 147, ал. 1 от Търговския закон,` },
            { p: 'РЕШИ:', bold: true },
            { list: decisions },
          ],
          date: v.date, place: c.city, signLines: true, signatures: [{ label: 'Едноличен собственик', name: v.owner }],
        }, `Решение на едноличния собственик ${v.date}`);
      },
    }));
  },

  async gmProtocol(env) {
    const c = env.company;
    done(await formDialog({
      title: 'Протокол от общо събрание на съдружниците', wide: true,
      fields: [grid(
        field({ name: 'date', label: 'Дата', type: 'date', value: today() }),
        field({ name: 'time', label: 'Час', value: '10:00', maxlength: 10 }),
        field({ name: 'place', label: 'Място', value: addressLine(c), maxlength: 200, wrapClass: 'full' }),
        textarea('partners', 'Присъстващи съдружници', { rows: 3, hint: 'по един на ред: име, дял от капитала %' }),
        field({ name: 'chair', label: 'Председател', value: c.mol || '', maxlength: 120 }),
        field({ name: 'secretary', label: 'Протоколчик', maxlength: 120 }),
        ...decisionFields())],
      submitLabel: 'Изтеглете PDF',
      onSubmit: async (v) => {
        required(v, { partners: 'Въведете присъстващите съдружници.', chair: 'Въведете председателя.' });
        const decisions = decisionsOf(v, c);
        if (!decisions.length) throw new Error('Изберете или въведете поне едно решение.');
        await download({
          title: 'Протокол', subtitle: `от общо събрание на съдружниците на ${c.name}`, issuer: c, logo: await env.logo(),
          blocks: [
            { p: `Днес, ${formatDate(v.date)}, в ${v.time} ч., в ${v.place}, се проведе общо събрание на съдружниците на ${c.name}, ЕИК ${c.eik}, при следните присъстващи съдружници:` },
            { list: lines(v.partners) },
            { p: `Събранието се откри от ${v.chair}, който/която беше избран/а за председател${v.secretary ? `, а за протоколчик — ${v.secretary}` : ''}. Председателят констатира, че събранието е редовно свикано и може да взема решения по чл. 137 от Търговския закон.` },
            { p: 'Събранието прие следния дневен ред и след обсъждане взе единодушно следните', bold: false },
            { p: 'РЕШЕНИЯ:', bold: true },
            { list: decisions },
            { p: 'Поради изчерпване на дневния ред събранието беше закрито.' },
          ],
          date: v.date, place: c.city, signLines: true,
          signatures: [{ label: 'Председател', name: v.chair }, { label: 'Протоколчик', name: v.secretary }, ...lines(v.partners).slice(0, 4).map((p) => ({ label: 'Съдружник', name: p.split(',')[0] }))],
        }, `Протокол ОС на съдружниците ${v.date}`);
      },
    }));
  },

  async gmInvitation(env) {
    const c = env.company;
    done(await formDialog({
      title: 'Покана за общо събрание на съдружниците', wide: true,
      fields: [grid(
        field({ name: 'date', label: 'Дата на събранието', type: 'date', value: dayAfter(10) }),
        field({ name: 'time', label: 'Час', value: '10:00', maxlength: 10 }),
        field({ name: 'place', label: 'Място', value: addressLine(c), maxlength: 200, wrapClass: 'full' }),
        textarea('agenda', 'Дневен ред', { rows: 4, hint: 'по една точка на ред', value: `Приемане на годишния финансов отчет за ${year()} г.\nРазпределение на печалбата за ${year()} г.\nОсвобождаване от отговорност на управителя.` }),
        ...signerFields(c, 'Свиква'))],
      submitLabel: 'Изтеглете PDF',
      onSubmit: async (v) => {
        required(v, { agenda: 'Въведете дневния ред.' });
        await download({
          title: 'Покана', subtitle: `за общо събрание на съдружниците на ${c.name}`, issuer: c, logo: await env.logo(),
          to: { label: 'ДО', lines: ['Съдружниците в дружеството'] },
          blocks: [
            { p: `На основание чл. 138 от Търговския закон ${v.signer}, ${v.role} на ${c.name}, ЕИК ${c.eik}, свиква общо събрание на съдружниците, което ще се проведе на ${formatDate(v.date)} от ${v.time} ч. в ${v.place}, при следния дневен ред:` },
            { list: lines(v.agenda) },
            { p: 'Материалите по дневния ред са на разположение на съдружниците в седалището на дружеството. Съдружник може да бъде представляван от друго лице с изрично писмено пълномощно.' },
          ],
          date: today(), place: c.city, signLines: true, signatures: [{ label: 'Свиква', name: v.signer, role: v.role }],
        }, `Покана за ОС на съдружниците ${v.date}`);
      },
    }));
  },

  async managerConsent(env) {
    const c = env.company;
    done(await formDialog({
      title: 'Декларация-съгласие на управител', wide: true,
      fields: [grid(
        field({ name: 'person', label: 'Управител', value: c.mol || '', maxlength: 120 }),
        field({ name: 'personId', label: 'Данни за самоличност', hint: 'ЕГН/дата на раждане, адрес', maxlength: 200 }))],
      submitLabel: 'Изтеглете PDF',
      onSubmit: async (v) => {
        required(v, { person: 'Въведете управителя.' });
        await download({
          title: 'Декларация', subtitle: 'по чл. 13, ал. 4 от Закона за търговския регистър и регистъра на юридическите лица с нестопанска цел', issuer: c, logo: await env.logo(),
          blocks: [
            { p: `Долуподписаният/ата ${v.person}${v.personId ? `, ${v.personId}` : ''},` },
            { p: 'ДЕКЛАРИРАМ:', bold: true },
            { list: [
              `Съгласен/съгласна съм да бъда вписан/а като управител на ${c.name}, ЕИК ${c.eik}.`,
              'Отговарям на изискванията на закона за заемане на длъжността и не са налице пречки да бъда управител.',
              'Образец от подписа ми:',
            ] },
            { space: 46 },
          ],
          date: today(), place: c.city, signLines: true, signatures: [{ label: 'Декларатор', name: v.person }],
        }, `Декларация-съгласие ${v.person}`);
      },
    }));
  },

  async poa(env) {
    const c = env.company;
    done(await formDialog({
      title: 'Пълномощно', wide: true,
      fields: [grid(
        field({ name: 'agent', label: 'Упълномощено лице', maxlength: 160 }),
        field({ name: 'agentId', label: 'Данни за самоличност', hint: 'ЕГН/ЕИК, документ', maxlength: 200 }),
        textarea('scope', 'Правомощия', { rows: 5, value: `да представлява ${c.name} пред държавни и общински органи, банки, търговски дружества и физически лица, като подава и получава документи, подписва заявления, декларации и искания и извършва всички необходими действия във връзка с това.` }),
        field({ name: 'until', label: 'Валидно до', type: 'date', value: dayAfter(365) }),
        ...signerFields(c, 'Упълномощител'))],
      submitLabel: 'Изтеглете PDF',
      onSubmit: async (v) => {
        required(v, { agent: 'Въведете упълномощеното лице.', scope: 'Опишете правомощията.' });
        await download({
          title: 'Пълномощно', issuer: c, logo: await env.logo(),
          blocks: [
            { p: `${declarant(v, c)},` },
            { p: 'УПЪЛНОМОЩАВАМ:', bold: true },
            { p: `${v.agent}${v.agentId ? `, ${v.agentId}` : ''},` },
            { p: 'със следните правомощия:', bold: true },
            { p: v.scope },
            { p: `Пълномощното е валидно до ${formatDate(v.until)}. Упълномощеното лице няма право да преупълномощава трети лица.` },
          ],
          date: today(), place: c.city, signLines: true, signatures: [{ label: 'Упълномощител', name: v.signer, role: v.role }],
        }, `Пълномощно ${v.agent}`);
      },
    }));
  },
};

// ============================ ЗЮЛНЦ ============================

const NGO = {
  async invitation(env) {
    const c = env.company;
    done(await formDialog({
      title: 'Покана за общо събрание', wide: true,
      fields: [grid(
        field({ name: 'date', label: 'Дата', type: 'date', value: dayAfter(35) }),
        field({ name: 'time', label: 'Час', value: '10:00', maxlength: 10 }),
        field({ name: 'place', label: 'Място', value: addressLine(c), maxlength: 200, wrapClass: 'full' }),
        selectField({ name: 'initiative', label: 'По инициатива на', options: ['управителния съвет', 'една трета от членовете на сдружението'], value: 'управителния съвет', wrapClass: 'full' }),
        textarea('agenda', 'Дневен ред', { rows: 4, hint: 'по една точка на ред', value: `Отчет за дейността на сдружението през ${year()} г.\nПриемане на годишния финансов отчет за ${year()} г.\nПриемане на програма и бюджет за ${Number(year()) + 2} г.` }),
        ...signerFields(c, 'За управителния съвет'))],
      submitLabel: 'Изтеглете PDF',
      onSubmit: async (v) => {
        required(v, { agenda: 'Въведете дневния ред.' });
        await download({
          title: 'Покана', subtitle: `за свикване на общо събрание на ${c.name}`, issuer: c, logo: await env.logo(),
          blocks: [
            { p: `На основание чл. 26 от Закона за юридическите лица с нестопанска цел и устава на ${c.name}, по инициатива на ${v.initiative}, се свиква общо събрание на членовете, което ще се проведе на ${formatDate(v.date)} от ${v.time} ч. в ${v.place}, при следния дневен ред:` },
            { list: lines(v.agenda) },
            { p: `При липса на кворум, на основание чл. 27, ал. 1 от ЗЮЛНЦ, събранието ще се проведе същия ден един час по-късно, на същото място и при същия дневен ред, независимо от броя на присъстващите членове.` },
          ],
          date: today(), place: c.city, signLines: true, signatures: [{ label: 'За управителния съвет', name: v.signer, role: v.role }],
        }, `Покана за ОС на сдружението ${v.date}`);
      },
    }));
  },

  async protocol(env) {
    const c = env.company;
    done(await formDialog({
      title: 'Протокол от общо събрание', wide: true,
      fields: [grid(
        field({ name: 'date', label: 'Дата', type: 'date', value: today() }),
        field({ name: 'time', label: 'Час', value: '10:00', maxlength: 10 }),
        field({ name: 'present', label: 'Присъстващи членове', inputmode: 'numeric', maxlength: 6 }),
        field({ name: 'total', label: 'Общо членове', inputmode: 'numeric', maxlength: 6 }),
        checkbox('postponed', 'Събранието е проведено един час по-късно поради липса на кворум (чл. 27, ал. 1 ЗЮЛНЦ)'),
        field({ name: 'chair', label: 'Председател', value: c.mol || '', maxlength: 120 }),
        field({ name: 'secretary', label: 'Протоколчик', maxlength: 120 }),
        textarea('decisions', 'Решения', { rows: 6, hint: 'по едно на ред; гласуване: за/против/въздържали се', value: `Приема отчета за дейността на сдружението през ${year()} г. (за: …, против: …, въздържали се: …)\nПриема годишния финансов отчет за ${year()} г. (за: …, против: …, въздържали се: …)` }))],
      submitLabel: 'Изтеглете PDF',
      onSubmit: async (v) => {
        required(v, { present: 'Въведете броя присъстващи.', decisions: 'Въведете поне едно решение.', chair: 'Въведете председателя.' });
        const quorum = num(v.total) ? `${v.present} от общо ${v.total} членове` : `${v.present} членове`;
        await download({
          title: 'Протокол', subtitle: `от общо събрание на ${c.name}`, issuer: c, logo: await env.logo(),
          blocks: [
            { p: `Днес, ${formatDate(v.date)}, в ${v.time} ч., в ${addressLine(c) || c.city || 'седалището на сдружението'}, се проведе общо събрание на ${c.name}, ЕИК ${c.eik}, свикано по реда на чл. 26 от Закона за юридическите лица с нестопанска цел.` },
            { p: v.postponed
              ? `Поради липса на кворум в обявения час, на основание чл. 27, ал. 1 от ЗЮЛНЦ, събранието се проведе един час по-късно при същия дневен ред. Присъстват ${quorum}.`
              : `Присъстват ${quorum}. Събранието има необходимия кворум по чл. 27 от ЗЮЛНЦ.` },
            { p: `За председател на събранието беше избран/а ${v.chair}${v.secretary ? `, а за протоколчик — ${v.secretary}` : ''}.` },
            { p: 'След обсъждане на точките от дневния ред общото събрание прие следните', bold: false },
            { p: 'РЕШЕНИЯ:', bold: true },
            { list: lines(v.decisions) },
            { p: 'Поради изчерпване на дневния ред събранието беше закрито.' },
          ],
          date: v.date, place: c.city, signLines: true, signatures: [{ label: 'Председател', name: v.chair }, { label: 'Протоколчик', name: v.secretary }],
        }, `Протокол ОС на сдружението ${v.date}`);
      },
    }));
  },

  async boardDecision(env) {
    const c = env.company;
    done(await formDialog({
      title: 'Решение на управителния съвет', wide: true,
      fields: [grid(
        field({ name: 'date', label: 'Дата', type: 'date', value: today() }),
        field({ name: 'number', label: 'Протокол №', maxlength: 20 }),
        textarea('members', 'Присъстващи членове на УС', { rows: 3, hint: 'по един на ред' }),
        textarea('decisions', 'Решения', { rows: 5, hint: 'по едно на ред' }))],
      submitLabel: 'Изтеглете PDF',
      onSubmit: async (v) => {
        required(v, { members: 'Въведете присъстващите.', decisions: 'Въведете поне едно решение.' });
        await download({
          title: 'Протокол', subtitle: `от заседание на управителния съвет на ${c.name}`, number: v.number, date: v.date, issuer: c, logo: await env.logo(),
          blocks: [
            { p: `Днес, ${formatDate(v.date)}, се проведе заседание на управителния съвет на ${c.name}, ЕИК ${c.eik}, при присъствието на:` },
            { list: lines(v.members) },
            { p: 'Заседанието е редовно и управителният съвет може да взема решения съгласно устава. След обсъждане управителният съвет', bold: false },
            { p: 'РЕШИ:', bold: true },
            { list: lines(v.decisions) },
          ],
          date: v.date, place: c.city, signLines: true, signatures: lines(v.members).slice(0, 6).map((m) => ({ label: 'Член на УС', name: m.split(',')[0] })),
        }, `Решение на УС ${v.date}`);
      },
    }));
  },

  async membership(env) {
    const c = env.company;
    done(await formDialog({
      title: 'Заявление за членство', wide: true,
      fields: [grid(
        field({ name: 'applicant', label: 'Кандидат', hint: 'име или наименование', maxlength: 200, wrapClass: 'full' }),
        field({ name: 'applicantId', label: 'ЕГН/ЕИК', maxlength: 20 }),
        field({ name: 'applicantAddress', label: 'Адрес', maxlength: 200 }),
        field({ name: 'applicantContact', label: 'Телефон и имейл', maxlength: 200, wrapClass: 'full' }))],
      submitLabel: 'Изтеглете PDF',
      onSubmit: async (v) => {
        required(v, { applicant: 'Въведете кандидата.' });
        await download({
          title: 'Заявление', subtitle: `за членство в ${c.name}`, issuer: c, logo: await env.logo(),
          to: { label: 'ДО', lines: [`Управителния съвет на ${c.name}`] },
          blocks: [
            { p: `От ${v.applicant}${v.applicantId ? `, ЕГН/ЕИК ${v.applicantId}` : ''}${v.applicantAddress ? `, адрес: ${v.applicantAddress}` : ''}${v.applicantContact ? `, ${v.applicantContact}` : ''}.` },
            { p: 'УВАЖАЕМИ ЧЛЕНОВЕ НА УПРАВИТЕЛНИЯ СЪВЕТ,', bold: true },
            { p: `Моля да бъда приет/а за член на ${c.name}.` },
            { list: ['Запознат/а съм с устава на сдружението и го приемам.', 'Задължавам се да спазвам устава, да плащам определения членски внос и да съдействам за постигане на целите на сдружението.', 'Съгласен/съгласна съм данните ми да се обработват за целите на членството съгласно Регламент (ЕС) 2016/679.'], numbered: false },
          ],
          date: today(), place: c.city, signLines: true, signatures: [{ label: 'Кандидат', name: v.applicant }],
        }, `Заявление за членство ${v.applicant}`);
      },
    }));
  },

  async annualReport(env) {
    const c = env.company;
    done(await formDialog({
      title: 'Годишен доклад за дейността', wide: true,
      fields: [grid(
        field({ name: 'year', label: 'Година', value: year(), inputmode: 'numeric', maxlength: 4 }),
        textarea('activities', 'Извършени дейности', { rows: 5, hint: 'по една на ред' }),
        textarea('results', 'Постигнати резултати', { rows: 3 }),
        field({ name: 'income', label: 'Приходи (EUR)', inputmode: 'decimal', maxlength: 20 }),
        field({ name: 'expense', label: 'Разходи (EUR)', inputmode: 'decimal', maxlength: 20 }),
        textarea('donors', 'Дарители и източници на финансиране', { rows: 3, hint: 'по желание' }),
        ...signerFields(c, 'Председател'))],
      submitLabel: 'Изтеглете PDF',
      onSubmit: async (v) => {
        required(v, { activities: 'Опишете дейностите.' });
        await download({
          title: 'Годишен доклад', subtitle: `за дейността на ${c.name} през ${v.year} г.`, issuer: c, logo: await env.logo(),
          blocks: [
            { h: '1. Извършени дейности' }, { list: lines(v.activities) },
            v.results && { h: '2. Постигнати резултати' }, v.results && { p: v.results },
            { h: `${v.results ? 3 : 2}. Финансово състояние` },
            { kv: [['Приходи', money(num(v.income))], ['Разходи', money(num(v.expense))], ['Резултат', money(round2(num(v.income) - num(v.expense))), true]] },
            v.donors && { h: `${v.results ? 4 : 3}. Източници на финансиране` }, v.donors && { list: lines(v.donors), numbered: false },
          ],
          date: today(), place: c.city, signLines: true, signatures: [{ label: v.role || 'Председател', name: v.signer }],
        }, `Годишен доклад ${v.year}`);
      },
    }));
  },
};

// ============================ За счетоводители ============================

const ACC = {
  async handoverDocs(env) {
    const c = env.company;
    const month = today().slice(0, 7);
    done(await formDialog({
      title: 'Протокол за предаване на счетоводни документи', wide: true,
      fields: [grid(
        field({ name: 'from', label: 'От дата', type: 'date', value: `${month}-01` }),
        field({ name: 'to', label: 'До дата', type: 'date', value: today() }),
        selectField({ name: 'accountant', label: 'Счетоводител', options: companyOptions(env, 'въведете по-долу'), value: '' }),
        field({ name: 'accountantName', label: 'или име на счетоводителя', maxlength: 160 }),
        textarea('extra', 'Други документи', { rows: 4, hint: 'по един на ред: вид, брой', value: 'Банкови извлечения\nФактури за покупки\nКасови бележки и разходни документи' }),
        field({ name: 'handedBy', label: 'Предал', value: c.mol || '', maxlength: 120 }),
        field({ name: 'receivedBy', label: 'Приел', maxlength: 120 }))],
      submitLabel: 'Изтеглете PDF',
      onSubmit: async (v) => {
        const docs = env.documents.filter((d) => d.number && d.issueDate >= v.from && d.issueDate <= v.to && d.docType !== 'Оферта');
        const byType = {};
        for (const d of docs) (byType[d.docType] ||= []).push(d);
        const rows = Object.entries(byType).map(([type, list]) => {
          const nums = list.map((d) => d.number).sort();
          return [type, list.length, `${nums[0]} – ${nums.at(-1)}`, list.filter((d) => d.docStatus === 'Анулиран').length || ''];
        });
        lines(v.extra).forEach((x) => { const [name, count] = x.split(','); rows.push([name.trim(), (count || '').trim(), '', '']); });
        const acc = env.find('companies', v.accountant);
        await download({
          title: 'Протокол', subtitle: `за предаване на счетоводни документи за периода ${formatDate(v.from)} – ${formatDate(v.to)}`, issuer: c, logo: await env.logo(),
          to: { label: 'ДО', lines: [acc?.name || v.accountantName || 'Счетоводителя', acc && addressLine(acc)] },
          blocks: [
            { p: `${c.name}, ЕИК ${c.eik}, предаде, а ${acc?.name || v.accountantName || 'счетоводителят'} прие следните документи:` },
            { table: { cols: [{ label: 'Документи', w: 46 }, { label: 'Брой', w: 12, right: true }, { label: 'Номера', w: 30 }, { label: 'Анулирани', w: 12, right: true }], rows } },
            { p: 'Документите от системата са в електронен вид; анулираните се предават с обозначение „Анулиран“.' },
          ],
          date: today(), place: c.city, signatures: [{ label: 'Предал', name: v.handedBy }, { label: 'Приел', name: v.receivedBy }],
        }, `Протокол за предаване на документи ${v.from} - ${v.to}`);
      },
    }));
  },

  async register(env) {
    const c = env.company;
    const month = today().slice(0, 7);
    done(await formDialog({
      title: 'Справка за издадените документи', wide: true,
      fields: [grid(
        field({ name: 'from', label: 'От дата', type: 'date', value: `${month}-01` }),
        field({ name: 'to', label: 'До дата', type: 'date', value: today() }),
        selectField({ name: 'kind', label: 'Документи', options: [['tax', 'фактури, известия и протоколи (за дневника за продажби)'], ['all', 'всички издадени']], value: 'tax', wrapClass: 'full' }))],
      submitLabel: 'Изтеглете PDF',
      onSubmit: async (v) => {
        const TAX = ['Фактура', 'Кредитно известие', 'Дебитно известие', 'Протокол по чл. 117'];
        const docs = env.documents.filter((d) => d.number && d.docStatus !== 'Чернова' && d.issueDate >= v.from && d.issueDate <= v.to && (v.kind === 'all' || TAX.includes(d.docType)))
          .sort((a, b) => a.number.localeCompare(b.number));
        if (!docs.length) throw new Error('Няма издадени документи за периода.');
        const live = docs.filter((d) => d.docStatus !== 'Анулиран');
        const sum = (k) => round2(live.reduce((s, d) => s + (d[`${k}Eur`] ?? d[k]), 0));
        await download({
          title: 'Справка', subtitle: `за издадените документи за периода ${formatDate(v.from)} – ${formatDate(v.to)}`, issuer: c, logo: await env.logo(),
          blocks: [
            { table: {
              cols: [{ label: 'Вид', w: 14 }, { label: '№', w: 13 }, { label: 'Дата', w: 11 }, { label: 'Контрагент', w: 17 }, { label: 'ЕИК / ДДС №', w: 14 }, { label: 'Основа', w: 11, right: true }, { label: 'ДДС', w: 9, right: true }, { label: 'Общо', w: 11, right: true }],
              rows: docs.map((d) => [d.docStatus === 'Анулиран' ? `${d.docType} (АНУЛИРАН)` : d.docType, d.number, d.issueDate.split('-').reverse().join('.'), d.companyName, d.buyer?.vatNumber || d.buyer?.eik || '',
                ...(d.docStatus === 'Анулиран' ? ['—', '—', '—'] : [money(d.subtotalEur ?? d.subtotal), money(d.vatAmountEur ?? d.vatAmount), money(d.totalEur ?? d.total)])]),
              foot: [['Общо (без анулираните)', `${live.length} бр.`, '', '', '', money(sum('subtotal')), money(sum('vatAmount')), money(sum('total'))]],
            } },
            { p: 'Сумите са в евро; документите в друга валута са превърнати по курса, посочен в тях.', muted: true },
          ],
          date: today(), place: c.city, signatures: [{ label: 'Съставил', name: env.userName }],
        }, `Справка документи ${v.from} - ${v.to}`);
      },
    }));
  },

  async inventory(env) {
    const c = env.company;
    const goods = env.products.filter((p) => p.itemType === 'Стока' && p.isActive !== 'Не');
    done(await formDialog({
      title: 'Инвентаризационен опис на стоките', wide: true,
      fields: [grid(
        field({ name: 'date', label: 'Към дата', type: 'date', value: today() }),
        field({ name: 'location', label: 'Склад / обект', maxlength: 160 }),
        textarea('committee', 'Инвентаризационна комисия', { rows: 3, hint: 'по един на ред: име, длъжност' }),
        checkbox('blank', 'Колоната „Фактическо количество“ да е празна (за попълване при броенето)', true))],
      submitLabel: 'Изтеглете PDF',
      onSubmit: async (v) => {
        if (!goods.length) throw new Error('Няма артикули от вид „Стока“.');
        const value = round2(goods.reduce((s, p) => s + (Number(p.stock) || 0) * (Number(p.price) || 0), 0));
        await download({
          title: 'Инвентаризационен опис', subtitle: `на стоките към ${formatDate(v.date)}${v.location ? `, ${v.location}` : ''}`, issuer: c, logo: await env.logo(),
          blocks: [
            { table: {
              cols: [{ label: '№', w: 5 }, { label: 'Артикул', w: 35 }, { label: 'Мярка', w: 8 }, { label: 'По данни', w: 11, right: true }, { label: 'Фактически', w: 12, right: true }, { label: 'Разлика', w: 10, right: true }, { label: 'Цена', w: 9, right: true }, { label: 'Стойност', w: 10, right: true }],
              rows: goods.map((p, i) => [i + 1, p.name, p.unit, Number(p.stock) || 0, v.blank ? '' : Number(p.stock) || 0, v.blank ? '' : 0, money(p.price), money(round2((Number(p.stock) || 0) * (Number(p.price) || 0)))]),
              foot: [['', 'Общо по данни', '', '', '', '', '', money(value)]],
            } },
            { p: 'Цените са продажните цени на артикулите без ДДС; при оценка по доставна цена коригирайте стойността.', muted: true },
          ],
          date: v.date, place: c.city, signatures: lines(v.committee).map((m) => ({ label: 'Член на комисията', name: m })),
        }, `Инвентаризационен опис ${v.date}`);
      },
    }));
  },

  async advanceReport(env) {
    const c = env.company;
    done(await formDialog({
      title: 'Авансов отчет', wide: true,
      fields: [grid(
        field({ name: 'person', label: 'Подотчетно лице', maxlength: 120 }),
        field({ name: 'position', label: 'Длъжност', maxlength: 120 }),
        field({ name: 'advance', label: 'Получен аванс (EUR)', inputmode: 'decimal', maxlength: 20 }),
        field({ name: 'date', label: 'Дата', type: 'date', value: today() }),
        textarea('expenses', 'Разходи', { rows: 5, hint: 'по един на ред: документ (вид, №, дата); сума' }))],
      submitLabel: 'Изтеглете PDF',
      onSubmit: async (v) => {
        required(v, { person: 'Въведете подотчетното лице.', expenses: 'Въведете поне един разход.' });
        const rows = lines(v.expenses).map((x) => { const i = x.lastIndexOf(';'); return i < 0 ? [x, 0] : [x.slice(0, i).trim(), num(x.slice(i + 1))]; });
        const spent = round2(rows.reduce((s, r) => s + r[1], 0));
        const diff = round2(num(v.advance) - spent);
        await download({
          title: 'Авансов отчет', date: v.date, issuer: c, logo: await env.logo(),
          blocks: [
            { kv: [['Подотчетно лице', `${v.person}${v.position ? `, ${v.position}` : ''}`, true], ['Получен аванс', money(num(v.advance))]] },
            { table: { cols: [{ label: '№', w: 6 }, { label: 'Разходооправдателен документ', w: 70 }, { label: 'Сума', w: 24, right: true }], rows: rows.map((r, i) => [i + 1, r[0], money(r[1])]), foot: [['', 'Общо разходи', money(spent)]] } },
            { kv: [[diff >= 0 ? 'За връщане от лицето' : 'За доплащане на лицето', `${money(Math.abs(diff))} (${amountWords(Math.abs(diff))})`, true]] },
          ],
          signatures: [{ label: 'Подотчетно лице', name: v.person }, { label: 'Проверил', name: env.userName }],
        }, `Авансов отчет ${v.person} ${v.date}`);
      },
    }));
  },

  async travelOrder(env) {
    const c = env.company;
    done(await formDialog({
      title: 'Командировъчна заповед', wide: true,
      fields: [grid(
        field({ name: 'number', label: 'Заповед №', maxlength: 20 }),
        field({ name: 'person', label: 'Командировано лице', maxlength: 120 }),
        field({ name: 'position', label: 'Длъжност', maxlength: 120 }),
        field({ name: 'destination', label: 'Населено място', maxlength: 160 }),
        field({ name: 'from', label: 'От дата', type: 'date', value: today() }),
        field({ name: 'to', label: 'До дата', type: 'date', value: today() }),
        textarea('task', 'Задача', { rows: 2 }),
        field({ name: 'transport', label: 'Превозно средство', value: 'лек автомобил', maxlength: 120 }),
        field({ name: 'advance', label: 'Аванс (EUR)', inputmode: 'decimal', maxlength: 20 }),
        ...[field({ name: 'signer', label: 'Командироващ', value: c.mol || '', maxlength: 120 })])],
      submitLabel: 'Изтеглете PDF',
      onSubmit: async (v) => {
        required(v, { person: 'Въведете командированото лице.', destination: 'Въведете мястото.' });
        const days = Math.max(1, Math.round((Date.parse(v.to) - Date.parse(v.from)) / 864e5) + 1);
        await download({
          title: 'Командировъчна заповед', number: v.number, date: today(), issuer: c, logo: await env.logo(),
          blocks: [
            { p: 'На основание Наредбата за командировките в страната' },
            { p: 'КОМАНДИРОВАМ:', bold: true },
            { kv: [
              ['Лице', `${v.person}${v.position ? `, ${v.position}` : ''}`, true],
              ['Място', v.destination],
              ['Срок', `${days} ${days === 1 ? 'ден' : 'дни'}, от ${formatDate(v.from)} до ${formatDate(v.to)} включително`],
              ['Задача', v.task || '—'],
              ['Превоз', v.transport || '—'],
              ['Аванс', num(v.advance) ? `${money(num(v.advance))} (${amountWords(num(v.advance))})` : 'не се дава'],
              ['Разходите са за сметка на', c.name],
            ] },
            { h: 'Заверка в мястото на командировката' },
            { kv: [['Пристигнал на', '…………………………'], ['Заминал на', '…………………………']] },
          ],
          signatures: [{ label: 'Командироващ', name: v.signer }, { label: 'Командирован', name: v.person }],
        }, `Командировъчна заповед ${v.person} ${v.from}`);
      },
    }));
  },

  async serviceContract(env) {
    const c = env.company;
    done(await formDialog({
      title: 'Договор за счетоводно обслужване', wide: true,
      fields: [grid(
        selectField({ name: 'client', label: 'Възложител (клиент)', options: companyOptions(env), value: '', wrapClass: 'full' }),
        field({ name: 'clientRep', label: 'Представляван от', maxlength: 120 }),
        field({ name: 'fee', label: 'Месечно възнаграждение (EUR без ДДС)', inputmode: 'decimal', maxlength: 20 }),
        field({ name: 'payDay', label: 'Плащане до … число на месеца', value: '10', inputmode: 'numeric', maxlength: 2 }),
        field({ name: 'docsDay', label: 'Документите се предават до … число', value: '5', inputmode: 'numeric', maxlength: 2 }),
        textarea('services', 'Услуги', { rows: 6, value: 'Текущо счетоводство и съставяне на счетоводни регистри\nИзготвяне и подаване на справки-декларации и дневници по ЗДДС\nИзчисляване на трудови възнаграждения, осигуровки и подаване на декларации към НАП\nИзготвяне на годишен финансов отчет и годишна данъчна декларация\nКонсултации по счетоводни и данъчни въпроси' }),
        ...signerFields(c, 'За изпълнителя'))],
      submitLabel: 'Изтеглете PDF',
      onSubmit: async (v) => {
        required(v, { client: 'Изберете клиента.', fee: 'Въведете възнаграждението.' });
        const client = env.find('companies', v.client);
        const fee = num(v.fee);
        await download({
          title: 'Договор', subtitle: 'за счетоводно обслужване', issuer: c, logo: await env.logo(),
          blocks: [
            { p: `Днес, ${formatDate(today())}, в гр. ${c.city || '…………'}, между:` },
            { list: [
              `${client.name}, ЕИК ${client.eik || '…………'}, ${addressLine(client)}, представлявано от ${v.clientRep || client.mol || '…………'}, наричано ВЪЗЛОЖИТЕЛ, и`,
              `${c.name}, ЕИК ${c.eik}, ${addressLine(c)}, представлявано от ${v.signer}, наричано ИЗПЪЛНИТЕЛ,`,
            ], numbered: false },
            { p: 'се сключи настоящият договор за следното:' },
            { h: 'I. Предмет' },
            { p: 'ВЪЗЛОЖИТЕЛЯТ възлага, а ИЗПЪЛНИТЕЛЯТ приема да извършва срещу възнаграждение следните услуги:' },
            { list: lines(v.services) },
            { h: 'II. Възнаграждение и плащане' },
            { p: `Месечното възнаграждение е ${money(fee)} (${amountWords(fee)}) без ДДС и се плаща до ${v.payDay}-о число на месеца, следващ месеца на услугата, по банков път въз основа на фактура.` },
            { h: 'III. Задължения на ВЪЗЛОЖИТЕЛЯ' },
            { list: [`Да предава първичните счетоводни документи за отчетния месец до ${v.docsDay}-о число на следващия месец с протокол.`, 'Да предоставя пълна и вярна информация и да уведомява своевременно за промени в обстоятелствата.', 'Да плаща възнаграждението в срок.'] },
            { h: 'IV. Задължения на ИЗПЪЛНИТЕЛЯ' },
            { list: ['Да извършва услугите добросъвестно и в сроковете по закон.', 'Да пази в тайна информацията, станала му известна при изпълнението.', 'Да уведомява ВЪЗЛОЖИТЕЛЯ за установени нередовни документи.'] },
            { h: 'V. Отговорност' },
            { p: 'ИЗПЪЛНИТЕЛЯТ не отговаря за последици от непредадени, забавени или неверни документи и данни от ВЪЗЛОЖИТЕЛЯ. Отговорността за достоверността на първичните документи е на съставителите им.' },
            { h: 'VI. Срок и прекратяване' },
            { p: 'Договорът е безсрочен и може да бъде прекратен от всяка от страните с едномесечно писмено предизвестие или по взаимно съгласие.' },
            { p: 'Договорът се състави в два еднообразни екземпляра — по един за всяка от страните.' },
          ],
          signLines: true, signatures: [{ label: 'Възложител', name: v.clientRep || client.mol, role: client.name }, { label: 'Изпълнител', name: v.signer, role: c.name }],
        }, `Договор за счетоводно обслужване - ${client.name}`);
      },
    }));
  },

  async napPoa(env) {
    const c = env.company;
    done(await formDialog({
      title: 'Пълномощно за НАП и НОИ', wide: true,
      fields: [grid(
        selectField({ name: 'principal', label: 'Упълномощител', options: [['', c.name], ...companyOptions(env).slice(1)], value: '', wrapClass: 'full' }),
        field({ name: 'principalRep', label: 'Представляван от', value: c.mol || '', maxlength: 120 }),
        field({ name: 'agent', label: 'Упълномощен', hint: 'лице или фирма', value: '', maxlength: 160 }),
        field({ name: 'agentId', label: 'ЕГН/ЕИК', maxlength: 20 }),
        textarea('scope', 'Правомощия', { rows: 6, value: 'да подава от мое име декларации, справки-декларации, дневници и други документи по данъчното и осигурителното законодателство\nда получава документи, удостоверения, справки и актове\nда подава искания и заявления и да представя документи при проверки и ревизии\nда извършва всички тези действия и по електронен път' }))],
      submitLabel: 'Изтеглете PDF',
      onSubmit: async (v) => {
        required(v, { agent: 'Въведете упълномощения.', principalRep: 'Въведете представляващия.' });
        const principal = (v.principal && env.find('companies', v.principal)) || c;
        await download({
          title: 'Пълномощно', subtitle: 'за представителство пред Националната агенция за приходите и Националния осигурителен институт', issuer: principal, logo: principal === c ? await env.logo() : null,
          blocks: [
            { p: `${declarant({ signer: v.principalRep, role: 'представляващ' }, principal)},` },
            { p: 'УПЪЛНОМОЩАВАМ:', bold: true },
            { p: `${v.agent}${v.agentId ? `, ЕГН/ЕИК ${v.agentId}` : ''},` },
            { p: 'да ме представлява пред всички териториални дирекции и офиси на НАП и НОИ, като:', bold: false },
            { list: lines(v.scope), numbered: false },
          ],
          date: today(), place: principal.city, signLines: true, signatures: [{ label: 'Упълномощител', name: v.principalRep, role: principal.name }],
        }, `Пълномощно НАП НОИ - ${principal.name}`);
      },
    }));
  },
};

// Бланките, групирани за раздела „Документи и бланки“. run(env) отваря диалога.
export const FORM_GROUPS = [
  { key: 'tz', title: 'Търговски закон (ТЗ)', note: 'Решенията и протоколите се подписват собственоръчно и се пазят в книгата на дружеството. Обстоятелствата, които подлежат на вписване (напр. нов управител или адрес), се заявяват в Търговския регистър.', items: [
    { title: 'Решение на едноличния собственик', hint: 'ЕООД, чл. 147 ТЗ: ГФО, печалба, дивидент', run: TZ.soleDecision },
    { title: 'Протокол от ОС на съдружниците', hint: 'ООД, чл. 137 ТЗ', run: TZ.gmProtocol },
    { title: 'Покана за ОС на съдружниците', hint: 'ООД, чл. 138 ТЗ', run: TZ.gmInvitation },
    { title: 'Декларация-съгласие на управител', hint: 'чл. 13, ал. 4 ЗТРРЮЛНЦ, с образец от подписа', run: TZ.managerConsent },
    { title: 'Общо пълномощно', hint: 'представителство на фирмата', run: TZ.poa },
  ] },
  { key: 'ngo', title: 'Сдружения и фондации (ЗЮЛНЦ)', note: 'Поканата за общо събрание се разгласява по реда на устава и чл. 26 ЗЮЛНЦ. Годишният доклад на организациите в обществена полза се публикува в Регистъра на юридическите лица с нестопанска цел.', items: [
    { title: 'Покана за ОС на сдружението', hint: 'чл. 26 ЗЮЛНЦ', run: NGO.invitation },
    { title: 'Протокол от ОС на сдружението', hint: 'кворум по чл. 27 ЗЮЛНЦ', run: NGO.protocol },
    { title: 'Протокол от заседание на УС', hint: 'решения на управителния съвет', run: NGO.boardDecision },
    { title: 'Заявление за членство', hint: 'до управителния съвет', run: NGO.membership },
    { title: 'Годишен доклад за дейността', hint: 'дейности, резултати, финанси', run: NGO.annualReport },
  ] },
  { key: 'acc', title: 'За счетоводители', note: 'Подписът и печатът не са задължителни реквизити на счетоводните документи, затова те са без места за подпис и печат. Договорът и пълномощното се подписват от страните.', items: [
    { title: 'Протокол за предаване на документи', hint: 'от клиента към счетоводителя за период', run: ACC.handoverDocs },
    { title: 'Справка за издадените документи', hint: 'за дневника за продажби, с анулираните', run: ACC.register },
    { title: 'Инвентаризационен опис', hint: 'стоките с количества по данни', run: ACC.inventory },
    { title: 'Авансов отчет', hint: 'разходи на подотчетно лице', run: ACC.advanceReport },
    { title: 'Командировъчна заповед', hint: 'Наредба за командировките в страната', run: ACC.travelOrder },
    { title: 'Договор за счетоводно обслужване', hint: 'с клиент от контрагентите', run: ACC.serviceContract },
    { title: 'Пълномощно за НАП и НОИ', hint: 'представителство на клиент', run: ACC.napPoa },
  ] },
];
