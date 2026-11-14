// Шаблон за автоматичните имейли: таблици и вградени стилове, за да изглеждат еднакво в Outlook, Gmail и на телефон.
// Всички стойности минават през esc().

const C = {
  navy: '#10294c', gold: '#b5862a', goldSoft: '#e0b65e', ink: '#10294c', muted: '#4a5a73',
  line: '#dcd7cb', page: '#f3efe6', paper: '#ffffff', tint: '#faf7f0',
};
const FONT = "'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

export const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[ch]));

function actionBlock({ label, url }) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:4px 0 24px;"><tr>
    <td bgcolor="${C.navy}" style="border-radius:8px;">
      <a href="${esc(url)}" style="display:inline-block;padding:14px 26px;font:600 15px/1 ${FONT};color:#ffffff;text-decoration:none;border-radius:8px;">${esc(label)}</a>
    </td></tr></table>
    <p style="margin:0 0 24px;font:12px/1.5 ${FONT};color:${C.muted};">Ако бутонът не работи, копирайте този адрес в браузъра:<br><a href="${esc(url)}" style="color:${C.navy};word-break:break-all;">${esc(url)}</a></p>`;
}

// Връща HTML и текстова версия на едно и също съобщение.
export function renderEmail({ origin, preheader, title, paragraphs = [], action, note }) {
  const p = (text) => `<p style="margin:0 0 16px;font:15px/1.6 ${FONT};color:${C.ink};">${esc(text)}</p>`;
  const html = `<!doctype html>
<html lang="bg"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><title>${esc(title)}</title></head>
<body style="margin:0;padding:0;background:${C.page};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(preheader || title)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.page};"><tr><td align="center" style="padding:28px 12px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:${C.paper};border:1px solid ${C.line};border-radius:12px;border-collapse:separate;overflow:hidden;">
    <tr><td style="padding:18px 28px;background:${C.navy};border-radius:12px 12px 0 0;">
      <table role="presentation" cellpadding="0" cellspacing="0"><tr>
        <td style="padding-right:12px;"><img src="${esc(origin)}/assets/img/apple-touch-icon.png" width="36" height="36" alt="" style="display:block;border:0;border-radius:8px;background:#ffffff;"></td>
        <td style="font:600 18px/1 ${FONT};letter-spacing:2px;color:#ffffff;">БУЛ<span style="color:${C.goldSoft};">АДМИН</span> <span style="font-size:12px;letter-spacing:1px;color:${C.goldSoft};">CRM · ERP</span></td>
      </tr></table>
    </td></tr>
    <tr><td style="height:4px;background:${C.gold};font-size:0;line-height:0;">&nbsp;</td></tr>
    <tr><td style="padding:32px 28px 8px;">
      <h1 style="margin:0 0 18px;font:700 22px/1.3 ${FONT};color:${C.ink};">${esc(title)}</h1>
      ${paragraphs.map(p).join('')}
      ${action ? actionBlock(action) : ''}
      ${note ? `<p style="margin:0 0 24px;font:13px/1.6 ${FONT};color:${C.muted};">${esc(note)}</p>` : ''}
    </td></tr>
    <tr><td style="padding:20px 28px 24px;border-top:1px solid ${C.line};background:${C.tint};border-radius:0 0 12px 12px;">
      <p style="margin:0 0 6px;font:600 13px/1.5 ${FONT};color:${C.ink};">BulAdmin CRM / BulAdmin ERP</p>
      <p style="margin:0;font:12px/1.6 ${FONT};color:${C.muted};">Това съобщение е изпратено автоматично. Моля, не отговаряйте на него.<br>Никога няма да Ви поискаме парола или код по имейл или телефон.</p>
    </td></tr>
  </table>
</td></tr></table>
</body></html>`;

  const text = [
    title,
    '',
    ...paragraphs.flatMap((t) => [t, '']),
    ...(action ? [`${action.label}: ${action.url}`, ''] : []),
    ...(note ? [note, ''] : []),
    'BulAdmin CRM / BulAdmin ERP',
    origin,
    'Това съобщение е изпратено автоматично. Моля, не отговаряйте на него.',
  ].join('\n');
  return { html, text };
}
