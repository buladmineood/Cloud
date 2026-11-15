// Създава PDF на оферта или фактура в браузъра с pdf-lib и шрифта Onest (кирилица).
// Библиотеките (около 1,3 MB) се зареждат само при първото създаване на PDF.
import { addressLine } from './core.js?v=c6c5e2e1e0';

const NAVY = [16, 41, 76];
const GOLD = [181, 134, 42];
const INK2 = [74, 90, 115];
const LINE = [220, 215, 203];
const TINT = [243, 239, 230];
const RED = [178, 34, 34];
const A4 = [595.28, 841.89];
const M = 40;
const FOOTER = 'Създадено с BulAdmin Cloud · cloud.buladmin.eu';
const TAX = ['Фактура', 'Кредитно известие', 'Дебитно известие', 'Протокол по чл. 117'];
const PROTOCOL = 'Протокол по чл. 117';

let libsPromise;
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    el.onload = resolve;
    el.onerror = () => reject(new Error('Модулът за PDF не се зареди. Проверете връзката и опитайте отново.'));
    document.head.append(el);
  });
}
function loadLibs() {
  libsPromise ??= (async () => {
    await loadScript('/assets/vendor/pdf-lib.min.js');
    await loadScript('/assets/vendor/fontkit.min.js');
    const [regular, bold] = await Promise.all(['/assets/vendor/onest-regular.ttf', '/assets/vendor/onest-bold.ttf']
      .map((url) => fetch(url).then((res) => {
        if (!res.ok) throw new Error('Шрифтът за PDF не се зареди.');
        return res.arrayBuffer();
      })));
    return { PDFLib: window.PDFLib, fontkit: window.fontkit, regular, bold };
  })().catch((err) => {
    libsPromise = null;
    throw err;
  });
  return libsPromise;
}

// Интервалите от Intl (неразделящи) се заменят с обикновени, за да се изписват с всеки шрифт.
const plain = (s) => String(s ?? '').replace(/[  ]/g, ' ');
const moneyFormats = new Map();
const moneyFormat = (currency) => {
  // Евро е със знака €, а другите валути — с кода си (USD, GBP), както е прието във фактурите.
  if (!moneyFormats.has(currency)) moneyFormats.set(currency, new Intl.NumberFormat('bg-BG', { style: 'currency', currency, currencyDisplay: currency === 'EUR' ? 'symbol' : 'code', minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  return moneyFormats.get(currency);
};
const numFormat = new Intl.NumberFormat('bg-BG', { maximumFractionDigits: 3 });
const money = (n, currency = 'EUR') => plain(moneyFormat(currency).format(Number(n) || 0));
const num = (n) => plain(numFormat.format(Number(n) || 0));
const rateNum = new Intl.NumberFormat('bg-BG', { minimumFractionDigits: 4, maximumFractionDigits: 6 });
const date = (iso) => (iso ? iso.split('-').reverse().join('.') : '');
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const lineNet = (l) => round2(l.qty * l.price * (1 - (l.discount || 0) / 100));

function totalsOf(lines, docType) {
  const bases = new Map();
  for (const l of lines) bases.set(Number(l.vatRate), round2((bases.get(Number(l.vatRate)) || 0) + lineNet(l)));
  const sign = docType === 'Кредитно известие' ? -1 : 1;
  const byRate = [...bases].sort((a, b) => b[0] - a[0]).map(([rate, base]) => ({ rate, base: sign * base, vat: sign * round2((base * rate) / 100) }));
  const subtotal = round2(byRate.reduce((s, r) => s + r.base, 0));
  const vat = round2(byRate.reduce((s, r) => s + r.vat, 0));
  return { byRate, total: round2(subtotal + vat) };
}

const partyLines = (p) => [
  p.eik && `ЕИК: ${p.eik}`, p.vatNumber && `ДДС №: ${p.vatNumber}`, addressLine(p), p.mol && `МОЛ: ${p.mol}`,
].filter(Boolean);

/**
 * doc: документът от /api/data; seller и buyer: данните на страните;
 * logo: { bytes, type } или null; related: свързаният документ (за кредитно известие).
 */
export async function buildPdf({ doc, seller, buyer, logo, related, issuedBy }) {
  const cur = doc.currency || 'EUR';
  const { PDFLib, fontkit, regular, bold } = await loadLibs();
  const { PDFDocument, rgb } = PDFLib;
  const color = (c) => rgb(c[0] / 255, c[1] / 255, c[2] / 255);
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const font = await pdf.embedFont(regular, { subset: true });
  const fontBold = await pdf.embedFont(bold, { subset: true });
  pdf.setTitle(`${doc.docType} ${doc.number || ''}`.trim());
  pdf.setAuthor(seller.name || '');
  pdf.setCreator('BulAdmin Cloud (cloud.buladmin.eu)');
  pdf.setProducer('BulAdmin Cloud');
  pdf.setLanguage('bg-BG');

  let page;
  let y;
  const width = (text, size, f = font) => f.widthOfTextAtSize(plain(text), size);
  const draw = (text, x, yy, { size = 9, f = font, c = NAVY, align = 'left', maxWidth } = {}) => {
    const t = plain(text);
    let xx = x;
    if (align === 'right') xx = x - width(t, size, f);
    if (align === 'center') xx = x - width(t, size, f) / 2;
    page.drawText(t, { x: xx, y: yy, size, font: f, color: color(c), maxWidth });
  };
  // Пренася текста по думи, а прекалено дългите думи — по знаци.
  const wrap = (text, maxWidth, size, f = font) => {
    const lines = [];
    for (const paragraph of plain(text).split('\n')) {
      let current = '';
      for (const word of paragraph.split(' ')) {
        const candidate = current ? `${current} ${word}` : word;
        if (width(candidate, size, f) <= maxWidth) { current = candidate; continue; }
        if (current) lines.push(current);
        current = word;
        while (width(current, size, f) > maxWidth) {
          let cut = current.length - 1;
          while (cut > 1 && width(current.slice(0, cut), size, f) > maxWidth) cut--;
          lines.push(current.slice(0, cut));
          current = current.slice(cut);
        }
      }
      lines.push(current);
    }
    return lines;
  };
  const hline = (yy, c = LINE, thickness = 0.8) => page.drawLine({ start: { x: M, y: yy }, end: { x: A4[0] - M, y: yy }, thickness, color: color(c) });
  const newPage = () => {
    page = pdf.addPage(A4);
    y = A4[1] - M;
  };

  newPage();

  // Заглавие: лого вляво, вид и номер вдясно.
  let headerBottom = y - 50;
  if (logo?.bytes) {
    try {
      const image = logo.type === 'image/png' ? await pdf.embedPng(logo.bytes) : await pdf.embedJpg(logo.bytes);
      const scale = Math.min(170 / image.width, 56 / image.height, 1);
      const w = image.width * scale;
      const h = image.height * scale;
      page.drawImage(image, { x: M, y: y - h, width: w, height: h });
      headerBottom = Math.min(headerBottom, y - h - 6);
    } catch { /* повредено лого не спира документа */ }
  } else {
    draw(seller.name || '', M, y - 16, { size: 14, f: fontBold });
  }
  draw(doc.docType.toUpperCase(), A4[0] - M, y - 18, { size: 20, f: fontBold, align: 'right' });
  draw(doc.number ? `№ ${doc.number}` : 'ЧЕРНОВА', A4[0] - M, y - 34, { size: 12, f: fontBold, align: 'right' });
  const cancelled = doc.docStatus === 'Анулиран';
  if (cancelled) draw('АНУЛИРАН', A4[0] - M, y - 48, { size: 10, f: fontBold, c: RED, align: 'right' });
  else if (TAX.includes(doc.docType) && doc.number) draw('ОРИГИНАЛ', A4[0] - M, y - 47, { size: 8, c: INK2, align: 'right' });
  y = headerBottom - 6;
  hline(y, GOLD, 2);
  y -= 18;

  // Дати и свързан документ.
  const dates = [
    ['Дата на издаване', date(doc.issueDate)],
    TAX.includes(doc.docType) && ['Дата на данъчно събитие', date(doc.taxEventDate || doc.issueDate)],
    doc.dueDate && doc.docType !== PROTOCOL && [doc.docType === 'Оферта' ? 'Валидна до' : 'Падеж', date(doc.dueDate)],
  ].filter(Boolean);
  dates.forEach(([label, value], i) => {
    draw(label, A4[0] - M - 90, y - i * 13, { size: 8.5, c: INK2, align: 'right' });
    draw(value, A4[0] - M, y - i * 13, { size: 9, f: fontBold, align: 'right' });
  });
  const note = related ? `Към ${related.docType.toLowerCase()} № ${related.number} от ${date(related.issueDate)}`
    : doc.docType === PROTOCOL ? `По фактура № ${doc.sourceDocNumber || '—'} от ${date(doc.sourceDocDate)} на доставчика`
      : doc.advance === 'Да' ? 'Фактура за авансово плащане' : '';
  if (note) draw(note, M, y, { size: 9, c: INK2, f: doc.advance === 'Да' ? fontBold : font });
  y -= dates.length * 13 + 10;

  // Получател и доставчик.
  const boxW = (A4[0] - 2 * M - 14) / 2;
  const party = (title, p) => [title, p.name || '', ...partyLines(p).flatMap((l) => wrap(l, boxW - 20, 8.5))];
  const parties = doc.docType === PROTOCOL ? [party('ДОСТАВЧИК', buyer), party('ПОЛУЧАТЕЛ (ИЗДАТЕЛ НА ПРОТОКОЛА)', seller)] : [party('ПОЛУЧАТЕЛ', buyer), party('ДОСТАВЧИК', seller)];
  const boxH = 14 + Math.max(...parties.map((p) => (p.length - 2) * 11 + 26));
  parties.forEach((lines, i) => {
    const x = M + i * (boxW + 14);
    page.drawRectangle({ x, y: y - boxH, width: boxW, height: boxH, borderColor: color(LINE), borderWidth: 0.8 });
    draw(lines[0], x + 10, y - 14, { size: 7.5, f: fontBold, c: INK2 });
    draw(lines[1], x + 10, y - 28, { size: 10.5, f: fontBold, maxWidth: boxW - 20 });
    lines.slice(2).forEach((l, j) => draw(l, x + 10, y - 41 - j * 11, { size: 8.5 }));
  });
  y -= boxH + 18;

  // Редове.
  const cols = [
    { label: '№', w: 22 }, { label: 'Наименование', w: 199 }, { label: 'Кол.', w: 42, right: true }, { label: 'Мярка', w: 38 },
    { label: 'Ед. цена', w: 64, right: true }, { label: 'Отст.', w: 38, right: true }, { label: 'ДДС', w: 34, right: true }, { label: 'Стойност', w: 78, right: true },
  ];
  const colX = cols.reduce((acc, c, i) => [...acc, (acc[i - 1] ?? M) + (cols[i - 1]?.w ?? 0)], []);
  const tableHeader = () => {
    page.drawRectangle({ x: M, y: y - 16, width: A4[0] - 2 * M, height: 18, color: color(TINT) });
    cols.forEach((c, i) => draw(c.label, c.right ? colX[i] + c.w - 4 : colX[i] + 4, y - 11, { size: 7.5, f: fontBold, c: INK2, align: c.right ? 'right' : 'left' }));
    y -= 20;
  };
  tableHeader();
  doc.lines.forEach((l, index) => {
    const nameLines = wrap(l.name, cols[1].w - 8, 8.5);
    const rowH = nameLines.length * 11 + 7;
    if (y - rowH < 110) {
      newPage();
      tableHeader();
    }
    const cells = [String(index + 1), null, num(l.qty), l.unit, money(l.price, cur), l.discount ? `${num(l.discount)}%` : '', `${l.vatRate}%`, money(lineNet(l), cur)];
    cells.forEach((value, i) => {
      if (i === 1) nameLines.forEach((t, j) => draw(t, colX[1] + 4, y - 10 - j * 11, { size: 8.5 }));
      else if (value) draw(value, cols[i].right ? colX[i] + cols[i].w - 4 : colX[i] + 4, y - 10, { size: 8.5, align: cols[i].right ? 'right' : 'left' });
    });
    y -= rowH;
    hline(y + 2);
  });
  y -= 10;

  // Суми вдясно, плащане и бележки вляво.
  const t = totalsOf(doc.lines, doc.docType);
  const totalRows = t.byRate.flatMap((r) => [[`Данъчна основа ${r.rate}%`, money(r.base, cur)], [`ДДС ${r.rate}%`, money(r.vat, cur)]]);
  // При чужда валута данъчната основа и ДДС се посочват и в евро по курса на документа.
  const rate = Number(doc.exchangeRate) || 1;
  const eur = (n) => round2(n / rate);
  const eurRows = cur === 'EUR' ? [] : [
    [`Курс: 1 EUR = ${rateNum.format(rate)} ${cur}${doc.rateDate ? ` (ЕЦБ, ${date(doc.rateDate)})` : ''}`, ''],
    ...t.byRate.flatMap((r) => [[`Данъчна основа ${r.rate}% в EUR`, money(eur(r.base))], [`ДДС ${r.rate}% в EUR`, money(eur(r.vat))]]),
    ['Общо в EUR', money(eur(t.total))],
  ];
  const protocol = doc.docType === PROTOCOL;
  const leftLines = protocol ? [
    [`Основание за начисляване на ДДС: ${doc.vatExemptReason || '—'}`, true],
    ['Данъкът е начислен от получателя по чл. 117 ЗДДС и се отразява в дневниците за покупки и продажби.'],
    doc.notes && [doc.notes],
    [`Съставил: ${issuedBy || ''}`],
  ].filter(Boolean).flatMap(([text, strong]) => wrap(text, 270, 8.5, strong ? fontBold : font).map((line) => [line, strong])) : [
    [`Начин на плащане: ${doc.paymentMethod || '—'}`, true],
    doc.paymentMethod === 'Банков превод' && seller.iban && [`IBAN: ${seller.iban}${seller.bic ? ` · BIC: ${seller.bic}` : ''}${seller.bank ? ` · ${seller.bank}` : ''}`],
    doc.vatExemptReason && [`Основание за неначисляване на ДДС: ${doc.vatExemptReason}`],
    doc.notes && [doc.notes],
    [`Съставил: ${issuedBy || ''}`],
  ].filter(Boolean).flatMap(([text, strong]) => wrap(text, 270, 8.5, strong ? fontBold : font).map((line) => [line, strong]));
  const blockH = Math.max(totalRows.length * 13 + 28 + eurRows.length * 12 + (eurRows.length ? 10 : 0), leftLines.length * 12);
  if (y - blockH < 70) newPage();
  totalRows.forEach(([label, value], i) => {
    draw(label, A4[0] - M - 110, y - 10 - i * 13, { size: 8.5, c: INK2, align: 'right' });
    draw(value, A4[0] - M, y - 10 - i * 13, { size: 9, align: 'right' });
  });
  const grandY = y - 10 - totalRows.length * 13 - 8;
  page.drawLine({ start: { x: A4[0] - M - 210, y: grandY + 12 }, end: { x: A4[0] - M, y: grandY + 12 }, thickness: 1.2, color: color(NAVY) });
  draw(protocol ? 'Общо с начисления ДДС' : 'Сума за плащане', A4[0] - M - 110, grandY, { size: 10, f: fontBold, align: 'right' });
  draw(money(t.total, cur), A4[0] - M, grandY, { size: 11, f: fontBold, align: 'right' });
  eurRows.forEach(([label, value], i) => {
    const yy = grandY - 18 - i * 12;
    draw(label, A4[0] - M - (value ? 110 : 0), yy, { size: 8, c: INK2, align: 'right' });
    if (value) draw(value, A4[0] - M, yy, { size: 8.5, c: INK2, align: 'right' });
  });
  leftLines.forEach(([line, strong], i) => draw(line, M, y - 10 - i * 12, { size: 8.5, f: strong ? fontBold : font }));

  // Долен колонтитул на всяка страница: с коя система е създаден документът и номер на страницата.
  const pages = pdf.getPages();
  pages.forEach((p, i) => {
    page = p;
    // Анулираният документ се тегли със следа през цялата страница, за да не се ползва като валиден.
    if (cancelled) {
      const text = 'АНУЛИРАН';
      const size = 92;
      const w = width(text, size, fontBold);
      const angle = Math.PI / 5;
      page.drawText(text, {
        x: A4[0] / 2 - (w / 2) * Math.cos(angle), y: A4[1] / 2 - (w / 2) * Math.sin(angle),
        size, font: fontBold, color: color(RED), opacity: 0.16, rotate: PDFLib.degrees(36),
      });
      draw(`Документът е анулиран${doc.cancelledAt ? ` на ${date(doc.cancelledAt.slice(0, 10))}` : ''} и не е валиден.`, M, 56, { size: 8, f: fontBold, c: RED });
    }
    hline(46, LINE, 0.6);
    draw(FOOTER, M, 32, { size: 7.5, c: INK2 });
    draw(`${doc.docType} ${doc.number || ''}${cancelled ? ' · АНУЛИРАН' : ''} · страница ${i + 1} от ${pages.length}`, A4[0] - M, 32, { size: 7.5, c: cancelled ? RED : INK2, align: 'right' });
  });
  return pdf.save();
}

export function saveFile(bytes, filename) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/**
 * Писмо, декларация, протокол или касов ордер (A4, без таблицата с ДДС на фактурите).
 * spec: { title, subtitle, number, date, place, issuer (данни на фирмата горе вляво), logo, to: { label, lines } (адресат горе вдясно),
 *         blocks: [{ h }, { p }, { list, numbered }, { kv: [[етикет, стойност, удебелено]] }, { table: { cols: [{ label, w, right }], rows, foot } }, { space }],
 *         signatures: [{ label, name, role }], note (малък текст най-долу) }
 */
export async function buildLetter(spec) {
  const { PDFLib, fontkit, regular, bold } = await loadLibs();
  const { PDFDocument, rgb } = PDFLib;
  const color = (c) => rgb(c[0] / 255, c[1] / 255, c[2] / 255);
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const font = await pdf.embedFont(regular, { subset: true });
  const fontBold = await pdf.embedFont(bold, { subset: true });
  pdf.setTitle([spec.title, spec.subtitle, spec.number && `№ ${spec.number}`].filter(Boolean).join(' '));
  pdf.setAuthor(spec.issuer?.name || '');
  pdf.setCreator('BulAdmin Cloud (cloud.buladmin.eu)');
  pdf.setProducer('BulAdmin Cloud');
  pdf.setLanguage('bg-BG');
  const W = A4[0] - 2 * M;
  let page;
  let y;
  const width = (text, size, f = font) => f.widthOfTextAtSize(plain(text), size);
  const draw = (text, x, yy, { size = 10, f = font, c = NAVY, align = 'left' } = {}) => {
    const t = plain(text);
    let xx = x;
    if (align === 'right') xx = x - width(t, size, f);
    if (align === 'center') xx = x - width(t, size, f) / 2;
    page.drawText(t, { x: xx, y: yy, size, font: f, color: color(c) });
  };
  const wrap = (text, maxWidth, size, f = font) => {
    const lines = [];
    for (const paragraph of plain(text).split('\n')) {
      let current = '';
      for (const word of paragraph.split(' ')) {
        const candidate = current ? `${current} ${word}` : word;
        if (width(candidate, size, f) <= maxWidth) { current = candidate; continue; }
        if (current) lines.push(current);
        current = word;
        while (width(current, size, f) > maxWidth) {
          let cut = current.length - 1;
          while (cut > 1 && width(current.slice(0, cut), size, f) > maxWidth) cut--;
          lines.push(current.slice(0, cut));
          current = current.slice(cut);
        }
      }
      lines.push(current);
    }
    return lines;
  };
  const newPage = () => { page = pdf.addPage(A4); y = A4[1] - M; };
  const need = (h) => { if (y - h < 80) newPage(); };
  const hline = (yy, c = LINE, thickness = 0.8, x1 = M, x2 = A4[0] - M) => page.drawLine({ start: { x: x1, y: yy }, end: { x: x2, y: yy }, thickness, color: color(c) });

  newPage();
  // Издател горе вляво (лого, име и данни), адресат горе вдясно.
  const issuer = spec.issuer || {};
  let leftBottom = y;
  if (spec.logo?.bytes) {
    try {
      const image = spec.logo.type === 'image/png' ? await pdf.embedPng(spec.logo.bytes) : await pdf.embedJpg(spec.logo.bytes);
      const scale = Math.min(150 / image.width, 48 / image.height, 1);
      page.drawImage(image, { x: M, y: y - image.height * scale, width: image.width * scale, height: image.height * scale });
      leftBottom = y - image.height * scale - 4;
    } catch { /* повредено лого не спира документа */ }
  }
  if (issuer.name) {
    const details = partyLines(issuer).flatMap((l) => wrap(l, W * 0.5, 8.5));
    draw(issuer.name, M, leftBottom - 11, { size: 10.5, f: fontBold });
    details.forEach((l, i) => draw(l, M, leftBottom - 24 - i * 11, { size: 8.5, c: INK2 }));
    leftBottom -= 24 + details.length * 11;
  }
  let rightBottom = y;
  if (spec.to) {
    const x = M + W * 0.56;
    draw(spec.to.label || 'ДО', x, y - 11, { size: 8, f: fontBold, c: INK2 });
    const lines = spec.to.lines.filter(Boolean).flatMap((l, i) => wrap(l, W * 0.44, i === 0 ? 10 : 9, i === 0 ? fontBold : font).map((t) => [t, i === 0]));
    lines.forEach(([t, strong], i) => draw(t, x, y - 25 - i * 12, { size: strong ? 10 : 9, f: strong ? fontBold : font }));
    rightBottom = y - 25 - lines.length * 12;
  }
  y = Math.min(leftBottom, rightBottom) - 24;

  // Заглавие в средата.
  for (const t of wrap(spec.title.toUpperCase(), W - 40, 15, fontBold)) {
    draw(t, A4[0] / 2, y, { size: 15, f: fontBold, align: 'center' });
    y -= 18;
  }
  for (const line of [spec.subtitle, spec.number && `№ ${spec.number}${spec.date ? ` от ${date(spec.date)}` : ''}`].filter(Boolean)) {
    for (const t of wrap(line, W - 60, 10)) {
      draw(t, A4[0] / 2, y, { size: 10, align: 'center', c: INK2 });
      y -= 13;
    }
  }
  y -= 2;
  hline(y, GOLD, 1.6, A4[0] / 2 - 40, A4[0] / 2 + 40);
  y -= 24;

  const paragraph = (text, { size = 10, f = font, indent = 0, gap = 7, c = NAVY } = {}) => {
    // „15.11.2026 г.“ в края на изречение: без втора точка.
    for (const t of wrap(String(text).replace(/ г\.\./g, ' г.'), W - indent, size, f)) {
      need(size + 4);
      draw(t, M + indent, y, { size, f, c });
      y -= size + 4;
    }
    y -= gap;
  };
  for (const block of spec.blocks || []) {
    if (!block) continue;
    if (block.space) { y -= block.space; continue; }
    if (block.h) { need(34); y -= 4; paragraph(block.h, { size: 10.5, f: fontBold, gap: 4 }); continue; }
    if (block.p) { paragraph(block.p, { size: block.size || 10, f: block.bold ? fontBold : font, c: block.muted ? INK2 : NAVY }); continue; }
    if (block.list) {
      block.list.filter(Boolean).forEach((item, i) => {
        const marker = block.numbered === false ? '•' : `${i + 1}.`;
        wrap(item, W - 22, 10).forEach((t, j) => {
          need(14);
          if (j === 0) draw(marker, M + 4, y, { size: 10 });
          draw(t, M + 22, y, { size: 10 });
          y -= 14;
        });
        y -= 2;
      });
      y -= 6;
      continue;
    }
    if (block.kv) {
      const labelW = block.labelWidth || 160;
      for (const [label, value, strong] of block.kv) {
        const lines = wrap(String(value ?? ''), W - labelW, 10, strong ? fontBold : font);
        const labels = wrap(label, labelW - 10, 9);
        need(Math.max(lines.length, labels.length) * 14);
        labels.forEach((t, i) => draw(t, M, y - i * 13, { size: 9, c: INK2 }));
        lines.forEach((t, i) => draw(t, M + labelW, y - i * 14, { size: 10, f: strong ? fontBold : font }));
        y -= Math.max(lines.length * 14, labels.length * 13) + 5;
      }
      y -= 6;
      continue;
    }
    if (block.table) {
      const { cols, rows, foot = [] } = block.table;
      const sum = cols.reduce((s, c) => s + c.w, 0);
      const widths = cols.map((c) => (c.w / sum) * W);
      const xs = widths.reduce((acc, w, i) => [...acc, i ? acc[i - 1] + widths[i - 1] : M], []);
      const header = () => {
        need(40);
        page.drawRectangle({ x: M, y: y - 6, width: W, height: 18, color: color(TINT) });
        cols.forEach((c, i) => draw(c.label, c.right ? xs[i] + widths[i] - 4 : xs[i] + 4, y, { size: 8, f: fontBold, c: INK2, align: c.right ? 'right' : 'left' }));
        y -= 20;
      };
      header();
      const row = (cells, strong) => {
        const wrapped = cells.map((v, i) => wrap(String(v ?? ''), widths[i] - 8, 9, strong ? fontBold : font));
        const h = Math.max(...wrapped.map((w) => w.length)) * 11 + 6;
        if (y - h < 80) { newPage(); header(); }
        wrapped.forEach((lines, i) => lines.forEach((t, j) => draw(t, cols[i].right ? xs[i] + widths[i] - 4 : xs[i] + 4, y - j * 11, { size: 9, f: strong ? fontBold : font, align: cols[i].right ? 'right' : 'left' })));
        y -= h;
        hline(y + 8);
      };
      rows.forEach((r) => row(r, false));
      foot.forEach((r) => row(r, true));
      y -= 10;
    }
  }

  // Дата, място и подписи. Място за подпис (линия) има само при signLines: протоколи на органи, договори,
  // пълномощни. Счетоводните документи са без подпис и печат (не са задължителни реквизити по ЗСч), а
  // документите по ЗОП се подписват с КЕП — при тях се изписват само имената.
  const signs = spec.signatures || [];
  const perRow = Math.min(signs.length, 3) || 1;
  need(40 + (spec.signLines ? Math.ceil(signs.length / 3) * 72 : signs.length * 14));
  y -= 6;
  if (spec.dateLine !== false && (spec.date !== undefined || spec.place)) {
    draw(`Дата: ${date(spec.date) || '……………………'}`, M, y, { size: 10 });
    if (spec.place) draw(`гр./с. ${spec.place}`, M, y - 14, { size: 10 });
    y -= spec.signLines ? 40 : 34;
  }
  const colW = W / perRow;
  if (!spec.signLines) {
    for (const s of signs.filter((x) => x.name || x.role)) {
      draw(`${s.label}: `, M, y, { size: 9.5, c: INK2 });
      draw([s.name, s.role].filter(Boolean).join(', '), M + width(`${s.label}: `, 9.5) + 2, y, { size: 9.5, f: fontBold });
      y -= 14;
    }
  }
  if (spec.signLines) signs.forEach((s, i) => {
    const x = signs.length === 1 ? M + W * 0.55 : M + (i % 3) * colW;
    const yy = y - Math.floor(i / 3) * 72;
    const lineW = signs.length === 1 ? W * 0.45 : colW - 16;
    draw(`${s.label}:`, x, yy, { size: 9, c: INK2 });
    hline(yy - 24, NAVY, 0.6, x, x + lineW);
    if (s.name) draw(s.name, x, yy - 36, { size: 9 });
    if (s.role) draw(s.role, x, yy - 48, { size: 8, c: INK2 });
  });

  const pages = pdf.getPages();
  pages.forEach((p, i) => {
    page = p;
    if (spec.note && i === pages.length - 1) {
      const lines = wrap(spec.note, W, 7.5);
      lines.forEach((t, j) => draw(t, M, 56 + (lines.length - 1 - j) * 9, { size: 7.5, c: INK2 }));
    }
    hline(46, LINE, 0.6);
    draw(FOOTER, M, 32, { size: 7.5, c: INK2 });
    draw(`${spec.title}${spec.number ? ` ${spec.number}` : ''} · страница ${i + 1} от ${pages.length}`, A4[0] - M, 32, { size: 7.5, c: INK2, align: 'right' });
  });
  return pdf.save();
}
