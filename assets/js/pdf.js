// Създава PDF на оферта или фактура в браузъра с pdf-lib и шрифта Onest (кирилица).
// Библиотеките (около 1,3 MB) се зареждат само при първото създаване на PDF.

const NAVY = [16, 41, 76];
const GOLD = [181, 134, 42];
const INK2 = [74, 90, 115];
const LINE = [220, 215, 203];
const TINT = [243, 239, 230];
const A4 = [595.28, 841.89];
const M = 40;
const FOOTER = 'Създадено с BulAdmin Cloud · cloud.buladmin.eu';
const TAX = ['Фактура', 'Кредитно известие'];

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
const moneyFormat = new Intl.NumberFormat('bg-BG', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const numFormat = new Intl.NumberFormat('bg-BG', { maximumFractionDigits: 3 });
const money = (n) => plain(moneyFormat.format(Number(n) || 0));
const num = (n) => plain(numFormat.format(Number(n) || 0));
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
  p.eik && `ЕИК: ${p.eik}`, p.vatNumber && `ДДС №: ${p.vatNumber}`, [p.city, p.address].filter(Boolean).join(', '), p.mol && `МОЛ: ${p.mol}`,
].filter(Boolean);

/**
 * doc: документът от /api/data; seller и buyer: данните на страните;
 * logo: { bytes, type } или null; related: свързаният документ (за кредитно известие).
 */
export async function buildPdf({ doc, seller, buyer, logo, related, issuedBy }) {
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
  if (TAX.includes(doc.docType) && doc.number) draw('ОРИГИНАЛ', A4[0] - M, y - 47, { size: 8, c: INK2, align: 'right' });
  y = headerBottom - 6;
  hline(y, GOLD, 2);
  y -= 18;

  // Дати и свързан документ.
  const dates = [
    ['Дата на издаване', date(doc.issueDate)],
    TAX.includes(doc.docType) && ['Дата на данъчно събитие', date(doc.taxEventDate || doc.issueDate)],
    doc.dueDate && [doc.docType === 'Оферта' ? 'Валидна до' : 'Падеж', date(doc.dueDate)],
  ].filter(Boolean);
  dates.forEach(([label, value], i) => {
    draw(label, A4[0] - M - 90, y - i * 13, { size: 8.5, c: INK2, align: 'right' });
    draw(value, A4[0] - M, y - i * 13, { size: 9, f: fontBold, align: 'right' });
  });
  if (related) draw(`Към ${related.docType.toLowerCase()} № ${related.number} от ${date(related.issueDate)}`, M, y, { size: 9, c: INK2 });
  y -= dates.length * 13 + 10;

  // Получател и доставчик.
  const boxW = (A4[0] - 2 * M - 14) / 2;
  const party = (title, p) => [title, p.name || '', ...partyLines(p).flatMap((l) => wrap(l, boxW - 20, 8.5))];
  const parties = [party('ПОЛУЧАТЕЛ', buyer), party('ДОСТАВЧИК', seller)];
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
    const cells = [String(index + 1), null, num(l.qty), l.unit, money(l.price), l.discount ? `${num(l.discount)}%` : '', `${l.vatRate}%`, money(lineNet(l))];
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
  const totalRows = t.byRate.flatMap((r) => [[`Данъчна основа ${r.rate}%`, money(r.base)], [`ДДС ${r.rate}%`, money(r.vat)]]);
  const leftLines = [
    [`Начин на плащане: ${doc.paymentMethod || '—'}`, true],
    doc.paymentMethod === 'Банков превод' && seller.iban && [`IBAN: ${seller.iban}${seller.bic ? ` · BIC: ${seller.bic}` : ''}${seller.bank ? ` · ${seller.bank}` : ''}`],
    doc.vatExemptReason && [`Основание за неначисляване на ДДС: ${doc.vatExemptReason}`],
    doc.notes && [doc.notes],
    [`Съставил: ${issuedBy || ''}`],
  ].filter(Boolean).flatMap(([text, strong]) => wrap(text, 270, 8.5, strong ? fontBold : font).map((line) => [line, strong]));
  const blockH = Math.max(totalRows.length * 13 + 28, leftLines.length * 12);
  if (y - blockH < 70) newPage();
  totalRows.forEach(([label, value], i) => {
    draw(label, A4[0] - M - 110, y - 10 - i * 13, { size: 8.5, c: INK2, align: 'right' });
    draw(value, A4[0] - M, y - 10 - i * 13, { size: 9, align: 'right' });
  });
  const grandY = y - 10 - totalRows.length * 13 - 8;
  page.drawLine({ start: { x: A4[0] - M - 210, y: grandY + 12 }, end: { x: A4[0] - M, y: grandY + 12 }, thickness: 1.2, color: color(NAVY) });
  draw('Сума за плащане', A4[0] - M - 110, grandY, { size: 10, f: fontBold, align: 'right' });
  draw(money(t.total), A4[0] - M, grandY, { size: 11, f: fontBold, align: 'right' });
  leftLines.forEach(([line, strong], i) => draw(line, M, y - 10 - i * 12, { size: 8.5, f: strong ? fontBold : font }));

  // Долен колонтитул на всяка страница: с коя система е създаден документът и номер на страницата.
  const pages = pdf.getPages();
  pages.forEach((p, i) => {
    page = p;
    hline(46, LINE, 0.6);
    draw(FOOTER, M, 32, { size: 7.5, c: INK2 });
    draw(`${doc.docType} ${doc.number || ''} · страница ${i + 1} от ${pages.length}`, A4[0] - M, 32, { size: 7.5, c: INK2, align: 'right' });
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
