// Servidor del "Partido en vivo" de Z-Score Lite.
//
// Guarda el último estado de cada partido que se está transmitiendo y se lo
// reparte al público en tiempo real (Server-Sent Events). Sin dependencias:
// solo módulos incluidos en Node.
//
//   POST   /api/live              crea una transmisión -> { code, token }
//   PUT    /api/live/:code        el marcador publica su estado (header x-token)
//   GET    /api/live/:code        último estado (JSON)
//   GET    /api/live/:code/stream estado en vivo (SSE)
//   DELETE /api/live/:code        termina la transmisión (header x-token)
//
// Variables de entorno: PORT (3720), HOST (127.0.0.1), DATA_DIR (./data),
// STATIC_DIR (solo para pruebas locales: sirve la web desde esa carpeta).

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 3720);
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STATIC_DIR = process.env.STATIC_DIR || '';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sin 0/O/1/I
const CODE_LEN = 6;
const MAX_BODY = 16 * 1024; // el estado de un partido pesa unos pocos KB
const MAX_STREAMS = 400;
const MAX_STREAMS_PER_IP = 12;
const MAX_MATCHES = 500;
const MAX_CREATES_PER_HOUR_PER_IP = 20;
const STALE_MS = 8 * 60 * 60 * 1000; // sin novedades en 8 h: se borra
const PERSIST_FILE = path.join(DATA_DIR, 'live.json');

/** code -> { token, snapshot, updatedAt, createdAt, clients:Set<res> } */
const matches = new Map();
const createLog = new Map(); // ip -> [timestamps]
const streamsPerIp = new Map();
let totalStreams = 0;

// ---------- Persistencia (para que un reinicio no corte los partidos) ----------
function load() {
  try {
    const data = JSON.parse(fs.readFileSync(PERSIST_FILE, 'utf8'));
    for (const [code, m] of Object.entries(data)) {
      matches.set(code, { ...m, clients: new Set() });
    }
  } catch (e) { /* primera vez */ }
}

let persistTimer = null;
function persistSoon() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const out = {};
    for (const [code, m] of matches) {
      out[code] = { token: m.token, snapshot: m.snapshot, updatedAt: m.updatedAt, createdAt: m.createdAt };
    }
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(PERSIST_FILE + '.tmp', JSON.stringify(out));
      fs.renameSync(PERSIST_FILE + '.tmp', PERSIST_FILE);
    } catch (e) { console.error('persist:', e.message); }
  }, 2000);
}

// ---------- Utilidades ----------
function newCode() {
  for (let attempt = 0; attempt < 20; attempt++) {
    let code = '';
    const bytes = crypto.randomBytes(CODE_LEN);
    for (let i = 0; i < CODE_LEN; i++) code += ALPHABET[bytes[i] % ALPHABET.length];
    if (!matches.has(code)) return code;
  }
  return null;
}

function clientIp(req) {
  // Detrás de nginx: la IP real viene en X-Forwarded-For / X-Real-IP.
  return (req.headers['x-real-ip'] || (req.headers['x-forwarded-for'] || '').split(',')[0] || req.socket.remoteAddress || '?').trim();
}

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooBig = false;
    const chunks = [];
    req.on('data', (c) => {
      if (tooBig) return; // se sigue leyendo (y descartando) para poder contestar 413
      size += c.length;
      if (size > MAX_BODY) { tooBig = true; chunks.length = 0; reject(Object.assign(new Error('too large'), { status: 413 })); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function tokenOk(m, req) {
  const given = String(req.headers['x-token'] || '');
  const a = Buffer.from(given);
  const b = Buffer.from(m.token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Solo se guardan los campos que el visor necesita, con tipos y largos acotados.
function sanitizeSnapshot(raw) {
  const str = (v, max) => String(v ?? '').slice(0, max);
  const num = (v) => (Number.isFinite(Number(v)) ? Math.max(0, Math.min(999, Math.trunc(Number(v)))) : 0);
  const team = (v) => (v === 'A' || v === 'B' ? v : null);
  const d = raw.display || {};
  return {
    v: 1,
    club: str(raw.club, 60),
    court: str(raw.court, 40),
    names: { A: str(raw.names?.A, 80), B: str(raw.names?.B, 80) },
    display: {
      pointA: str(d.pointA, 12), pointB: str(d.pointB, 12),
      gamesA: num(d.gamesA), gamesB: num(d.gamesB),
      setsA: num(d.setsA), setsB: num(d.setsB),
      server: team(d.server),
      inTiebreak: !!d.inTiebreak, isSuperTiebreak: !!d.isSuperTiebreak, goldenPoint: !!d.goldenPoint,
    },
    completedSets: (Array.isArray(raw.completedSets) ? raw.completedSets : []).slice(0, 7)
      .map((s) => ({ gamesA: num(s.gamesA), gamesB: num(s.gamesB) })),
    counts: { games: num(raw.counts?.games), sets: num(raw.counts?.sets) },
    lastGameWinner: team(raw.lastGameWinner),
    lastSetWinner: team(raw.lastSetWinner),
    matchOver: !!raw.matchOver,
    winner: team(raw.winner),
    startedAt: Number.isFinite(Number(raw.startedAt)) ? Math.trunc(Number(raw.startedAt)) : null,
  };
}

// ---------- SSE ----------
function broadcast(m) {
  const line = `data: ${JSON.stringify(m.snapshot)}\n\n`;
  for (const res of m.clients) res.write(line);
}

function openStream(req, res, code, m) {
  const ip = clientIp(req);
  if (totalStreams >= MAX_STREAMS || (streamsPerIp.get(ip) || 0) >= MAX_STREAMS_PER_IP) {
    return send(res, 429, { error: 'demasiadas conexiones' });
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  if (m.snapshot) res.write(`data: ${JSON.stringify(m.snapshot)}\n\n`);
  m.clients.add(res);
  totalStreams += 1;
  streamsPerIp.set(ip, (streamsPerIp.get(ip) || 0) + 1);
  req.on('close', () => {
    m.clients.delete(res);
    totalStreams -= 1;
    streamsPerIp.set(ip, Math.max(0, (streamsPerIp.get(ip) || 1) - 1));
  });
}

setInterval(() => {
  // Latido para que nginx y los celulares no cierren conexiones ociosas.
  for (const m of matches.values()) for (const res of m.clients) res.write(': ping\n\n');
}, 20000).unref();

setInterval(() => {
  const now = Date.now();
  for (const [code, m] of matches) {
    if (now - m.updatedAt > STALE_MS) {
      for (const res of m.clients) res.end();
      matches.delete(code);
      persistSoon();
    }
  }
  for (const [ip, list] of createLog) {
    const recent = list.filter((t) => now - t < 3600000);
    if (recent.length) createLog.set(ip, recent); else createLog.delete(ip);
  }
}, 10 * 60 * 1000).unref();

// ---------- Rutas ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.json': 'application/json' };

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const parts = url.pathname.split('/').filter(Boolean); // ['api','live',code?,'stream'?]

  if (parts[0] !== 'api' || parts[1] !== 'live') {
    if (STATIC_DIR) {
      const file = path.join(STATIC_DIR, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname));
      if (file.startsWith(path.resolve(STATIC_DIR))) {
        return fs.readFile(file, (err, data) => {
          if (err) return send(res, 404, { error: 'no encontrado' });
          res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
          res.end(data);
        });
      }
    }
    return send(res, 404, { error: 'no encontrado' });
  }

  const code = (parts[2] || '').toUpperCase();

  // Crear
  if (req.method === 'POST' && !code) {
    const ip = clientIp(req);
    const recent = (createLog.get(ip) || []).filter((t) => Date.now() - t < 3600000);
    if (recent.length >= MAX_CREATES_PER_HOUR_PER_IP || matches.size >= MAX_MATCHES) {
      return send(res, 429, { error: 'demasiadas transmisiones, probá más tarde' });
    }
    const newC = newCode();
    if (!newC) return send(res, 503, { error: 'sin códigos disponibles' });
    recent.push(Date.now());
    createLog.set(ip, recent);
    const token = crypto.randomBytes(18).toString('base64url');
    matches.set(newC, { token, snapshot: null, updatedAt: Date.now(), createdAt: Date.now(), clients: new Set() });
    persistSoon();
    return send(res, 201, { code: newC, token });
  }

  const m = matches.get(code);
  if (!m) return send(res, 404, { error: 'transmisión no encontrada' });

  if (req.method === 'GET' && parts[3] === 'stream') return openStream(req, res, code, m);

  if (req.method === 'GET') {
    if (!m.snapshot) return send(res, 200, { waiting: true });
    return send(res, 200, m.snapshot);
  }

  if (req.method === 'PUT') {
    if (!tokenOk(m, req)) return send(res, 403, { error: 'token inválido' });
    let raw;
    try { raw = JSON.parse(await readBody(req)); } catch (e) {
      return send(res, e.status || 400, { error: e.status === 413 ? 'demasiado grande' : 'JSON inválido' });
    }
    if (!raw || typeof raw !== 'object') return send(res, 400, { error: 'JSON inválido' });
    m.snapshot = { ...sanitizeSnapshot(raw), updatedAt: Date.now() };
    m.updatedAt = Date.now();
    broadcast(m);
    persistSoon();
    return send(res, 200, { ok: true });
  }

  if (req.method === 'DELETE') {
    if (!tokenOk(m, req)) return send(res, 403, { error: 'token inválido' });
    if (m.snapshot) { m.snapshot = { ...m.snapshot, ended: true, updatedAt: Date.now() }; broadcast(m); }
    for (const res2 of m.clients) res2.end();
    matches.delete(code);
    persistSoon();
    return send(res, 200, { ok: true });
  }

  return send(res, 405, { error: 'método no permitido' });
}

load();
http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    console.error('error:', e);
    if (!res.headersSent) send(res, 500, { error: 'error interno' });
  });
}).listen(PORT, HOST, () => console.log(`zscore-live escuchando en http://${HOST}:${PORT}`));
