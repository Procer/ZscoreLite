// Servicio de licencias de Z-Score Lite. Sin dependencias.
//
//   POST /api/license/activar  { code, device }  -> { token }
//   POST /api/license/renovar  { token, device } -> { token }
//   POST /api/license/prueba   { device }        -> { token, days } (prueba por autoservicio: 1 por dispositivo)
//   POST /api/license/version  { token, device } -> { versionName, versionCode, url } (APK vigente + link corto de descarga)
//   GET  /api/license/app?t=LINK                 -> página de descarga (código + botón); mirarla no gasta usos del link
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
const path = require('path');
const crypto = require('crypto');
const lib = require('./license-lib.cjs');
const ops = require('./license-ops.cjs');
const pay = require('./license-pay.cjs');
const texts = require('./license-texts.cjs');
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

/**
 * Página de descarga: es a donde lleva el botón del email. Muestra el código y un botón grande que baja el APK.
 * Mirar la página NO gasta usos del link: solo cuenta la descarga de verdad (/api/license/descargar).
 * Existe porque Gmail abre los links en una ventana interna que a veces no sabe guardar archivos: acá hay un botón
 * para abrir la misma página en Chrome y las ayudas para el caso de que Android o Play Protect pidan permisos.
 */
function paginaApp(req, url, ip, res) {
  const token = url.searchParams.get('t') || '';
  const db = lib.readDb();
  const link = db.links[token];
  const lic = link && db.licenses[link.code];
  const meta = lib.readApkMeta();
  if (!link) noteFail(ip);
  if (!link || link.expiresAt < Date.now() || link.uses >= link.maxUses || !lic || lib.blockReason(lic)) {
    return page(res, 403, 'Este link venció o su licencia no está vigente. Pedí uno nuevo escribiéndonos.');
  }
  if (!meta) return page(res, 503, 'La descarga no está disponible por el momento. Probá más tarde.');

  const e = texts.esc;
  const mb = (fs.statSync(lib.APK_FILE).size / 1e6).toFixed(1).replace('.', ',');
  const host = String(req.headers.host || '').replace(/[^A-Za-z0-9.:-]/g, '');
  const chromeUrl = `intent://${host}/api/license/app?t=${encodeURIComponent(token)}#Intent;scheme=https;package=com.android.chrome;end`;
  const dlUrl = `/api/license/descargar?t=${encodeURIComponent(token)}`;
  const vence = lic.paidUntil == null ? '' : `Vence el ${texts.fmtDate(lic.paidUntil)}. `;

  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
  });
  res.end(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Descargar Z-Score Lite</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#0b0e13;color:#f5f7fa;font:16px/1.55 -apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif}
.w{max-width:520px;margin:0 auto;padding:28px 18px 48px}.brand{font-weight:800;letter-spacing:.6px;font-size:20px}.brand b{color:#a3e635}
h1{font-size:26px;line-height:1.2;margin:26px 0 4px}.sub{color:#9aa4b2;margin:0 0 22px}
.card{background:#141a23;border:1px solid #232c3a;border-radius:14px;padding:18px;margin:0 0 18px}
.lbl{font-size:12px;letter-spacing:1.3px;color:#9aa4b2;font-weight:700}
.code{font:800 28px 'Courier New',monospace;letter-spacing:2px;margin:8px 0;word-break:break-all;-webkit-user-select:all;user-select:all}
.btn{display:block;text-align:center;text-decoration:none;font-weight:700;font-size:18px;border-radius:12px;padding:17px 14px;margin:0 0 12px;border:0;width:100%;cursor:pointer}
.go{background:#16a34a;color:#fff}.alt{background:#232c3a;color:#f5f7fa;font-size:15px;padding:13px 14px}
ol{padding-left:22px;margin:8px 0}li{margin:0 0 10px}h2{font-size:13px;letter-spacing:1.3px;color:#9aa4b2;margin:26px 0 8px;text-transform:uppercase}
.muted{color:#9aa4b2;font-size:14px}
</style></head><body><div class="w">
<div class="brand"><img src="/api/license/logo.png" width="46" height="43" alt="Z" style="vertical-align:middle;margin-right:10px">Z-SCORE <b>LITE</b></div>
<h1>Descargá la app</h1>
<p class="sub">Versión ${e(meta.versionName)} · ${mb} MB · para Android</p>
<div class="card"><div class="lbl">TU CÓDIGO DE LICENCIA</div><div class="code" id="c">${e(lic.code)}</div>
<div class="muted">${e(vence)}Lo vas a necesitar para activar la app.</div>
<button class="btn alt" style="margin:12px 0 0" id="cp" type="button">Copiar el código</button></div>
<a class="btn go" href="${e(dlUrl)}">Descargar Z-Score Lite</a>
<a class="btn alt" href="${e(chromeUrl)}">¿No baja? Abrir en Chrome</a>
<h2>Después de descargar</h2>
<ol><li><b>Abrí el archivo</b> descargado: tocá la notificación de descarga o buscalo en «Descargas».</li>
<li>Android va a mostrar avisos de seguridad (son normales: la app no viene de Google Play). Mirá abajo cómo pasarlos.</li>
<li>Abrí <b>Z-Score Lite</b>, escribí el código y tocá <b>«Activar»</b>.</li></ol>
<h2>Si Android te bloquea la instalación</h2>
<div class="card"><b>«Tu teléfono no puede instalar aplicaciones desconocidas desde esta fuente»</b><br>
<span class="muted">Tocá <b>«Ajustes»</b>, activá <b>«Permitir desde esta fuente»</b>, volvé atrás con la flecha y tocá <b>«Instalar»</b>. Es un permiso para el navegador; lo podés quitar después.</span></div>
<div class="card"><b>Aviso de «Play Protect»</b><br>
<span class="muted">Tocá <b>«Más detalles»</b> y después <b>«Instalar de todos modos»</b>. Aparece porque la app todavía no está en Google Play.</span></div>
<h2>¿Algo no funciona?</h2>
<p class="muted">Si la descarga queda trabada, tocá «Abrir en Chrome» o copiá la dirección de esta página y pegala en Chrome. Si usás iPhone, activá el mismo código en la versión web: <b>${e(String(req.headers.host || ''))}/app/</b></p>
</div><script>
(function(){var b=document.getElementById('cp'),c=document.getElementById('c');
b.addEventListener('click',function(){var t=c.textContent;
function ok(){b.textContent='¡Copiado!'}
function fb(){var r=document.createRange();r.selectNodeContents(c);var s=getSelection();s.removeAllRanges();s.addRange(r);try{document.execCommand('copy');ok()}catch(e){b.textContent='Mantené apretado el código para copiarlo'}}
if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(t).then(ok,fb)}else{fb()}});})();
</script></body></html>`);
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

  // Compra online: lleva al checkout de Mercado Pago, y la página a la que vuelve el cliente
  if (route === '/api/license/comprar') return pay.handleSale(req, res, clientIp(req));
  if (route === '/api/license/gracias') return pay.handleThanks(req, res, url);

  // Aviso de pago de Mercado Pago (tiene su propia validación de firma)
  if (route === '/api/license/pago') {
    const ip = clientIp(req);
    if (tooManyFails(ip)) return send(res, 429, { error: 'demasiados' });
    return pay.handleWebhook(req, res, url, () => noteFail(ip));
  }

  // Panel de administración (página y API): tiene su propia autenticación y límites.
  if (panel.handles(route)) return panel.handle(req, res, url, route, clientIp(req));

  // Logo para los emails y la página de descarga (es público: no tiene nada privado)
  if (req.method === 'GET' && route === '/api/license/logo.png') {
    try {
      const png = fs.readFileSync(path.join(__dirname, 'panel', 'logo.png'));
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length, 'Cache-Control': 'public, max-age=86400' });
      return res.end(png);
    } catch (e) { return send(res, 404, { error: 'no encontrado' }); }
  }

  if (req.method === 'GET' && route === '/api/license/app') {
    const ip = clientIp(req);
    if (tooManyFails(ip)) return page(res, 429, 'Demasiados intentos. Probá de nuevo en una hora.');
    return paginaApp(req, url, ip, res);
  }

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
}).listen(PORT, HOST, () => {
  console.log(`zscore-license escuchando en http://${HOST}:${PORT}`);
  pay.startJobs(); // reintentos de emails y avisos de vencimiento
});
