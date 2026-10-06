// Pruebas de la prueba por autoservicio (POST /api/license/prueba). node --test server/test/

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const SERVER_DIR = path.join(__dirname, '..');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'zslite-trial-'));
const KEY_FILE = path.join(DATA_DIR, 'license-private.pem');
fs.writeFileSync(KEY_FILE, crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' }));

process.env.DATA_DIR = DATA_DIR;
process.env.PRIVATE_KEY_FILE = KEY_FILE;
const { freePort } = require('./helpers.cjs');
const lib = require('../license-lib.cjs');
const ops = require('../license-ops.cjs');

const servers = [];
async function start(env = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(SERVER_DIR, 'license-server.cjs')], { env: { ...process.env, PORT: String(port), ...env } });
  servers.push(child);
  return new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => { if (String(d).includes('escuchando')) resolve(`http://127.0.0.1:${port}`); });
    child.on('exit', () => reject(new Error('el servicio no arrancó')));
  });
}

test.after(() => {
  for (const s of servers) s.kill();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

const device = (n) => `dispositivo-prueba-${String(n).padStart(4, '0')}`;

async function ask(base, dev, ip = '10.0.0.1') {
  const res = await fetch(`${base}/api/license/prueba`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Real-IP': ip }, body: JSON.stringify({ device: dev }),
  });
  return { status: res.status, body: await res.json() };
}

test('una prueba nueva crea una licencia prueba ya activada en ese celular', async () => {
  const base = await start();
  const r = await ask(base, device(1));
  assert.equal(r.status, 200);
  assert.equal(r.body.days, 14);
  const payload = lib.readToken(r.body.token);
  assert.equal(payload.type, 'prueba');
  assert.equal(payload.dev, device(1));
  assert.ok(payload.exp - Date.now() <= 14 * lib.DAY + 1000);

  const all = Object.values(lib.readDb().licenses);
  assert.equal(all.length, 1);
  assert.equal(all[0].note, 'Prueba autoservicio');
  assert.equal(all[0].devices.length, 1);
  assert.deepEqual(all[0].events.map((e) => e.type), ['creada', 'dispositivo']);
  const raw = fs.readFileSync(path.join(DATA_DIR, 'licenses.json'), 'utf8');
  assert.ok(!raw.includes('10.0.0.1'), 'la IP no se guarda en claro');
});

test('el mismo celular pidiendo otra vez recibe su misma prueba; no se crea otra', async () => {
  const base = await start();
  const again = await ask(base, device(1));
  assert.equal(again.status, 200);
  assert.equal(lib.readToken(again.body.token).dev, device(1));
  assert.equal(Object.keys(lib.readDb().licenses).length, 1);
});

test('si la prueba ya no está al día, ese celular no puede pedir otra', async () => {
  const base = await start();
  const code = Object.keys(lib.readDb().licenses)[0];
  lib.update((db) => ops.revocar(db, code, 'cli'));
  const r = await ask(base, device(1));
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'prueba_usada');
  assert.equal(Object.keys(lib.readDb().licenses).length, 1);
});

test('tope de pruebas por conexión: la 4.ª desde la misma IP se rechaza; otra IP sigue pudiendo', async () => {
  const base = await start();
  const ip = '10.9.9.9';
  assert.equal((await ask(base, device(11), ip)).status, 200);
  assert.equal((await ask(base, device(12), ip)).status, 200);
  assert.equal((await ask(base, device(13), ip)).status, 200);
  const blocked = await ask(base, device(14), ip);
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.error, 'prueba_limite');
  assert.equal((await ask(base, device(14), '10.8.8.8')).status, 200);
});

test('datos inválidos: se rechazan sin crear nada', async () => {
  const base = await start();
  const before = Object.keys(lib.readDb().licenses).length;
  assert.equal((await ask(base, 'corto')).status, 404);
  assert.equal((await ask(base, 'con espacios y símbolos!!!')).status, 404);
  assert.equal(Object.keys(lib.readDb().licenses).length, before);
});

test('con TRIAL_DAYS=0 las pruebas están apagadas', async () => {
  const base = await start({ TRIAL_DAYS: '0' });
  const r = await ask(base, device(99), '10.7.7.7');
  assert.equal(r.status, 404);
  assert.equal(r.body.error, 'sin_prueba');
});
