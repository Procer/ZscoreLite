// Panel de licencias de Z-Score Lite. Sin librerías: arma el DOM con h() y usa solo textContent
// (nada de innerHTML), porque la página corre con una CSP estricta y muestra datos de clientes.
'use strict';

const DAY = 86400000;
const WARN_DAYS = 7;
const TRIAL_WARN_DAYS = 3;
const MAIL_STATUS = { enviado: 'Enviado', pendiente: 'Pendiente', error: 'Falló (se reintenta)', sin_email: 'Sin email', sin_smtp: 'Correo sin configurar' };
const PAY_ROW_STATUS = { approved: 'Aprobado', monto_incorrecto: 'Revisar: monto', refunded: 'Reintegrado', charged_back: 'Contracargo', cancelled: 'Cancelado' };
const PAY_STATUS = { monto_incorrecto: 'monto distinto al del link', refunded: 'reintegrado', charged_back: 'contracargo', cancelled: 'cancelado' };
const NEVER_ACTIVATED_DAYS = 2;

const TYPE_NAME = { paga: 'Paga', prueba: 'Prueba', cortesia: 'Cortesía' };
const STATE_NAME = { activa: 'Activa', vencida: 'Vencida', revocada: 'Revocada' };
const ERROR_TEXT = {
  credenciales: 'Usuario o contraseña incorrectos.',
  demasiados: 'Demasiados intentos. Esperá unos minutos.',
  sin_clave: 'Todavía no hay una contraseña creada. En el servidor: node license-admin.cjs panel-clave',
  sesion: 'La sesión venció. Ingresá de nuevo.',
  csrf: 'La sesión no es válida. Recargá la página.',
  origen: 'Pedido rechazado (origen distinto).',
  clave_actual: 'La contraseña actual no es correcta.',
};

const app = document.getElementById('app');
const state = {
  csrf: null, user: null, licenses: [], apk: { published: false }, pagos: { configured: false, month: [], review: [] }, loadedAt: 0,
  tab: 'resumen', filter: { q: '', estado: '', tipo: '' }, sort: { key: 'createdAt', dir: -1 },
};

// ---------- Utilidades ----------

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : String(kid));
  return el;
}

const ICONS = {
  home: 'M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  key: 'M21 2l-2 2m-7.6 7.6a5.5 5.5 0 1 1-7.8 7.8 5.5 5.5 0 0 1 7.8-7.8zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4',
  card: 'M2 6a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2zM2 10h20',
  phone: 'M7 2h10a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1zM11 18h2',
  help: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3',
  refresh: 'M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5',
  lock: 'M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
  plus: 'M12 5v14M5 12h14',
  check: 'M20 6 9 17l-5-5',
  clock: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2',
  alert: 'M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01',
  ban: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM4.9 4.9l14.2 14.2',
  gift: 'M20 12v10H4V12M2 7h20v5H2zM12 22V7M12 7H7.5a2.5 2.5 0 1 1 0-5C11 2 12 7 12 7zM12 7h4.5a2.5 2.5 0 1 0 0-5C13 2 12 7 12 7z',
  flask: 'M9 3h6M10 3v6L4.5 19a1.5 1.5 0 0 0 1.3 2.2h12.4a1.5 1.5 0 0 0 1.3-2.2L14 9V3M7.5 15h9',
  money: 'M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6',
  moon: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z',
  sun: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
};

/** Ícono SVG de trazo (se arma con el DOM: nada de innerHTML). */
function icon(name, cls = '') {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', `ico ${cls}`.trim());
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', ICONS[name] || '');
  svg.append(path);
  return svg;
}

const fmtDate = (ms) => (ms == null ? '—' : new Date(ms).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' }));
const fmtDateTime = (ms) => (ms == null ? 'nunca' : new Date(ms).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' }));
const money = (n, cur) => (n == null ? '—' : `${new Intl.NumberFormat('es-AR').format(n)} ${cur || ''}`.trim());

function daysLeft(lic) {
  return lic.paidUntil == null ? null : Math.ceil((lic.paidUntil - Date.now()) / DAY);
}

function toast(text, bad = false) {
  let box = document.querySelector('.toasts');
  if (!box) { box = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' }); document.body.append(box); }
  const t = h('div', { class: `toast${bad ? ' bad' : ''}`, text });
  box.append(t);
  setTimeout(() => t.remove(), bad ? 7000 : 3500);
}

async function copy(text, what = 'Copiado') {
  try {
    await navigator.clipboard.writeText(text);
    toast(what);
  } catch (e) {
    toast('No se pudo copiar. Seleccionalo y copialo a mano.', true);
  }
}

class ApiError extends Error {
  constructor(code, message, status) { super(message); this.code = code; this.status = status; }
}

async function api(method, path, body, extra = {}) {
  let res;
  try {
    res = await fetch(`/api/admin${path}`, {
      method,
      credentials: 'same-origin',
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(state.csrf ? { 'X-CSRF': state.csrf } : {}), ...extra.headers },
      body: extra.rawBody !== undefined ? extra.rawBody : (body !== undefined ? JSON.stringify(body) : undefined),
    });
  } catch (e) {
    throw new ApiError('red', 'No hay conexión con el servidor.', 0);
  }
  let data = {};
  try { data = await res.json(); } catch (e) { /* sin cuerpo */ }
  if (res.ok) return data;
  const code = data.error || 'error';
  if (res.status === 401 && code === 'sesion') { state.csrf = null; showLogin(ERROR_TEXT.sesion); }
  throw new ApiError(code, ERROR_TEXT[code] || data.error || 'Algo salió mal.', res.status);
}

/** Corre una acción, avisa el error y deja el botón sin trabarse. */
async function run(button, fn) {
  if (button) button.disabled = true;
  try { return await fn(); } catch (e) {
    if (!(e instanceof ApiError && e.code === 'sesion')) toast(e.message || 'Algo salió mal.', true);
    return undefined;
  } finally { if (button) button.disabled = false; }
}

// ---------- Ingreso ----------

function showLogin(message = '') {
  document.querySelectorAll('dialog').forEach((d) => d.close());
  const err = h('p', { class: 'error', role: 'alert', text: message });
  const user = h('input', { id: 'u', name: 'user', autocomplete: 'username', value: 'admin', required: true });
  const pass = h('input', { id: 'p', name: 'password', type: 'password', autocomplete: 'current-password', required: true });
  const submit = h('button', { class: 'btn primary block', type: 'submit', text: 'Ingresar' });
  const form = h('form', {
    onsubmit: async (ev) => {
      ev.preventDefault();
      err.textContent = '';
      submit.disabled = true;
      try {
        const r = await api('POST', '/login', { user: user.value, password: pass.value });
        state.csrf = r.csrf;
        state.user = r.user;
        await load();
        showApp();
      } catch (e) {
        err.textContent = e.message;
        pass.value = '';
      } finally { submit.disabled = false; }
    },
  },
  h('label', {}, 'Usuario', user),
  h('label', {}, 'Contraseña', pass),
  err, submit);
  app.replaceChildren(h('div', { class: 'login' },
    h('button', { class: 'btn ghost icon login-theme', type: 'button', 'aria-label': isLight() ? 'Modo oscuro' : 'Modo claro', onclick: toggleTheme }, icon(isLight() ? 'moon' : 'sun')),
    h('div', { class: 'login-card' },
    h('div', { class: 'login-logo' }, h('img', { src: '/admin/logo.png', alt: 'Z-Score' }),
      h('div', {}, h('h1', {}, 'Z-Score ', h('b', { text: 'Lite' })), h('p', { class: 'hint', text: 'Panel de licencias' }))),
    form)));
  pass.focus();
}

// ---------- Datos ----------

async function load() {
  const [r, pagos] = await Promise.all([api('GET', '/licenses'), api('GET', '/pagos')]);
  state.licenses = r.licenses;
  state.apk = r.apk;
  state.pagos = pagos;
  state.loadedAt = Date.now();
}

function upsert(lic) {
  const i = state.licenses.findIndex((l) => l.code === lic.code);
  const { deviceList, events, ...summary } = lic;
  if (i >= 0) state.licenses[i] = summary; else state.licenses.push(summary);
}

// ---------- Estructura general ----------

const TABS = [['resumen', 'Resumen', 'home'], ['licencias', 'Licencias', 'key'], ['cobros', 'Cobros', 'card'], ['apk', 'App', 'phone'], ['ayuda', 'Ayuda', 'help']];

async function logoutNow() {
  try { await api('POST', '/logout', {}); } catch (e) { /* igual se sale */ }
  state.csrf = null;
  showLogin();
}

// Tema claro/oscuro: sin elegir, sigue al dispositivo; al elegir, se recuerda en este navegador.
function isLight() {
  const t = document.documentElement.getAttribute('data-theme');
  return t ? t === 'light' : window.matchMedia('(prefers-color-scheme: light)').matches;
}

function toggleTheme() {
  const next = isLight() ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', next);
  try { localStorage.setItem('zsl-admin-theme', next); } catch (e) { /* sin almacenamiento */ }
  if (state.csrf) showApp(); else showLogin();
}

try {
  const saved = localStorage.getItem('zsl-admin-theme');
  if (saved === 'light' || saved === 'dark') document.documentElement.setAttribute('data-theme', saved);
} catch (e) { /* sin almacenamiento */ }

function refreshNow(button) {
  return run(button, async () => { await load(); showApp(); toast('Actualizado'); });
}

function goTab(id) {
  state.tab = id;
  showApp();
  window.scrollTo(0, 0);
}

function showApp() {
  const y = window.scrollY;
  const brand = () => h('div', { class: 'brand' }, h('img', { src: '/admin/logo.png', alt: '' }),
    h('div', {}, h('div', {}, 'Z-Score ', h('b', { text: 'Lite' })), h('small', { text: 'Panel de licencias' })));
  const navBtn = (cls, id, label, ic) => h('button', {
    class: cls, role: 'tab', 'aria-selected': String(state.tab === id), 'aria-label': label, onclick: () => goTab(id),
  }, icon(ic), cls === 'bn' ? h('span', { text: label }) : label);

  const side = h('aside', { class: 'side' }, brand(),
    h('nav', { class: 'nav', role: 'tablist' }, TABS.map(([id, label, ic]) => navBtn('nav-item', id, label, ic))),
    h('div', { class: 'side-foot' },
      h('span', { class: 'who', text: state.user ? `Sesión: ${state.user}` : '' }),
      h('button', { class: 'nav-item', onclick: (ev) => refreshNow(ev.currentTarget) }, icon('refresh'), 'Actualizar'),
      h('button', { class: 'nav-item', onclick: toggleTheme }, icon(isLight() ? 'moon' : 'sun'), isLight() ? 'Modo oscuro' : 'Modo claro'),
      h('button', { class: 'nav-item', onclick: openPassword }, icon('lock'), 'Contraseña'),
      h('button', { class: 'nav-item', onclick: logoutNow }, icon('logout'), 'Salir')));

  const mtop = h('header', { class: 'mtop' }, brand(),
    h('button', { class: 'btn ghost icon', 'aria-label': 'Actualizar', onclick: (ev) => refreshNow(ev.currentTarget) }, icon('refresh')),
    h('button', { class: 'btn ghost icon', 'aria-label': isLight() ? 'Modo oscuro' : 'Modo claro', onclick: toggleTheme }, icon(isLight() ? 'moon' : 'sun')),
    h('button', { class: 'btn ghost icon', 'aria-label': 'Cambiar contraseña', onclick: openPassword }, icon('lock')),
    h('button', { class: 'btn ghost icon', 'aria-label': 'Salir', onclick: logoutNow }, icon('logout')));

  const bottom = h('nav', { class: 'bottomnav', role: 'tablist' }, TABS.map(([id, label, ic]) => navBtn('bn', id, label, ic)));
  const view = { resumen: viewSummary, licencias: viewLicenses, cobros: viewPayments, apk: viewApk, ayuda: viewHelp }[state.tab]();
  app.replaceChildren(h('div', { class: 'shell' }, side, h('div', {}, mtop, h('main', { class: 'main' }, h('div', { class: 'view' }, view)))), bottom);
  window.scrollTo(0, y);
}

// ---------- Resumen ----------

function classify(l) {
  const left = daysLeft(l);
  return {
    expiring: l.state === 'activa' && l.type !== 'cortesia' && left != null && left <= WARN_DAYS,
    trialEnding: l.type === 'prueba' && l.state === 'activa' && left != null && left <= TRIAL_WARN_DAYS,
    trialExpired: l.type === 'prueba' && l.state === 'vencida',
    unpaid: l.type === 'paga' && l.state === 'vencida',
    neverActivated: l.state === 'activa' && l.devices === 0 && Date.now() - l.createdAt > NEVER_ACTIVATED_DAYS * DAY,
  };
}

function goLicenses(filter) {
  state.tab = 'licencias';
  state.filter = { q: '', estado: '', tipo: '', ...filter };
  showApp();
}

function viewSummary() {
  const all = state.licenses;
  const by = (fn) => all.filter(fn);
  const active = by((l) => l.state === 'activa');
  const worth = {};
  for (const l of active.filter((x) => x.type === 'paga' && x.price != null)) worth[l.currency] = (worth[l.currency] || 0) + l.price;
  const worthText = Object.keys(worth).length ? Object.entries(worth).map(([c, n]) => money(n, c)).join(' + ') : '—';

  const stat = (n, label, cls, filter, ic) => h('button', { class: `stat ${cls || ''}`, onclick: () => goLicenses(filter) },
    h('span', { class: 'ic' }, icon(ic)), h('span', { class: 'n', text: String(n) }), h('span', { class: 'l', text: label }));
  const stats = h('div', { class: 'stats' },
    stat(active.length, 'Activas', 'good', { estado: 'activa' }, 'check'),
    stat(by((l) => classify(l).expiring).length, `Vencen en ${WARN_DAYS} días`, 'warn', { estado: 'porvencer' }, 'clock'),
    stat(by((l) => l.state === 'vencida').length, 'Vencidas', 'bad', { estado: 'vencida' }, 'alert'),
    stat(by((l) => l.state === 'revocada').length, 'Revocadas', '', { estado: 'revocada' }, 'ban'),
    stat(by((l) => l.type === 'prueba' && l.state === 'activa').length, 'Pruebas en curso', 'info', { tipo: 'prueba', estado: 'activa' }, 'flask'),
    stat(by((l) => l.type === 'cortesia').length, 'Cortesías', '', { tipo: 'cortesia' }, 'gift'),
    h('div', { class: 'stat' }, h('span', { class: 'ic' }, icon('money')), h('span', { class: 'n money', text: worthText }), h('span', { class: 'l', text: 'Pagas activas (precio cargado)' })),
    h('div', { class: 'stat good' }, h('span', { class: 'ic' }, icon('card')), h('span', { class: 'n money', text: state.pagos.month.length ? state.pagos.month.map((m) => money(m.total, m.currency)).join(' + ') : '—' }),
      h('span', { class: 'l', text: state.pagos.configured ? 'Cobrado este mes (Mercado Pago)' : 'Cobrado este mes (Mercado Pago sin activar)' })));

  const group = (title, list, describe) => h('section', { class: 'card' },
    h('h3', { class: 'card-title' }, title, h('span', { class: 'count-pill', text: String(list.length) })),
    list.length ? h('div', { class: 'todo' }, list.slice(0, 8).map((l) => h('button', { class: 'todo-item', onclick: () => openDetail(l.code) },
      h('span', { class: 'mono', text: l.code }),
      h('span', { class: 'grow', text: l.customer || l.note || '—' }),
      h('span', { class: 'muted', text: describe(l) })))) : h('p', { class: 'empty', text: 'Nada por ahora.' }),
    list.length > 8 ? h('p', { class: 'hint', text: `y ${list.length - 8} más en Licencias` }) : null);

  const left = (l) => { const d = daysLeft(l); return d <= 0 ? 'vence hoy' : `${d} día${d === 1 ? '' : 's'}`; };
  return h('div', { class: 'stack' },
    h('div', { class: 'section-head' }, h('h2', { text: 'Resumen' }),
      h('button', { class: 'btn primary', onclick: openCreate }, icon('plus', 'sm'), 'Nueva licencia')),
    stats,
    h('h2', { text: 'Para atender' }),
    h('div', { class: 'attention' },
      state.pagos.review.length ? group('Pagos de Mercado Pago para revisar', state.pagos.review.map((p) => ({ code: p.code, customer: (state.licenses.find((l) => l.code === p.code) || {}).customer, note: '', status: p.status })),
        (l) => PAY_STATUS[l.status] || l.status) : null,
      state.pagos.rows.some((r) => r.status === 'approved' && ['error', 'sin_email', 'sin_smtp'].includes(r.mail))
        ? group('Emails de compra sin enviar', state.pagos.rows.filter((r) => r.status === 'approved' && ['error', 'sin_email', 'sin_smtp'].includes(r.mail))
          .map((r) => ({ code: r.code, customer: r.customer || r.email, note: '', status: r.mail })), (l) => MAIL_STATUS[l.status] || l.status) : null,
      group('Por vencer', by((l) => classify(l).expiring).sort((a, b) => a.paidUntil - b.paidUntil), left),
      group('Pagas vencidas: cobrar o dar de baja', by((l) => classify(l).unpaid).sort((a, b) => b.paidUntil - a.paidUntil), (l) => `venció ${fmtDate(l.paidUntil)}`),
      group('Pruebas por terminar o terminadas: convertir', by((l) => classify(l).trialEnding || classify(l).trialExpired).sort((a, b) => a.paidUntil - b.paidUntil),
        (l) => (l.state === 'vencida' ? `terminó ${fmtDate(l.paidUntil)}` : left(l))),
      group('Sin activar todavía', by((l) => classify(l).neverActivated).sort((a, b) => a.createdAt - b.createdAt), (l) => `creada ${fmtDate(l.createdAt)}`)));
}

// ---------- Licencias ----------

function matches(l) {
  const { q, estado, tipo } = state.filter;
  if (tipo && l.type !== tipo) return false;
  if (estado === 'porvencer') { if (!classify(l).expiring) return false; } else if (estado && l.state !== estado) return false;
  if (q) {
    const hay = `${l.code} ${l.customer} ${l.contact} ${l.note}`.toLowerCase();
    if (!q.toLowerCase().split(/\s+/).every((w) => hay.includes(w))) return false;
  }
  return true;
}

const COLUMNS = [
  ['code', 'Código', (l) => h('span', { class: 'mono', text: l.code })],
  ['customer', 'Cliente', (l) => h('span', { text: l.customer || l.note || '—' }), 'clip'],
  ['type', 'Tipo', (l) => h('span', { class: `badge ${l.type}`, text: TYPE_NAME[l.type] })],
  ['state', 'Estado', (l) => h('span', { class: `badge ${l.state}`, text: STATE_NAME[l.state] })],
  ['paidUntil', 'Vence', (l) => h('span', { text: l.paidUntil == null ? 'sin vencimiento' : fmtDate(l.paidUntil) })],
  ['devices', 'Disp.', (l) => h('span', { text: `${l.devices}/${l.maxDevices}` })],
  ['lastSeenAt', 'Última conexión', (l) => h('span', { class: 'muted', text: fmtDateTime(l.lastSeenAt) })],
];

function compare(a, b, key) {
  const va = a[key];
  const vb = b[key];
  if (va == null && vb == null) return 0;
  if (va == null) return 1; // lo vacío (sin vencimiento, nunca conectó) al final
  if (vb == null) return -1;
  return typeof va === 'string' ? va.localeCompare(vb, 'es') : va - vb;
}

function viewLicenses() {
  const tbody = h('tbody');
  const count = h('span', { class: 'muted' });
  const paint = () => {
    const rows = state.licenses.filter(matches).sort((a, b) => compare(a, b, state.sort.key) * state.sort.dir);
    count.textContent = `${rows.length} de ${state.licenses.length}`;
    tbody.replaceChildren(...rows.map((l) => h('tr', { tabindex: '0', onclick: () => openDetail(l.code), onkeydown: (ev) => { if (ev.key === 'Enter') openDetail(l.code); } },
      COLUMNS.map(([, label, cell, cls]) => h('td', { class: cls, 'data-label': label }, cell(l))))));
    if (!rows.length) tbody.replaceChildren(h('tr', {}, h('td', { colspan: String(COLUMNS.length), class: 'empty', text: state.licenses.length ? 'No hay licencias con ese filtro.' : 'Todavía no hay licencias. Creá la primera con "Nueva licencia".' })));
  };
  const q = h('input', { type: 'search', placeholder: 'Buscar por código, cliente, contacto o nota', value: state.filter.q, 'aria-label': 'Buscar' });
  q.addEventListener('input', () => { state.filter.q = q.value; paint(); });
  const chips = h('div', { class: 'chips', role: 'group', 'aria-label': 'Estado' });
  const ESTADOS = [['', 'Todas'], ['activa', 'Activas'], ['porvencer', 'Por vencer'], ['vencida', 'Vencidas'], ['revocada', 'Revocadas']];
  const paintChips = () => chips.replaceChildren(...ESTADOS.map(([v, t]) => h('button', {
    class: 'chip', type: 'button', text: t, 'aria-pressed': String(state.filter.estado === v),
    onclick: () => { state.filter.estado = v; paintChips(); paint(); },
  })));
  paintChips();
  const select = (key, label, options) => {
    const el = h('select', { 'aria-label': label }, options.map(([v, t]) => h('option', { value: v, text: t, selected: state.filter[key] === v })));
    el.addEventListener('change', () => { state.filter[key] = el.value; paint(); });
    return el;
  };
  const head = h('tr', {}, COLUMNS.map(([key, label]) => h('th', {
    scope: 'col', text: label + (state.sort.key === key ? (state.sort.dir > 0 ? ' ▲' : ' ▼') : ''),
    onclick: () => { state.sort = { key, dir: state.sort.key === key ? -state.sort.dir : 1 }; showApp(); },
  })));
  paint();
  return h('div', { class: 'stack' },
    h('div', { class: 'section-head' }, h('h2', { text: 'Licencias' }), count,
      h('button', { class: 'btn primary', onclick: openCreate }, icon('plus', 'sm'), 'Nueva licencia')),
    h('div', { class: 'toolbar' },
      h('div', { class: 'toolbar-row' }, h('div', { class: 'search' }, icon('search', 'sm'), q),
        select('tipo', 'Tipo', [['', 'Todos los tipos'], ['paga', 'Pagas'], ['prueba', 'Pruebas'], ['cortesia', 'Cortesías']])),
      chips),
    h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, head), tbody)));
}

// ---------- Crear ----------

function dialog(content, onClose) {
  const dlg = h('dialog', {}, h('div', { class: 'dlg' }, content));
  dlg.addEventListener('close', () => { dlg.remove(); if (onClose) onClose(); });
  dlg.addEventListener('click', (ev) => { if (ev.target === dlg) dlg.close(); }); // clic en el fondo
  document.body.append(dlg);
  dlg.showModal();
  return dlg;
}

function field(label, el) { return h('label', {}, label, el); }

function openCreate() {
  const f = {
    type: h('select', {}, [['paga', 'Paga (30 días)'], ['prueba', 'Prueba (14 días)'], ['cortesia', 'Cortesía (no vence)']].map(([v, t]) => h('option', { value: v, text: t }))),
    days: h('input', { type: 'number', min: '1', step: '1', placeholder: 'por defecto del tipo' }),
    customer: h('input', { maxlength: '120', placeholder: 'Club o persona' }),
    contact: h('input', { maxlength: '120', placeholder: 'Teléfono u otro dato' }),
    email: h('input', { type: 'email', maxlength: '120', placeholder: 'Para mandarle el código y los avisos' }),
    price: h('input', { type: 'number', min: '0', step: 'any' }),
    currency: h('input', { maxlength: '3', value: 'ARS' }),
    maxDevices: h('input', { type: 'number', min: '1', step: '1', value: '1' }),
    note: h('input', { maxlength: '300', placeholder: 'Nota interna' }),
  };
  f.type.addEventListener('change', () => { f.days.disabled = f.type.value === 'cortesia'; });
  const out = h('div');
  const submit = h('button', { class: 'btn primary', type: 'submit', text: 'Crear licencia' });
  const dlg = dialog(h('form', {
    class: 'stack',
    onsubmit: (ev) => {
      ev.preventDefault();
      run(submit, async () => {
        const body = Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.value]));
        if (!body.days || f.days.disabled) delete body.days; else body.days = Number(body.days);
        body.maxDevices = Number(body.maxDevices);
        body.price = body.price === '' ? null : Number(body.price);
        const lic = await api('POST', '/licenses', body);
        upsert(lic);
        out.replaceChildren(h('div', { class: 'card' },
          h('p', { class: 'muted', text: 'Licencia creada. Código para entregar:' }),
          h('p', { class: 'mono code-big', text: lic.code }),
          h('div', { class: 'row' },
            h('button', { class: 'btn', type: 'button', text: 'Copiar código', onclick: () => copy(lic.code, 'Código copiado') }),
            h('button', { class: 'btn', type: 'button', text: 'Abrir ficha', onclick: () => { dlg.close(); openDetail(lic.code); } }))));
        submit.hidden = true;
        showApp();
      });
    },
  },
  h('div', { class: 'dlg-head' }, h('h2', { text: 'Nueva licencia' }), h('span', { class: 'spacer' }), h('button', { class: 'btn small', type: 'button', text: 'Cerrar', onclick: () => dlg.close() })),
  h('div', { class: 'row' }, field('Tipo', f.type), field('Días', f.days)),
  h('p', { class: 'hint', text: 'Días vacío usa el valor del tipo (paga 30, prueba 14). La cortesía no vence. Cliente, contacto, precio y nota son solo para vos.' }),
  h('div', { class: 'row' }, field('Cliente', f.customer), field('Contacto', f.contact)),
  field('Email del cliente', f.email),
  h('div', { class: 'row' }, field('Precio', f.price), field('Moneda', f.currency), field('Dispositivos', f.maxDevices)),
  field('Nota', f.note), out, submit));
}

// ---------- Ficha de una licencia ----------

async function openDetail(code) {
  let lic;
  try {
    lic = await api('GET', `/licenses/${encodeURIComponent(code)}`);
    state.pagos = await api('GET', '/pagos');
  } catch (e) {
    if (!(e instanceof ApiError && e.code === 'sesion')) toast(e.message, true);
    return;
  }
  document.querySelectorAll('dialog[data-detail]').forEach((d) => d.close());
  const body = h('div', { class: 'dlg' });
  const dlg = h('dialog', { 'data-detail': code }, body);
  dlg.addEventListener('close', () => dlg.remove());
  dlg.addEventListener('click', (ev) => { if (ev.target === dlg) dlg.close(); });
  document.body.append(dlg);

  const paint = (current) => {
    lic = current;
    upsert(lic);
    body.replaceChildren(...detailContent(lic, paint, dlg));
  };
  paint(lic);
  dlg.showModal();
}

function detailContent(lic, paint, dlg) {
  const act = (button, method, path, payload, okText) => run(button, async () => {
    const next = await api(method, `/licenses/${encodeURIComponent(lic.code)}${path}`, payload);
    paint(next);
    refreshBackground();
    if (okText) toast(okText);
  });
  const small = (text, onclick, cls = '') => h('button', { class: `btn small ${cls}`, type: 'button', text, onclick });
  const num = (props) => h('input', { type: 'number', min: '1', step: '1', ...props });

  const certText = lic.tokenExp == null
    ? 'Sin dato (el celular todavía no pidió certificado)'
    : fmtDate(lic.tokenExp);

  const info = h('dl', { class: 'kv' },
    kv('Cliente', lic.customer || '—'), kv('Contacto', lic.contact || '—'), kv('Email', lic.email || '—'),
    kv('Precio', money(lic.price, lic.currency)), kv('Nota', lic.note || '—'),
    kv('Creada', fmtDate(lic.createdAt)),
    kv('Vence', lic.paidUntil == null ? 'Sin vencimiento' : `${fmtDate(lic.paidUntil)}${daysLeft(lic) != null ? ` (${daysLeft(lic) >= 0 ? `faltan ${daysLeft(lic)}` : `hace ${-daysLeft(lic)}`} días)` : ''}`),
    kv('Última conexión', fmtDateTime(lic.lastSeenAt)),
    kv('Dispositivos', `${lic.devices} de ${lic.maxDevices}`),
    kv('Certificado del celular vigente hasta', certText));

  // Extender
  const extDays = num({ value: '30', 'aria-label': 'Días a sumar' });
  const extender = lic.type === 'cortesia' ? null : h('div', { class: 'action' }, h('h3', { text: 'Registrar pago / extender' }),
    h('div', { class: 'row' }, field('Días a sumar', extDays),
      small('Extender', (ev) => act(ev.currentTarget, 'POST', '/extender', { days: Number(extDays.value) }, 'Licencia extendida'), 'primary')),
    h('p', { class: 'hint', text: 'Si ya venció, cuenta desde hoy. El celular lo toma al renovar su certificado.' }));

  // Convertir
  const convDays = num({ value: '30', 'aria-label': 'Días de la licencia paga' });
  const convertir = lic.type === 'paga' ? null : h('div', { class: 'action' }, h('h3', { text: 'Convertir a paga' }),
    h('div', { class: 'row' }, field('Días', convDays),
      small('Convertir', (ev) => act(ev.currentTarget, 'POST', '/convertir', { days: Number(convDays.value) }, 'Convertida a paga'), 'primary')));

  // Estado
  const revoke = () => {
    const base = `El celular se bloquea cuando termine su certificado actual (${lic.tokenExp ? `hasta el ${fmtDate(lic.tokenExp)}` : 'hasta 32 días'}, más 3 días de gracia). No es inmediato.`;
    return window.confirm(`¿Revocar ${lic.code}?\n\n${base}`);
  };
  const estado = h('div', { class: 'action' }, h('h3', { text: 'Estado y dispositivos' }),
    h('div', { class: 'row' },
      lic.state === 'revocada'
        ? small('Reactivar', (ev) => act(ev.currentTarget, 'POST', '/reactivar', {}, 'Reactivada'))
        : small('Revocar', (ev) => { if (revoke()) act(ev.currentTarget, 'POST', '/revocar', {}, 'Revocada'); }, 'danger'),
      small('Liberar dispositivo', (ev) => { if (window.confirm('¿Liberar los dispositivos? El próximo celular que use el código queda asociado (cambio de celular).')) act(ev.currentTarget, 'POST', '/resetear', {}, 'Dispositivos liberados'); })));
  const maxDev = num({ value: String(lic.maxDevices), 'aria-label': 'Máximo de dispositivos' });
  estado.append(h('div', { class: 'row' }, field('Máximo de dispositivos', maxDev),
    small('Guardar', (ev) => act(ev.currentTarget, 'POST', '/dispositivos', { maxDevices: Number(maxDev.value) }, 'Guardado'))));

  // Cobro con Mercado Pago
  const payAmount = h('input', { type: 'number', min: '0', step: 'any', value: lic.price == null ? '' : String(lic.price), 'aria-label': 'Monto' });
  const payDays = num({ value: '30', max: '366', 'aria-label': 'Días que paga' });
  const payOut = h('div');
  const cobro = (lic.type === 'cortesia' || lic.state === 'revocada') ? null : h('div', { class: 'action' }, h('h3', { text: 'Cobrar con Mercado Pago' }),
    state.pagos.configured
      ? h('div', { class: 'stack' },
        h('div', { class: 'row' }, field(`Monto (${lic.currency})`, payAmount), field('Días que paga', payDays),
          small('Generar link de pago', (ev) => run(ev.currentTarget, async () => {
            const r = await api('POST', `/licenses/${encodeURIComponent(lic.code)}/pago`, { amount: payAmount.value === '' ? undefined : Number(payAmount.value), days: Number(payDays.value) });
            const input = h('input', { readonly: true, value: r.url, 'aria-label': 'Link de pago' });
            input.addEventListener('focus', () => input.select());
            payOut.replaceChildren(h('div', { class: 'linkbox' }, input, small('Copiar', () => copy(r.url, 'Link de pago copiado'))),
              h('p', { class: 'hint', text: `Cobra ${money(r.amount, r.currency)} por ${r.days} días. Mandalo al cliente: cuando paga, la licencia se extiende sola en unos segundos. El link vence en 7 días.` }));
            paint(await api('GET', `/licenses/${encodeURIComponent(lic.code)}`));
          }), 'primary')), payOut)
      : h('p', { class: 'hint', text: 'Todavía no está activado en el servidor (faltan las credenciales de Mercado Pago). Mientras tanto registrá los pagos a mano con "Extender". Mirá la Ayuda.' }));

  // Enviar los datos por email
  const enviar = !lic.email || lic.state === 'revocada' ? null : h('div', { class: 'action' }, h('h3', { text: 'Enviar al cliente por email' }),
    h('p', { class: 'hint', text: `Le manda a ${lic.email} el código, el vencimiento, un link de descarga personal y los pasos para activarla.` }),
    h('div', { class: 'row' }, small('Enviar instrucciones por email', (ev) => run(ev.currentTarget, async () => {
      const r = await api('POST', `/licenses/${encodeURIComponent(lic.code)}/email`, {});
      paint(r.license);
      toast(`Email enviado a ${r.to}`);
    }), 'primary')));

  const misPagos = state.pagos.rows.filter((r) => r.code === lic.code);
  const pagos = !misPagos.length ? null : h('div', { class: 'action' }, h('h3', { text: 'Pagos de esta licencia' }),
    h('div', { class: 'timeline' }, misPagos.map((r) => h('div', {},
      h('span', { class: 'muted', text: fmtDateTime(r.at) }), h('strong', { text: money(r.amount, r.currency) }),
      h('span', { class: 'muted', text: `${r.days} d` }), h('span', { text: `${PAY_ROW_STATUS[r.status] || r.status} · email: ${MAIL_STATUS[r.mail] || '—'}` })))));

  // Link
  const hours = num({ value: '48', max: '720', 'aria-label': 'Horas de vigencia' });
  const uses = num({ value: '3', max: '20', 'aria-label': 'Descargas' });
  const linkOut = h('div');
  const link = h('div', { class: 'action' }, h('h3', { text: 'Link de descarga del APK' }),
    h('div', { class: 'row' }, field('Vale (horas)', hours), field('Descargas', uses),
      small('Generar link', (ev) => run(ev.currentTarget, async () => {
        const r = await api('POST', `/licenses/${encodeURIComponent(lic.code)}/link`, { hours: Number(hours.value), uses: Number(uses.value) });
        const input = h('input', { readonly: true, value: r.url, 'aria-label': 'Link de descarga' });
        input.addEventListener('focus', () => input.select());
        linkOut.replaceChildren(h('div', { class: 'linkbox' }, input, small('Copiar', () => copy(r.url, 'Link copiado'))),
          h('p', { class: 'hint', text: `Vale ${r.hours} h y ${r.uses} descargas. Mandalo por WhatsApp.` }));
        paint(await api('GET', `/licenses/${encodeURIComponent(lic.code)}`));
      }))), linkOut);

  // Editar
  const e = {
    customer: h('input', { value: lic.customer, maxlength: '120' }), contact: h('input', { value: lic.contact, maxlength: '120' }),
    email: h('input', { type: 'email', value: lic.email || '', maxlength: '120' }),
    price: h('input', { type: 'number', min: '0', step: 'any', value: lic.price == null ? '' : String(lic.price) }),
    currency: h('input', { value: lic.currency, maxlength: '3' }), note: h('input', { value: lic.note, maxlength: '300' }),
  };
  const editar = h('div', { class: 'action' }, h('h3', { text: 'Datos del cliente' }),
    h('div', { class: 'row' }, field('Cliente', e.customer), field('Contacto', e.contact)),
    field('Email del cliente', e.email),
    h('div', { class: 'row' }, field('Precio', e.price), field('Moneda', e.currency)),
    field('Nota', e.note),
    h('div', { class: 'row' }, small('Guardar datos', (ev) => act(ev.currentTarget, 'POST', '/editar', {
      customer: e.customer.value, contact: e.contact.value, email: e.email.value, note: e.note.value, currency: e.currency.value, price: e.price.value === '' ? '' : Number(e.price.value),
    }, 'Datos guardados'), 'primary')));

  const devices = h('div', { class: 'action' }, h('h3', { text: 'Dispositivos activados' }),
    lic.deviceList.length ? lic.deviceList.map((d) => h('p', {}, h('span', { class: 'mono', text: d.id }), h('span', { class: 'muted', text: `  ·  ${fmtDateTime(d.activatedAt)}` })))
      : h('p', { class: 'empty', text: 'Ninguno todavía.' }));

  const history = h('div', { class: 'action' }, h('h3', { text: 'Historial' }),
    h('div', { class: 'timeline' }, lic.events.length ? lic.events.map((ev) => h('div', {},
      h('span', { class: 'muted', text: fmtDateTime(ev.at) }), h('strong', { text: ev.type }), h('span', { class: 'muted', text: ev.actor }), h('span', { text: ev.detail })))
      : h('p', { class: 'empty', text: 'Sin movimientos.' })));

  return [
    h('div', { class: 'dlg-head' }, h('h2', { text: lic.code }),
      h('span', { class: `badge ${lic.type}`, text: TYPE_NAME[lic.type] }), h('span', { class: `badge ${lic.state}`, text: STATE_NAME[lic.state] }),
      small('Copiar código', () => copy(lic.code, 'Código copiado')), h('span', { class: 'spacer' }),
      small('Cerrar', () => dlg.close())),
    info, h('div', { class: 'actions' }, cobro, pagos, enviar, extender, convertir, estado, link, editar, devices, history),
  ];
}

function kv(label, value) {
  return h('div', {}, h('dt', { text: label }), h('dd', { text: String(value) }));
}

/** Refresca lo de atrás (tabla/resumen) cuando cambia una licencia desde la ficha. Los diálogos viven fuera de #app. */
function refreshBackground() {
  showApp();
}

// ---------- APK ----------

function viewApk() {
  const a = state.apk;
  const info = a.published
    ? h('dl', { class: 'kv' }, kv('Versión', `${a.versionName} (código ${a.versionCode})`), kv('Publicada', fmtDateTime(a.publishedAt)),
      kv('Tamaño', a.size ? (a.size < 1048576 ? `${Math.round(a.size / 1024)} KB` : `${(a.size / 1048576).toFixed(1)} MB`) : '—'), kv('sha256', `${a.sha256.slice(0, 16)}…`),
      h('div', {}, h('dt', { text: 'Novedades' }), h('dd', {}, a.notes.length ? h('ul', { class: 'plain-list' }, a.notes.map((n) => h('li', { text: n }))) : '—')))
    : h('p', { class: 'empty', text: 'Todavía no hay un APK publicado.' });

  const file = h('input', { type: 'file', accept: '.apk,application/vnd.android.package-archive', required: true });
  const name = h('input', { placeholder: 'ej. 1.6', maxlength: '20', required: true });
  const code = h('input', { type: 'number', min: '1', step: '1', required: true, value: a.published ? String(a.versionCode + 1) : '' });
  const notes = h('textarea', { placeholder: 'Una novedad por línea (hasta 10)' });
  const bar = h('div', { class: 'progress', hidden: true }, h('div'));
  const submit = h('button', { class: 'btn primary', type: 'submit', text: 'Publicar versión' });
  const form = h('form', {
    class: 'stack',
    onsubmit: (ev) => {
      ev.preventDefault();
      const f = file.files[0];
      if (!f) return;
      if (a.published && Number(code.value) < a.versionCode) { toast(`El código tiene que ser ${a.versionCode} o más.`, true); return; }
      if (!window.confirm(`¿Publicar ${name.value} (código ${code.value})? Las apps con licencia al día la van a ver como actualización.`)) return;
      run(submit, async () => {
        bar.hidden = false;
        try {
          const qs = new URLSearchParams({ nombre: name.value.trim(), codigo: code.value, notas: notes.value });
          const r = await api('PUT', `/apk?${qs}`, undefined, { rawBody: f, headers: { 'Content-Type': 'application/vnd.android.package-archive' } });
          state.apk = r.apk;
          toast('APK publicado');
          showApp();
        } finally { bar.hidden = true; }
      });
    },
  },
  field('Archivo APK (app-release.apk)', file),
  h('div', { class: 'row' }, field('Nombre de versión (versionName)', name), field('Código (versionCode)', code)),
  field('Novedades', notes), bar, submit,
  h('p', { class: 'hint', text: 'El nombre y el código salen de android/app/build.gradle. El código tiene que ser mayor al de la versión que ya tienen instalada los clientes.' }));

  return h('div', { class: 'stack' }, h('h2', { text: 'App (APK)' }),
    h('section', { class: 'card stack' }, h('h3', { text: 'Versión vigente' }), info),
    h('section', { class: 'card stack' }, h('h3', { text: 'Publicar una versión nueva' }), form));
}

// ---------- Cobros ----------

function viewPayments() {
  const pg = state.pagos;
  const sale = pg.config.sale;
  const amount = h('input', { type: 'number', min: '0', step: 'any', value: sale ? String(sale.amount) : '', placeholder: 'ej. 15000' });
  const currency = h('input', { maxlength: '3', value: sale ? sale.currency : 'ARS' });
  const dayz = h('input', { type: 'number', min: '1', max: '366', step: '1', value: sale ? String(sale.days) : '30' });
  const adminEmail = h('input', { type: 'email', maxlength: '120', value: pg.config.adminEmail || '', placeholder: 'tu@email.com' });
  const remind = h('input', { type: 'number', min: '0', max: '30', step: '1', value: String(pg.config.remindDays) });
  const chip = (ok, label) => h('span', { class: `badge ${ok ? 'activa' : 'vencida'}`, text: `${label}: ${ok ? 'listo' : 'falta configurar'}` });

  const save = h('button', { class: 'btn primary', type: 'submit', text: 'Guardar' });
  const form = h('form', {
    class: 'stack',
    onsubmit: (ev) => {
      ev.preventDefault();
      run(save, async () => {
        state.pagos = await api('POST', '/config', {
          amount: amount.value === '' ? '' : Number(amount.value), currency: currency.value, days: Number(dayz.value),
          adminEmail: adminEmail.value, remindDays: Number(remind.value),
        });
        toast('Guardado');
        showApp();
      });
    },
  },
  h('div', { class: 'row' }, field('Precio de la licencia', amount), field('Moneda', currency), field('Días que dura', dayz)),
  h('p', { class: 'hint', text: 'Si dejás el precio vacío y guardás, se apaga la venta online. Podés cambiar el precio cuando quieras: vale para las compras nuevas.' }),
  h('div', { class: 'row' }, field('Email para avisos de venta (te llega uno por cada pago)', adminEmail), field('Avisar de vencimientos (días antes, 0 = no)', remind)),
  save);

  const saleLink = sale && pg.configured
    ? h('div', { class: 'stack' },
      h('div', { class: 'linkbox' }, h('input', { readonly: true, value: pg.saleUrl, 'aria-label': 'Link de compra' }), h('button', { class: 'btn small', type: 'button', text: 'Copiar', onclick: () => copy(pg.saleUrl, 'Link de compra copiado') })),
      h('p', { class: 'hint', text: 'Ponelo en el botón "Comprar" de tu sitio o mandalo por WhatsApp. Quien lo abre va al pago de Mercado Pago.' }))
    : h('p', { class: 'hint', text: !pg.configured ? 'Falta cargar las credenciales de Mercado Pago en el servidor (ver Ayuda y server/README.md).' : 'Cargá el precio y guardá para activar el link de compra.' });

  const testMail = h('button', { class: 'btn small', type: 'button', text: 'Enviar email de prueba', onclick: (ev) => run(ev.currentTarget, async () => {
    const r = await api('POST', '/mail/prueba', {});
    toast(`Email de prueba enviado a ${r.to}`);
  }) });

  const total = pg.month.length ? pg.month.map((m) => `${money(m.total, m.currency)} (${m.count} pago${m.count === 1 ? '' : 's'})`).join(' + ') : 'todavía nada';
  const table = pg.rows.length
    ? h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Fecha', 'Cliente', 'Código', 'Tipo', 'Monto', 'Días', 'Vence', 'Estado', 'Email'].map((t) => h('th', { scope: 'col', text: t })))),
      h('tbody', {}, pg.rows.map((r) => h('tr', { tabindex: '0', onclick: () => { if (r.code) openDetail(r.code); }, onkeydown: (ev) => { if (ev.key === 'Enter' && r.code) openDetail(r.code); } },
        h('td', { 'data-label': 'Fecha', text: fmtDateTime(r.at) }),
        h('td', { class: 'clip', 'data-label': 'Cliente', text: r.customer || r.email || '—' }),
        h('td', { 'data-label': 'Código' }, h('span', { class: 'mono', text: r.code || '—' })),
        h('td', { 'data-label': 'Tipo', text: r.kind === 'new' ? 'Compra' : 'Renovación' }),
        h('td', { 'data-label': 'Monto', text: money(r.amount, r.currency) }),
        h('td', { 'data-label': 'Días', text: r.days ? String(r.days) : '—' }),
        h('td', { 'data-label': 'Vence', text: r.paidUntil == null ? '—' : fmtDate(r.paidUntil) }),
        h('td', { 'data-label': 'Estado' }, h('span', { class: `badge ${r.status === 'approved' ? 'activa' : 'vencida'}`, text: PAY_ROW_STATUS[r.status] || r.status })),
        h('td', { 'data-label': 'Email', title: r.mailError || r.mailTo || '', text: MAIL_STATUS[r.mail] || (r.status === 'approved' ? '—' : '') }))))))
    : h('p', { class: 'empty big', text: 'Todavía no hay pagos.' });

  return h('div', { class: 'stack' },
    h('div', { class: 'section-head' }, h('h2', { text: 'Cobros' })),
    h('section', { class: 'card stack' },
      h('h3', { text: 'Venta online' }),
      h('p', { class: 'hint', text: 'Cuando alguien paga, se crea sola su licencia y le llega por email el código, el link de descarga y los pasos. A vos te llega un aviso.' }),
      h('div', { class: 'status-row' }, chip(pg.configured, 'Mercado Pago'), chip(pg.mailConfigured, 'Envío de emails'), testMail),
      form, saleLink),
    h('section', { class: 'card stack' },
      h('h3', { text: 'Pagos recibidos' }),
      h('p', { text: `Cobrado este mes: ${total}` }),
      table));
}

// ---------- Ayuda ----------

function helpSection(title, open, ...content) {
  return h('details', { class: 'card help', open }, h('summary', { text: title }), h('div', { class: 'help-body' }, ...content));
}

function viewHelp() {
  const p = (text) => h('p', { text });
  const li = (...items) => h('ul', {}, items.map((t) => h('li', { text: t })));
  const ol = (...items) => h('ol', {}, items.map((t) => h('li', { text: t })));
  return h('div', { class: 'stack' },
    h('div', { class: 'section-head' }, h('h2', { text: 'Ayuda' })),
    h('p', { class: 'hint', text: 'Cómo usar este panel, en orden de lo que más vas a necesitar. Tocá cada título para abrirlo.' }),

    helpSection('Cómo se entrega una licencia (paso a paso)', true,
      ol('Licencias > Nueva licencia. Elegí el tipo (paga, prueba o cortesía), cargá cliente y contacto, y creala.',
        'Copiá el código (ZSL-XXXX-XXXX) y mandáselo al cliente por WhatsApp.',
        'En la ficha de esa licencia, "Link de descarga del APK" > Generar link > Copiar. Mandale también el link: vale unas horas y unas pocas descargas.',
        'El cliente instala la app, escribe el código una sola vez y queda atado a su celular. En la ficha vas a ver "Dispositivos 1 de 1" y la última conexión.',
        'Cuando pague de nuevo, entrá a su ficha y usá "Registrar pago / extender".'),
      p('Si el cliente compra online, los pasos 1 a 4 pasan solos (ver "Venta online automática").'),
      p('La app exige licencia: sin un código activo no deja jugar. No hay prueba gratis automática; las pruebas las das vos con una licencia de tipo Prueba o Cortesía.')),

    helpSection('Tipos de licencia', false,
      li('Paga: dura lo que sumes (30 días por defecto). Se renueva con "Extender" cada vez que paga.',
        'Prueba: 14 días por defecto, para que el cliente pruebe. Si le gusta, "Convertir a paga".',
        'Cortesía: no vence. Es para vos, demos y regalos. Se puede revocar como cualquier otra.')),

    helpSection('Estados y qué significan los números del Resumen', false,
      li('Activa: al día. Vencida: se le terminaron los días. Revocada: la diste de baja a mano.',
        '"Vencen en 7 días": activas que están por terminar. Conviene avisarles o cobrar antes.',
        '"Pagas vencidas": clientes que dejaron de pagar. Decidí si cobrar o dar de baja.',
        '"Pruebas por terminar": ofrecé la conversión a paga antes de que se les corte.',
        '"Sin activar todavía": creaste el código hace más de 2 días y el cliente no lo usó. Recordáselo.',
        '"Pagas activas": suma del precio cargado en las licencias pagas al día (solo informativo; no es plata cobrada).')),

    helpSection('Venta online automática (el cliente paga y recibe todo por email)', false,
      li('Pestaña Cobros: cargá el precio, la moneda y los días (por ejemplo 15000 ARS, 30 días) y tocá Guardar. Eso activa el link de compra.',
        'Copiá el "Link de compra" y ponelo en el botón Comprar de tu sitio o mandalo por WhatsApp. Quien lo abre va al pago de Mercado Pago.',
        'Cuando paga: se crea sola una licencia paga (con el nombre y el email que dejó en Mercado Pago), le llega un email con el código, el vencimiento, el link de descarga y los pasos, y a vos te llega un aviso al "Email para avisos".',
        'Todo queda en Cobros: quién pagó, cuánto, qué licencia, hasta cuándo vence y si el email salió.',
        'Unos días antes de vencer (por defecto 5) el cliente recibe un email con un link para renovar. Se apaga poniendo 0.'),
      p('Si un email no sale (falló el correo o el pagador no dejó email) aparece en "Emails de compra sin enviar" del Resumen. Si falló el correo se reintenta solo; si falta el email, cargalo en la ficha y tocá "Enviar instrucciones por email".'),
      p('Para que funcione, el servidor necesita las credenciales de Mercado Pago y del correo (ver server/README.md). La pestaña Cobros te dice qué falta y tiene un botón para mandarte un email de prueba.')),

    helpSection('Cobrar la renovación de una licencia que ya existe', false,
      li('En la ficha, "Cobrar con Mercado Pago": confirmá el monto y los días y tocá "Generar link de pago". Copialo y mandáselo al cliente.',
        'Cuando el cliente paga, Mercado Pago avisa al servidor y la licencia se extiende sola en unos segundos (si era una prueba, pasa a paga). Queda en el historial como "pago" con actor mp y, si la licencia tiene email, el cliente recibe el recibo.',
        'Cada link cobra UN período (por ejemplo 30 días). Para el mes siguiente se genera otro link: todavía no hay débito automático.',
        'El link vence a los 7 días. Un mismo pago nunca suma dos veces.'),
      p('Seguridad: el servidor verifica la firma del aviso, le pregunta a Mercado Pago por el pago y comprueba que el monto y la moneda sean los del link. Si no coinciden, no suma días y lo deja en "Pagos de Mercado Pago para revisar" (Resumen).'),
      p('Reintegros y contracargos: se anotan en el historial y aparecen para revisar, pero la licencia NO se corta sola: decidís vos si revocarla.'),
      p('Si ves "Mercado Pago sin activar", el servidor todavía no tiene las credenciales (ver server/README.md). Mientras tanto usá "Extender".')),

    helpSection('Registrar un pago / extender', false,
      p('Ponés los días y tocás Extender. Si la licencia todavía está vigente, los días se suman al final; si ya venció, cuentan desde hoy.'),
      p('El celular toma el cambio solo cuando renueva su certificado (necesita internet, y lo hace a los pocos días de abrir la app). Si el cliente tiene apuro, que entre a Configuración y toque "Renovar ahora".')),

    helpSection('Cuándo se bloquea la app (y por qué no es inmediato)', false,
      p('La app tiene que funcionar en la cancha sin internet. Por eso guarda un certificado firmado de hasta 32 días y lo renueva sola cuando hay conexión.'),
      li('Antes de vencer la app avisa (5 días antes).',
        'Si vence, tiene 3 días de gracia con aviso en rojo.',
        'Después se bloquea: puede terminar el partido en curso, ver el historial y hacer la copia de seguridad. No pierde datos.'),
      p('Consecuencia: si revocás o dejás vencer una licencia, el celular se corta cuando termina su certificado actual (hasta 32 días + 3). La ficha muestra "Certificado del celular vigente hasta" para que sepas cuándo.')),

    helpSection('Revocar y reactivar', false,
      p('Revocar corta el acceso: el celular deja de renovar y se bloquea cuando termine su certificado. Reactivar lo deshace.'),
      p('Las cortesías también se cortan: aunque la licencia no venza, el celular renueva un certificado de 32 días, y si la revocás deja de renovarlo.')),

    helpSection('Cambio de celular', false,
      p('El código queda atado al primer celular que lo activa. Si el cliente cambia de teléfono, en su ficha tocá "Liberar dispositivo" y que active el código en el nuevo. Si necesita usarlo en más de un celular a la vez, subí el "Máximo de dispositivos".'),
      p('Si alguien le pasa el APK a otro y usa el mismo código, el segundo celular recibe "ya está activado en otro dispositivo".')),

    helpSection('Convertir una prueba (o cortesía) a paga', false,
      p('En la ficha, "Convertir a paga" con los días que pagó. Mantiene lo que le quedaba de la prueba y suma los días nuevos. Queda registrado en el historial.')),

    helpSection('Link de descarga del APK', false,
      p('El APK ya no está en una dirección pública. Cada link es de UNA licencia, vence (48 horas por defecto), tiene tope de descargas (3) y solo sirve si la licencia está activa. Una licencia vencida o revocada no puede generar link.'),
      p('Mandalo por WhatsApp. Si se vence o se gasta, generá otro.')),

    helpSection('Publicar una versión nueva de la app (pestaña App)', false,
      li('Compilá el APK de release (app-release.apk).',
        'En la pestaña App, elegí el archivo y completá "Nombre de versión" y "Código" tal cual están en android/app/build.gradle (versionName y versionCode).',
        'El código tiene que ser mayor o igual al publicado: si es menor, las apps instaladas no lo ven como actualización y el panel lo rechaza.',
        'Escribí las novedades, una por línea: es lo que el cliente lee antes de actualizar.'),
      p('Las apps con licencia al día preguntan al abrir si hay versión nueva y muestran "Ver novedades" con el botón de descarga. Quien no tiene licencia vigente no se entera.')),

    helpSection('Datos del cliente, precio e historial', false,
      p('Cliente, contacto, precio y nota son solo para vos (el cliente no los ve). El historial de cada ficha registra quién hizo qué y cuándo: crear, extender, convertir, revocar, activar un celular, generar links.'),
      p('Para buscar: en Licencias escribí parte del código, del cliente, del contacto o de la nota. Tocá el título de una columna para ordenar.')),

    helpSection('Tu contraseña y la seguridad del panel', false,
      li('Usuario: admin. La contraseña la elegiste vos; el botón "Contraseña" de arriba la cambia (te pide la actual).',
        'La sesión se cierra sola a los 30 minutos sin tocar nada, y siempre a las 12 horas.',
        'Tras 5 intentos fallidos desde una misma conexión, el panel espera 15 minutos.',
        'Si te olvidás la contraseña, se crea una nueva desde el servidor con: node license-admin.cjs panel-clave (ver server/README.md).',
        'Salí siempre con el botón "Salir" si usás una computadora que no es tuya.')),

    helpSection('Qué NO hace todavía', false,
      li('No hace débito automático ni suscripción: cada período se cobra con un link nuevo (el aviso por email antes de vencer sale solo).',
        'No manda WhatsApp: solo emails.',
        'No tiene gráficos de ingresos ni estadísticas de uso (solo el total cobrado del mes).',
        'No hay prueba gratis automática desde la app: las pruebas se dan a mano con licencias de tipo Prueba o Cortesía.')));
}

// ---------- Cambiar contraseña ----------

function openPassword() {
  const current = h('input', { type: 'password', autocomplete: 'current-password', required: true });
  const next = h('input', { type: 'password', autocomplete: 'new-password', required: true, minlength: '12' });
  const again = h('input', { type: 'password', autocomplete: 'new-password', required: true, minlength: '12' });
  const err = h('p', { class: 'error', role: 'alert' });
  const submit = h('button', { class: 'btn primary', type: 'submit', text: 'Cambiar contraseña' });
  const dlg = dialog(h('form', {
    class: 'stack',
    onsubmit: (ev) => {
      ev.preventDefault();
      err.textContent = '';
      if (next.value !== again.value) { err.textContent = 'Las dos contraseñas nuevas no coinciden.'; return; }
      run(submit, async () => {
        try {
          await api('POST', '/password', { current: current.value, next: next.value });
          toast('Contraseña cambiada. Las otras sesiones abiertas se cerraron.');
          dlg.close();
        } catch (e) {
          if (e instanceof ApiError && e.code === 'sesion') return;
          err.textContent = e.message;
          current.value = '';
        }
      });
    },
  },
  h('div', { class: 'dlg-head' }, h('h2', { text: 'Cambiar contraseña' }), h('span', { class: 'spacer' }), h('button', { class: 'btn small', type: 'button', text: 'Cerrar', onclick: () => dlg.close() })),
  field('Contraseña actual', current),
  field('Contraseña nueva (mínimo 12 caracteres)', next),
  field('Repetí la nueva', again),
  h('p', { class: 'hint', text: 'Usá una frase larga que no uses en otro lado. Un gestor de contraseñas ayuda.' }),
  err, submit));
  current.focus();
}

// ---------- Arranque ----------

async function start() {
  try {
    const s = await api('GET', '/session');
    if (s.authenticated) {
      state.csrf = s.csrf;
      state.user = s.user;
      await load();
      showApp();
    } else {
      showLogin(s.configured ? '' : ERROR_TEXT.sin_clave);
    }
  } catch (e) {
    showLogin(e.message);
  }
  // Los datos se refrescan solos si la pestaña está a la vista (cambian por los pagos y las activaciones).
  setInterval(async () => {
    if (!state.csrf || document.hidden || document.querySelector('dialog[open]')) return;
    try { await load(); showApp(); } catch (e) { /* si falla, se reintenta en el próximo ciclo */ }
  }, 60000);
}

start();
