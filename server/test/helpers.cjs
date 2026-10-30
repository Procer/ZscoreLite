// Ayudas compartidas por las pruebas.
'use strict';

const net = require('net');
const http = require('http');

/** Un puerto libre que elige el sistema (evita choques entre servidores de prueba). */
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/** Espera a que `fn()` devuelva algo verdadero (la devuelve) o falla pasado `ms`. */
async function waitFor(fn, ms = 8000, what = 'la condición') {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > ms) throw new Error(`se esperó ${ms} ms y no se cumplió: ${what}`);
    await new Promise((r) => setTimeout(r, 40));
  }
}

/** SMTP simulado, sin cifrado (el servicio se configura con SMTP_SECURE=none). Guarda lo recibido en `inbox`. */
function startSmtpMock() {
  const inbox = [];
  const state = { down: false };
  const server = net.createServer((socket) => {
    if (state.down) { socket.destroy(); return; }
    const CRLF = '\r\n';
    let mode = 'cmd';
    let envelope = { from: '', to: [] };
    let buffer = '';
    const send = (line) => socket.write(line + CRLF);
    send('220 mock listo');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      for (;;) {
        if (mode === 'data') {
          const end = buffer.indexOf(CRLF + '.' + CRLF);
          if (end < 0) return;
          inbox.push({ ...envelope, ...decode(buffer.slice(0, end)) });
          buffer = buffer.slice(end + 5);
          mode = 'cmd';
          send('250 aceptado');
          continue;
        }
        const i = buffer.indexOf(CRLF);
        if (i < 0) return;
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);
        if (/^EHLO/i.test(line)) { send('250-mock'); send('250 AUTH PLAIN'); }
        else if (/^AUTH/i.test(line)) send('235 ok');
        else if (/^MAIL FROM:/i.test(line)) { envelope = { from: /<(.*)>/.exec(line)[1], to: [] }; send('250 ok'); }
        else if (/^RCPT TO:/i.test(line)) { envelope.to.push(/<(.*)>/.exec(line)[1]); send('250 ok'); }
        else if (/^DATA/i.test(line)) { mode = 'data'; send('354 adelante'); }
        else if (/^QUIT/i.test(line)) { send('221 chau'); socket.end(); return; }
        else send('500 ?');
      }
    });
    socket.on('error', () => {});
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, inbox, state, close: () => server.close() })));
}

/** Decodifica un mensaje: asunto (con acentos) y cuerpo de texto. */
function decode(raw) {
  const [head, ...rest] = raw.split('\r\n\r\n');
  const subjectLine = /^Subject: (.*)$/im.exec(head);
  const subject = (subjectLine ? subjectLine[1] : '').replace(/=\?UTF-8\?B\?(.*?)\?=/g, (m, b) => Buffer.from(b, 'base64').toString('utf8'));
  const b64 = (s) => Buffer.from(s.replace(/\r\n/g, ''), 'base64').toString('utf8');
  const boundary = /boundary="([^"]+)"/i.exec(head);
  if (!boundary) return { subject, text: b64(rest.join('')), html: '' };
  // multipart/alternative: texto plano + HTML
  const parts = {};
  for (const chunk of rest.join('\r\n\r\n').split(`--${boundary[1]}`).slice(1)) {
    if (chunk.startsWith('--')) break;
    const [h, ...b] = chunk.replace(/^\r\n/, '').split('\r\n\r\n');
    const type = /Content-Type: ([a-z/]+)/i.exec(h);
    if (type) parts[type[1]] = b64(b.join(''));
  }
  return { subject, text: parts['text/plain'] || '', html: parts['text/html'] || '' };
}

/** Mercado Pago simulado: preferencias y pagos. `state.payments[id]` es lo que devuelve GET /v1/payments/:id. */
function startMpMock() {
  const state = { payments: {}, prefs: [], down: false };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const out = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (state.down) return out(500, { message: 'caído' });
      if (req.method === 'POST' && req.url === '/checkout/preferences') {
        state.prefs.push(JSON.parse(raw));
        const n = state.prefs.length;
        return out(201, { id: `pref-${n}`, init_point: `https://mp.example/checkout?pref=pref-${n}` });
      }
      const m = /^\/v1\/payments\/(\d+)$/.exec(req.url);
      if (req.method === 'GET' && m) return state.payments[m[1]] ? out(200, state.payments[m[1]]) : out(404, { message: 'no existe' });
      return out(404, {});
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, state, close: () => server.close() })));
}

module.exports = { freePort, waitFor, startSmtpMock, startMpMock };
