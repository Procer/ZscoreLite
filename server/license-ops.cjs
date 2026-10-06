// Operaciones sobre licencias: las usan el comando de administración y, más adelante,
// el panel y el cobro. Cada función trabaja sobre `db` (siempre dentro de `lib.update`),
// anota el cambio en el historial de la licencia y devuelve la licencia modificada.
// Los errores de uso se lanzan como OpError: el que llama decide cómo mostrarlos.

'use strict';

const lib = require('./license-lib.cjs');

const { OpError } = lib;

const DEFAULT_DAYS = { paga: 30, prueba: 14 };
const LIMITS = { note: 300, customer: 120, contact: 120 };

function stateOf(lic, now = Date.now()) {
  if (lic.revoked) return 'revocada';
  if (lic.type !== 'cortesia' && lic.paidUntil != null && lic.paidUntil < now) return 'vencida';
  return 'activa';
}

function getLicense(db, rawCode) {
  const code = lib.normalizeCode(rawCode);
  const lic = db.licenses[code];
  if (!lic) throw new OpError(`no existe la licencia ${code || '(falta el código)'}`);
  return lic;
}

function text(value, field) {
  return String(value == null ? '' : value).trim().slice(0, LIMITS[field]);
}

function parsePositive(value, what) {
  const n = Number(value);
  if (!(n > 0)) throw new OpError(`${what} tiene que ser un número mayor a 0`);
  return n;
}

function parsePrice(value) {
  if (value === '' || value == null) return null;
  const n = Number(value);
  if (!(n >= 0)) throw new OpError('el precio tiene que ser un número de 0 en adelante');
  return n;
}

function parseCurrency(value) {
  const c = String(value).trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(c)) throw new OpError('la moneda tiene que ser un código de 3 letras (ARS, USD)');
  return c;
}

function parseDevices(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new OpError('los dispositivos tienen que ser un entero de 1 en adelante');
  return n;
}

function crear(db, opts, actor) {
  const type = opts.type || 'paga';
  if (!lib.TYPES.includes(type)) throw new OpError(`tipo inválido (${lib.TYPES.join(', ')})`);
  let days = null;
  if (type !== 'cortesia') days = parsePositive(opts.days != null ? opts.days : DEFAULT_DAYS[type], 'los días');
  const maxDevices = opts.maxDevices != null ? parseDevices(opts.maxDevices) : 1;

  const code = lib.newCode(db);
  const lic = {
    code, type, note: text(opts.note, 'note'), customer: text(opts.customer, 'customer'), contact: text(opts.contact, 'contact'),
    price: opts.price != null ? parsePrice(opts.price) : null,
    currency: opts.currency != null ? parseCurrency(opts.currency) : 'ARS',
    createdAt: Date.now(),
    paidUntil: days == null ? null : Date.now() + days * lib.DAY,
    maxDevices, devices: [], revoked: false, events: [],
  };
  db.licenses[code] = lic;
  lib.addEvent(lic, 'creada', actor, days == null ? `${type}, sin vencimiento` : `${type}, ${days} días`);
  return lic;
}

function extender(db, rawCode, rawDays, actor) {
  const lic = getLicense(db, rawCode);
  const days = parsePositive(rawDays, 'los días');
  if (lic.type === 'cortesia') throw new OpError('las licencias de cortesía no vencen');
  lic.paidUntil = Math.max(lic.paidUntil || 0, Date.now()) + days * lib.DAY;
  lib.addEvent(lic, 'extendida', actor, `+${days} días, vence ${new Date(lic.paidUntil).toISOString().slice(0, 10)}`);
  return lic;
}

/** Pasa una prueba (o cortesía) a paga. El celular toma el cambio cuando renueva su certificado. */
function convertir(db, rawCode, rawDays, actor) {
  const lic = getLicense(db, rawCode);
  if (lic.type === 'paga') throw new OpError('la licencia ya es paga');
  const days = parsePositive(rawDays != null ? rawDays : DEFAULT_DAYS.paga, 'los días');
  const from = lic.type;
  lic.type = 'paga';
  lic.paidUntil = Math.max(lic.paidUntil || 0, Date.now()) + days * lib.DAY;
  lib.addEvent(lic, 'convertida', actor, `${from} a paga, +${days} días, vence ${new Date(lic.paidUntil).toISOString().slice(0, 10)}`);
  return lic;
}

function revocar(db, rawCode, actor) {
  const lic = getLicense(db, rawCode);
  lic.revoked = true;
  lib.addEvent(lic, 'revocada', actor);
  return lic;
}

function reactivar(db, rawCode, actor) {
  const lic = getLicense(db, rawCode);
  lic.revoked = false;
  lib.addEvent(lic, 'reactivada', actor);
  return lic;
}

function resetear(db, rawCode, actor) {
  const lic = getLicense(db, rawCode);
  const n = lic.devices.length;
  lic.devices = [];
  lib.addEvent(lic, 'reseteada', actor, `se liberaron ${n} dispositivo(s)`);
  return lic;
}

/** Cambia solo los campos que vienen definidos: note, customer, contact, price, currency. */
function editar(db, rawCode, fields, actor) {
  const lic = getLicense(db, rawCode);
  const changed = [];
  for (const f of ['note', 'customer', 'contact']) {
    if (fields[f] !== undefined) { lic[f] = text(fields[f], f); changed.push(f); }
  }
  if (fields.price !== undefined) { lic.price = parsePrice(fields.price); changed.push('price'); }
  if (fields.currency !== undefined) { lic.currency = parseCurrency(fields.currency); changed.push('currency'); }
  if (!changed.length) throw new OpError('no hay nada para cambiar');
  lib.addEvent(lic, 'editada', actor, changed.join(', '));
  return lic;
}

function dispositivos(db, rawCode, rawN, actor) {
  const lic = getLicense(db, rawCode);
  const n = parseDevices(rawN);
  const before = lic.maxDevices;
  lic.maxDevices = n;
  lib.addEvent(lic, 'dispositivos', actor, `máximo ${before} a ${n}`);
  return lic;
}

module.exports = {
  OpError, DEFAULT_DAYS, stateOf, getLicense,
  crear, extender, convertir, revocar, reactivar, resetear, editar, dispositivos,
};
