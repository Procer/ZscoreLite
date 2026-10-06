// Código compartido por el servicio de licencias y el comando de administración:
// guarda las licencias en un archivo JSON y firma los tokens que valida la app
// (ver www/js/license.js, que es el otro extremo del contrato).

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/** Error de uso (dato inválido, licencia inexistente...): se muestra tal cual al que lo causó. */
class OpError extends Error {}

const DAY = 86400000;
const TOKEN_DAYS = 32; // vigencia de cada token; la app renueva en silencio mucho antes
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // sin 0/O/1/I/L: no se confunden al dictarlos
const TYPES = ['paga', 'cortesia', 'prueba'];

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'license-data');
const DB_FILE = path.join(DATA_DIR, 'licenses.json');
const APK_DIR = path.join(DATA_DIR, 'apk');
const APK_FILE = path.join(APK_DIR, 'zscore-lite.apk');
const APK_META_FILE = path.join(APK_DIR, 'apk.json'); // { versionName, versionCode, sha256, publishedAt }
const PRIVATE_KEY_FILE = process.env.PRIVATE_KEY_FILE || path.join(DATA_DIR, 'license-private.pem');

// ---------- Almacenamiento ----------
// Chico y a propósito simple: cada operación lee y escribe el archivo entero
// (alcanza de sobra para cientos de licencias) con reemplazo atómico, así el
// servicio y el comando de administración pueden usarlo a la vez sin pisarse.

const SCHEMA_VERSION = 2;
const MAX_EVENTS = 200; // por licencia; los más viejos se descartan

/** Completa lo que falte (bases de versiones anteriores) sin tocar lo que ya está. */
function normalize(db) {
  db.version = SCHEMA_VERSION;
  db.links = db.links || {};
  db.payLinks = db.payLinks || {}; // links de pago generados: ref -> { code, days, amount, currency, at }
  db.payments = db.payments || {}; // pagos de Mercado Pago ya aplicados (por id de pago)
  db.trials = db.trials || {}; // pruebas por autoservicio: huella del dispositivo -> { at, code }
  db.trialIps = db.trialIps || {}; // huella de la IP -> fechas de las pruebas pedidas
  for (const lic of Object.values(db.licenses)) {
    if (!Array.isArray(lic.devices)) lic.devices = [];
    if (!Array.isArray(lic.events)) lic.events = [];
    if (lic.customer == null) lic.customer = '';
    if (lic.contact == null) lic.contact = '';
    if (lic.price === undefined) lic.price = null;
    if (!lic.currency) lic.currency = 'ARS';
  }
  return db;
}

function readRaw() {
  let text;
  try {
    text = fs.readFileSync(DB_FILE, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  let db;
  try { db = JSON.parse(text); } catch (e) { db = null; }
  // Un archivo que existe pero no se entiende NO se trata como "vacío": el próximo
  // guardado pisaría todas las licencias. Mejor frenar y que se revise a mano.
  if (!db || typeof db.licenses !== 'object' || db.licenses === null) {
    throw new Error(`licenses.json ilegible: no se modifica (${DB_FILE})`);
  }
  return db;
}

function readDb() {
  return normalize(readRaw() || { licenses: {}, links: {} });
}

function writeDb(db) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${DB_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

// ---------- Bloqueo ----------
// Servicio, comandos y (más adelante) el panel escriben el mismo archivo. Cada
// operación toma un archivo de bloqueo (creación exclusiva) mientras lee, cambia y
// guarda, así dos procesos a la vez no se pisan. La sección protegida dura milisegundos.

const LOCK_FILE = `${DB_FILE}.lock`;
const LOCK_STALE_MS = 10000; // un bloqueo más viejo que esto es de un proceso que murió
const LOCK_WAIT_MS = 5000;

let lockHeld = false;

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquireLock() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const start = Date.now();
  for (;;) {
    try {
      const fd = fs.openSync(LOCK_FILE, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      lockHeld = true;
      return;
    } catch (e) {
      // EEXIST: lo tiene otro. En Windows, crear un archivo que se está borrando da EPERM/EACCES/EBUSY: también se reintenta.
      if (!['EEXIST', 'EPERM', 'EACCES', 'EBUSY'].includes(e.code)) throw e;
    }
    try {
      if (Date.now() - fs.statSync(LOCK_FILE).mtimeMs > LOCK_STALE_MS) fs.unlinkSync(LOCK_FILE);
      else if (Date.now() - start > LOCK_WAIT_MS) throw new Error('la base de licencias está ocupada, probá de nuevo');
    } catch (e) {
      if (e.code === 'ENOENT') continue; // el otro proceso justo la soltó: reintentar
      if (e.code !== 'EPERM' && e.code !== 'EBUSY' && e.code !== 'EACCES') throw e;
      // Transitorio (archivo en uso por un instante): se espera y se reintenta, hasta el tiempo máximo.
      if (Date.now() - start > LOCK_WAIT_MS) throw new Error('la base de licencias está ocupada, probá de nuevo');
    }
    sleep(10 + Math.random() * 30);
  }
}

function releaseLock() {
  if (!lockHeld) return;
  lockHeld = false;
  // En Windows un antivirus o el indexador pueden tener el archivo abierto un instante: se reintenta
  // en vez de dejar el bloqueo puesto (los demás esperarían hasta que se lo considere viejo).
  for (let attempt = 0; attempt < 10; attempt++) {
    try { fs.unlinkSync(LOCK_FILE); return; } catch (e) {
      if (e.code === 'ENOENT') return; // ya no estaba
      if (e.code !== 'EPERM' && e.code !== 'EBUSY' && e.code !== 'EACCES') return;
      sleep(15);
    }
  }
}

// Si el proceso termina a mitad de una operación (process.exit), no deja el bloqueo puesto.
process.on('exit', releaseLock);

/** Lee, aplica `fn(db)` y guarda, todo bajo bloqueo. Si `fn` lanza un error no se guarda nada. */
function update(fn) {
  acquireLock();
  try {
    const raw = readRaw();
    if (raw && (raw.version || 1) < SCHEMA_VERSION) {
      // Primera vez con el esquema nuevo: copia de seguridad de lo que había.
      fs.copyFileSync(DB_FILE, `${DB_FILE}.v${raw.version || 1}-${Date.now()}.bak`);
    }
    const db = normalize(raw || { licenses: {}, links: {} });
    const result = fn(db);
    writeDb(db);
    return result;
  } finally {
    releaseLock();
  }
}

// ---------- Historial ----------

/** Anota algo que le pasó a una licencia. `actor`: 'cli', 'panel', 'app', 'mp'... */
function addEvent(lic, type, actor, detail = '') {
  if (!Array.isArray(lic.events)) lic.events = [];
  lic.events.push({ at: Date.now(), type, actor, detail: String(detail).slice(0, 300) });
  if (lic.events.length > MAX_EVENTS) lic.events.splice(0, lic.events.length - MAX_EVENTS);
}

// ---------- Links de descarga del APK ----------
// Un link es de una licencia y de uso limitado: vence y tiene un tope de descargas.
// Se pueden mandar por WhatsApp; no sirven si la licencia está revocada o vencida.

function newLink(db, code, { hours, maxUses }, now = Date.now()) {
  for (const [t, l] of Object.entries(db.links)) if (l.expiresAt < now - DAY) delete db.links[t]; // limpieza
  const token = crypto.randomBytes(18).toString('base64url');
  db.links[token] = { code, createdAt: now, expiresAt: now + hours * 3600000, maxUses, uses: 0 };
  return token;
}

function readApkMeta() {
  try {
    const meta = JSON.parse(fs.readFileSync(APK_META_FILE, 'utf8'));
    return fs.existsSync(APK_FILE) ? meta : null;
  } catch (e) {
    return null;
  }
}

/**
 * Deja `src` como el APK vigente. Lo usan el comando y el panel.
 * Sin `force`, rechaza un código de versión menor al publicado: las apps instaladas no lo verían como novedad.
 */
function publishApkCheck({ versionName, versionCode, force = false }) {
  if (!/^[0-9A-Za-z._-]{1,20}$/.test(String(versionName))) throw new OpError('el nombre de versión solo admite letras, números, punto y guion (hasta 20)');
  if (!Number.isInteger(versionCode) || versionCode < 1) throw new OpError('el código de versión tiene que ser un entero de 1 en adelante');
  const current = readApkMeta();
  if (!force && current && versionCode < current.versionCode) {
    throw new OpError(`el código ${versionCode} es menor al publicado (${current.versionCode}): las apps no lo tomarían como actualización`);
  }
}

function publishApk(src, { versionName, versionCode, notes = [], force = false }) {
  publishApkCheck({ versionName, versionCode, force });
  fs.mkdirSync(APK_DIR, { recursive: true });
  const tmp = `${APK_FILE}.${process.pid}.tmp`;
  fs.copyFileSync(src, tmp);
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(tmp, 'r');
  try {
    const buf = Buffer.alloc(1 << 20);
    for (let n; (n = fs.readSync(fd, buf, 0, buf.length, null)) > 0;) hash.update(buf.subarray(0, n));
  } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, APK_FILE);
  const clean = notes.map((n) => String(n).trim().slice(0, 200)).filter(Boolean).slice(0, 10);
  const meta = { versionName: String(versionName), versionCode, notes: clean, sha256: hash.digest('hex'), publishedAt: Date.now() };
  fs.writeFileSync(APK_META_FILE, JSON.stringify(meta, null, 2));
  return meta;
}

// ---------- Códigos ----------

function randomPart() {
  let s = '';
  for (let i = 0; i < 4; i++) s += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return s;
}

function newCode(db) {
  for (;;) {
    const code = `ZSL-${randomPart()}-${randomPart()}`;
    if (!db.licenses[code]) return code;
  }
}

function normalizeCode(raw) {
  return String(raw || '').trim().toUpperCase();
}

// ---------- Tokens ----------

let privateKey = null;
function getPrivateKey() {
  if (!privateKey) privateKey = crypto.createPrivateKey(fs.readFileSync(PRIVATE_KEY_FILE));
  return privateKey;
}

const b64u = (buf) => Buffer.from(buf).toString('base64url');

/** Fecha hasta la que vale el token que se entrega ahora (null = no vence; hoy ninguna licencia lo usa). */
function tokenExpiry(lic, now) {
  // La cortesía no vence, pero su certificado sí (igual que el de las demás): así revocarla corta el acceso.
  if (lic.type === 'cortesia') return now + TOKEN_DAYS * DAY;
  if (lic.paidUntil == null) return null;
  return Math.min(now + TOKEN_DAYS * DAY, lic.paidUntil);
}

function signToken(lic, device, now = Date.now()) {
  const body = b64u(JSON.stringify({
    v: 1, code: lic.code, type: lic.type, dev: device, iat: now, exp: tokenExpiry(lic, now),
  }));
  const sig = crypto.sign('sha256', Buffer.from(body), { key: getPrivateKey(), dsaEncoding: 'ieee-p1363' });
  return `${body}.${b64u(sig)}`;
}

/** Firma un token y anota en la licencia hasta cuándo vale el que tiene ese celular (lo muestra el panel). */
function issueToken(lic, device, now = Date.now()) {
  lic.tokenExp = tokenExpiry(lic, now);
  return signToken(lic, device, now);
}

/** Valida la firma y devuelve el contenido (aunque esté vencido: sirve para renovar). */
function readToken(token) {
  try {
    const [body, sig] = String(token).split('.');
    if (!body || !sig) return null;
    const publicKey = crypto.createPublicKey(getPrivateKey());
    const ok = crypto.verify('sha256', Buffer.from(body), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url'));
    return ok ? JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) : null;
  } catch (e) {
    return null;
  }
}

// ---------- Reglas ----------

/** ¿Está al día? Devuelve null si sí, o el código de error del contrato con la app. */
function blockReason(lic, now = Date.now()) {
  if (lic.revoked) return 'revocada';
  if (lic.type !== 'cortesia' && lic.paidUntil != null && lic.paidUntil < now) return 'vencida';
  return null;
}

module.exports = {
  DAY, TOKEN_DAYS, TYPES, DATA_DIR, DB_FILE, APK_DIR, APK_FILE, APK_META_FILE,
  SCHEMA_VERSION, readDb, writeDb, update, addEvent, newCode, normalizeCode, newLink,
  signToken, issueToken, readToken, blockReason, OpError, readApkMeta, publishApk, publishApkCheck,
};
