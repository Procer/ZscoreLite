// Pruebas de la venta online: compra pública, licencia creada sola, emails, reintentos, avisos de vencimiento y panel.
// Usa un Mercado Pago simulado y un SMTP simulado. node --test server/test/

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { freePort, waitFor, startSmtpMock, startMpMock } = require('./helpers.cjs');

const SERVER_DIR = path.join(__dirname, '..');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'zslite-sale-'));
const KEY_FILE = path.join(DATA_DIR, 'license-private.pem');
fs.writeFileSync(KEY_FILE, crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' }));

process.env.DATA_DIR = DATA_DIR;
process.env.PRIVATE_KEY_FILE = KEY_FILE;
const lib = require('../license-lib.cjs');
const panel = require('../license-panel.cjs');

const SECRET = 'secreto-de-webhook-de-prueba';
const PASSWORD = 'una-clave-bien-larga-123';
const PUBLIC = 'https://lite.test';

let mp;
let smtp;
let server;
let base;

test.before(async () => {
  mp = await startMpMock();
  smtp = await startSmtpMock();
  await panel.setPassword('admin', PASSWORD);
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [path.join(SERVER_DIR, 'license-server.cjs')], {
    env: {
      ...process.env, PORT: String(port), PANEL_DEV: '1', ZS_JOBS_MS: '400', PUBLIC_URL: PUBLIC,
      MP_ACCESS_TOKEN: 'APP_USR-token-de-prueba', MP_WEBHOOK_SECRET: SECRET, MP_API: `http://127.0.0.1:${mp.port}`,
      SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.port), SMTP_SECURE: 'none', SMTP_FROM: 'Z-Score Lite <licencias@ejemplo.com>',
    },
  });
  await new Promise((resolve, reject) => {
    server.stdout.on('data', (d) => { if (String(d).includes('escuchando')) resolve(); });
    server.on('exit', () => reject(new Error('el servicio no arrancó')));
  });
});

test.after(() => {
  server.kill();
  mp.close();
  smtp.close();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

// ---- ayudas ----
async function api(method, route, { body, cookie, csrf, headers = {}, raw, redirect } = {}) {
  const res = await fetch(`${base}${route}`, {
    method,
    redirect,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { 'X-CSRF': csrf } : {}), ...headers },
    body: raw !== undefined ? raw : (body !== undefined ? JSON.stringify(body) : undefined),
  });
  const text = Buffer.from(await res.arrayBuffer());
  let data = text.toString('utf8');
  try { data = JSON.parse(data); } catch (e) { /* texto */ }
  return { status: res.status, data, headers: res.headers, bytes: text };
}

async function adminSession() {
  const res = await fetch(`${base}/api/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user: 'admin', password: PASSWORD }) });
  const data = await res.json();
  const cookie = (res.headers.get('set-cookie') || '').split(';')[0];
  const call = (method, route, body) => api(method, route, { body, cookie, csrf: data.csrf });
  return { call, cookie, csrf: data.csrf };
}

function webhook(dataId, requestId = 'req-1') {
  const ts = String(Date.now());
  const v1 = crypto.createHmac('sha256', SECRET).update(`id:${dataId};request-id:${requestId};ts:${ts};`).digest('hex');
  return api('POST', `/api/license/pago?data.id=${dataId}&type=payment`, {
    body: { action: 'payment.updated', type: 'payment', data: { id: String(dataId) } },
    headers: { 'x-request-id': requestId, 'x-signature': `ts=${ts},v1=${v1}` },
  });
}

let nextPaymentId = 9000;
const SALE_PREFIX = /^NEW:30:[0-9a-f]{10}$/;
/** Referencia del link de compra vigente de $15.000 (el que usa un cliente real). */
const lastSaleRef = () => mp.state.prefs.find((p) => /^NEW:/.test(p.external_reference) && p.items[0].unit_price === 15000).external_reference;

function fakePayment(over = {}) {
  const id = nextPaymentId++;
  mp.state.payments[id] = {
    id, status: 'approved', external_reference: lastSaleRef(), transaction_amount: 15000, currency_id: 'ARS',
    payer: { email: 'cliente@ejemplo.com', first_name: 'Ana', last_name: 'Pérez' }, ...over,
  };
  return id;
}

const mailsTo = (to) => smtp.inbox.filter((m) => m.to.includes(to));
const licenses = () => Object.values(lib.readDb().licenses);
const days = (ms) => Math.round(ms / 86400000);

// ---- pruebas ----
test('compra sin precio cargado: página de aviso y nada se crea en Mercado Pago', async () => {
  const r = await api('GET', '/api/license/comprar', { redirect: 'manual' });
  assert.equal(r.status, 503);
  assert.match(String(r.data), /todavía no está disponible/);
  assert.match(String(r.data), /licencias@ejemplo\.com/, 'ofrece el contacto del remitente');
  assert.equal(mp.state.prefs.length, 0);
});

test('email de prueba sin "email de avisos" cargado: pide cargarlo', async () => {
  const a = await adminSession();
  const r = await a.call('POST', '/api/admin/mail/prueba', {});
  assert.equal(r.status, 400);
  assert.match(r.data.error, /email para avisos/);
});

test('ajustes de venta: se validan, se guardan y requieren sesión', async () => {
  const a = await adminSession();
  assert.equal((await api('POST', '/api/admin/config', { body: { amount: 1 } })).status, 401);
  for (const bad of [{ amount: -5 }, { amount: 15000, currency: 'pesos' }, { amount: 15000, days: 0 }, { amount: 15000, days: 1.5 }, { amount: 15000, adminEmail: 'no-es-mail' }, { amount: 15000, remindDays: 99 }]) {
    assert.equal((await a.call('POST', '/api/admin/config', bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal(lib.readDb().config.sale, undefined, 'los intentos inválidos no guardaron nada');

  const ok = await a.call('POST', '/api/admin/config', { amount: 15000, currency: 'ars', days: 30, adminEmail: 'dueno@ejemplo.com', remindDays: 5 });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.data.config.sale, { amount: 15000, currency: 'ARS', days: 30 });
  assert.equal(ok.data.config.adminEmail, 'dueno@ejemplo.com');
  assert.equal(ok.data.mailConfigured, true);
  assert.equal(ok.data.saleUrl, `${PUBLIC}/api/license/comprar`);
});

test('email de prueba: llega al correo de avisos', async () => {
  const a = await adminSession();
  const r = await a.call('POST', '/api/admin/mail/prueba', {});
  assert.equal(r.status, 200);
  const m = await waitFor(() => mailsTo('dueno@ejemplo.com').find((x) => /Prueba de email/.test(x.subject)), 5000, 'email de prueba');
  assert.match(m.text, /funciona/);
});

test('se publica un APK de prueba (para que los emails lleven link de descarga)', async () => {
  const a = await adminSession();
  const apk = Buffer.concat([Buffer.from('PK\x03\x04'), crypto.randomBytes(3000)]);
  const r = await api('PUT', '/api/admin/apk?nombre=1.5&codigo=6', { cookie: a.cookie, csrf: a.csrf, raw: apk, headers: { 'Content-Type': 'application/octet-stream' } });
  assert.equal(r.status, 200);
  test.apkBytes = apk;
});

test('"Comprar": redirige a Mercado Pago con el precio cargado y reutiliza el link', async () => {
  const r = await api('GET', '/api/license/comprar', { redirect: 'manual' });
  assert.equal(r.status, 302);
  assert.match(r.headers.get('location'), /^https:\/\/mp\.example\/checkout\?pref=/);
  assert.equal(mp.state.prefs.length, 1);
  const pref = mp.state.prefs[0];
  assert.match(pref.external_reference, SALE_PREFIX);
  assert.equal(pref.items[0].unit_price, 15000);
  assert.equal(pref.items[0].currency_id, 'ARS');
  assert.equal(pref.notification_url, `${PUBLIC}/api/license/pago`);
  assert.equal(pref.back_urls.success, `${PUBLIC}/api/license/gracias`);

  const again = await api('GET', '/api/license/comprar', { redirect: 'manual' });
  assert.equal(again.headers.get('location'), r.headers.get('location'));
  assert.equal(mp.state.prefs.length, 1, 'no se crea un link por cada visita');

  const a = await adminSession();
  await a.call('POST', '/api/admin/config', { amount: 18000 });
  const repriced = await api('GET', '/api/license/comprar', { redirect: 'manual' });
  assert.notEqual(repriced.headers.get('location'), r.headers.get('location'));
  assert.equal(mp.state.prefs.at(-1).items[0].unit_price, 18000, 'con otro precio se crea un link nuevo');
  await a.call('POST', '/api/admin/config', { amount: 15000 });
  const back = await api('GET', '/api/license/comprar', { redirect: 'manual' });
  assert.equal(back.headers.get('location'), r.headers.get('location'), 'al volver al precio de antes se reutiliza el link que seguía vigente');
  assert.equal(mp.state.prefs.length, 2);
});

test('pago aprobado de una compra: crea la licencia paga y manda los emails', async () => {
  const before = licenses().length;
  const id = fakePayment();
  assert.equal((await webhook(id)).status, 200);

  const lic = licenses().find((l) => l.email === 'cliente@ejemplo.com');
  assert.ok(lic, 'se creó la licencia');
  assert.equal(licenses().length, before + 1);
  assert.equal(lic.type, 'paga');
  assert.equal(lic.customer, 'Ana Pérez');
  assert.equal(lic.price, 15000);
  assert.equal(lic.currency, 'ARS');
  assert.equal(lic.note, 'Compra online (Mercado Pago)');
  assert.equal(days(lic.paidUntil - Date.now()), 30);
  assert.deepEqual(lic.devices, []);
  assert.ok(lic.events.some((e) => e.type === 'pago' && e.actor === 'mp'));

  // Email al cliente
  const welcome = await waitFor(() => mailsTo('cliente@ejemplo.com').find((m) => /está lista/.test(m.subject)), 8000, 'email de bienvenida');
  assert.match(welcome.text, new RegExp(lic.code));
  assert.match(welcome.text, /Hola Ana Pérez,/);
  assert.match(welcome.text, /Vence el \d{2}\/\d{2}\/\d{4}/);
  assert.match(welcome.text, new RegExp(`Mercado Pago #${id}`));
  assert.match(welcome.text, /15\.000 ARS/);
  assert.match(welcome.text, new RegExp(`${PUBLIC}/app/`));
  assert.match(welcome.text, /Activar/);
  const link = /(https:\/\/lite\.test\/api\/license\/descargar\?t=[\w-]+)/.exec(welcome.text);
  assert.ok(link, 'lleva el link personal de descarga');

  // El email también va en HTML, con el botón a la página de descarga y el código
  const pageLink = /(https:\/\/lite\.test\/api\/license\/app\?t=[\w-]+)/.exec(welcome.text);
  assert.ok(pageLink, 'el texto lleva la página de descarga');
  assert.ok(welcome.html.includes('Descargar la app') && welcome.html.includes(pageLink[1]), 'el HTML tiene el botón a la página de descarga');
  assert.ok(welcome.html.includes(lic.code) && welcome.html.includes('Ana Pérez'), 'el HTML lleva el código y el nombre');
  assert.ok(welcome.html.includes(link[1]), 'el HTML también lleva el link directo como plan B');

  // La página de descarga muestra el código y mirarla (varias veces) no gasta usos del link
  const usesBefore = Object.values(lib.readDb().links).find((l) => l.code === lic.code).uses;
  for (let i = 0; i < 3; i++) {
    const pg = await api('GET', pageLink[1].replace(PUBLIC, ''));
    assert.equal(pg.status, 200);
    assert.match(pg.headers.get('content-type'), /text\/html/);
    assert.ok(pg.data.includes(lic.code) && pg.data.includes('/api/license/descargar?t='), 'muestra el código y el botón de descarga');
    assert.ok(pg.data.includes('intent://') && pg.data.includes('com.android.chrome'), 'tiene el botón para abrir en Chrome');
  }
  assert.equal(Object.values(lib.readDb().links).find((l) => l.code === lic.code).uses, usesBefore, 'mirar la página no gasta usos');
  assert.equal((await api('GET', '/api/license/app?t=inventado')).status, 403, 'un link inventado no muestra nada');
  assert.equal((await api('GET', '/api/license/app')).status, 403);
  const logo = await api('GET', '/api/license/logo.png');
  assert.equal(logo.status, 200);
  assert.equal(logo.headers.get('content-type'), 'image/png');
  assert.ok(welcome.html.includes('/api/license/logo.png'), 'el email lleva el logo');

  // El link funciona y baja el APK
  const dl = await api('GET', link[1].replace(PUBLIC, ''));
  assert.equal(dl.status, 200);
  assert.deepEqual(dl.bytes, test.apkBytes);

  // Aviso al dueño
  const sale = await waitFor(() => mailsTo('dueno@ejemplo.com').find((m) => /Nueva venta/.test(m.subject)), 8000, 'aviso de venta');
  assert.match(sale.text, new RegExp(lic.code));
  assert.match(sale.text, /Ana Pérez/);
  assert.match(sale.text, /cliente@ejemplo\.com/);
  assert.match(sale.text, /15\.000 ARS/);

  // Lo que ve el panel
  const a = await adminSession();
  const row = await waitFor(async () => {
    const r = (await a.call('GET', '/api/admin/pagos')).data.rows.find((x) => x.id === String(id));
    return r && r.mail === 'enviado' ? r : null;
  }, 5000, 'fila de pago con email enviado');
  assert.equal(row.kind, 'new');
  assert.equal(row.code, lic.code);
  assert.equal(row.customer, 'Ana Pérez');
  assert.equal(row.email, 'cliente@ejemplo.com');
  assert.equal(row.amount, 15000);
  assert.equal(row.days, 30);
  assert.equal(row.paidUntil, lic.paidUntil);
  assert.equal(row.licState, 'activa');
  const month = (await a.call('GET', '/api/admin/pagos')).data.month.find((m) => m.currency === 'ARS');
  assert.ok(month.total >= 15000);
  const detail = await a.call('GET', `/api/admin/licenses/${lic.code}`);
  assert.ok(detail.data.events.some((e) => e.type === 'email' && /instrucciones enviado a cliente@ejemplo\.com/.test(e.detail)));
  test.firstCode = lic.code;
  test.firstPayment = id;
});

test('el mismo aviso repetido no crea otra licencia ni manda otro email', async () => {
  const count = licenses().length;
  const mails = smtp.inbox.length;
  assert.equal((await webhook(test.firstPayment, 'req-2')).status, 200);
  assert.equal((await webhook(test.firstPayment, 'req-3')).status, 200);
  await new Promise((r) => setTimeout(r, 900));
  assert.equal(licenses().length, count);
  assert.equal(smtp.inbox.length, mails);
});

test('monto menor, moneda distinta o referencia inventada: no se crea ninguna licencia', async () => {
  const count = licenses().length;
  const cheap = fakePayment({ transaction_amount: 100 });
  const usd = fakePayment({ currency_id: 'USD' });
  const forged = fakePayment({ external_reference: 'NEW:30:aaaaaaaaaa' });
  const days365 = fakePayment({ external_reference: lastSaleRef().replace(':30:', ':365:') });
  const garbage = fakePayment({ external_reference: 'cualquier-cosa' });
  for (const id of [cheap, usd, forged, days365, garbage]) assert.equal((await webhook(id, `req-${id}`)).status, 200);
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(licenses().length, count);
  const a = await adminSession();
  const pagos = (await a.call('GET', '/api/admin/pagos')).data;
  assert.ok(pagos.review.some((p) => p.id === String(cheap) && p.status === 'monto_incorrecto'));
  assert.ok(pagos.review.some((p) => p.id === String(usd)));
  assert.ok(!pagos.rows.some((p) => p.id === String(forged)), 'una referencia que no es nuestra no se registra');
});

test('pagador sin email: la licencia se crea, queda marcado y se puede mandar a mano después', async () => {
  const id = fakePayment({ payer: { first_name: 'Beto' } });
  await webhook(id, 'req-noemail');
  const lic = licenses().find((l) => l.customer === 'Beto');
  assert.ok(lic);
  assert.equal(lic.email, '');
  assert.match(lic.events.find((e) => e.type === 'pago').detail, /no dejó email/);

  const a = await adminSession();
  const row = await waitFor(async () => (await a.call('GET', '/api/admin/pagos')).data.rows.find((r) => r.id === String(id) && r.mail === 'sin_email'), 5000, 'estado sin_email');
  assert.equal(row.email, '');

  assert.equal((await a.call('POST', `/api/admin/licenses/${lic.code}/email`, {})).status, 400, 'sin email no se puede mandar');
  assert.equal((await a.call('POST', `/api/admin/licenses/${lic.code}/editar`, { email: 'beto@ejemplo.com' })).status, 200);
  assert.equal((await a.call('POST', `/api/admin/licenses/${lic.code}/editar`, { email: 'esto no es un mail' })).status, 400);
  const sent = await a.call('POST', `/api/admin/licenses/${lic.code}/email`, {});
  assert.equal(sent.status, 200);
  assert.equal(sent.data.to, 'beto@ejemplo.com');
  const m = await waitFor(() => mailsTo('beto@ejemplo.com')[0], 5000, 'email manual');
  assert.match(m.text, new RegExp(lic.code));
  assert.match(m.subject, /Los datos de tu licencia/);
  assert.ok(sent.data.license.events.some((e) => e.type === 'email' && e.actor === 'panel'));
});

test('servidor de correo caído al pagar: la licencia se crea igual y el email sale solo al volver', async () => {
  smtp.state.down = true;
  const id = fakePayment({ payer: { email: 'lenta@ejemplo.com', first_name: 'Lena' } });
  await webhook(id, 'req-down');
  const lic = licenses().find((l) => l.email === 'lenta@ejemplo.com');
  assert.ok(lic, 'la licencia se creó aunque el correo esté caído');

  await waitFor(() => lib.readDb().payments[id].mail.status === 'error', 8000, 'estado error');
  assert.ok(lib.readDb().payments[id].mail.lastError);
  assert.equal(mailsTo('lenta@ejemplo.com').length, 0);

  smtp.state.down = false;
  await waitFor(() => lib.readDb().payments[id].mail.status === 'enviado', 8000, 'reintento exitoso');
  assert.ok(lib.readDb().payments[id].mail.tries >= 2);
  const m = await waitFor(() => mailsTo('lenta@ejemplo.com')[0], 5000, 'email reenviado');
  assert.match(m.text, new RegExp(lic.code));
  assert.equal(mailsTo('lenta@ejemplo.com').length, 1, 'se manda una sola vez');
});

test('renovación de una licencia que ya existe: se extiende y llega el recibo', async () => {
  const a = await adminSession();
  const code = test.firstCode;
  const before = lib.readDb().licenses[code].paidUntil;
  const link = await a.call('POST', `/api/admin/licenses/${code}/pago`, { days: 30 });
  assert.equal(link.status, 200);
  const ref = mp.state.prefs.at(-1).external_reference;
  assert.match(ref, new RegExp(`^${code}:30:[0-9a-f]{10}$`));
  const id = fakePayment({ external_reference: ref });
  await webhook(id, 'req-renew');
  assert.equal(lib.readDb().licenses[code].paidUntil, before + 30 * 86400000);
  assert.equal(licenses().filter((l) => l.email === 'cliente@ejemplo.com').length, 1, 'no se creó otra licencia');
  const receipt = await waitFor(() => mailsTo('cliente@ejemplo.com').find((m) => /Recibimos tu pago/.test(m.subject)), 8000, 'recibo');
  assert.match(receipt.text, new RegExp(code));
  assert.match(receipt.text, /ahora vence el \d{2}\/\d{2}\/\d{4}/);
  const row = (await a.call('GET', '/api/admin/pagos')).data.rows.find((r) => r.id === String(id));
  assert.equal(row.kind, 'renewal');
});

test('aviso de vencimiento: llega una sola vez, con link de pago, y solo a quien corresponde', async () => {
  const a = await adminSession();
  const mk = async (body) => (await a.call('POST', '/api/admin/licenses', body)).data;
  const due = await mk({ type: 'paga', days: 3, email: 'vence@ejemplo.com', customer: 'Vero', price: 9000 });
  const noEmail = await mk({ type: 'paga', days: 3, price: 9000 });
  const far = await mk({ type: 'paga', days: 20, email: 'lejos@ejemplo.com', price: 9000 });
  const trial = await mk({ type: 'prueba', days: 2, email: 'prueba@ejemplo.com' });

  const m = await waitFor(() => mailsTo('vence@ejemplo.com')[0], 8000, 'aviso de vencimiento');
  assert.match(m.subject, /vence el \d{2}\/\d{2}\/\d{4}/);
  assert.match(m.text, /Hola Vero,/);
  assert.match(m.text, new RegExp(due.code));
  assert.match(m.text, /9\.000 ARS por 30 días/);
  assert.match(m.text, /https:\/\/mp\.example\/checkout\?pref=/);
  assert.match(mp.state.prefs.at(-1).external_reference, new RegExp(`^${due.code}:30:`));

  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(mailsTo('vence@ejemplo.com').length, 1, 'no se repite');
  assert.equal(mailsTo('lejos@ejemplo.com').length, 0, 'lejos de vencer: nada');
  assert.equal(mailsTo('prueba@ejemplo.com').length, 0, 'las pruebas no reciben aviso de renovación');
  assert.equal(lib.readDb().licenses[noEmail.code].reminderFor, undefined);
  assert.equal(lib.readDb().licenses[due.code].reminderFor, lib.readDb().licenses[due.code].paidUntil);
  assert.ok(lib.readDb().licenses[due.code].events.some((e) => e.type === 'email' && /aviso de vencimiento/.test(e.detail)));
  assert.ok(far.code && trial.code);
});

test('con los avisos apagados (0 días) no se manda ninguno', async () => {
  const a = await adminSession();
  await a.call('POST', '/api/admin/config', { remindDays: 0 });
  const lic = (await a.call('POST', '/api/admin/licenses', { type: 'paga', days: 2, email: 'apagado@ejemplo.com', price: 100 })).data;
  await new Promise((r) => setTimeout(r, 1200));
  assert.equal(mailsTo('apagado@ejemplo.com').length, 0);
  assert.equal(lib.readDb().licenses[lic.code].reminderFor, undefined);
  await a.call('POST', '/api/admin/config', { remindDays: 5 });
});

test('página de gracias según el estado del pago', async () => {
  const ok = await api('GET', '/api/license/gracias');
  assert.equal(ok.status, 200);
  assert.match(String(ok.data), /Gracias por tu compra/);
  assert.match(String(ok.data), /email/);
  assert.match(String((await api('GET', '/api/license/gracias?estado=pendiente')).data), /pendiente/);
  assert.match(String((await api('GET', '/api/license/gracias?estado=fallo')).data), /No se te cobró nada/);
});

test('"Comprar" tiene tope por conexión (para que nadie llene Mercado Pago de links)', async () => {
  const statuses = [];
  for (let i = 0; i < 40; i++) statuses.push((await api('GET', '/api/license/comprar', { redirect: 'manual', headers: { 'X-Real-IP': '10.5.5.5' } })).status);
  assert.equal(statuses[0], 302);
  assert.equal(statuses.at(-1), 429);
  assert.equal(statuses.filter((s) => s === 302).length, 30);
});
