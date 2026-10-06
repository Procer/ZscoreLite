// Pruebas del servicio de licencias: node --test server/test/
// Cada archivo de prueba usa su propia carpeta temporal y su propia clave; no toca datos reales.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const SERVER_DIR = path.join(__dirname, '..');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'zslite-test-'));
const KEY_FILE = path.join(DATA_DIR, 'license-private.pem');

const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
fs.writeFileSync(KEY_FILE, privateKey.export({ type: 'pkcs8', format: 'pem' }));

process.env.DATA_DIR = DATA_DIR;
process.env.PRIVATE_KEY_FILE = KEY_FILE;
const { freePort } = require('./helpers.cjs');
const lib = require('../license-lib.cjs');
const ops = require('../license-ops.cjs');

const childEnv = { ...process.env, DATA_DIR, PRIVATE_KEY_FILE: KEY_FILE };

function resetDb() {
  for (const f of fs.readdirSync(DATA_DIR)) if (f.startsWith('licenses.json')) fs.rmSync(path.join(DATA_DIR, f));
}

function cli(...args) {
  return spawnSync(process.execPath, [path.join(SERVER_DIR, 'license-admin.cjs'), ...args], { env: childEnv, encoding: 'utf8' });
}

test.after(() => fs.rmSync(DATA_DIR, { recursive: true, force: true }));

test('crear: valores por defecto, campos nuevos e historial', () => {
  resetDb();
  const lic = lib.update((db) => ops.crear(db, { type: 'prueba', customer: ' Club Sur ', price: '15000', currency: 'usd' }, 'cli'));
  assert.match(lic.code, /^ZSL-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  assert.equal(lic.customer, 'Club Sur');
  assert.equal(lic.price, 15000);
  assert.equal(lic.currency, 'USD');
  assert.equal(Math.round((lic.paidUntil - lic.createdAt) / lib.DAY), 14);
  assert.equal(lic.events.length, 1);
  assert.equal(lic.events[0].type, 'creada');
  assert.equal(lib.readDb().version, lib.SCHEMA_VERSION);
});

test('crear: cortesía no vence y valida entradas', () => {
  resetDb();
  const c = lib.update((db) => ops.crear(db, { type: 'cortesia' }, 'cli'));
  assert.equal(c.paidUntil, null);
  assert.equal(ops.stateOf(c), 'activa');
  assert.throws(() => lib.update((db) => ops.crear(db, { type: 'oro' }, 'cli')), ops.OpError);
  assert.throws(() => lib.update((db) => ops.crear(db, { days: -3 }, 'cli')), ops.OpError);
  assert.throws(() => lib.update((db) => ops.crear(db, { price: 'abc' }, 'cli')), ops.OpError);
  assert.throws(() => lib.update((db) => ops.crear(db, { currency: 'pesos' }, 'cli')), ops.OpError);
  assert.throws(() => lib.update((db) => ops.crear(db, { maxDevices: 1.5 }, 'cli')), ops.OpError);
});

test('una operación que falla no guarda nada', () => {
  resetDb();
  const code = lib.update((db) => ops.crear(db, { type: 'cortesia' }, 'cli')).code;
  const before = fs.readFileSync(path.join(DATA_DIR, 'licenses.json'), 'utf8');
  assert.throws(() => lib.update((db) => { ops.revocar(db, code, 'cli'); ops.extender(db, code, 10, 'cli'); }), ops.OpError);
  assert.equal(fs.readFileSync(path.join(DATA_DIR, 'licenses.json'), 'utf8'), before);
  assert.equal(fs.existsSync(path.join(DATA_DIR, 'licenses.json.lock')), false, 'el bloqueo se libera');
});

test('extender, convertir, revocar, reactivar, resetear, editar y dispositivos', () => {
  resetDb();
  const code = lib.update((db) => ops.crear(db, { type: 'prueba' }, 'cli')).code;

  let lic = lib.update((db) => ops.extender(db, code, 10, 'panel'));
  assert.equal(Math.round((lic.paidUntil - lic.createdAt) / lib.DAY), 24);

  lic = lib.update((db) => ops.convertir(db, code, undefined, 'panel'));
  assert.equal(lic.type, 'paga');
  assert.equal(Math.round((lic.paidUntil - lic.createdAt) / lib.DAY), 54);
  assert.throws(() => lib.update((db) => ops.convertir(db, code, 30, 'panel')), /ya es paga/);

  lic = lib.update((db) => ops.revocar(db, code, 'cli'));
  assert.equal(ops.stateOf(lic), 'revocada');
  lic = lib.update((db) => ops.reactivar(db, code, 'cli'));
  assert.equal(ops.stateOf(lic), 'activa');

  lib.update((db) => { db.licenses[code].devices.push({ id: 'dispositivo-1', activatedAt: 1 }); });
  lic = lib.update((db) => ops.resetear(db, code, 'cli'));
  assert.deepEqual(lic.devices, []);

  lic = lib.update((db) => ops.editar(db, code, { note: 'nota', contact: '11-5555' }, 'cli'));
  assert.equal(lic.note, 'nota');
  assert.equal(lic.contact, '11-5555');
  assert.equal(lic.customer, '', 'lo que no se pasó queda igual');
  assert.throws(() => lib.update((db) => ops.editar(db, code, {}, 'cli')), /nada para cambiar/);

  lic = lib.update((db) => ops.dispositivos(db, code, 3, 'cli'));
  assert.equal(lic.maxDevices, 3);

  const types = lic.events.map((e) => e.type);
  assert.deepEqual(types, ['creada', 'extendida', 'convertida', 'revocada', 'reactivada', 'reseteada', 'editada', 'dispositivos']);
  assert.equal(lic.events[1].actor, 'panel');
});

test('extender una vencida cuenta desde hoy', () => {
  resetDb();
  const code = lib.update((db) => {
    const l = ops.crear(db, { type: 'paga' }, 'cli');
    l.paidUntil = Date.now() - 20 * lib.DAY;
    return l.code;
  });
  assert.equal(ops.stateOf(lib.readDb().licenses[code]), 'vencida');
  const lic = lib.update((db) => ops.extender(db, code, 30, 'cli'));
  assert.equal(Math.round((lic.paidUntil - Date.now()) / lib.DAY), 30);
});

test('el historial se recorta a los últimos 200 eventos', () => {
  resetDb();
  const lic = lib.update((db) => {
    const l = ops.crear(db, { type: 'cortesia' }, 'cli');
    for (let i = 0; i < 250; i++) lib.addEvent(l, 'prueba', 'cli', `n${i}`);
    return l;
  });
  assert.equal(lic.events.length, 200);
  assert.equal(lic.events[199].detail, 'n249');
});

test('migración de una base v1: copia de seguridad y campos nuevos', () => {
  resetDb();
  const v1 = { licenses: { 'ZSL-AAAA-BBBB': { code: 'ZSL-AAAA-BBBB', type: 'paga', note: 'vieja', createdAt: 1, paidUntil: 2e12, maxDevices: 1, devices: [{ id: 'x', activatedAt: 1 }], revoked: false } }, links: {} };
  fs.writeFileSync(path.join(DATA_DIR, 'licenses.json'), JSON.stringify(v1));

  const seen = lib.readDb().licenses['ZSL-AAAA-BBBB'];
  assert.equal(seen.currency, 'ARS');
  assert.deepEqual(seen.events, []);

  lib.update((db) => ops.editar(db, 'ZSL-AAAA-BBBB', { customer: 'Club Norte' }, 'cli'));
  const saved = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'licenses.json'), 'utf8'));
  assert.equal(saved.version, lib.SCHEMA_VERSION);
  assert.equal(saved.licenses['ZSL-AAAA-BBBB'].customer, 'Club Norte');
  assert.equal(saved.licenses['ZSL-AAAA-BBBB'].note, 'vieja');
  const backups = fs.readdirSync(DATA_DIR).filter((f) => f.startsWith('licenses.json.v1-'));
  assert.equal(backups.length, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(DATA_DIR, backups[0]), 'utf8')), v1);

  lib.update(() => {}); // ya migrada: no vuelve a hacer copia
  assert.equal(fs.readdirSync(DATA_DIR).filter((f) => f.startsWith('licenses.json.v1-')).length, 1);
});

test('un licenses.json ilegible no se pisa', () => {
  resetDb();
  const file = path.join(DATA_DIR, 'licenses.json');
  fs.writeFileSync(file, '{ esto no es json');
  assert.throws(() => lib.readDb(), /ilegible/);
  assert.throws(() => lib.update((db) => ops.crear(db, { type: 'cortesia' }, 'cli')), /ilegible/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{ esto no es json');
  assert.equal(fs.existsSync(`${file}.lock`), false);
});

test('un bloqueo viejo (proceso muerto) se ignora', () => {
  resetDb();
  const lock = path.join(DATA_DIR, 'licenses.json.lock');
  fs.writeFileSync(lock, '99999');
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(lock, old, old);
  lib.update((db) => ops.crear(db, { type: 'cortesia' }, 'cli'));
  assert.equal(Object.keys(lib.readDb().licenses).length, 1);
  assert.equal(fs.existsSync(lock), false);
});

test('escrituras simultáneas desde varios procesos no pierden ninguna', async () => {
  resetDb();
  const N = 24;
  const runs = Array.from({ length: N }, (_, i) => new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(SERVER_DIR, 'license-admin.cjs'), 'crear', '--tipo', 'cortesia', '--nota', `n${i}`], { env: childEnv });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => resolve({ code, err }));
  }));
  const results = await Promise.all(runs);
  for (const r of results) assert.equal(r.code, 0, r.err);
  const all = Object.values(lib.readDb().licenses);
  assert.equal(all.length, N);
  assert.deepEqual(all.map((l) => l.note).sort(), Array.from({ length: N }, (_, i) => `n${i}`).sort());
});

test('comando: errores de uso salen con mensaje y sin dejar bloqueo', () => {
  resetDb();
  const r = cli('extender', 'ZSL-NOPE-NOPE', '5');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no existe la licencia/);
  assert.equal(fs.existsSync(path.join(DATA_DIR, 'licenses.json.lock')), false);
});

test('comando: crear, editar, convertir y ver muestran lo esperado', () => {
  resetDb();
  const out = cli('crear', '--tipo', 'prueba', '--cliente', 'Club Este', '--precio', '9000').stdout;
  const code = out.match(/ZSL-[A-Z0-9]{4}-[A-Z0-9]{4}/)[0];
  assert.equal(cli('editar', code, '--contacto', 'a@b.com').status, 0);
  assert.equal(cli('convertir', code, '--dias', '30').status, 0);
  const ver = cli('ver', code).stdout;
  assert.match(ver, /Club Este/);
  assert.match(ver, /a@b\.com/);
  assert.match(ver, /precio: 9000 ARS/);
  assert.match(ver, /convertida/);
  assert.match(ver, /paga/);
});

test('tokens: firma, lectura y reglas de bloqueo', () => {
  resetDb();
  const lic = lib.update((db) => ops.crear(db, { type: 'paga' }, 'cli'));
  const token = lib.signToken(lic, 'dispositivo-de-prueba');
  const payload = lib.readToken(token);
  assert.equal(payload.code, lic.code);
  assert.equal(payload.dev, 'dispositivo-de-prueba');
  assert.ok(payload.exp <= lic.paidUntil);
  assert.equal(lib.readToken(token.slice(0, -4) + 'AAAA'), null, 'firma alterada');
  assert.equal(lib.blockReason(lic), null);
  assert.equal(lib.blockReason({ ...lic, revoked: true }), 'revocada');
  assert.equal(lib.blockReason({ ...lic, paidUntil: Date.now() - 1 }), 'vencida');
  assert.equal(lib.blockReason({ ...lic, type: 'cortesia', paidUntil: Date.now() - 1 }), null);
});

test('cortesía: el certificado vence a los 32 días y revocarla corta la renovación', () => {
  resetDb();
  const lic = lib.update((db) => ops.crear(db, { type: 'cortesia' }, 'cli'));
  assert.equal(lic.paidUntil, null);
  const now = Date.now();
  const token = lib.update((db) => lib.issueToken(db.licenses[lic.code], 'dispositivo-cortesia', now));
  const payload = lib.readToken(token);
  assert.equal(payload.type, 'cortesia');
  assert.equal(payload.exp, now + lib.TOKEN_DAYS * lib.DAY);
  assert.equal(lib.readDb().licenses[lic.code].tokenExp, payload.exp, 'el panel ve hasta cuándo vale el certificado');
  assert.equal(lib.blockReason(lib.readDb().licenses[lic.code]), null);
  lib.update((db) => ops.revocar(db, lic.code, 'cli'));
  assert.equal(lib.blockReason(lib.readDb().licenses[lic.code]), 'revocada', 'ya no renueva');
});

test('servicio: activar, mismo dispositivo, otro dispositivo, revocada y historial', async () => {
  resetDb();
  const lic = lib.update((db) => ops.crear(db, { type: 'paga' }, 'cli'));
  const port = await freePort();
  const server = spawn(process.execPath, [path.join(SERVER_DIR, 'license-server.cjs')], { env: { ...childEnv, PORT: String(port) } });
  try {
    await new Promise((resolve, reject) => {
      server.stdout.on('data', (d) => { if (String(d).includes('escuchando')) resolve(); });
      server.on('error', reject);
      server.on('exit', () => reject(new Error('el servicio no arrancó')));
    });
    const post = async (route, body) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/license/${route}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      return { status: res.status, body: await res.json() };
    };

    const a = await post('activar', { code: lic.code, device: 'dispositivo-aaaa-1111' });
    assert.equal(a.status, 200);
    assert.ok(lib.readToken(a.body.token));

    assert.equal((await post('activar', { code: lic.code, device: 'dispositivo-aaaa-1111' })).status, 200);
    const other = await post('activar', { code: lic.code, device: 'dispositivo-bbbb-2222' });
    assert.equal(other.status, 409);
    assert.equal(other.body.error, 'en_uso');
    assert.equal((await post('activar', { code: 'ZSL-ZZZZ-ZZZZ', device: 'dispositivo-aaaa-1111' })).status, 404);

    assert.equal((await post('renovar', { token: a.body.token, device: 'dispositivo-aaaa-1111' })).status, 200);

    // El panel/CLI escribe mientras el servicio está andando: ninguno pisa al otro.
    assert.equal(cli('revocar', lic.code).status, 0);
    const rev = await post('renovar', { token: a.body.token, device: 'dispositivo-aaaa-1111' });
    assert.equal(rev.status, 403);
    assert.equal(rev.body.error, 'revocada');

    const events = lib.readDb().licenses[lic.code].events.map((e) => e.type);
    assert.deepEqual(events, ['creada', 'dispositivo', 'revocada']);
  } finally {
    server.kill();
  }
});
