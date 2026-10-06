// Panel de administración de licencias: página en /admin y API en /api/admin.
// Lo atiende el mismo servicio de licencias (license-server.cjs), sin dependencias.
//
// Seguridad:
//   - Una sola cuenta; la contraseña se guarda con scrypt en DATA_DIR/admin.json (se crea con
//     `license-admin.cjs panel-clave`, nunca viaja por el panel).
//   - Sesión en cookie HttpOnly + Secure + SameSite=Strict, con vencimiento por inactividad y total.
//   - Toda acción que cambia algo exige el token CSRF de la sesión y, si el navegador manda
//     Origin, que sea el mismo sitio.
//   - Intentos de ingreso limitados por IP y en total.
//   - La página se sirve con una política CSP estricta (sin scripts ni estilos en línea).
//
// Variables: PANEL_DIR (archivos de la página), PUBLIC_URL, PANEL_DEV=1 (cookie sin Secure, solo para pruebas locales),
// PANEL_IDLE_MS / PANEL_MAX_MS (vencimiento de sesión).

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');
const lib = require('./license-lib.cjs');
const ops = require('./license-ops.cjs');
const pay = require('./license-pay.cjs');

const scrypt = promisify(crypto.scrypt);

const PANEL_DIR = process.env.PANEL_DIR || path.join(__dirname, 'panel');
const ADMIN_FILE = path.join(lib.DATA_DIR, 'admin.json');
const PUBLIC_URL = process.env.PUBLIC_URL || 'https://lite.zscore.ar';
const SECURE_COOKIE = process.env.PANEL_DEV !== '1';
const COOKIE = 'zs_admin';
const SESSION_IDLE_MS = Number(process.env.PANEL_IDLE_MS) || 30 * 60000;
const SESSION_MAX_MS = Number(process.env.PANEL_MAX_MS) || 12 * 3600000;
const MAX_JSON = 8 * 1024;
const MAX_APK = 150 * 1024 * 1024;
const LOGIN_WINDOW_MS = 15 * 60000;
const LOGIN_MAX_PER_IP = 5;
const LOGIN_MAX_TOTAL = 40;
const MIN_PASSWORD = 12;
const ACTOR = 'panel';
const SCRYPT = { N: 16384, r: 8, p: 1 };

// ---------- Contraseña ----------

async function hashPassword(password, salt) {
  return (await scrypt(password, salt, 64, SCRYPT)).toString('base64');
}

/** Crea o cambia la cuenta del panel. La usa el comando `panel-clave`. */
async function setPassword(user, password, { keepSid = null } = {}) {
  if (!/^[A-Za-z0-9._-]{3,32}$/.test(user)) throw new ops.OpError('el usuario admite letras, números, punto, guion (3 a 32)');
  if (String(password).length < MIN_PASSWORD) throw new ops.OpError(`la contraseña tiene que tener al menos ${MIN_PASSWORD} caracteres`);
  const salt = crypto.randomBytes(16).toString('base64');
  const data = { v: 1, user, salt, hash: await hashPassword(password, salt), params: SCRYPT, changedAt: Date.now() };
  fs.mkdirSync(lib.DATA_DIR, { recursive: true });
  const tmp = `${ADMIN_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, ADMIN_FILE);
  // Un cambio de clave cierra las demás sesiones abiertas (de este proceso); la que lo pidió sigue.
  for (const sid of [...sessions.keys()]) if (sid !== keepSid) sessions.delete(sid);
}

function readAdmin() {
  try { return JSON.parse(fs.readFileSync(ADMIN_FILE, 'utf8')); } catch (e) { return null; }
}

const digest = (s) => crypto.createHash('sha256').update(String(s)).digest();

async function checkLogin(user, password) {
  const admin = readAdmin();
  if (!admin) return { error: 'sin_clave' };
  // Siempre se calcula el hash, aunque el usuario esté mal: el tiempo no delata nada.
  const salt = admin.salt;
  const got = Buffer.from(await hashPassword(String(password), salt), 'base64');
  const want = Buffer.from(admin.hash, 'base64');
  const okPass = got.length === want.length && crypto.timingSafeEqual(got, want);
  const okUser = crypto.timingSafeEqual(digest(user), digest(admin.user));
  return okPass && okUser ? { ok: true, user: admin.user } : { error: 'credenciales' };
}

// ---------- Sesiones e intentos ----------

const sessions = new Map(); // sid -> { csrf, user, createdAt, lastSeen }
const loginFails = new Map(); // ip -> [timestamps]
let loginFailsAll = [];

function recentFails(ip) {
  const now = Date.now();
  const list = (loginFails.get(ip) || []).filter((t) => now - t < LOGIN_WINDOW_MS);
  loginFails.set(ip, list);
  loginFailsAll = loginFailsAll.filter((t) => now - t < LOGIN_WINDOW_MS);
  return list;
}

function tooManyLogins(ip) {
  return recentFails(ip).length >= LOGIN_MAX_PER_IP || loginFailsAll.length >= LOGIN_MAX_TOTAL;
}

function noteLoginFail(ip) {
  recentFails(ip).push(Date.now());
  loginFailsAll.push(Date.now());
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function sessionOf(req) {
  const sid = parseCookies(req)[COOKIE];
  const s = sid && sessions.get(sid);
  if (!s) return null;
  const now = Date.now();
  if (now - s.lastSeen > SESSION_IDLE_MS || now - s.createdAt > SESSION_MAX_MS) {
    sessions.delete(sid);
    return null;
  }
  s.lastSeen = now;
  return { sid, ...s };
}

function cookieHeader(value, maxAgeSec) {
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict${SECURE_COOKIE ? '; Secure' : ''}; Max-Age=${maxAgeSec}`;
}

setInterval(() => {
  const now = Date.now();
  for (const [sid, s] of sessions) if (now - s.lastSeen > SESSION_IDLE_MS || now - s.createdAt > SESSION_MAX_MS) sessions.delete(sid);
}, 60000).unref();

// ---------- Respuestas ----------

const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
};

function json(res, status, body, extra = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...SECURITY_HEADERS, ...extra });
  res.end(JSON.stringify(body));
}

const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; "
  + "base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const STATIC = {
  '/admin': ['admin.html', 'text/html; charset=utf-8'],
  '/admin/admin.css': ['admin.css', 'text/css; charset=utf-8'],
  '/admin/admin.js': ['admin.js', 'text/javascript; charset=utf-8'],
};

function serveStatic(res, route) {
  const entry = STATIC[route];
  if (!entry) return json(res, 404, { error: 'no encontrado' });
  let body;
  try { body = fs.readFileSync(path.join(PANEL_DIR, entry[0])); } catch (e) { return json(res, 404, { error: 'no encontrado' }); }
  res.writeHead(200, { 'Content-Type': entry[1], 'Content-Security-Policy': CSP, ...SECURITY_HEADERS });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_JSON) { reject(Object.assign(new ops.OpError('el pedido es demasiado grande'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try {
        const body = JSON.parse(text);
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('forma');
        resolve(body);
      } catch (e) { reject(new ops.OpError('JSON inválido')); }
    });
    req.on('error', reject);
  });
}

// ---------- Vistas de licencias ----------

function summary(lic) {
  const state = ops.stateOf(lic);
  return {
    code: lic.code, type: lic.type, state, customer: lic.customer, contact: lic.contact, note: lic.note,
    price: lic.price, currency: lic.currency, createdAt: lic.createdAt, paidUntil: lic.paidUntil,
    lastSeenAt: lic.lastSeenAt || null, devices: lic.devices.length, maxDevices: lic.maxDevices, tokenExp: lic.tokenExp === undefined ? null : lic.tokenExp,
  };
}

function detail(lic) {
  return { ...summary(lic), deviceList: lic.devices.map((d) => ({ id: d.id, activatedAt: d.activatedAt })), events: [...lic.events].reverse() };
}

function apkInfo() {
  const meta = lib.readApkMeta();
  if (!meta) return { published: false };
  let size = null;
  try { size = fs.statSync(lib.APK_FILE).size; } catch (e) { /* nada */ }
  return { published: true, size, ...meta };
}

/** Corre una operación sobre una licencia y devuelve su detalle. */
function mutate(code, fn) {
  return detail(lib.update((db) => {
    const lic = ops.getLicense(db, code);
    fn(db, lic);
    return lic;
  }));
}

// ---------- APK (subida) ----------

function receiveApk(req, url) {
  return new Promise((resolve, reject) => {
    const params = {
      versionName: url.searchParams.get('nombre') || '',
      versionCode: Number(url.searchParams.get('codigo')),
      notes: String(url.searchParams.get('notas') || '').split('\n'),
    };
    const declared = Number(req.headers['content-length']);
    if (!(declared > 0)) return reject(new ops.OpError('falta el archivo'));
    if (declared > MAX_APK) return reject(Object.assign(new ops.OpError('el APK pesa demasiado (máximo 150 MB)'), { status: 413 }));
    // Se valida lo barato antes de recibir 30 MB.
    try { lib.publishApkCheck(params); } catch (e) { return reject(e); }

    fs.mkdirSync(lib.APK_DIR, { recursive: true });
    const tmp = path.join(lib.APK_DIR, `subida-${process.pid}-${Date.now()}.tmp`);
    const out = fs.createWriteStream(tmp);
    let size = 0;
    let head = Buffer.alloc(0);
    let failed = false;
    const fail = (err) => {
      if (failed) return;
      failed = true;
      out.destroy();
      fs.rm(tmp, { force: true }, () => reject(err));
    };
    req.on('data', (c) => {
      size += c.length;
      if (head.length < 4) head = Buffer.concat([head, c]).subarray(0, 4);
      if (size > MAX_APK) { fail(Object.assign(new ops.OpError('el APK pesa demasiado (máximo 150 MB)'), { status: 413 })); req.destroy(); }
    });
    req.on('error', fail);
    req.on('aborted', () => fail(new ops.OpError('se cortó la subida')));
    out.on('error', fail);
    out.on('finish', () => {
      if (failed) return;
      try {
        if (size !== declared) throw new ops.OpError('la subida quedó incompleta');
        if (head.toString('latin1') !== 'PK\x03\x04') throw new ops.OpError('el archivo no parece un APK (no es un zip)');
        const meta = lib.publishApk(tmp, params);
        fs.rmSync(tmp, { force: true });
        resolve(meta);
      } catch (e) {
        fs.rmSync(tmp, { force: true });
        reject(e);
      }
    });
    req.pipe(out);
  });
}

// ---------- Rutas de la API ----------

const LIC_PATH = /^\/api\/admin\/licenses\/([A-Za-z0-9-]{1,32})(?:\/([a-z]+))?$/;

async function api(req, res, url, route, ip) {
  const method = req.method;

  if (route === '/api/admin/session' && method === 'GET') {
    const s = sessionOf(req);
    return json(res, 200, { authenticated: !!s, configured: !!readAdmin(), csrf: s ? s.csrf : null, user: s ? s.user : null });
  }

  if (route === '/api/admin/login' && method === 'POST') {
    if (tooManyLogins(ip)) return json(res, 429, { error: 'demasiados' });
    const body = await readJson(req);
    const r = await checkLogin(body.user, body.password);
    if (r.error === 'sin_clave') return json(res, 503, { error: 'sin_clave' });
    if (!r.ok) {
      noteLoginFail(ip);
      console.warn(`panel: ingreso fallido desde ${ip}`);
      return json(res, 401, { error: 'credenciales' });
    }
    const sid = crypto.randomBytes(32).toString('base64url');
    const csrf = crypto.randomBytes(24).toString('base64url');
    sessions.set(sid, { csrf, user: r.user, createdAt: Date.now(), lastSeen: Date.now() });
    console.log(`panel: ingreso de ${r.user} desde ${ip}`);
    return json(res, 200, { ok: true, csrf, user: r.user }, { 'Set-Cookie': cookieHeader(sid, SESSION_MAX_MS / 1000) });
  }

  const session = sessionOf(req);
  if (!session) return json(res, 401, { error: 'sesion' });

  if (method !== 'GET') {
    // Cambios: token CSRF de la sesión y, si hay Origin, que sea este mismo sitio.
    const origin = req.headers.origin;
    if (origin) {
      let same = false;
      try { same = new URL(origin).host === req.headers.host; } catch (e) { /* inválido */ }
      if (!same) return json(res, 403, { error: 'origen' });
    }
    const sent = String(req.headers['x-csrf'] || '');
    if (sent.length !== session.csrf.length || !crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(session.csrf))) {
      return json(res, 403, { error: 'csrf' });
    }
  }

  if (route === '/api/admin/password' && method === 'POST') {
    // Pide la contraseña actual (aunque haya sesión) y cuenta los errores como intentos de ingreso.
    if (tooManyLogins(ip)) return json(res, 429, { error: 'demasiados' });
    const b = await readJson(req);
    const admin = readAdmin();
    const check = admin ? await checkLogin(admin.user, b.current) : { error: 'sin_clave' };
    if (!check.ok) {
      noteLoginFail(ip);
      console.warn(`panel: cambio de contraseña con clave actual incorrecta desde ${ip}`);
      return json(res, 403, { error: 'clave_actual' });
    }
    if (String(b.next || '') === String(b.current)) throw new ops.OpError('la contraseña nueva tiene que ser distinta de la actual');
    await setPassword(admin.user, String(b.next || ''), { keepSid: session.sid });
    console.log(`panel: ${admin.user} cambió su contraseña desde ${ip}`);
    return json(res, 200, { ok: true });
  }

  if (route === '/api/admin/logout' && method === 'POST') {
    sessions.delete(session.sid);
    return json(res, 200, { ok: true }, { 'Set-Cookie': cookieHeader('', 0) });
  }

  if (route === '/api/admin/licenses' && method === 'GET') {
    const all = Object.values(lib.readDb().licenses).map(summary);
    return json(res, 200, { licenses: all, apk: apkInfo(), now: Date.now() });
  }

  if (route === '/api/admin/licenses' && method === 'POST') {
    const b = await readJson(req);
    const lic = lib.update((db) => ops.crear(db, {
      type: b.type, days: b.days, note: b.note, customer: b.customer, contact: b.contact,
      price: b.price, currency: b.currency, maxDevices: b.maxDevices,
    }, ACTOR));
    return json(res, 201, detail(lic));
  }

  const m = LIC_PATH.exec(route);
  if (m) {
    const code = m[1];
    const action = m[2];
    if (!action && method === 'GET') return json(res, 200, detail(ops.getLicense(lib.readDb(), code)));
    if (action && method === 'POST') {
      const b = await readJson(req);
      switch (action) {
        case 'extender': return json(res, 200, mutate(code, (db) => ops.extender(db, code, b.days, ACTOR)));
        case 'convertir': return json(res, 200, mutate(code, (db) => ops.convertir(db, code, b.days, ACTOR)));
        case 'revocar': return json(res, 200, mutate(code, (db) => ops.revocar(db, code, ACTOR)));
        case 'reactivar': return json(res, 200, mutate(code, (db) => ops.reactivar(db, code, ACTOR)));
        case 'resetear': return json(res, 200, mutate(code, (db) => ops.resetear(db, code, ACTOR)));
        case 'dispositivos': return json(res, 200, mutate(code, (db) => ops.dispositivos(db, code, b.maxDevices, ACTOR)));
        case 'editar': return json(res, 200, mutate(code, (db) => ops.editar(db, code, {
          note: b.note, customer: b.customer, contact: b.contact, price: b.price, currency: b.currency,
        }, ACTOR)));
        case 'pago': return json(res, 200, await pay.createLink(code, b, ACTOR));
        case 'link': {
          const hours = b.hours != null ? Number(b.hours) : 48;
          const uses = b.uses != null ? Number(b.uses) : 3;
          if (!(hours > 0 && hours <= 720) || !Number.isInteger(uses) || uses < 1 || uses > 20) {
            throw new ops.OpError('el link vale de 1 a 720 horas y de 1 a 20 descargas');
          }
          if (!lib.readApkMeta()) throw new ops.OpError('todavía no hay un APK publicado');
          const token = lib.update((db) => {
            const lic = ops.getLicense(db, code);
            const state = ops.stateOf(lic);
            if (state !== 'activa') throw new ops.OpError(`la licencia está ${state}: no se le puede dar un link`);
            lib.addEvent(lic, 'link', ACTOR, `${hours} h, ${uses} usos`);
            return lib.newLink(db, lic.code, { hours, maxUses: uses });
          });
          return json(res, 200, { url: `${PUBLIC_URL}/api/license/descargar?t=${token}`, hours, uses });
        }
        default: break;
      }
    }
  }

  if (route === '/api/admin/pagos' && method === 'GET') return json(res, 200, pay.summary());

  if (route === '/api/admin/apk' && method === 'GET') return json(res, 200, apkInfo());
  if (route === '/api/admin/apk' && method === 'PUT') {
    const meta = await receiveApk(req, url);
    console.log(`panel: APK ${meta.versionName} (${meta.versionCode}) publicado desde ${ip}`);
    return json(res, 200, { ok: true, apk: apkInfo() });
  }

  return json(res, 404, { error: 'no encontrado' });
}

/** ¿Esta ruta es del panel? (el servicio de licencias le pasa estas) */
function handles(route) {
  return route === '/admin' || route.startsWith('/admin/') || route === '/api/admin' || route.startsWith('/api/admin/');
}

async function handle(req, res, url, route, ip) {
  try {
    if (route === '/admin' || route.startsWith('/admin/')) {
      if (req.method !== 'GET') return json(res, 405, { error: 'método' });
      return serveStatic(res, route);
    }
    return await api(req, res, url, route, ip);
  } catch (e) {
    if (res.headersSent) return undefined;
    if (e instanceof ops.OpError) return json(res, e.status || 400, { error: e.message });
    console.error('panel: error', e);
    return json(res, 500, { error: 'error interno' });
  }
}

module.exports = { handles, handle, setPassword, MIN_PASSWORD };
