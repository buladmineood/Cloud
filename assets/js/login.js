import { api, h, showError, showFieldErrors } from './core.js?v=3806c5bf79';

const form = document.getElementById('login-form');
const alert = document.getElementById('form-alert');
const submit = document.getElementById('login-submit');

const MESSAGES = {
  login: 'Входът не успя. Опитайте отново.',
  noaccount: 'Няма потребител с този акаунт. Влезте с имейла, на който сте поканени, или помолете администратор за покана.',
  inactive: 'Профилът Ви е деактивиран. Обърнете се към администратор.',
};
const error = new URLSearchParams(location.search).get('error');
if (error) {
  const box = document.getElementById('login-error');
  box.textContent = MESSAGES[error] || MESSAGES.login;
  box.hidden = false;
  history.replaceState(null, '', location.pathname);
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  alert.replaceChildren();
  submit.disabled = true;
  try {
    await api('/auth/login', { method: 'POST', body: { email: form.elements.email.value, password: form.elements.password.value } });
    location.replace('/app.html');
  } catch (err) {
    showFieldErrors(form, err.fields);
    showError(alert, err.message);
    submit.disabled = false;
  }
});

// При включени имейли потребителят сам получава линк за нова парола.
const forgotButton = document.getElementById('forgot-button');
api('/meta').then(({ mailEnabled }) => {
  if (!mailEnabled) return;
  document.getElementById('forgot-note').hidden = true;
  forgotButton.hidden = false;
}).catch(() => { /* остава указанието */ });

forgotButton.addEventListener('click', async () => {
  alert.replaceChildren();
  const email = form.elements.email.value.trim();
  if (!email) {
    showFieldErrors(form, { email: 'Въведете имейла си и натиснете отново.' });
    return;
  }
  showFieldErrors(form, {});
  forgotButton.disabled = true;
  try {
    await api('/auth/forgot', { method: 'POST', body: { email } });
    alert.replaceChildren(h('div', { class: 'alert alert--ok', role: 'status' }, 'Ако има профил с този имейл, изпратихме линк за нова парола. Той важи 1 час.'));
  } catch (err) {
    showError(alert, err.message);
  }
  forgotButton.disabled = false;
});

// Вече влязъл потребител отива директно в системата.
api('/me').then((me) => {
  if (me.authenticated) location.replace('/app.html');
}).catch(() => { /* формата остава видима */ });
