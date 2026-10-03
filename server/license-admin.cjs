#!/usr/bin/env node
// Administración de licencias de Z-Score Lite (se corre en el VPS).
//
//   node license-admin.cjs crear [--tipo paga|cortesia|prueba] [--dias N] [--nota "texto"] [--dispositivos N]
//   node license-admin.cjs listar
//   node license-admin.cjs ver ZSL-XXXX-XXXX
//   node license-admin.cjs extender ZSL-XXXX-XXXX DIAS     suma días de pago (desde hoy si ya venció)
//   node license-admin.cjs revocar ZSL-XXXX-XXXX           corta el acceso (en la próxima renovación de la app)
//   node license-admin.cjs reactivar ZSL-XXXX-XXXX         deshace una revocación
//   node license-admin.cjs resetear ZSL-XXXX-XXXX          libera el dispositivo (cambio de celular)
//
// Valores por defecto: paga = 30 días, prueba = 14 días, cortesia = sin vencimiento.
// Usa DATA_DIR igual que el servicio (por defecto ./license-data).

'use strict';

const lib = require('./license-lib.cjs');

const DEFAULT_DAYS = { paga: 30, prueba: 14 };

function parseFlags(args) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) flags[args[i].slice(2)] = args[++i];
    else rest.push(args[i]);
  }
  return { flags, rest };
}

function die(msg) {
  console.error(`Error: ${msg}`);
  process.exit(1);
}

function fmt(ms) {
  return ms == null ? 'sin vencimiento' : new Date(ms).toLocaleDateString('es-AR');
}

function stateOf(lic) {
  if (lic.revoked) return 'REVOCADA';
  if (lic.type !== 'cortesia' && lic.paidUntil != null && lic.paidUntil < Date.now()) return 'vencida';
  return 'activa';
}

function describe(lic) {
  return [
    `${lic.code}  ${lic.type.padEnd(8)} ${stateOf(lic).padEnd(8)} vence: ${fmt(lic.paidUntil).padEnd(16)}`,
    `disp: ${lic.devices.length}/${lic.maxDevices}`,
    lic.note ? `· ${lic.note}` : '',
  ].join('  ');
}

function getLicense(db, rawCode) {
  const code = lib.normalizeCode(rawCode);
  const lic = db.licenses[code];
  if (!lic) die(`no existe la licencia ${code || '(falta el código)'}`);
  return lic;
}

const [cmd, ...args] = process.argv.slice(2);
const { flags, rest } = parseFlags(args);

switch (cmd) {
  case 'crear': {
    const type = flags.tipo || 'paga';
    if (!lib.TYPES.includes(type)) die(`tipo inválido (${lib.TYPES.join(', ')})`);
    const days = flags.dias != null ? Number(flags.dias) : DEFAULT_DAYS[type];
    if (type !== 'cortesia' && !(days > 0)) die('--dias tiene que ser un número mayor a 0');
    const maxDevices = flags.dispositivos != null ? Number(flags.dispositivos) : 1;
    if (!(maxDevices >= 1)) die('--dispositivos tiene que ser 1 o más');
    const lic = lib.update((db) => {
      const code = lib.newCode(db);
      const created = {
        code, type, note: flags.nota || '', createdAt: Date.now(),
        paidUntil: type === 'cortesia' ? null : Date.now() + days * lib.DAY,
        maxDevices, devices: [], revoked: false,
      };
      db.licenses[code] = created;
      return created;
    });
    console.log(describe(lic));
    console.log(`\nCódigo para entregar: ${lic.code}`);
    break;
  }
  case 'listar': {
    const all = Object.values(lib.readDb().licenses).sort((a, b) => a.createdAt - b.createdAt);
    if (!all.length) console.log('No hay licencias.');
    for (const lic of all) console.log(describe(lic));
    break;
  }
  case 'ver': {
    const lic = getLicense(lib.readDb(), rest[0]);
    console.log(describe(lic));
    console.log(`creada: ${fmt(lic.createdAt)}   última conexión: ${lic.lastSeenAt ? new Date(lic.lastSeenAt).toLocaleString('es-AR') : 'nunca'}`);
    for (const d of lic.devices) console.log(`dispositivo ${d.id}  activado ${new Date(d.activatedAt).toLocaleString('es-AR')}`);
    break;
  }
  case 'extender': {
    const days = Number(rest[1]);
    if (!(days > 0)) die('uso: extender ZSL-XXXX-XXXX DIAS');
    const lic = lib.update((db) => {
      const l = getLicense(db, rest[0]);
      if (l.type === 'cortesia') die('las licencias de cortesía no vencen');
      l.paidUntil = Math.max(l.paidUntil || 0, Date.now()) + days * lib.DAY;
      return l;
    });
    console.log(describe(lic));
    break;
  }
  case 'revocar':
  case 'reactivar': {
    const lic = lib.update((db) => {
      const l = getLicense(db, rest[0]);
      l.revoked = cmd === 'revocar';
      return l;
    });
    console.log(describe(lic));
    if (cmd === 'revocar') console.log('La app deja de renovar; se bloquea cuando venza su token actual (hasta 32 días + gracia).');
    break;
  }
  case 'resetear': {
    const lic = lib.update((db) => {
      const l = getLicense(db, rest[0]);
      l.devices = [];
      return l;
    });
    console.log(describe(lic));
    console.log('Listo: el próximo dispositivo que active este código queda asociado.');
    break;
  }
  default:
    console.log('Comandos: crear, listar, ver, extender, revocar, reactivar, resetear (ver el encabezado de este archivo).');
    process.exit(cmd ? 1 : 0);
}
