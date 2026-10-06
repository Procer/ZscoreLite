// Pruebas del cobro con Mercado Pago contra un Mercado Pago simulado. node --test server/test/
// El simulado atiende /checkout/preferences y /v1/payments/:id; los avisos se firman como los firma Mercado Pago.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');

const SERVER_DIR = path.join(__dirname, '..');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'zslite-pay-'));
const KEY_FILE = path.join(DATA_DIR, 'license-private.pem');
fs.writeFileSync(KEY_FILE, crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' }));

process.env.DATA_DIR = DATA_DIR;
process.env.PRIVATE_KEY_FILE = KEY_FILE;
const { freePort } = require('./helpers.cjs');
const lib = require('../license-lib.cjs');
const ops = require('../license-ops.cjs');
const panel = require('../license-panel.cjs');

const SECRET = 'secreto-de-webhook-de-prueba';
const TOKEN = 'APP_USR-token-de-prueba';
const PASSWORD = 'una-clave-bien-larga-123';

// ---- Mercado Pago simulado ----
const mpState = { payments: {}, prefs: [], down: false, auth: [] };
let mpServer;
let mpPort;

function startMp() {
  mpServer = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      mpState.auth.push(req.headers.authorization);
      const out = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (mpState.down) return out(500, { message: 'caído' });
      if (req.method === 'POST' && req.url === '/checkout/preferences') {
        const body = JSON.parse(raw);
        mpState.prefs.push(body);
        return out(201, { id: `pref-${mpState.prefs.length}`, init_point: `https://mp.example/checkout?pref=pref-${mpState.prefs.length}` });
      }
      const m = /^\/v1\/payments\/(\d+)$/.exec(req.url);
      if (req.method === 'GET' && m) return mpState.payments[m[1]] ? out(200, mpState.payments[m[1]]) : out(404, { message: 'no existe' });
      return out(404, {});
    });
  });
  return new Promise((resolve) => mpServer.listen(0, '127.0.0.1', () => { mpPort = mpServer.address().port; resolve(); }));
}

// ---- Servicio de licencias ----
let server;
let base;
const bareEnv = { ...process.env, PORT: '0', PANEL_DEV: '1' };

async function startServer(extraEnv) {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(SERVER_DIR, 'license-server.cjs')], { env: { ...bareEnv, PORT: String(port), ...extraEnv } });
  return new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => { if (String(d).includes('escuchando')) resolve({ child, base: `http://127.0.0.1:${port}` }); });
    child.on('exit', () => reject(new Error('el servicio no arrancó')));
  });
}

test.before(async () => {
  await startMp();
  await panel.setPassword('admin', PASSWORD);
  ({ child: server, base } = await startServer({
    MP_ACCESS_TOKEN: TOKEN, MP_WEBHOOK_SECRET: SECRET, MP_API: `http://127.0.0.1:${mpPort}`, PUBLIC_URL: 'https://lite.test',
  }));
});

test.after(() => {
  server.kill();
  mpServer.close();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

async function call(method, route, { body, cookie, csrf, headers = {}, raw } = {}) {
  const res = await fetch(`${base}${route}`, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { 'X-CSRF': csrf } : {}), ...headers },
    body: raw !== undefined ? raw : (body !== undefined ? JSON.stringify(body) : undefined),
  });
  const text = await res.text();
  let data = text;
  try { data = JSON.parse(text); } catch (e) { /* texto */ }
  return { status: res.status, data };
}

async function login() {
  const res = await fetch(`${base}/api/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user: 'admin', password: PASSWORD }) });
  const data = await res.json();
  return { cookie: (res.headers.get('set-cookie') || '').split(';')[0], csrf: data.csrf };
}

/** Manda un aviso de pago firmado como lo hace Mercado Pago. */
function webhook(dataId, { secret = SECRET, requestId = 'req-1', tamper = false, type = 'payment', sign = true } = {}) {
  const ts = String(Date.now());
  const manifest = `id:${String(dataId).toLowerCase()};request-id:${requestId};ts:${ts};`;
  let v1 = crypto.createHmac('sha256', secret).update(manifest).digest('hex');
  if (tamper) v1 = v1.replace(/.$/, v1.endsWith('0') ? '1' : '0');
  return call('POST', `/api/license/pago?data.id=${dataId}&type=${type}`, {
    body: { action: 'payment.updated', type, data: { id: String(dataId) } },
    headers: { 'x-request-id': requestId, ...(sign ? { 'x-signature': `ts=${ts},v1=${v1}` } : {}) },
  });
}

let nextPaymentId = 5000;
function fakePayment(link, over = {}) {
  const id = nextPaymentId++;
  mpState.payments[id] = {
    id, status: 'approved', external_reference: link.externalReference, transaction_amount: link.amount, currency_id: link.currency, ...over,
  };
  return id;
}

/** Crea una licencia y su link de pago por el panel; devuelve lo que MP vio. */
async function newLink(licOpts = { type: 'prueba', price: 15000, currency: 'ARS', customer: 'Club Pago' }, payOpts = {}) {
  const s = await login();
  const lic = await call('POST', '/api/admin/licenses', { cookie: s.cookie, csrf: s.csrf, body: licOpts });
  const r = await call('POST', `/api/admin/licenses/${lic.data.code}/pago`, { cookie: s.cookie, csrf: s.csrf, body: payOpts });
  const pref = mpState.prefs[mpState.prefs.length - 1];
  return { s, code: lic.data.code, r, pref, externalReference: pref && pref.external_reference, amount: pref && pref.items[0].unit_price, currency: pref && pref.items[0].currency_id };
}

test('link de pago: crea la preferencia con monto, moneda y referencia propios', async () => {
  const { r, pref, code, s } = await newLink({ type: 'prueba', price: 15000, currency: 'ars', customer: 'Club Pago' }, { days: 30 });
  assert.equal(r.status, 200);
  assert.match(r.data.url, /^https:\/\/mp\.example\/checkout\?pref=/);
  assert.equal(r.data.amount, 15000);
  assert.equal(pref.items[0].unit_price, 15000);
  assert.equal(pref.items[0].currency_id, 'ARS');
  assert.equal(pref.notification_url, 'https://lite.test/api/license/pago');
  assert.match(pref.external_reference, new RegExp(`^${code}:30:[0-9a-f]{10}$`));
  assert.equal(mpState.auth.at(-1), `Bearer ${TOKEN}`);
  const refKey = pref.external_reference.split(':')[2];
  assert.equal(lib.readDb().payLinks[refKey].amount, 15000);
  const detail = await call('GET', `/api/admin/licenses/${code}`, { cookie: s.cookie });
  assert.equal(detail.data.events[0].type, 'link_pago');
  assert.ok(!JSON.stringify(detail.data).includes(TOKEN));
});

test('link de pago: valida monto, días, estado y que haya cobro configurado', async () => {
  const s = await login();
  const mk = async (opts) => (await call('POST', '/api/admin/licenses', { cookie: s.cookie, csrf: s.csrf, body: opts })).data.code;
  const pay = (code, body) => call('POST', `/api/admin/licenses/${code}/pago`, { cookie: s.cookie, csrf: s.csrf, body });

  const sinPrecio = await mk({ type: 'paga' });
  assert.equal((await pay(sinPrecio, {})).status, 400, 'sin precio ni monto');
  assert.equal((await pay(sinPrecio, { amount: 9000 })).status, 200, 'el monto puede venir del formulario');
  assert.equal((await pay(sinPrecio, { amount: -5 })).status, 400);
  assert.equal((await pay(sinPrecio, { amount: 100, days: 0 })).status, 400);
  assert.equal((await pay(sinPrecio, { amount: 100, days: 1.5 })).status, 400);
  const cort = await mk({ type: 'cortesia' });
  assert.match((await pay(cort, { amount: 100 })).data.error, /cortesías no se cobran/);
  const rev = await mk({ type: 'paga', price: 100 });
  await call('POST', `/api/admin/licenses/${rev}/revocar`, { cookie: s.cookie, csrf: s.csrf, body: {} });
  assert.match((await pay(rev, {})).data.error, /revocada/);
  assert.equal((await pay('ZSL-NOPE-NOPE', { amount: 100 })).status, 400);
  assert.equal((await call('POST', `/api/admin/licenses/${sinPrecio}/pago`, { body: { amount: 1 } })).status, 401, 'sin sesión');

  mpState.down = true;
  const caido = await pay(sinPrecio, { amount: 100 });
  mpState.down = false;
  assert.equal(caido.status, 502);
  assert.equal(Object.values(lib.readDb().payLinks).filter((l) => l.code === sinPrecio).length, 1, 'un link que no se pudo crear no se guarda');
});

test('pago aprobado: suma los días, pasa la prueba a paga y queda en el historial', async () => {
  const l = await newLink();
  const before = lib.readDb().licenses[l.code];
  assert.equal(before.type, 'prueba');
  const id = fakePayment(l);
  const r = await webhook(id);
  assert.equal(r.status, 200);
  const lic = lib.readDb().licenses[l.code];
  assert.equal(lic.type, 'paga');
  assert.ok(Math.abs((lic.paidUntil - before.paidUntil) - 0) >= 0);
  assert.ok(lic.paidUntil >= Date.now() + 29 * lib.DAY);
  const ev = lic.events.find((e) => e.type === 'pago');
  assert.equal(ev.actor, 'mp');
  assert.match(ev.detail, new RegExp(`pago ${id}`));
  assert.equal(lib.readDb().payments[id].status, 'approved');
});

test('el mismo aviso repetido no suma dos veces', async () => {
  const l = await newLink();
  const id = fakePayment(l);
  await webhook(id);
  const once = lib.readDb().licenses[l.code].paidUntil;
  assert.equal((await webhook(id, { requestId: 'req-2' })).status, 200);
  assert.equal((await webhook(id, { requestId: 'req-3' })).status, 200);
  assert.equal(lib.readDb().licenses[l.code].paidUntil, once);
  assert.equal(lib.readDb().licenses[l.code].events.filter((e) => e.type === 'pago').length, 1);
});

test('un pago sobre una licencia vigente suma al vencimiento actual', async () => {
  const l = await newLink({ type: 'paga', price: 100, currency: 'ARS' }, { days: 10 });
  const before = lib.readDb().licenses[l.code].paidUntil;
  await webhook(fakePayment(l));
  assert.equal(lib.readDb().licenses[l.code].paidUntil, before + 10 * lib.DAY);
});

test('firma inválida o ausente: 401 y no se consulta ni cambia nada', async () => {
  const l = await newLink();
  const id = fakePayment(l);
  const consultasAntes = mpState.auth.length;
  assert.equal((await webhook(id, { tamper: true })).status, 401);
  assert.equal((await webhook(id, { secret: 'otro-secreto' })).status, 401);
  assert.equal((await webhook(id, { sign: false })).status, 401);
  assert.equal(mpState.auth.length, consultasAntes, 'ni siquiera se le preguntó a Mercado Pago');
  assert.equal(lib.readDb().licenses[l.code].type, 'prueba');
  assert.equal(lib.readDb().payments[id], undefined);
});

test('monto o moneda distintos a los del link: no se suman días y queda para revisar', async () => {
  const l = await newLink({ type: 'paga', price: 15000, currency: 'ARS' });
  const before = lib.readDb().licenses[l.code].paidUntil;
  const barato = fakePayment(l, { transaction_amount: 1 });
  assert.equal((await webhook(barato)).status, 200);
  const otraMoneda = fakePayment(l, { currency_id: 'USD' });
  assert.equal((await webhook(otraMoneda)).status, 200);
  assert.equal(lib.readDb().licenses[l.code].paidUntil, before);
  assert.equal(lib.readDb().payments[barato].status, 'monto_incorrecto');
  const s = await login();
  const pagos = await call('GET', '/api/admin/pagos', { cookie: s.cookie });
  assert.ok(pagos.data.review.some((p) => p.id === String(barato)));
});

test('referencia falsa o ajena: se ignora', async () => {
  const l = await newLink();
  const forged = fakePayment(l, { external_reference: `${l.code}:30:aaaaaaaaaa` }); // ref que este servidor nunca generó
  const garbage = fakePayment(l, { external_reference: 'cualquier-cosa' });
  const days = fakePayment(l, { external_reference: l.externalReference.replace(':30:', ':365:') }); // cambia los días
  for (const id of [forged, garbage, days]) assert.equal((await webhook(id)).status, 200);
  assert.equal(lib.readDb().licenses[l.code].type, 'prueba');
  for (const id of [forged, garbage, days]) assert.equal(lib.readDb().payments[id], undefined);
});

test('pagos pendientes o rechazados no hacen nada; los de otro tema se ignoran', async () => {
  const l = await newLink();
  const pending = fakePayment(l, { status: 'pending' });
  const rejected = fakePayment(l, { status: 'rejected' });
  assert.equal((await webhook(pending)).status, 200);
  assert.equal((await webhook(rejected)).status, 200);
  assert.equal((await webhook(pending, { type: 'merchant_order' })).status, 200);
  assert.equal(lib.readDb().licenses[l.code].type, 'prueba');
  // Cuando el pendiente se aprueba, recién ahí se aplica.
  mpState.payments[pending].status = 'approved';
  await webhook(pending, { requestId: 'req-9' });
  assert.equal(lib.readDb().licenses[l.code].type, 'paga');
});

test('reintegro o contracargo: se anota para revisar y la licencia no se toca sola', async () => {
  const l = await newLink();
  const id = fakePayment(l);
  await webhook(id);
  const after = lib.readDb().licenses[l.code].paidUntil;
  mpState.payments[id].status = 'refunded';
  assert.equal((await webhook(id, { requestId: 'req-8' })).status, 200);
  assert.equal(lib.readDb().licenses[l.code].paidUntil, after);
  assert.equal(lib.readDb().payments[id].status, 'refunded');
  assert.ok(lib.readDb().licenses[l.code].events.some((e) => e.type === 'pago_revertido'));
  const s = await login();
  const pagos = await call('GET', '/api/admin/pagos', { cookie: s.cookie });
  assert.ok(pagos.data.review.some((p) => p.id === String(id) && p.status === 'refunded'));
});

test('pago de una licencia revocada: se registra, sigue revocada y avisa', async () => {
  const l = await newLink({ type: 'paga', price: 100, currency: 'ARS' });
  await call('POST', `/api/admin/licenses/${l.code}/revocar`, { cookie: l.s.cookie, csrf: l.s.csrf, body: {} });
  await webhook(fakePayment(l));
  const lic = lib.readDb().licenses[l.code];
  assert.equal(lic.revoked, true);
  assert.match(lic.events.find((e) => e.type === 'pago').detail, /REVOCADA/);
});

test('Mercado Pago caído al consultar el pago: 502 para que reintente; pago inexistente: 200', async () => {
  const l = await newLink();
  const id = fakePayment(l);
  mpState.down = true;
  const caido = await webhook(id);
  mpState.down = false;
  assert.equal(caido.status, 502);
  assert.equal(lib.readDb().payments[id], undefined);
  assert.equal((await webhook(id, { requestId: 'req-7' })).status, 200);
  assert.equal(lib.readDb().licenses[l.code].type, 'paga', 'al reintentar se aplica');
  assert.equal((await webhook(999999, { requestId: 'req-6' })).status, 200, 'no existe: no tiene sentido reintentar');
});

test('resumen del panel: total cobrado del mes por moneda', async () => {
  const s = await login();
  const pagos = await call('GET', '/api/admin/pagos', { cookie: s.cookie });
  assert.equal(pagos.data.configured, true);
  const ars = pagos.data.month.find((m) => m.currency === 'ARS');
  assert.ok(ars.count >= 3);
  const expected = Object.values(lib.readDb().payments).filter((p) => p.status === 'approved' && p.currency === 'ARS').reduce((a, p) => a + p.amount, 0);
  assert.equal(ars.total, expected);
  assert.equal((await call('GET', '/api/admin/pagos')).status, 401);
});

test('sin credenciales de Mercado Pago el cobro está apagado y no rompe nada', async () => {
  const { child, base: b } = await startServer({ MP_ACCESS_TOKEN: '', MP_WEBHOOK_SECRET: '' });
  try {
    const hook = await fetch(`${b}/api/license/pago?data.id=1&type=payment`, { method: 'POST', body: '{}' });
    assert.equal(hook.status, 503);
    const res = await fetch(`${b}/api/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user: 'admin', password: PASSWORD }) });
    const { csrf } = await res.json();
    const cookie = (res.headers.get('set-cookie') || '').split(';')[0];
    const lic = lib.update((db) => ops.crear(db, { type: 'paga', price: 100 }, 'cli'));
    const link = await fetch(`${b}/api/admin/licenses/${lic.code}/pago`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF': csrf, Cookie: cookie }, body: '{}',
    });
    assert.equal(link.status, 400);
    assert.match((await link.json()).error, /no está configurado/);
    const pagos = await (await fetch(`${b}/api/admin/pagos`, { headers: { Cookie: cookie } })).json();
    assert.equal(pagos.configured, false);
    const act = await fetch(`${b}/api/license/activar`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'ZSL-ZZZZ-ZZZZ', device: 'dispositivo-0000001' }) });
    assert.equal(act.status, 404);
  } finally { child.kill(); }
});
