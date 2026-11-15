import { api, h, showError, showFieldErrors } from './core.js?v=8fdd9a957d';

const form = document.getElementById('login-form');
const alert = document.getElementById('form-alert');
const submit = document.getElementById('login-submit');
const modeLogin = document.getElementById('mode-login');
const modeSignup = document.getElementById('mode-signup');
let signup = false;

const MESSAGES = {
  login: 'Входът не успя. Опитайте отново.',
  exists: 'Вече има профил с този имейл. Влезте с паролата си или с Google и после свържете Microsoft от „Профил“.',
  inactive: 'Профилът Ви е блокиран. Свържете се с БУЛАДМИН.',
};
const error = new URLSearchParams(location.search).get('error');
if (error) {
  const box = document.getElementById('login-error');
  box.textContent = MESSAGES[error] || MESSAGES.login;
  box.hidden = false;
  history.replaceState(null, '', location.pathname);
}

function setMode(value) {
  signup = value;
  modeLogin.setAttribute('aria-pressed', String(!signup));
  modeSignup.setAttribute('aria-pressed', String(signup));
  submit.textContent = signup ? 'Създайте профил' : 'Вход';
  form.elements.password.autocomplete = signup ? 'new-password' : 'current-password';
  document.getElementById('password-hint').hidden = !signup;
  document.getElementById('name-field').hidden = !signup;
  document.getElementById('forgot-area').hidden = signup;
  for (const label of document.querySelectorAll('.provider-label')) {
    label.textContent = label.textContent.replace(/^(Вход|Регистрация) с/, signup ? 'Регистрация с' : 'Вход с');
  }
  alert.replaceChildren();
  showFieldErrors(form, {});
}
modeLogin.addEventListener('click', () => setMode(false));
modeSignup.addEventListener('click', () => setMode(true));
if (location.hash === '#signup') setMode(true);

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  alert.replaceChildren();
  submit.disabled = true;
  const body = { email: form.elements.email.value, password: form.elements.password.value };
  if (signup) body.fullName = form.elements.fullName.value;
  try {
    await api(signup ? '/auth/signup' : '/auth/login', { method: 'POST', body });
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
