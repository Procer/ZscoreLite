// Código compartido por el servicio de licencias y el comando de administración:
// guarda las licencias en un archivo JSON y firma los tokens que valida la app
// (ver www/js/license.js, que es el otro extremo del contrato).

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DAY = 86400000;
const TOKEN_DAYS = 32; // vigencia de cada token; la app renueva en silencio mucho antes
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // sin 0/O/1/I/L: no se confunden al dictarlos
const TYPES = ['paga', 'cortesia', 'prueba'];

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'license-data');
const DB_FILE = path.join(DATA_DIR, 'licenses.json');
const PRIVATE_KEY_FILE = process.env.PRIVATE_KEY_FILE || path.join(DATA_DIR, 'license-private.pem');

// ---------- Almacenamiento ----------
// Chico y a propósito simple: cada operación lee y escribe el archivo entero
// (alcanza de sobra para cientos de licencias) con reemplazo atómico, así el
// servicio y el comando de administración pueden usarlo a la vez sin pisarse.

function readDb() {
  try {
    const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    return db && typeof db.licenses === 'object' ? db : { licenses: {} };
  } catch (e) {
    return { licenses: {} };
  }
}

function writeDb(db) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${DB_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

/** Lee, aplica `fn(db)` y guarda. Devuelve lo que devuelva `fn`. */
function update(fn) {
  const db = readDb();
  const result = fn(db);
  writeDb(db);
  return result;
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

/** Fecha hasta la que vale el token que se entrega ahora (null = no vence). */
function tokenExpiry(lic, now) {
  if (lic.type === 'cortesia' || lic.paidUntil == null) return null;
  return Math.min(now + TOKEN_DAYS * DAY, lic.paidUntil);
}

function signToken(lic, device, now = Date.now()) {
  const body = b64u(JSON.stringify({
    v: 1, code: lic.code, type: lic.type, dev: device, iat: now, exp: tokenExpiry(lic, now),
  }));
  const sig = crypto.sign('sha256', Buffer.from(body), { key: getPrivateKey(), dsaEncoding: 'ieee-p1363' });
  return `${body}.${b64u(sig)}`;
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
  DAY, TOKEN_DAYS, TYPES, DATA_DIR, DB_FILE,
  readDb, writeDb, update, newCode, normalizeCode,
  signToken, readToken, blockReason,
};
