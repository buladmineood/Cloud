// Документи, които се създават като PDF в браузъра и не се пазят (данните им остават в системата):
//  • по ЗОП — от страницата на обществената поръчка: ценово и техническо предложение, декларации, опис,
//    искания до възложителя, пълномощно, споразумение за обединение, съгласие на подизпълнител;
//  • по ЗСч — приемо-предавателен протокол, потвърждение на салдо, покана за плащане, касови ордери.
// Документите по ЗОП са проекти: ако възложителят е дал образец, се ползва неговият. Подписват се с КЕП
// и се подават само в ЦАИС ЕОП.
import { addressLine, amountWords, field, formatDate, formDialog, h, money, round2, selectField, today, toast } from './core.js?v=acbd99f011';
import { buildLetter, saveFile } from './pdf.js?v=acbd99f011';

const ZOP_NOTE = 'Проект, създаден от данните в BulAdmin Cloud. Ако възложителят е предоставил образец, използвайте неговия. Документите се подписват с КЕП и се подават само в ЦАИС ЕОП.';
const safeName = (s) => String(s).replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);

const textarea = (name, label, { value = '', rows = 4, hint, required } = {}) => h('div', { class: 'field full' },
  h('label', { for: `f-${name}` }, label, hint && h('span', { class: 'field__hint' }, ` (${hint})`)),
  h('textarea', { id: `f-${name}`, name, rows, maxlength: 8000, required }, value));
const checkbox = (name, label, checked = false) => h('div', { class: 'field full' }, h('label', { class: 'check' }, h('input', { type: 'checkbox', name, checked }), h('span', {}, label)));
const grid = (...children) => h('div', { class: 'form__grid' }, children);
const lines = (text) => String(text || '').split('\n').map((s) => s.trim()).filter(Boolean);

function required(values, names) {
  const fields = {};
  for (const [name, message] of Object.entries(names)) if (!String(values[name] || '').trim()) fields[name] = message || 'Задължително поле.';
  if (Object.keys(fields).length) throw Object.assign(new Error('Попълнете задължителните полета.'), { fields });
}

async function download(spec, filename) {
  try {
    saveFile(await buildLetter(spec), `${safeName(filename)}.pdf`);
    return true;
  } catch (err) {
    toast(err.message, 'error');
    throw err;
  }
}

const signerFields = (company, label = 'Подписва') => [
  field({ name: 'signer', label, value: company.mol || '', maxlength: 120 }),
  field({ name: 'role', label: 'В качеството на', value: 'управител', maxlength: 120 }),
];
const declarant = (v, c) => `Долуподписаният/ата ${v.signer}, в качеството си на ${v.role} на ${c.name}, ЕИК ${c.eik || "—"}${addressLine(c) ? `, със седалище и адрес на управление: ${addressLine(c)}` : ''}`;
const signature = (v, label = 'Подпис') => [{ label, name: v.signer, role: v.role }];

// ============================ ЗОП ============================

function tenderContext(t, env) {
  const authority = (t.companyId && env.find('companies', t.companyId)) || {};
  const subject = (lot) => `обществена поръчка с предмет „${t.tenderName}“${t.eopNumber ? `, уникален номер в ЦАИС ЕОП ${t.eopNumber}` : ''}${lot ? `, обособена позиция: ${lot}` : ''}`;
  return {
    company: env.company,
    to: { label: 'ДО', lines: [t.authority || authority.name || 'Възложителя', addressLine(authority)] },
    subject,
    authorityName: t.authority || authority.name || 'възложителя',
  };
}

export const ZOP_DOCS = [
  { key: 'price', title: 'Ценово предложение', hint: 'таблица с цените и сума с думи' },
  { key: 'technical', title: 'Техническо предложение', hint: 'срок, начин на изпълнение, валидност' },
  { key: 'confidential', title: 'Декларация за конфиденциалност', hint: 'чл. 102 ЗОП' },
  { key: 'offshore', title: 'Декларация по ЗИФОДРЮПДРСЛ', hint: 'офшорни дружества, чл. 3, т. 8 и чл. 4' },
  { key: 'owners', title: 'Декларация за действителните собственици', hint: 'чл. 59, ал. 1, т. 3 ЗМИП' },
  { key: 'inventory', title: 'Опис на представените документи', hint: 'от списъка с документи' },
  { key: 'clarify', title: 'Искане за разяснения', hint: 'чл. 33 ЗОП' },
  { key: 'abnormal', title: 'Обосновка на предложението', hint: 'чл. 72 ЗОП' },
  { key: 'guarantee', title: 'Искане за освобождаване на гаранция', hint: 'за участие или изпълнение' },
  { key: 'poa', title: 'Пълномощно', hint: 'за подписване и подаване на офертата' },
  { key: 'consortium', title: 'Споразумение за обединение', hint: 'чл. 10, ал. 2 ЗОП' },
  { key: 'subcontractor', title: 'Декларация за съгласие на подизпълнител', hint: 'чл. 66 ЗОП' },
];

const ZOP_BUILDERS = {
  async price(t, env, z) {
    const c = z.company;
    const offers = env.documents.filter((d) => d.docType === 'Оферта' && d.docStatus !== 'Анулиран' && (d.companyId === t.companyId || (t.dealId && d.dealId === t.dealId)));
    const v = await formDialog({
      title: 'Ценово предложение',
      wide: true,
      fields: [grid(
        selectField({ name: 'source', label: 'Цени от', options: [['', `Стойността в поръчката (${t.offerValue ? money(t.offerValue) : 'не е въведена'})`], ...offers.map((d) => [d.id, `Оферта ${d.number || 'чернова'} · ${money(d.subtotal, d.currency)} без ДДС`])], value: offers[0]?.id || '', wrapClass: 'full' }),
        field({ name: 'lot', label: 'Обособена позиция', hint: 'ако има', maxlength: 200 }),
        selectField({ name: 'vatRate', label: 'ДДС', options: [['20', '20%'], ['9', '9%'], ['0', 'без ДДС']], value: c.vatRegistered === 'Не' ? '0' : '20' }),
        ...signerFields(c)),
      h('p', { class: 'small muted' }, 'Ценовото предложение се попълва по образеца на възложителя, ако има такъв. Тук се създава проект със същите данни.')],
      submitLabel: 'Изтеглете PDF',
      onSubmit: async (values) => {
        const offer = values.source && env.find('documents', values.source);
        const rows = offer
          ? offer.lines.map((l) => ({ name: l.name, qty: l.qty, unit: l.unit, price: l.price * (1 - (l.discount || 0) / 100), vatRate: l.vatRate }))
          : [{ name: t.tenderName, qty: 1, unit: 'бр.', price: Number(t.offerValue) || 0, vatRate: Number(values.vatRate) }];
        if (!rows.some((r) => r.price > 0)) throw Object.assign(new Error('Въведете „Наша цена“ в поръчката или изберете оферта.'), { fields: { source: 'Няма цена.' } });
        const cur = offer?.currency || 'EUR';
        const net = round2(rows.reduce((s, r) => s + round2(r.qty * r.price), 0));
        const vat = round2(rows.reduce((s, r) => s + round2((r.qty * r.price * (offer ? r.vatRate : Number(values.vatRate))) / 100), 0));
        await download({
          title: 'Ценово предложение', subtitle: `за участие в ${z.subject(values.lot)}`, issuer: c, logo: await env.logo(), to: z.to,
          blocks: [
            { p: `${declarant(values, c)},` },
            { p: 'УВАЖАЕМИ ДАМИ И ГОСПОДА,', bold: true },
            { p: `След запознаване с документацията на обществената поръчка предлагаме да я изпълним при следните цени в ${cur === 'EUR' ? 'евро' : cur}:` },
            { table: {
              cols: [{ label: '№', w: 5 }, { label: 'Наименование', w: 45 }, { label: 'Кол.', w: 9, right: true }, { label: 'Мярка', w: 9 }, { label: 'Ед. цена без ДДС', w: 16, right: true }, { label: 'Стойност без ДДС', w: 16, right: true }],
              rows: rows.map((r, i) => [i + 1, r.name, r.qty, r.unit, money(r.price, cur), money(round2(r.qty * r.price), cur)]),
              foot: [['', 'Общо без ДДС', '', '', '', money(net, cur)], ['', 'ДДС', '', '', '', money(vat, cur)], ['', 'Общо с ДДС', '', '', '', money(round2(net + vat), cur)]],
            } },
            { p: `Предлаганата обща цена за изпълнение на поръчката е ${money(net, cur)} (${amountWords(net, cur)}) без ДДС, съответно ${money(round2(net + vat), cur)} (${amountWords(net + vat, cur)}) с ДДС.` },
            { list: [
              'Посочените цени включват всички разходи за качественото и срочно изпълнение на поръчката.',
              'Цените са окончателни и не подлежат на увеличение за срока на изпълнение на договора, освен в случаите, предвидени в него и в ЗОП.',
              'При несъответствие между цифровото и словесното изписване на сумите за вярно се приема словесното.',
              'До сключването на договор това предложение заедно с решението на възложителя за определяне на изпълнител има силата на споразумение между нас.',
            ] },
          ],
          date: today(), place: c.city, signatures: signature(values), note: ZOP_NOTE,
        }, `Ценово предложение - ${t.tenderName}`);
      },
    });
    return v;
  },

  async technical(t, env, z) {
    const c = z.company;
    const days = t.validUntil && t.submissionDeadline ? Math.max(0, Math.round((Date.parse(t.validUntil) - Date.parse(String(t.submissionDeadline).slice(0, 10))) / 864e5)) : '';
    return formDialog({
      title: 'Техническо предложение',
      wide: true,
      fields: [grid(
        field({ name: 'lot', label: 'Обособена позиция', hint: 'ако има', maxlength: 200 }),
        field({ name: 'term', label: 'Срок за изпълнение', placeholder: 'напр. 60 календарни дни от възлагането', maxlength: 200 }),
        field({ name: 'validity', label: 'Срок на валидност на офертата (дни)', value: String(days || ''), inputmode: 'numeric', maxlength: 4 }),
        field({ name: 'warranty', label: 'Гаранционен срок', hint: 'ако е приложимо', maxlength: 200 }),
        textarea('approach', 'Предложение за изпълнение', { rows: 7, hint: 'организация, етапи, ресурси, контрол на качеството' }),
        ...signerFields(c))],
      submitLabel: 'Изтеглете PDF',
      onSubmit: async (v) => {
        required(v, { term: 'Въведете срока за изпълнение.', approach: 'Опишете как ще изпълните поръчката.' });
        await download({
          title: 'Техническо предложение', subtitle: `за изпълнение на ${z.subject(v.lot)}`, issuer: c, logo: await env.logo(), to: z.to,
          blocks: [
            { p: `${declarant(v, c)},` },
            { p: 'УВАЖАЕМИ ДАМИ И ГОСПОДА,', bold: true },
            { p: 'След запознаване с документацията на обществената поръчка заявяваме, че желаем да участваме в нея при условията, обявени в документацията и приети от нас, и представяме следното предложение:' },
            { h: '1. Предмет и съответствие' },
            { p: 'Предлагаме да изпълним поръчката в пълно съответствие с техническата спецификация и изискванията на възложителя.' },
            { h: '2. Срок за изпълнение' },
            { p: v.term },
            { h: '3. Предложение за изпълнение на поръчката' },
            { p: v.approach },
            v.warranty && { h: '4. Гаранционен срок' },
            v.warranty && { p: v.warranty },
            { h: `${v.warranty ? 5 : 4}. Декларираме, че:` },
            { list: [
              'приемаме условията в проекта на договора;',
              v.validity ? `офертата ни е валидна ${v.validity} дни от крайния срок за получаване на оферти;` : 'офертата ни е валидна в срока, определен от възложителя;',
              'при изпълнението ще спазваме задълженията, свързани с данъци и осигуровки, опазване на околната среда, закрила на заетостта и условията на труд;',
              'запознати сме със съдържанието на документацията и нямаме възражения по нея.',
            ], numbered: false },
          ],
          date: today(), place: c.city, signatures: signature(v), note: ZOP_NOTE,
        }, `Техническо предложение - ${t.tenderName}`);
      },
    });
  },

  async confidential(t, env, z) {
    const c = z.company;
    return formDialog({
      title: 'Декларация за конфиденциалност (чл. 102 ЗОП)',
      wide: true,
      fields: [grid(
        textarea('parts', 'Коя информация е конфиденциална', { rows: 4, hint: 'документ, раздел, страници', value: '' }),
        textarea('reason', 'Защо', { rows: 3, value: 'Съдържа технически и търговски тайни, чието разкриване би увредило законните търговски интереси на участника.' }),
        ...signerFields(c, 'Декларатор')),
      h('p', { class: 'small muted' }, 'Не може да се иска конфиденциалност за предложенията, които подлежат на оценка (чл. 102, ал. 2 ЗОП), например цената.')],
      submitLabel: 'Изтеглете PDF',
      onSubmit: async (v) => {
        required(v, { parts: 'Посочете конфиденциалната информация.' });
        await download({
          title: 'Декларация', subtitle: 'по чл. 102 от Закона за обществените поръчки', issuer: c, logo: await env.logo(),
          blocks: [
            { p: `${declarant(v, c)}, участник в ${z.subject()},` },
            { p: 'ДЕКЛАРИРАМ:', bold: true },
            { list: [
              `Информацията, съдържаща се в: ${v.parts}, да се счита за конфиденциална. ${v.reason}`,
              'Не желаем посочената информация да бъде разкривана от възложителя, освен в предвидените от закона случаи.',
              'Запознат/а съм, че не мога да се позовавам на конфиденциалност по отношение на предложенията от офертата, които подлежат на оценка.',
            ] },
            { p: 'Известна ми е отговорността по чл. 313 от Наказателния кодекс за посочване на неверни данни.', muted: true },
          ],
          date: today(), place: c.city, signatures: signature(v, 'Декларатор'), note: ZOP_NOTE,
        }, `Декларация чл. 102 ЗОП - ${t.tenderName}`);
      },
    });
  },

  async offshore(t, env, z) {
    const c = z.company;
    return formDialog({
      title: 'Декларация по ЗИФОДРЮПДРСЛ',
      wide: true,
      fields: [grid(
        selectField({ name: 'status', label: 'Дружеството', wrapClass: 'full', value: 'no', options: [
          ['no', 'не е регистрирано в юрисдикция с преференциален данъчен режим и не е свързано с такива лица'],
          ['exception', 'е свързано с такова лице, но попада в изключение по чл. 4 от закона'],
        ] }),
        field({ name: 'exception', label: 'Изключение по чл. 4', hint: 'само при второто', placeholder: 'напр. чл. 4, т. 1 — акциите се търгуват на регулиран пазар', maxlength: 300, wrapClass: 'full' }),
        ...signerFields(c, 'Декларатор'))],
      submitLabel: 'Изтеглете PDF',
      onSubmit: async (v) => {
        if (v.status === 'exception') required(v, { exception: 'Посочете изключението.' });
        await download({
          title: 'Декларация',
          subtitle: 'по чл. 3, т. 8 и чл. 4 от Закона за икономическите и финансовите отношения с дружествата, регистрирани в юрисдикции с преференциален данъчен режим, контролираните от тях лица и техните действителни собственици',
          issuer: c, logo: await env.logo(),
          blocks: [
            { p: `${declarant(v, c)}, във връзка с ${z.subject()},` },
            { p: 'ДЕКЛАРИРАМ, ЧЕ:', bold: true },
            v.status === 'no'
              ? { list: [
                'Представляваното от мен дружество не е регистрирано в юрисдикция с преференциален данъчен режим.',
                'Представляваното от мен дружество не е свързано лице с дружество, регистрирано в юрисдикция с преференциален данъчен режим, и не е контролирано от такова дружество.',
              ] }
              : { list: [
                'Представляваното от мен дружество е свързано с дружество, регистрирано в юрисдикция с преференциален данъчен режим, но за него не се прилага забраната по чл. 3, т. 8 от закона, тъй като е налице изключение:',
                v.exception,
              ] },
            { p: 'Задължавам се при промяна на декларираните обстоятелства да уведомя възложителя в 7-дневен срок от настъпването ѝ.' },
            { p: 'Известна ми е отговорността по чл. 313 от Наказателния кодекс за посочване на неверни данни.', muted: true },
          ],
          date: today(), place: c.city, signatures: signature(v, 'Декларатор'), note: ZOP_NOTE,
        }, `Декларация ЗИФОДРЮПДРСЛ - ${t.tenderName}`);
      },
    });
  },

  async owners(t, env, z) {
    const c = z.company;
    return formDialog({
      title: 'Декларация за действителните собственици (ЗМИП)',
      wide: true,
      fields: [grid(
        textarea('owners', 'Действителни собственици', { rows: 5, hint: 'по един на ред: име, дата на раждане, гражданство, постоянен адрес, вид и размер на участието', value: c.mol ? `${c.mol}, …, българско, …, 100% от капитала` : '' }),
        ...signerFields(c, 'Декларатор')),
      h('p', { class: 'small muted' }, 'Данните се въвеждат само за този PDF и не се пазят в системата.')],
      submitLabel: 'Изтеглете PDF',
      onSubmit: async (v) => {
        required(v, { owners: 'Въведете поне един действителен собственик.' });
        await download({
          title: 'Декларация', subtitle: 'по чл. 59, ал. 1, т. 3 от Закона за мерките срещу изпирането на пари', issuer: c, logo: await env.logo(),
          blocks: [
            { p: `${declarant(v, c)}, във връзка с ${z.subject()},` },
            { p: 'ДЕКЛАРИРАМ, ЧЕ:', bold: true },
            { p: `Действителен собственик/собственици на ${c.name} по смисъла на § 2 от допълнителните разпоредби на Закона за мерките срещу изпирането на пари е/са:` },
            { list: lines(v.owners) },
            { p: 'Данните за действителните собственици са вписани в съответния регистър по чл. 63 от ЗМИП.' },
            { p: 'Известна ми е отговорността по чл. 313 от Наказателния кодекс за посочване на неверни данни.', muted: true },
          ],
          date: today(), place: c.city, signatures: signature(v, 'Декларатор'), note: ZOP_NOTE,
        }, `Декларация ЗМИП - ${t.tenderName}`);
      },
    });
  },

  async inventory(t, env, z) {
    const c = z.company;
    const items = (t.checklist || []).filter((i) => i.state !== 'Неприложим');
    return formDialog({
      title: 'Опис на представените документи',
      wide: true,
      fields: [grid(
        selectField({ name: 'group', label: 'Документи', options: [['Оферта', 'за офертата'], ['Преди договор', 'преди сключване на договор'], ['', 'всички']], value: 'Оферта' }),
        selectField({ name: 'state', label: 'Кои', options: [['Готов', 'само готовите'], ['', 'всички неотхвърлени']], value: '' }),
        field({ name: 'lot', label: 'Обособена позиция', hint: 'ако има', maxlength: 200 }),
        ...signerFields(c)),
      h('p', { class: 'small muted' }, `В списъка на поръчката има ${items.length} приложими документа. Бележката към всеки се отпечатва в колона „Забележка“.`)],
      submitLabel: 'Изтеглете PDF',
      onSubmit: async (v) => {
        const rows = items.filter((i) => (!v.group || i.group === v.group) && (!v.state || i.state === v.state));
        if (!rows.length) throw new Error('Няма документи по избраните условия.');
        await download({
          title: 'Опис', subtitle: `на документите в офертата за участие в ${z.subject(v.lot)}`, issuer: c, logo: await env.logo(), to: z.to,
          blocks: [
            { table: { cols: [{ label: '№', w: 6 }, { label: 'Документ', w: 64 }, { label: 'Забележка', w: 30 }], rows: rows.map((i, n) => [n + 1, i.label, i.note || '']) } },
          ],
          date: today(), place: c.city, signatures: signature(v), note: ZOP_NOTE,
        }, `Опис - ${t.tenderName}`);
      },
    });
  },

  async clarify(t, env, z) {
    const c = z.company;
    const late = t.questionsDeadline && t.questionsDeadline < new Date().toISOString();
    return formDialog({
      title: 'Искане за разяснения (чл. 33 ЗОП)',
      wide: true,
      fields: [grid(
        textarea('questions', 'Въпроси', { rows: 7, hint: 'по един на ред' }),
        ...signerFields(c)),
      h('p', { class: `small ${late ? 'text-error' : 'muted'}` }, late
        ? `Внимание: срокът за въпроси (${formatDate(t.questionsDeadline)}) е изтекъл.`
        : 'Искането се подава през ЦАИС ЕОП до 10 дни преди срока за получаване на оферти (чл. 33, ал. 1 ЗОП). Разясненията се публикуват за всички участници, без да се посочва кой е питал.')],
      submitLabel: 'Изтеглете PDF',
      onSubmit: async (v) => {
        required(v, { questions: 'Въведете поне един въпрос.' });
        await download({
          title: 'Искане за разяснения', subtitle: `по чл. 33 от ЗОП относно ${z.subject()}`, issuer: c, logo: await env.logo(), to: z.to,
          blocks: [
            { p: 'УВАЖАЕМИ ДАМИ И ГОСПОДА,', bold: true },
            { p: 'На основание чл. 33, ал. 1 от Закона за обществените поръчки моля да предоставите разяснения по условията на обществената поръчка, както следва:' },
            { list: lines(v.questions) },
            { p: 'Благодарим предварително.' },
          ],
          date: today(), place: c.city, signatures: signature(v), note: ZOP_NOTE,
        }, `Искане за разяснения - ${t.tenderName}`);
      },
    });
  },

  async abnormal(t, env, z) {
    const c = z.company;
    const reasons = [
      ['r1', 'икономичност при изпълнението на поръчката (т. 1)'],
      ['r2', 'избрани технически решения или наличие на изключително благоприятни условия за участника (т. 2)'],
      ['r3', 'оригиналност на предложеното решение по отношение на строителството, доставките или услугите (т. 3)'],
      ['r4', 'спазване на задълженията по чл. 115 от ЗОП (т. 4)'],
      ['r5', 'възможност участникът да получи държавна помощ (т. 5)'],
    ];
    return formDialog({
      title: 'Обосновка по чл. 72 ЗОП',
      wide: true,
      fields: [grid(
        field({ name: 'request', label: 'Искане на комисията', hint: '№ и дата, ако има', maxlength: 200, wrapClass: 'full' }),
        h('p', { class: 'small full' }, h('strong', {}, 'Обстоятелства по чл. 72, ал. 2 ЗОП')), reasons.map(([name, label], i) => checkbox(name, label, i === 0)),
        textarea('explanation', 'Обосновка', { rows: 8, hint: 'конкретни факти и разчети за цената' }),
        ...signerFields(c))],
      submitLabel: 'Изтеглете PDF',
      onSubmit: async (v) => {
        const chosen = reasons.filter(([name]) => v[name]).map(([, label]) => label);
        if (!chosen.length) throw new Error('Изберете поне едно обстоятелство.');
        required(v, { explanation: 'Напишете обосновката.' });
        await download({
          title: 'Обосновка', subtitle: `по чл. 72 от ЗОП за ${z.subject()}`, issuer: c, logo: await env.logo(), to: { ...z.to, lines: [`Комисията, назначена от ${z.authorityName}`, ...z.to.lines.slice(1)] },
          blocks: [
            { p: 'УВАЖАЕМИ ЧЛЕНОВЕ НА КОМИСИЯТА,', bold: true },
            { p: `${v.request ? `В отговор на Ваше искане ${v.request} ` : 'В отговор на искането Ви '}представяме обосновка на предложението си, което е с повече от 20 на сто по-благоприятно от средната стойност на предложенията на останалите участници по същия показател за оценка.` },
            { p: 'Предложението ни се дължи на следните обективни обстоятелства по чл. 72, ал. 2 от ЗОП:' },
            { list: chosen },
            { h: 'Обосновка' },
            { p: v.explanation },
            { p: 'Предложението ни гарантира качествено и срочно изпълнение на поръчката при спазване на приложимите правила за опазване на околната среда, социалното и трудовото право.' },
          ],
          date: today(), place: c.city, signatures: signature(v), note: ZOP_NOTE,
        }, `Обосновка чл. 72 ЗОП - ${t.tenderName}`);
      },
    });
  },

  async guarantee(t, env, z) {
    const c = z.company;
    const accounts = c.bankAccounts || [];
    return formDialog({
      title: 'Искане за освобождаване на гаранция',
      wide: true,
      fields: [grid(
        selectField({ name: 'kind', label: 'Гаранция за', options: [['участие', 'участие'], ['изпълнение', 'изпълнение']], value: t.performanceGuarantee ? 'изпълнение' : 'участие' }),
        field({ name: 'amount', label: 'Размер (EUR)', value: String(t.performanceGuarantee || t.guaranteeAmount || '').replace('.', ','), inputmode: 'decimal', maxlength: 20 }),
        selectField({ name: 'form', label: 'Форма', options: ['Парична сума', 'Банкова гаранция', 'Застраховка'], value: ['Парична сума', 'Банкова гаранция', 'Застраховка'].includes(t.guaranteeType) ? t.guaranteeType : 'Парична сума' }),
        field({ name: 'reference', label: 'Документ за гаранцията', hint: 'платежно, № на гаранция/полица', maxlength: 200 }),
        field({ name: 'contract', label: 'Договор', hint: '№ и дата, при гаранция за изпълнение', value: t.contractDate ? `от ${formatDate(t.contractDate)}` : '', maxlength: 200 }),
        selectField({ name: 'iban', label: 'Сметка за възстановяване', options: accounts.length ? accounts.map((a) => [a.iban, `${a.iban}${a.bank ? ` · ${a.bank}` : ''}`]) : [['', 'няма въведена сметка']], value: accounts[0]?.iban || '' }),
        ...signerFields(c))],
      submitLabel: 'Изтеглете PDF',
      onSubmit: async (v) => {
        const amount = Number(String(v.amount).replace(/\s/g, '').replace(',', '.'));
        if (!(amount > 0)) throw Object.assign(new Error('Въведете размера на гаранцията.'), { fields: { amount: 'Въведете сума.' } });
        const account = accounts.find((a) => a.iban === v.iban);
        await download({
          title: 'Искане', subtitle: `за освобождаване на гаранция за ${v.kind} по ${z.subject()}`, issuer: c, logo: await env.logo(), to: z.to,
          blocks: [
            { p: 'УВАЖАЕМИ ДАМИ И ГОСПОДА,', bold: true },
            { p: `Моля да бъде освободена гаранцията за ${v.kind} в размер на ${money(amount)} (${amountWords(amount)}), представена от ${c.name}, ЕИК ${c.eik}, под формата на ${v.form.toLowerCase()}${v.reference ? ` (${v.reference})` : ''}${v.kind === 'изпълнение' && v.contract ? ` по договор ${v.contract}` : ''}.` },
            { p: v.kind === 'участие'
              ? 'Основанието за освобождаване е настъпило съгласно условията на поръчката и ЗОП (процедурата е приключила, прекратена е или е сключен договор).'
              : 'Договорът е изпълнен и сроковете и условията за освобождаване на гаранцията по договора са настъпили.' },
            v.form === 'Парична сума'
              ? { p: `Моля сумата да бъде преведена по банкова сметка: IBAN ${account?.iban || '……………………'}${account?.bic ? `, BIC ${account.bic}` : ''}${account?.bank ? `, ${account.bank}` : ''}, титуляр ${c.name}.` }
              : { p: `Моля оригиналът на ${v.form === 'Банкова гаранция' ? 'банковата гаранция' : 'застрахователната полица'} да бъде върнат на ${c.name} или банката/застрахователя да бъде уведомен(а) за освобождаването.` },
          ],
          date: today(), place: c.city, signatures: signature(v), note: ZOP_NOTE,
        }, `Искане за гаранция - ${t.tenderName}`);
      },
    });
  },

  async poa(t, env, z) {
    const c = z.company;
    return formDialog({
      title: 'Пълномощно',
      wide: true,
      fields: [grid(
        field({ name: 'agent', label: 'Упълномощено лице', placeholder: 'три имена', maxlength: 120 }),
        field({ name: 'agentId', label: 'Данни за самоличност', hint: 'ЕГН/дата на раждане, лична карта', maxlength: 200 }),
        textarea('scope', 'Правомощия', { rows: 5, value: `да представлява ${c.name} пред ${z.authorityName} във връзка с участието му в ${z.subject()}, като подписва с квалифициран електронен подпис и подава в ЦАИС ЕОП офертата и всички документи към нея, получава съобщения, подава искания за разяснения и представя документи при поискване от комисията.` }),
        ...signerFields(c, 'Упълномощител')),
      h('p', { class: 'small muted' }, 'Данните на упълномощеното лице се въвеждат само за този PDF и не се пазят.')],
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
            { p: 'Пълномощното е валидно до приключване на процедурата за възлагане на обществената поръчка. Упълномощеното лице няма право да преупълномощава трети лица.' },
          ],
          date: today(), place: c.city, signatures: [{ label: 'Упълномощител', name: v.signer, role: v.role }, { label: 'Приел пълномощието', name: v.agent }], note: ZOP_NOTE,
        }, `Пълномощно - ${t.tenderName}`);
      },
    });
  },

  async consortium(t, env, z) {
    const c = z.company;
    return formDialog({
      title: 'Споразумение за създаване на обединение',
      wide: true,
      fields: [grid(
        field({ name: 'name', label: 'Наименование на обединението', value: c.name.replace(/\s+(ЕООД|ООД|АД|ЕАД|ЕТ|СД|КД)$/i, ''), hint: 'без кавички', maxlength: 200, wrapClass: 'full' }),
        textarea('partners', 'Участници', { rows: 4, hint: 'по един на ред: наименование, ЕИК, адрес, представляван от, дял %', value: `${c.name}, ЕИК ${c.eik}, ${addressLine(c)}, представлявано от ${c.mol || '…'}, 50%\n` }),
        field({ name: 'leader', label: 'Водещ участник / представляващ', value: `${c.name}, представлявано от ${c.mol || '…'}`, maxlength: 300, wrapClass: 'full' }),
        textarea('duties', 'Разпределение на дейностите', { rows: 4, hint: 'кой коя част изпълнява' }),
        ...signerFields(c))],
      submitLabel: 'Изтеглете PDF',
      onSubmit: async (v) => {
        v.name = String(v.name || '').replace(/[„“"«»]/g, '').trim();
        const partners = lines(v.partners);
        if (partners.length < 2) throw Object.assign(new Error('Обединението е поне от двама участници.'), { fields: { partners: 'Въведете поне двама участници.' } });
        required(v, { duties: 'Опишете разпределението на дейностите.' });
        await download({
          title: 'Споразумение', subtitle: `за създаване на обединение „${v.name}“ за участие в ${z.subject()}`, issuer: c, logo: await env.logo(),
          blocks: [
            { p: `Днес, ${formatDate(today())}, на основание чл. 10, ал. 2 от Закона за обществените поръчки, между:` },
            { list: partners },
            { p: 'се сключи настоящото споразумение за следното:' },
            { h: '1. Цел' },
            { p: `Страните създават обединение „${v.name}“ с цел съвместно участие в ${z.subject()} и изпълнение на договора, ако бъде сключен с обединението.` },
            { h: '2. Представляване' },
            { p: `Обединението се представлява от ${v.leader}, който има право да подписва и подава офертата, да получава съобщения, да подписва договора и да представлява обединението пред възложителя и трети лица.` },
            { h: '3. Разпределение на дейностите' },
            { p: v.duties },
            { h: '4. Отговорност' },
            { p: 'Участниците в обединението носят солидарна отговорност за изпълнението на договора.' },
            { h: '5. Срок и промени' },
            { p: 'Споразумението влиза в сила от подписването му и е със срок до пълното изпълнение на договора, включително гаранционните срокове. Не се допуска промяна в състава на обединението след подаването на офертата.' },
          ],
          date: today(), place: c.city, signatures: partners.slice(0, 6).map((p, i) => ({ label: `За участник ${i + 1}`, name: p.split(',')[0] })), note: ZOP_NOTE,
        }, `Споразумение за обединение - ${t.tenderName}`);
      },
    });
  },

  async subcontractor(t, env, z) {
    const c = z.company;
    const companies = [...env.companies].sort((a, b) => a.name.localeCompare(b.name, 'bg'));
    return formDialog({
      title: 'Декларация за съгласие на подизпълнител',
      wide: true,
      fields: [grid(
        selectField({ name: 'sub', label: 'Подизпълнител', options: [['', 'Изберете контрагент…'], ...companies.map((x) => [x.id, x.name])], value: '', wrapClass: 'full' }),
        field({ name: 'subSigner', label: 'Представляван от', maxlength: 120 }),
        field({ name: 'subRole', label: 'В качеството на', value: 'управител', maxlength: 120 }),
        textarea('work', 'Дейности, които ще изпълнява', { rows: 3 }),
        field({ name: 'share', label: 'Дял от стойността на поръчката (%)', inputmode: 'decimal', maxlength: 6 }))],
      submitLabel: 'Изтеглете PDF',
      onSubmit: async (v) => {
        required(v, { sub: 'Изберете подизпълнителя.', subSigner: 'Въведете представляващия.', work: 'Опишете дейностите.' });
        const sub = env.find('companies', v.sub) || {};
        await download({
          title: 'Декларация', subtitle: `за съгласие за участие като подизпълнител в ${z.subject()}`, issuer: sub,
          blocks: [
            { p: `${declarant({ signer: v.subSigner, role: v.subRole }, sub)},` },
            { p: 'ДЕКЛАРИРАМ, ЧЕ:', bold: true },
            { list: [
              `Представляваното от мен дружество е съгласно да участва като подизпълнител на ${c.name}, ЕИК ${c.eik}, при изпълнението на обществената поръчка.`,
              `Дейностите, които ще изпълняваме, са: ${v.work}${v.share ? `, което съответства на ${v.share}% от стойността на поръчката` : ''}.`,
              'Отговаряме на критериите за подбор, съответстващи на вида и дела от поръчката, който ще изпълняваме, и за нас не са налице основания за отстраняване от процедурата (чл. 66 от ЗОП).',
              'Запознати сме с документацията на поръчката и приемаме условията в нея.',
            ] },
            { p: 'Известна ми е отговорността по чл. 313 от Наказателния кодекс за посочване на неверни данни.', muted: true },
          ],
          date: today(), place: sub.city, signatures: [{ label: 'Декларатор', name: v.subSigner, role: v.subRole }], note: ZOP_NOTE,
        }, `Съгласие на подизпълнител - ${sub.name} - ${t.tenderName}`);
      },
    });
  },
};

export async function zopDocument(key, tender, env) {
  const result = await ZOP_BUILDERS[key](tender, env, tenderContext(tender, env));
  if (result) toast('PDF файлът е изтеглен.');
}

// ============================ ЗСч ============================

const sideOf = (doc, env) => doc.buyer || env.find('companies', doc.companyId) || {};

// Приемо-предавателен протокол към фактура, проформа или оферта.
export async function handoverProtocol(doc, env) {
  const seller = doc.seller || env.company;
  const buyer = sideOf(doc, env);
  const result = await formDialog({
    title: 'Приемо-предавателен протокол',
    wide: true,
    fields: [grid(
      field({ name: 'date', label: 'Дата', type: 'date', value: today() }),
      field({ name: 'place', label: 'Място', value: buyer.city || seller.city || '', maxlength: 120 }),
      selectField({ name: 'kind', label: 'Предмет', options: [['стоки', 'доставка на стоки'], ['услуги', 'извършени услуги'], ['работи', 'извършени работи']], value: 'стоки' }),
      checkbox('prices', 'Отпечатайте цените'),
      field({ name: 'handedBy', label: 'Предал', value: seller.mol || '', maxlength: 120 }),
      field({ name: 'receivedBy', label: 'Приел', value: buyer.mol || '', maxlength: 120 }),
      textarea('remarks', 'Забележки', { rows: 2, hint: 'празно = без забележки' }))],
    submitLabel: 'Изтеглете PDF',
    onSubmit: async (v) => {
      const cur = doc.currency || 'EUR';
      const net = (l) => round2(l.qty * l.price * (1 - (l.discount || 0) / 100));
      const cols = [{ label: '№', w: 5 }, { label: 'Наименование', w: v.prices ? 45 : 65 }, { label: 'Кол.', w: 10, right: true }, { label: 'Мярка', w: 10 }];
      if (v.prices) cols.push({ label: 'Ед. цена', w: 15, right: true }, { label: 'Стойност без ДДС', w: 15, right: true });
      const rows = doc.lines.map((l, i) => [i + 1, l.name, l.qty, l.unit, ...(v.prices ? [money(l.price, cur), money(net(l), cur)] : [])]);
      const what = { стоки: 'стоките', услуги: 'услугите', работи: 'работите' }[v.kind];
      await download({
        title: 'Приемо-предавателен протокол', subtitle: `към ${doc.docType.toLowerCase()} № ${doc.number || '—'} от ${formatDate(doc.issueDate)}`,
        issuer: seller, logo: await env.logo(),
        blocks: [
          { p: `Днес, ${formatDate(v.date)}${v.place ? `, в гр./с. ${v.place}` : ''}, между:` },
          { list: [
            `${seller.name}, ЕИК ${seller.eik || '—'}, ${addressLine(seller)}, наричано по-долу ПРЕДАВАЩ, и`,
            `${buyer.name}, ЕИК ${buyer.eik || '—'}, ${addressLine(buyer)}, наричано по-долу ПРИЕМАЩ,`,
          ], numbered: false },
          { p: `се състави настоящият протокол, с който ПРЕДАВАЩИЯТ предаде, а ПРИЕМАЩИЯТ прие ${v.kind === 'стоки' ? 'следните стоки' : v.kind === 'услуги' ? 'следните извършени услуги' : 'следните извършени работи'}:` },
          { table: { cols, rows, foot: v.prices ? [['', 'Общо без ДДС', '', '', '', money(Math.abs(doc.subtotal), cur)]] : [] } },
          { p: v.remarks ? `Забележки: ${v.remarks}` : `ПРИЕМАЩИЯТ потвърди, че ${what} са ${v.kind === 'стоки' ? 'доставени' : 'извършени'} в договореното количество и качество, без забележки.` },
          { p: 'Протоколът се състави в два еднообразни екземпляра — по един за всяка от страните.' },
        ],
        signatures: [{ label: 'Предал', name: v.handedBy, role: seller.name }, { label: 'Приел', name: v.receivedBy, role: buyer.name }],
      }, `Приемо-предавателен протокол ${doc.number || ''}`);
    },
  });
  if (result) toast('PDF файлът е изтеглен.');
}

// Отворени суми по контрагента към дата: фактури и дебитни известия минус плащанията и кредитните известия.
function openItems(companyId, asOf, env) {
  const kinds = ['Фактура', 'Дебитно известие', 'Кредитно известие'];
  return env.documents
    .filter((d) => d.companyId === companyId && kinds.includes(d.docType) && d.docStatus === 'Издаден' && d.issueDate <= asOf)
    .map((d) => {
      const paid = env.payments.filter((p) => p.documentId === d.id && p.paidAt <= asOf).reduce((s, p) => s + Number(p.amount || 0), 0);
      const open = round2(d.total - Math.sign(d.total) * paid);
      return { d, paid, open };
    })
    .filter((x) => Math.abs(x.open) >= 0.005)
    .sort((a, b) => a.d.issueDate.localeCompare(b.d.issueDate));
}

const itemsTable = (items, cur) => ({
  table: {
    cols: [{ label: 'Документ', w: 22 }, { label: '№', w: 16 }, { label: 'Дата', w: 13 }, { label: 'Падеж', w: 13 }, { label: 'Сума', w: 12, right: true }, { label: 'Платено', w: 12, right: true }, { label: 'Остатък', w: 12, right: true }],
    rows: items.map(({ d, paid, open }) => [d.docType, d.number, formatDate(d.issueDate), d.dueDate ? formatDate(d.dueDate) : '', money(d.total, cur), money(paid, cur), money(open, cur)]),
    foot: [['Общо', '', '', '', '', '', money(round2(items.reduce((s, x) => s + x.open, 0)), cur)]],
  },
});

export async function balanceConfirmation(company, env) {
  const result = await formDialog({
    title: `Потвърждение на салдо: ${company.name}`,
    fields: [grid(
      field({ name: 'asOf', label: 'Към дата', type: 'date', value: today() }),
      field({ name: 'replyBy', label: 'Отговор до', type: 'date', value: new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10) }),
      ...signerFields(env.company))],
    submitLabel: 'Изтеглете PDF',
    onSubmit: async (v) => {
      const items = openItems(company.id, v.asOf, env);
      const byCur = {};
      for (const x of items) (byCur[x.d.currency || 'EUR'] ||= []).push(x);
      const currencies = Object.keys(byCur).length ? Object.keys(byCur) : ['EUR'];
      const c = env.company;
      const blocks = [
        { p: 'УВАЖАЕМИ ДАМИ И ГОСПОДА,', bold: true },
        { p: `Във връзка с инвентаризацията на вземанията и задълженията молим да потвърдите салдото по разчетите между ${c.name} и ${company.name} към ${formatDate(v.asOf)}.` },
      ];
      for (const cur of currencies) {
        const list = byCur[cur] || [];
        const sum = round2(list.reduce((s, x) => s + x.open, 0));
        blocks.push({ p: `Според нашите счетоводни данни ${sum >= 0 ? 'Вие ни дължите' : 'ние Ви дължим'} ${money(Math.abs(sum), cur)} (${amountWords(Math.abs(sum), cur)}).`, bold: true });
        if (list.length) blocks.push(itemsTable(list, cur));
      }
      blocks.push(
        { p: `Моля, върнете подписано потвърждение до ${formatDate(v.replyBy)}. При несъответствие посочете Вашето салдо и документите, които го обясняват.` },
        { space: 10 },
        { h: 'ПОТВЪРЖДЕНИЕ (попълва се от контрагента)' },
        { p: `${company.name}, ЕИК ${company.eik || '……………'}:` },
        { list: ['Потвърждаваме посоченото салдо.', 'Не потвърждаваме салдото. Нашето салдо към същата дата е ……………………, поради: ………………………………………'], numbered: false },
      );
      await download({
        title: 'Потвърждение на салдо', subtitle: `към ${formatDate(v.asOf)}`, issuer: c, logo: await env.logo(),
        to: { lines: [company.name, company.eik && `ЕИК ${company.eik}`, addressLine(company)] },
        blocks, date: today(), place: c.city,
        signatures: [{ label: `За ${c.name}`, name: v.signer, role: v.role }, { label: `За ${company.name}` }],
      }, `Потвърждение на салдо - ${company.name} - ${v.asOf}`);
    },
  });
  if (result) toast('PDF файлът е изтеглен.');
}

export async function paymentReminder(company, env) {
  const accounts = env.company.bankAccounts || [];
  const overdue = openItems(company.id, today(), env).filter((x) => x.open > 0 && x.d.dueDate && x.d.dueDate < today());
  if (!overdue.length) { toast('Няма просрочени документи към този контрагент.', 'error'); return; }
  const result = await formDialog({
    title: `Покана за плащане: ${company.name}`,
    fields: [grid(
      field({ name: 'payBy', label: 'Срок за плащане', type: 'date', value: new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10) }),
      selectField({ name: 'iban', label: 'Сметка', options: accounts.length ? accounts.map((a) => [a.iban, `${a.iban} (${a.currency})`]) : [['', 'няма въведена сметка']], value: accounts[0]?.iban || '' }),
      checkbox('legal', 'Споменете законната лихва и съдебния ред', true),
      ...signerFields(env.company))],
    submitLabel: 'Изтеглете PDF',
    onSubmit: async (v) => {
      const c = env.company;
      const account = accounts.find((a) => a.iban === v.iban);
      const byCur = {};
      for (const x of overdue) (byCur[x.d.currency || 'EUR'] ||= []).push(x);
      const blocks = [
        { p: 'УВАЖАЕМИ ДАМИ И ГОСПОДА,', bold: true },
        { p: `Според нашите счетоводни данни към ${formatDate(today())} имате следните неплатени задължения към ${c.name}, чийто срок за плащане е изтекъл:` },
      ];
      const sums = [];
      for (const [cur, list] of Object.entries(byCur)) {
        blocks.push(itemsTable(list, cur));
        const sum = round2(list.reduce((s, x) => s + x.open, 0));
        sums.push(`${money(sum, cur)} (${amountWords(sum, cur)})`);
      }
      blocks.push(
        { p: `Каним Ви в срок до ${formatDate(v.payBy)} да заплатите доброволно дължимата сума от ${sums.join(' и ')}${account ? ` по банкова сметка IBAN ${account.iban}${account.bic ? `, BIC ${account.bic}` : ''}${account.bank ? `, ${account.bank}` : ''}` : ''}, с основание номерата на документите.` },
        v.legal && { p: 'В случай че плащането не бъде извършено в посочения срок, ще бъдем принудени да потърсим вземането си по съдебен ред, заедно със законната лихва за забава по чл. 86 от Закона за задълженията и договорите и разноските по събирането.' },
        { p: 'Ако вече сте извършили плащането, моля, приемете извиненията ни и не обръщайте внимание на тази покана.' },
      );
      await download({
        title: 'Покана за доброволно плащане', issuer: c, logo: await env.logo(),
        to: { lines: [company.name, company.eik && `ЕИК ${company.eik}`, addressLine(company)] },
        blocks, date: today(), place: c.city, signatures: signature(v, `За ${c.name}`),
      }, `Покана за плащане - ${company.name} - ${today()}`);
    },
  });
  if (result) toast('PDF файлът е изтеглен.');
}

// Приходен (ПКО) или разходен (РКО) касов ордер за плащане в брой.
export async function cashOrder(payment, env) {
  const doc = env.find('documents', payment.documentId) || {};
  const party = sideOf(doc, env);
  const c = doc.seller || env.company;
  const income = payment.cashOrder.startsWith('ПКО');
  const cur = doc.currency || 'EUR';
  await download({
    title: income ? 'Приходен касов ордер' : 'Разходен касов ордер', number: payment.cashOrder, date: payment.paidAt, dateLine: false, issuer: c, logo: await env.logo(),
    blocks: [
      { kv: [
        [income ? 'Получено от' : 'Изплатено на', `${party.name || ''}${party.eik ? `, ЕИК ${party.eik}` : ''}`, true],
        ['Основание', `${income ? 'Плащане' : 'Връщане'} по ${String(doc.docType || '').toLowerCase()} № ${doc.number || '—'} от ${formatDate(doc.issueDate)}${payment.reference ? `; ${payment.reference}` : ''}`],
        ['Сума', money(payment.amount, cur), true],
        ['Словом', amountWords(payment.amount, cur)],
        ['Дата', formatDate(payment.paidAt)],
      ] },
    ],
    signatures: income
      ? [{ label: 'Касиер' }, { label: 'Вносител', name: party.mol || '' }, { label: 'Съставил' }]
      : [{ label: 'Касиер' }, { label: 'Получател', name: party.mol || '' }, { label: 'Ръководител', name: c.mol || '' }],
  }, `Касов ордер ${payment.cashOrder}`);
}
