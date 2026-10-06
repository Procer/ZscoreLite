// Pruebas del panel de administración (login, sesión, CSRF, límites y acciones). node --test server/test/

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
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'zslite-panel-'));
const KEY_FILE = path.join(DATA_DIR, 'license-private.pem');
fs.writeFileSync(KEY_FILE, crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' }));

process.env.DATA_DIR = DATA_DIR;
process.env.PRIVATE_KEY_FILE = KEY_FILE;
const { freePort } = require('./helpers.cjs');
const lib = require('../license-lib.cjs');
const panel = require('../license-panel.cjs');

const PASSWORD = 'una-clave-bien-larga-123';
let port;
let base;
let server;

test.before(async () => {
  port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [path.join(SERVER_DIR, 'license-server.cjs')], {
    env: { ...process.env, PORT: String(port), PANEL_DEV: '1', PANEL_IDLE_MS: '1500' },
  });
  await new Promise((resolve, reject) => {
    server.stdout.on('data', (d) => { if (String(d).includes('escuchando')) resolve(); });
    server.on('exit', () => reject(new Error('el servicio no arrancó')));
  });
});

test.after(() => {
  server.kill();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

async function call(method, route, { body, cookie, csrf, origin, raw, headers = {} } = {}) {
  const res = await fetch(`${base}${route}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { 'X-CSRF': csrf } : {}), ...(origin ? { Origin: origin } : {}), ...headers,
    },
    body: raw !== undefined ? raw : (body !== undefined ? JSON.stringify(body) : undefined),
  });
  let data = null;
  const text = await res.text();
  try { data = JSON.parse(text); } catch (e) { data = text; }
  return { status: res.status, data, headers: res.headers };
}

async function login(password = PASSWORD) {
  const r = await call('POST', '/api/admin/login', { body: { user: 'admin', password } });
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
  return { ...r, cookie, csrf: r.data && r.data.csrf };
}

test('sin contraseña creada, el ingreso no es posible', async () => {
  const r = await call('POST', '/api/admin/login', { body: { user: 'admin', password: 'lo-que-sea-123456' } });
  assert.equal(r.status, 503);
  assert.equal(r.data.error, 'sin_clave');
  const s = await call('GET', '/api/admin/session');
  assert.equal(s.data.configured, false);
});

test('la contraseña se valida: corta se rechaza y queda hasheada', async () => {
  await assert.rejects(() => panel.setPassword('admin', 'corta'), /al menos 12/);
  await assert.rejects(() => panel.setPassword('a b', PASSWORD), /usuario/);
  await panel.setPassword('admin', PASSWORD);
  const saved = fs.readFileSync(path.join(DATA_DIR, 'admin.json'), 'utf8');
  assert.ok(!saved.includes(PASSWORD), 'no se guarda en claro');
  assert.equal(JSON.parse(saved).user, 'admin');
});

test('rutas de la API sin sesión: 401', async () => {
  for (const [m, route] of [['GET', '/api/admin/licenses'], ['POST', '/api/admin/licenses'], ['GET', '/api/admin/apk'], ['POST', '/api/admin/licenses/ZSL-AAAA-BBBB/revocar']]) {
    const r = await call(m, route, { body: m === 'POST' ? {} : undefined });
    assert.equal(r.status, 401, `${m} ${route}`);
  }
});

test('ingreso: la cookie sale endurecida y la página lleva CSP', async () => {
  const r = await login();
  assert.equal(r.status, 200);
  assert.ok(r.csrf && r.cookie.startsWith('zs_admin='));
  const raw = r.headers.get('set-cookie');
  assert.match(raw, /HttpOnly/);
  assert.match(raw, /SameSite=Strict/);

  const page = await call('GET', '/admin');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.match(page.headers.get('content-security-policy'), /default-src 'none'; script-src 'self'/);
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  assert.equal((await call('GET', '/admin/admin.js')).status, 200);
  assert.equal((await call('GET', '/admin/admin.css')).status, 200);
  assert.equal((await call('GET', '/admin/../license-lib.cjs')).status, 404);
  assert.equal((await call('GET', '/admin/otra.js')).status, 404);
  assert.equal((await call('POST', '/admin', { body: {} })).status, 405);
});

test('el panel no filtra el código del servidor por ninguna ruta', async () => {
  for (const route of ['/license-lib.cjs', '/admin/license-lib.cjs', '/admin/..%2Flicense-lib.cjs', '/admin/%2e%2e/license-private.pem', '/admin/panel/admin.js']) {
    const r = await call('GET', route);
    assert.notEqual(r.status, 200, route);
    assert.ok(!String(r.data).includes('BEGIN PRIVATE KEY'));
  }
});

test('cambios: sin CSRF o con otro origen se rechazan', async () => {
  const s = await login();
  const noCsrf = await call('POST', '/api/admin/licenses', { body: { type: 'cortesia' }, cookie: s.cookie });
  assert.equal(noCsrf.status, 403);
  assert.equal(noCsrf.data.error, 'csrf');
  const badCsrf = await call('POST', '/api/admin/licenses', { body: { type: 'cortesia' }, cookie: s.cookie, csrf: 'x'.repeat(s.csrf.length) });
  assert.equal(badCsrf.status, 403);
  const foreign = await call('POST', '/api/admin/licenses', { body: { type: 'cortesia' }, cookie: s.cookie, csrf: s.csrf, origin: 'https://malo.example' });
  assert.equal(foreign.status, 403);
  assert.equal(foreign.data.error, 'origen');
  assert.equal(Object.keys(lib.readDb().licenses).length, 0, 'ninguno de los intentos creó nada');
  const ok = await call('POST', '/api/admin/licenses', { body: { type: 'cortesia' }, cookie: s.cookie, csrf: s.csrf, origin: base });
  assert.equal(ok.status, 201);
});

test('ciclo completo de una licencia desde el panel', async () => {
  const s = await login();
  const opts = { cookie: s.cookie, csrf: s.csrf };
  const created = await call('POST', '/api/admin/licenses', { ...opts, body: { type: 'prueba', customer: 'Club Oeste', contact: '11-1111', price: 8000, currency: 'ars', maxDevices: 2 } });
  assert.equal(created.status, 201);
  const code = created.data.code;
  assert.equal(created.data.customer, 'Club Oeste');
  assert.equal(created.data.maxDevices, 2);
  assert.equal(created.data.events[0].actor, 'panel');

  const list = await call('GET', '/api/admin/licenses', { cookie: s.cookie });
  assert.ok(list.data.licenses.some((l) => l.code === code));
  assert.equal(list.data.apk.published, false);
  assert.ok(!('events' in list.data.licenses[0]), 'la lista no trae el historial');

  assert.equal((await call('POST', `/api/admin/licenses/${code}/extender`, { ...opts, body: { days: 10 } })).status, 200);
  const conv = await call('POST', `/api/admin/licenses/${code}/convertir`, { ...opts, body: { days: 30 } });
  assert.equal(conv.data.type, 'paga');
  assert.equal((await call('POST', `/api/admin/licenses/${code}/convertir`, { ...opts, body: { days: 30 } })).status, 400);
  const edit = await call('POST', `/api/admin/licenses/${code}/editar`, { ...opts, body: { note: 'llamar el 10' } });
  assert.equal(edit.data.note, 'llamar el 10');
  assert.equal(edit.data.customer, 'Club Oeste');
  assert.equal((await call('POST', `/api/admin/licenses/${code}/dispositivos`, { ...opts, body: { maxDevices: 3 } })).data.maxDevices, 3);
  const rev = await call('POST', `/api/admin/licenses/${code}/revocar`, { ...opts, body: {} });
  assert.equal(rev.data.state, 'revocada');
  assert.equal((await call('POST', `/api/admin/licenses/${code}/link`, { ...opts, body: {} })).status, 400, 'revocada: sin link');
  assert.equal((await call('POST', `/api/admin/licenses/${code}/reactivar`, { ...opts, body: {} })).data.state, 'activa');
  assert.equal((await call('POST', `/api/admin/licenses/${code}/resetear`, { ...opts, body: {} })).status, 200);

  const detail = await call('GET', `/api/admin/licenses/${code}`, { cookie: s.cookie });
  assert.deepEqual(detail.data.events.map((e) => e.type).reverse(), ['creada', 'extendida', 'convertida', 'editada', 'dispositivos', 'revocada', 'reactivada', 'reseteada']);
  assert.ok(detail.data.events.every((e) => e.actor === 'panel'));

  assert.equal((await call('GET', '/api/admin/licenses/ZSL-NOPE-NOPE', { cookie: s.cookie })).status, 400);
  const bad = await call('POST', '/api/admin/licenses', { ...opts, body: { type: 'oro' } });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /tipo inválido/);
  const notJson = await call('POST', '/api/admin/licenses', { ...opts, raw: '{no', headers: { 'Content-Type': 'application/json' } });
  assert.equal(notJson.status, 400);
});

test('APK: se rechaza lo que no es un APK y se publica y baja con link personal', async () => {
  const s = await login();
  const opts = { cookie: s.cookie, csrf: s.csrf };
  const put = (query, bytes) => call('PUT', `/api/admin/apk?${query}`, { ...opts, raw: bytes, headers: { 'Content-Type': 'application/octet-stream' } });

  assert.equal((await put('nombre=1.5&codigo=6', Buffer.from('esto no es un zip'))).status, 400);
  assert.equal((await put('nombre=1.5&codigo=0', Buffer.from('PK\x03\x04hola'))).status, 400, 'código inválido');
  assert.equal((await put('nombre=1.5%22x&codigo=6', Buffer.from('PK\x03\x04hola'))).status, 400, 'nombre con caracteres raros');
  assert.equal(fs.readdirSync(path.join(DATA_DIR, 'apk')).filter((f) => f.endsWith('.tmp')).length, 0, 'no quedan temporales');

  const apk = Buffer.concat([Buffer.from('PK\x03\x04'), crypto.randomBytes(5000)]);
  const ok = await put(`nombre=1.5&codigo=6&notas=${encodeURIComponent('Novedad uno\nNovedad dos')}`, apk);
  assert.equal(ok.status, 200);
  assert.equal(ok.data.apk.versionCode, 6);
  assert.deepEqual(ok.data.apk.notes, ['Novedad uno', 'Novedad dos']);
  assert.equal(ok.data.apk.size, apk.length);

  assert.equal((await put('nombre=1.4&codigo=5', apk)).status, 400, 'versión menor a la publicada');

  const lic = await call('POST', '/api/admin/licenses', { ...opts, body: { type: 'cortesia' } });
  const link = await call('POST', `/api/admin/licenses/${lic.data.code}/link`, { ...opts, body: { hours: 1, uses: 1 } });
  assert.equal(link.status, 200);
  const t = new URL(link.data.url).searchParams.get('t');
  const dl = await fetch(`${base}/api/license/descargar?t=${t}`);
  assert.equal(dl.status, 200);
  assert.deepEqual(Buffer.from(await dl.arrayBuffer()), apk);
  assert.equal((await fetch(`${base}/api/license/descargar?t=${t}`)).status, 403, 'el link de 1 uso no se repite');
});

test('la sesión vence por inactividad y se cierra con salir', async () => {
  const s = await login();
  assert.equal((await call('GET', '/api/admin/licenses', { cookie: s.cookie })).status, 200);
  await new Promise((r) => setTimeout(r, 1800));
  assert.equal((await call('GET', '/api/admin/licenses', { cookie: s.cookie })).status, 401, 'venció por inactividad');

  const t = await login();
  assert.equal((await call('POST', '/api/admin/logout', { cookie: t.cookie, csrf: t.csrf, body: {} })).status, 200);
  assert.equal((await call('GET', '/api/admin/licenses', { cookie: t.cookie })).status, 401);
});

test('cambiar la contraseña desde el panel: pide la actual, valida la nueva y cierra las otras sesiones', async () => {
  const NEW = 'otra-clave-igual-de-larga-456';
  const a = await login();
  const b = await login(); // otra sesión abierta
  const opts = { cookie: a.cookie, csrf: a.csrf };

  assert.equal((await call('POST', '/api/admin/password', { body: { current: 'no-es-la-actual', next: NEW } })).status, 401, 'sin sesión');
  const wrong = await call('POST', '/api/admin/password', { ...opts, body: { current: 'no-es-la-actual', next: NEW } });
  assert.equal(wrong.status, 403);
  assert.equal(wrong.data.error, 'clave_actual');
  assert.equal((await call('POST', '/api/admin/password', { cookie: a.cookie, body: { current: PASSWORD, next: NEW } })).status, 403, 'sin CSRF');
  const short = await call('POST', '/api/admin/password', { ...opts, body: { current: PASSWORD, next: 'corta' } });
  assert.equal(short.status, 400);
  assert.match(short.data.error, /al menos 12/);
  const same = await call('POST', '/api/admin/password', { ...opts, body: { current: PASSWORD, next: PASSWORD } });
  assert.equal(same.status, 400);
  assert.equal((await login()).status, 200, 'nada cambió con los intentos fallidos');

  const ok = await call('POST', '/api/admin/password', { ...opts, body: { current: PASSWORD, next: NEW } });
  assert.equal(ok.status, 200);
  assert.equal((await call('GET', '/api/admin/licenses', { cookie: a.cookie })).status, 200, 'la sesión que cambió sigue');
  assert.equal((await call('GET', '/api/admin/licenses', { cookie: b.cookie })).status, 401, 'la otra sesión se cerró');
  assert.equal((await login(PASSWORD)).status, 401, 'la vieja ya no sirve');
  const withNew = await login(NEW);
  assert.equal(withNew.status, 200);
  assert.ok(!fs.readFileSync(path.join(DATA_DIR, 'admin.json'), 'utf8').includes(NEW));

  // Se deja como estaba para los demás tests.
  const back = await call('POST', '/api/admin/password', { cookie: withNew.cookie, csrf: withNew.csrf, body: { current: NEW, next: PASSWORD } });
  assert.equal(back.status, 200);
});

test('contraseña incorrecta: 401 y, tras varios intentos, 429 (también con la clave correcta)', async () => {
  const statuses = [];
  for (let i = 0; i < 7; i++) statuses.push((await login('incorrecta-incorrecta')).status);
  assert.equal(statuses[0], 401);
  assert.equal(statuses[statuses.length - 1], 429);
  assert.ok(statuses.indexOf(429) <= 5, `se bloquea a lo sumo al 5.º intento fallido (${statuses.join(',')})`);
  assert.equal((await login()).status, 429, 'bloqueado aunque ahora acierte');
});

test('el servicio de licencias de siempre sigue andando junto al panel', async () => {
  const r = await call('POST', '/api/license/activar', { body: { code: 'ZSL-ZZZZ-ZZZZ', device: 'dispositivo-12345' } });
  assert.equal(r.status, 404);
  assert.equal(r.data.error, 'codigo');
});
