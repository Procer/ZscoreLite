#!/usr/bin/env node
// Administración de licencias de Z-Score Lite (se corre en el VPS).
//
//   node license-admin.cjs crear [--tipo paga|cortesia|prueba] [--dias N] [--nota "texto"] [--dispositivos N]
//                                [--cliente "nombre"] [--contacto "tel/mail"] [--precio N] [--moneda ARS]
//   node license-admin.cjs listar
//   node license-admin.cjs ver ZSL-XXXX-XXXX               datos, dispositivos e historial
//   node license-admin.cjs editar ZSL-XXXX-XXXX [--nota ..] [--cliente ..] [--contacto ..] [--precio N] [--moneda ARS]
//   node license-admin.cjs convertir ZSL-XXXX-XXXX [--dias 30]   pasa una prueba/cortesía a paga
//   node license-admin.cjs dispositivos ZSL-XXXX-XXXX N     cambia el máximo de dispositivos
//   node license-admin.cjs extender ZSL-XXXX-XXXX DIAS     suma días de pago (desde hoy si ya venció)
//   node license-admin.cjs revocar ZSL-XXXX-XXXX           corta el acceso (en la próxima renovación de la app)
//   node license-admin.cjs reactivar ZSL-XXXX-XXXX         deshace una revocación
//   node license-admin.cjs resetear ZSL-XXXX-XXXX          libera el dispositivo (cambio de celular)
//   node license-admin.cjs panel-clave [--usuario admin]     crea o cambia la contraseña del panel (/admin); la pide sin mostrarla
//   node license-admin.cjs publicar-apk RUTA.apk --nombre 1.5 --codigo 6 [--notas "Novedad 1|Novedad 2"]   sube el APK vigente (nombre y versionCode de build.gradle)
//   node license-admin.cjs link ZSL-XXXX-XXXX [--horas 48] [--usos 3]      link personal de descarga para mandar por WhatsApp
//
// Valores por defecto: paga = 30 días, prueba = 14 días, cortesia = sin vencimiento.
// Usa DATA_DIR igual que el servicio (por defecto ./license-data).
// Cada cambio queda en el historial de la licencia (actor "cli"). La lógica vive en license-ops.cjs.

'use strict';

const fs = require('fs');
const lib = require('./license-lib.cjs');
const ops = require('./license-ops.cjs');

const PUBLIC_URL = process.env.PUBLIC_URL || 'https://lite.zscore.ar';
const ACTOR = 'cli';

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
  const s = ops.stateOf(lic);
  return s === 'revocada' ? 'REVOCADA' : s;
}

function describe(lic) {
  return [
    `${lic.code}  ${lic.type.padEnd(8)} ${stateOf(lic).padEnd(8)} vence: ${fmt(lic.paidUntil).padEnd(16)}`,
    `disp: ${lic.devices.length}/${lic.maxDevices}`,
    lic.customer ? `· ${lic.customer}` : '',
    lic.note ? `· ${lic.note}` : '',
  ].join('  ');
}

/** Un valor de --flag, o undefined si no se pasó (para que `editar` toque solo lo pedido). */
const flag = (flags, name) => (flags[name] !== undefined ? flags[name] : undefined);

const [cmd, ...args] = process.argv.slice(2);
const { flags, rest } = parseFlags(args);

function run() {
  switch (cmd) {
    case 'crear': {
      const lic = lib.update((db) => ops.crear(db, {
        type: flags.tipo, days: flags.dias, note: flags.nota, maxDevices: flags.dispositivos,
        customer: flags.cliente, contact: flags.contacto, price: flags.precio, currency: flags.moneda,
      }, ACTOR));
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
      const lic = ops.getLicense(lib.readDb(), rest[0]);
      console.log(describe(lic));
      console.log(`creada: ${fmt(lic.createdAt)}   última conexión: ${lic.lastSeenAt ? new Date(lic.lastSeenAt).toLocaleString('es-AR') : 'nunca'}`);
      if (lic.customer || lic.contact) console.log(`cliente: ${lic.customer || '-'}   contacto: ${lic.contact || '-'}`);
      if (lic.price != null) console.log(`precio: ${lic.price} ${lic.currency}`);
      for (const d of lic.devices) console.log(`dispositivo ${d.id}  activado ${new Date(d.activatedAt).toLocaleString('es-AR')}`);
      if (lic.events.length) {
        console.log('historial (últimos 15):');
        for (const e of lic.events.slice(-15)) {
          console.log(`  ${new Date(e.at).toLocaleString('es-AR')}  ${e.type.padEnd(12)} ${e.actor.padEnd(6)} ${e.detail}`);
        }
      }
      break;
    }
    case 'editar': {
      const lic = lib.update((db) => ops.editar(db, rest[0], {
        note: flag(flags, 'nota'), customer: flag(flags, 'cliente'), contact: flag(flags, 'contacto'),
        price: flag(flags, 'precio'), currency: flag(flags, 'moneda'),
      }, ACTOR));
      console.log(describe(lic));
      break;
    }
    case 'convertir': {
      const lic = lib.update((db) => ops.convertir(db, rest[0], flags.dias, ACTOR));
      console.log(describe(lic));
      console.log('El celular toma el cambio cuando renueva su certificado (sola, o desde Configuración > Renovar).');
      break;
    }
    case 'dispositivos': {
      const lic = lib.update((db) => ops.dispositivos(db, rest[0], rest[1], ACTOR));
      console.log(describe(lic));
      break;
    }
    case 'extender': {
      const lic = lib.update((db) => ops.extender(db, rest[0], rest[1], ACTOR));
      console.log(describe(lic));
      break;
    }
    case 'revocar':
    case 'reactivar': {
      const lic = lib.update((db) => (cmd === 'revocar' ? ops.revocar(db, rest[0], ACTOR) : ops.reactivar(db, rest[0], ACTOR)));
      console.log(describe(lic));
      if (cmd === 'revocar') console.log('La app deja de renovar; se bloquea cuando venza su token actual (hasta 32 días + gracia).');
      break;
    }
    case 'resetear': {
      const lic = lib.update((db) => ops.resetear(db, rest[0], ACTOR));
      console.log(describe(lic));
      console.log('Listo: el próximo dispositivo que active este código queda asociado.');
      break;
    }
    case 'publicar-apk': {
      const src = rest[0];
      if (!src || !fs.existsSync(src)) die('uso: publicar-apk RUTA.apk --nombre 1.5 --codigo 6');
      if (!flags.nombre || !(Number(flags.codigo) >= 1)) die('faltan --nombre y --codigo (están en android/app/build.gradle)');
      // Novedades que ve el cliente antes de actualizar: "Una cosa|Otra cosa|..." (hasta 10 líneas)
      const meta = lib.publishApk(src, {
        versionName: flags.nombre, versionCode: Number(flags.codigo), notes: String(flags.notas || '').split('|'), force: true,
      });
      console.log(`APK ${meta.versionName} (código ${meta.versionCode}) publicado. sha256 ${meta.sha256}`);
      console.log(meta.notes.length ? `Novedades:\n${meta.notes.map((n) => `  - ${n}`).join('\n')}` : 'Sin novedades cargadas (agregá --notas "Una cosa|Otra cosa").');
      break;
    }
    case 'link': {
      const hours = flags.horas != null ? Number(flags.horas) : 48;
      const maxUses = flags.usos != null ? Number(flags.usos) : 3;
      if (!(hours > 0) || !(maxUses >= 1)) die('--horas y --usos tienen que ser mayores a 0');
      if (!lib.readApkMeta()) die('todavía no hay un APK publicado (usá publicar-apk)');
      const token = lib.update((db) => {
        const lic = ops.getLicense(db, rest[0]);
        const state = ops.stateOf(lic);
        if (state !== 'activa') throw new ops.OpError(`la licencia ${lic.code} está ${state}`);
        lib.addEvent(lic, 'link', ACTOR, `${hours} h, ${maxUses} usos`);
        return lib.newLink(db, lic.code, { hours, maxUses });
      });
      console.log(`${PUBLIC_URL}/api/license/descargar?t=${token}`);
      console.log(`(vale ${hours} h y ${maxUses} descargas)`);
      break;
    }
    case 'panel-clave':
      return setPanelPassword();
    default:
      console.log('Comandos: panel-clave, crear, listar, ver, editar, convertir, dispositivos, extender, revocar, reactivar, resetear, publicar-apk, link (ver el encabezado de este archivo).');
      process.exit(cmd ? 1 : 0);
  }
}

/** Lee una línea sin mostrarla (contraseña). Sin terminal, toma la primera línea de la entrada. */
function readSecret(prompt) {
  return new Promise((resolve) => {
    process.stderr.write(prompt);
    if (!process.stdin.isTTY) {
      let data = '';
      process.stdin.on('data', (c) => { data += c; });
      process.stdin.on('end', () => resolve(data.split(/\r?\n/)[0]));
      return;
    }
    let value = '';
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    const onData = (ch) => {
      for (const c of ch) {
        if (c === '\u0003') { process.stderr.write('\n'); process.exit(130); }
        if (c === '\r' || c === '\n') {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.removeListener('data', onData);
          process.stderr.write('\n');
          return resolve(value);
        }
        if (c === '\u007f' || c === '\b') value = value.slice(0, -1);
        else value += c;
      }
    };
    process.stdin.on('data', onData);
  });
}

async function setPanelPassword() {
  const panel = require('./license-panel.cjs');
  const user = flags.usuario || 'admin';
  const first = await readSecret(`Contraseña nueva para "${user}" (mínimo ${panel.MIN_PASSWORD} caracteres): `);
  if (process.stdin.isTTY) {
    const again = await readSecret('Repetila: ');
    if (first !== again) die('las dos contraseñas no coinciden');
  }
  await panel.setPassword(user, first);
  console.log(`Listo. Usuario "${user}". Ingresá en ${PUBLIC_URL}/admin`);
  console.log('Si el servicio estaba corriendo, las sesiones abiertas siguen hasta que venzan: para cerrarlas, reiniciá: systemctl restart zscore-license');
}

function fail(e) {
  die(e instanceof ops.OpError ? e.message : (e && e.message) || String(e));
}

Promise.resolve().then(run).catch(fail);
