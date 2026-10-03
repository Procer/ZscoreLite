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
//   node license-admin.cjs publicar-apk RUTA.apk --nombre 1.5 --codigo 6 [--notas "Novedad 1|Novedad 2"]   sube el APK vigente (nombre y versionCode de build.gradle)
//   node license-admin.cjs link ZSL-XXXX-XXXX [--horas 48] [--usos 3]      link personal de descarga para mandar por WhatsApp
//
// Valores por defecto: paga = 30 días, prueba = 14 días, cortesia = sin vencimiento.
// Usa DATA_DIR igual que el servicio (por defecto ./license-data).

'use strict';

const fs = require('fs');
const crypto = require('crypto');
const lib = require('./license-lib.cjs');

const PUBLIC_URL = process.env.PUBLIC_URL || 'https://zscorelite.anka.ar';

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
  case 'publicar-apk': {
    const src = rest[0];
    if (!src || !fs.existsSync(src)) die('uso: publicar-apk RUTA.apk --nombre 1.5 --codigo 6');
    const versionCode = Number(flags.codigo);
    if (!flags.nombre || !(versionCode >= 1)) die('faltan --nombre y --codigo (están en android/app/build.gradle)');
    fs.mkdirSync(lib.APK_DIR, { recursive: true });
    fs.copyFileSync(src, lib.APK_FILE);
    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(lib.APK_FILE)).digest('hex');
    // Novedades que ve el cliente antes de actualizar: "Una cosa|Otra cosa|..." (hasta 10 líneas)
    const notes = String(flags.notas || '').split('|').map((n) => n.trim().slice(0, 200)).filter(Boolean).slice(0, 10);
    const meta = { versionName: flags.nombre, versionCode, notes, sha256, publishedAt: Date.now() };
    fs.writeFileSync(lib.APK_META_FILE, JSON.stringify(meta, null, 2));
    console.log(`APK ${meta.versionName} (código ${versionCode}) publicado. sha256 ${sha256}`);
    console.log(notes.length ? `Novedades:\n${notes.map((n) => `  - ${n}`).join('\n')}` : 'Sin novedades cargadas (agregá --notas "Una cosa|Otra cosa").');
    break;
  }
  case 'link': {
    const hours = flags.horas != null ? Number(flags.horas) : 48;
    const maxUses = flags.usos != null ? Number(flags.usos) : 3;
    if (!(hours > 0) || !(maxUses >= 1)) die('--horas y --usos tienen que ser mayores a 0');
    if (!lib.readApkMeta()) die('todavía no hay un APK publicado (usá publicar-apk)');
    const token = lib.update((db) => {
      const lic = getLicense(db, rest[0]);
      if (stateOf(lic) !== 'activa') die(`la licencia ${lic.code} está ${stateOf(lic)}`);
      return lib.newLink(db, lic.code, { hours, maxUses });
    });
    console.log(`${PUBLIC_URL}/api/license/descargar?t=${token}`);
    console.log(`(vale ${hours} h y ${maxUses} descargas)`);
    break;
  }
  default:
    console.log('Comandos: crear, listar, ver, extender, revocar, reactivar, resetear, publicar-apk, link (ver el encabezado de este archivo).');
    process.exit(cmd ? 1 : 0);
}
