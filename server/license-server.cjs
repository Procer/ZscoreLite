// Servicio de licencias de Z-Score Lite. Sin dependencias.
//
//   POST /api/license/activar  { code, device }  -> { token }
//   POST /api/license/renovar  { token, device } -> { token }
//   POST /api/license/prueba   { device }        -> { token, days } (prueba por autoservicio: 1 por dispositivo)
//   POST /api/license/version  { token, device } -> { versionName, versionCode, url } (APK vigente + link corto de descarga)
//   GET  /api/license/descargar?t=LINK           -> el APK (link personal de una licencia al día)
//
// Errores: { error: 'codigo' | 'en_uso' | 'vencida' | 'revocada' | 'demasiados' | 'prueba_usada' | 'prueba_limite' | 'sin_prueba' }.
// La app (www/js/license.js) valida el token sin internet con la clave pública.
// Las licencias se crean y administran con license-admin.cjs o desde el panel (/admin, ver license-panel.cjs).
//
// Variables de entorno: PORT (3721), HOST (127.0.0.1), DATA_DIR, PRIVATE_KEY_FILE, TRIAL_DAYS (14; 0 apaga las pruebas).

'use strict';

const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const lib = require('./license-lib.cjs');
const ops = require('./license-ops.cjs');
const pay = require('./license-pay.cjs');
const panel = require('./license-panel.cjs');

const PORT = Number(process.env.PORT || 3721);
const HOST = process.env.HOST || '127.0.0.1';
const MAX_BODY = 4 * 1024;
const MAX_FAILS_PER_HOUR = 15; // frena el adivinar códigos a ciegas

const fails = new Map(); // ip -> [timestamps]

function clientIp(req) {
  return String(req.headers['x-real-ip'] || req.socket.remoteAddress || '');
}

function tooManyFails(ip) {
  const recent = (fails.get(ip) || []).filter((t) => Date.now() - t < 3600000);
  fails.set(ip, recent);
  return recent.length >= MAX_FAILS_PER_HOUR;
}

function noteFail(ip) {
  const list = fails.get(ip) || [];
  list.push(Date.now());
  fails.set(ip, list);
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('grande'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const ERROR_STATUS = { codigo: 404, en_uso: 409, vencida: 402, revocada: 403, demasiados: 429, prueba_usada: 409, prueba_limite: 429, sin_prueba: 404 };

function fail(res, ip, error, { count = true } = {}) {
  if (count) noteFail(ip);
  return send(res, ERROR_STATUS[error] || 400, { error });
}

function validDevice(device) {
  return typeof device === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(device);
}

function activar(body, ip, res) {
  const code = lib.normalizeCode(body.code);
  if (!validDevice(body.device)) return fail(res, ip, 'codigo');

  const outcome = lib.update((db) => {
    const lic = db.licenses[code];
    if (!lic) return { error: 'codigo' };
    const blocked = lib.blockReason(lic);
    if (blocked) return { error: blocked, count: false };
    const known = lic.devices.some((d) => d.id === body.device);
    if (!known) {
      if (lic.devices.length >= lic.maxDevices) return { error: 'en_uso', count: false };
      lic.devices.push({ id: body.device, activatedAt: Date.now() });
      lib.addEvent(lic, 'dispositivo', 'app', `activado ${body.device.slice(0, 8)} (${lic.devices.length}/${lic.maxDevices})`);
    }
    lic.lastSeenAt = Date.now();
    return { token: lib.issueToken(lic, body.device) };
  });

  if (outcome.error) return fail(res, ip, outcome.error, { count: outcome.count !== false });
  return send(res, 200, { token: outcome.token });
}

function renovar(body, ip, res) {
  const payload = lib.readToken(body.token);
  // Un token vencido igual sirve para renovar: justamente se renueva cuando ya pagaron.
  if (!payload || payload.dev !== body.device) return fail(res, ip, 'codigo');

  const outcome = lib.update((db) => {
    const lic = db.licenses[payload.code];
    if (!lic || !lic.devices.some((d) => d.id === payload.dev)) return { error: 'codigo' };
    const blocked = lib.blockReason(lic);
    if (blocked) return { error: blocked, count: false };
    lic.lastSeenAt = Date.now();
    return { token: lib.issueToken(lic, payload.dev) };
  });

  if (outcome.error) return fail(res, ip, outcome.error, { count: outcome.count !== false });
  return send(res, 200, { token: outcome.token });
}

// ---------- Prueba por autoservicio ----------
// Un celular nuevo pide su prueba y recibe una licencia 'prueba' ya activada. Una por dispositivo, y tope por
// conexión y por día para que no se pueda regalar licencias a granel. TRIAL_DAYS=0 apaga las pruebas.

const TRIAL_DAYS = process.env.TRIAL_DAYS === undefined ? 14 : Number(process.env.TRIAL_DAYS);
const TRIALS_PER_IP = 3;
const TRIAL_IP_WINDOW = 30 * lib.DAY;
const TRIALS_PER_DAY = 300;

/** Huella corta: no se guardan IPs ni ids de dispositivo en claro en la lista de pruebas. */
const fingerprint = (value) => crypto.createHash('sha256').update(`zs-prueba:${value}`).digest('hex').slice(0, 24);

function prueba(body, ip, res) {
  if (!(TRIAL_DAYS > 0)) return send(res, 404, { error: 'sin_prueba' });
  if (!validDevice(body.device)) return fail(res, ip, 'codigo');

  const outcome = lib.update((db) => {
    const now = Date.now();
    const deviceKey = fingerprint(body.device);
    const known = db.trials[deviceKey];
    if (known) {
      // Mismo celular pidiendo de nuevo (perdió el certificado): se le devuelve su prueba si sigue en curso.
      const lic = db.licenses[known.code];
      if (lic && lic.devices.some((d) => d.id === body.device) && !lib.blockReason(lic)) {
        lic.lastSeenAt = now;
        return { token: lib.issueToken(lic, body.device) };
      }
      return { error: 'prueba_usada' };
    }
    const ipKey = fingerprint(`ip:${ip}`);
    const recent = (db.trialIps[ipKey] || []).filter((t) => now - t < TRIAL_IP_WINDOW);
    const today = Object.values(db.trials).filter((t) => now - t.at < lib.DAY).length;
    if (recent.length >= TRIALS_PER_IP || today >= TRIALS_PER_DAY) return { error: 'prueba_limite' };

    const lic = ops.crear(db, { type: 'prueba', days: TRIAL_DAYS, note: 'Prueba autoservicio' }, 'app');
    lic.devices.push({ id: body.device, activatedAt: now });
    lic.lastSeenAt = now;
    lib.addEvent(lic, 'dispositivo', 'app', `activado ${body.device.slice(0, 8)} (1/${lic.maxDevices})`);
    db.trials[deviceKey] = { at: now, code: lic.code };
    db.trialIps[ipKey] = [...recent, now];
    for (const [k, list] of Object.entries(db.trialIps)) if (list.every((t) => now - t >= TRIAL_IP_WINDOW)) delete db.trialIps[k];
    return { token: lib.issueToken(lic, body.device) };
  });

  if (outcome.error) return fail(res, ip, outcome.error, { count: false });
  return send(res, 200, { token: outcome.token, days: TRIAL_DAYS });
}

const APP_LINK_MINUTES = 15; // vigencia del link que la app pide para actualizarse
const APP_LINK_USES = 3; // el navegador a veces reintenta o reanuda la descarga

function page(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<body style="font-family:sans-serif;background:#0b0e13;color:#f5f7fa;padding:32px;text-align:center">'
    + `<h2>Z-Score Lite</h2><p>${text}</p></body>`);
}

function descargar(url, ip, res) {
  const meta = lib.readApkMeta();
  const outcome = lib.update((db) => {
    const link = db.links[url.searchParams.get('t')];
    if (!link) return { why: 'nolink' };
    if (link.expiresAt < Date.now() || link.uses >= link.maxUses) return { why: 'vencido' };
    const lic = db.licenses[link.code];
    if (!lic || lib.blockReason(lic)) return { why: 'licencia' };
    if (!meta) return { why: 'sinapk' };
    link.uses += 1;
    return { ok: true };
  });

  if (outcome.why === 'sinapk') return page(res, 503, 'La descarga no está disponible por el momento. Probá más tarde.');
  if (outcome.why) {
    if (outcome.why === 'nolink') noteFail(ip);
    return page(res, 403, 'Este link venció, ya se usó o su licencia no está vigente. Pedí uno nuevo.');
  }
  const stat = fs.statSync(lib.APK_FILE);
  res.writeHead(200, {
    'Content-Type': 'application/vnd.android.package-archive',
    'Content-Length': stat.size,
    'Content-Disposition': `attachment; filename="zscore-lite-${meta.versionName}.apk"`,
    'Cache-Control': 'no-store',
  });
  fs.createReadStream(lib.APK_FILE).pipe(res);
}

/** La app (con licencia al día) pregunta cuál es la versión vigente y recibe un link corto para bajarla. */
function version(body, ip, res) {
  const payload = lib.readToken(body.token);
  if (!payload || payload.dev !== body.device) return fail(res, ip, 'codigo');
  const meta = lib.readApkMeta();

  const outcome = lib.update((db) => {
    const lic = db.licenses[payload.code];
    if (!lic || !lic.devices.some((d) => d.id === payload.dev)) return { error: 'codigo' };
    const blocked = lib.blockReason(lic);
    if (blocked) return { error: blocked, count: false };
    if (!meta) return { none: true };
    const t = lib.newLink(db, lic.code, { hours: APP_LINK_MINUTES / 60, maxUses: APP_LINK_USES });
    return { url: `/api/license/descargar?t=${t}` };
  });

  if (outcome.error) return fail(res, ip, outcome.error, { count: outcome.count !== false });
  if (outcome.none) return send(res, 200, { versionCode: null });
  return send(res, 200, {
    versionName: meta.versionName, versionCode: meta.versionCode, notes: meta.notes || [], url: outcome.url,
  });
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const route = url.pathname.replace(/\/+$/, '');

  // Aviso de pago de Mercado Pago (tiene su propia validación de firma)
  if (route === '/api/license/pago') {
    const ip = clientIp(req);
    if (tooManyFails(ip)) return send(res, 429, { error: 'demasiados' });
    return pay.handleWebhook(req, res, url, () => noteFail(ip));
  }

  // Panel de administración (página y API): tiene su propia autenticación y límites.
  if (panel.handles(route)) return panel.handle(req, res, url, route, clientIp(req));

  if (req.method === 'GET' && route === '/api/license/descargar') {
    const ip = clientIp(req);
    if (tooManyFails(ip)) return page(res, 429, 'Demasiados intentos. Probá de nuevo en una hora.');
    return descargar(url, ip, res);
  }

  if (req.method !== 'POST' || !['/api/license/activar', '/api/license/renovar', '/api/license/version', '/api/license/prueba'].includes(route)) {
    return send(res, 404, { error: 'no encontrado' });
  }

  const ip = clientIp(req);
  if (tooManyFails(ip)) return send(res, 429, { error: 'demasiados' });

  let body;
  try { body = JSON.parse(await readBody(req)); } catch (e) {
    return send(res, e.status || 400, { error: 'JSON inválido' });
  }
  if (!body || typeof body !== 'object') return send(res, 400, { error: 'JSON inválido' });

  if (route.endsWith('activar')) return activar(body, ip, res);
  if (route.endsWith('renovar')) return renovar(body, ip, res);
  if (route.endsWith('prueba')) return prueba(body, ip, res);
  return version(body, ip, res);
}

http.createServer({ requestTimeout: 15 * 60000 }, (req, res) => { // el panel recibe el APK (decenas de MB)
  handle(req, res).catch((e) => {
    console.error('error:', e);
    if (!res.headersSent) send(res, 500, { error: 'error interno' });
  });
}).listen(PORT, HOST, () => console.log(`zscore-license escuchando en http://${HOST}:${PORT}`));
