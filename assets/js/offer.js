// Страницата, която клиентът отваря от имейла: преглед на офертата, PDF и отговор „Приемам“ или „Отказвам“.
import { addressLine, api, formatDate, formValues, h, icon, money, num, round2, showError, showFieldErrors } from './core.js?v=c6c5e2e1e0';
import { buildPdf, saveFile } from './pdf.js?v=c6c5e2e1e0';

const root = document.getElementById('offer');

// Линкът се маха от адресната лента; пази се само за този раздел, за да работи и след презареждане.
const KEY = 'bc_offer_token';
const read = () => { try { return sessionStorage.getItem(KEY); } catch { return null; } };
const save = (v) => { try { sessionStorage.setItem(KEY, v); } catch { /* до презареждане */ } };
const fromLink = new URLSearchParams(location.hash.slice(1)).get('t');
if (fromLink) save(fromLink);
const token = fromLink || read();
history.replaceState(null, '', location.pathname);

const lineNet = (l) => round2(l.qty * l.price * (1 - (l.discount || 0) / 100));
const partyLines = (p) => [p.eik && `ЕИК: ${p.eik}`, p.vatNumber && `ДДС №: ${p.vatNumber}`, addressLine(p)].filter(Boolean);

function message(kind, title, text) {
  root.replaceChildren(h('section', { class: 'card stack narrow' },
    h('h1', {}, title), text && h('p', { class: `alert alert--${kind}` }, text)));
}

function render({ offer, org, logo }) {
  const cur = offer.currency || 'EUR';
  const open = offer.docStatus === 'Издаден' && !offer.expired;
  const alert = h('div', { 'aria-live': 'polite' });
  const logoBytes = logo ? Uint8Array.from(atob(logo.base64), (c) => c.charCodeAt(0)) : null;

  const pdfButton = h('button', {
    class: 'btn btn--ghost', type: 'button',
    onclick: async () => {
      pdfButton.disabled = true;
      try {
        const bytes = await buildPdf({ doc: offer, seller: offer.seller || { name: org.name }, buyer: offer.buyer || {}, logo: logoBytes && { bytes: logoBytes, type: logo.type }, issuedBy: offer.issuedBy });
        saveFile(bytes, `Оферта ${offer.number}.pdf`);
      } catch (err) {
        showError(alert, err.message);
      }
      pdfButton.disabled = false;
    },
  }, icon('download', 18), 'Изтеглете PDF');

  const decide = (decision) => async (event) => {
    event.preventDefault();
    const form = event.target.closest('form');
    alert.replaceChildren();
    for (const b of form.querySelectorAll('button')) b.disabled = true;
    try {
      const result = await api('/public/offer/decision', { method: 'POST', body: { ...formValues(form), token, decision } });
      offer.docStatus = result.status;
      render({ offer, org, logo });
      root.querySelector('.offer-status')?.focus();
    } catch (err) {
      showFieldErrors(form, err.fields);
      showError(alert, err.message);
      for (const b of form.querySelectorAll('button')) b.disabled = false;
    }
  };

  const form = h('form', { class: 'form', novalidate: true },
    h('div', { class: 'field' }, h('label', { for: 'f-name' }, 'Вашето име'), h('input', { id: 'f-name', name: 'name', type: 'text', autocomplete: 'name', maxlength: 120, required: true })),
    h('div', { class: 'field' }, h('label', { for: 'f-note' }, 'Коментар', h('span', { class: 'field__hint' }, ' (по желание)')), h('textarea', { id: 'f-note', name: 'note', rows: 3, maxlength: 2000 })),
    alert,
    h('div', { class: 'row' },
      h('button', { class: 'btn', type: 'submit', onclick: decide('accept') }, icon('check', 18), 'Приемам офертата'),
      h('button', { class: 'btn btn--ghost', type: 'button', onclick: decide('reject') }, 'Отказвам')));

  const statusText = {
    'Приета': 'Офертата е приета. Благодарим Ви! Изпращачът е уведомен.',
    'Отказана': 'Офертата е отказана. Изпращачът е уведомен.',
  }[offer.docStatus] || (offer.expired ? `Срокът на валидност на офертата изтече (${formatDate(offer.dueDate)}). Свържете се с ${org.name} за нова оферта.` : '');

  root.replaceChildren(
    h('div', { class: 'split' },
      h('article', { class: 'card stack' },
        h('header', { class: 'row row--between' },
          h('div', {},
            logo && h('img', { class: 'doc-print__logo', src: `data:${logo.type};base64,${logo.base64}`, alt: org.name }),
            h('p', { class: 'small muted' }, `${org.name} Ви изпраща`),
            h('h1', {}, `Оферта № ${offer.number}`)),
          h('dl', { class: 'details' },
            h('dt', {}, 'Дата'), h('dd', {}, formatDate(offer.issueDate)),
            offer.dueDate && [h('dt', {}, 'Валидна до'), h('dd', {}, formatDate(offer.dueDate))])),
        offer.buyer && h('p', { class: 'small' }, h('strong', {}, 'За: '), [offer.buyer.name, ...partyLines(offer.buyer)].join(' · ')),
        h('div', { class: 'table-wrap' }, h('table', { class: 'doc-print__lines' },
          h('thead', {}, h('tr', {}, ['Наименование', 'Кол.', 'Мярка', 'Ед. цена', 'ДДС', 'Стойност'].map((t) => h('th', { scope: 'col' }, t)))),
          h('tbody', {}, offer.lines.map((l) => h('tr', {},
            h('td', {}, l.name), h('td', { class: 'num' }, num(l.qty)), h('td', {}, l.unit), h('td', { class: 'num' }, money(l.price, cur)),
            h('td', { class: 'num' }, `${l.vatRate}%`), h('td', { class: 'num' }, money(lineNet(l), cur))))))),
        h('dl', { class: 'totals' },
          h('dt', {}, 'Без ДДС'), h('dd', {}, money(offer.subtotal, cur)),
          h('dt', {}, 'ДДС'), h('dd', {}, money(offer.vatAmount, cur)),
          h('dt', { class: 'totals__grand' }, 'Общо'), h('dd', { class: 'totals__grand' }, money(offer.total, cur)),
          cur !== 'EUR' && [h('dt', {}, 'Общо в EUR'), h('dd', {}, money(offer.totalEur))]),
        offer.notes && h('p', { class: 'pre small' }, offer.notes),
        h('div', { class: 'row' }, pdfButton)),
      h('aside', { class: 'card stack' },
        h('h2', { class: 'offer-status', tabindex: '-1' }, open ? 'Вашият отговор' : 'Статус'),
        open ? [h('p', { class: 'small muted' }, `Отговорът отива директно до ${org.name}.`), form]
          : h('p', { class: `alert ${offer.docStatus === 'Приета' ? 'alert--ok' : 'alert--warn'}` }, statusText),
        (org.email || org.phone) && h('p', { class: 'small muted' }, 'Въпроси: ', [org.email, org.phone].filter(Boolean).join(' · ')))));
  document.title = `Оферта № ${offer.number} от ${org.name}`;
}

if (!token) {
  message('error', 'Липсва линк', 'Отворете целия линк от имейла с офертата.');
} else {
  api('/public/offer', { method: 'POST', body: { token } })
    .then(render)
    .catch((err) => message('error', 'Офертата не може да се отвори', err.message));
}
