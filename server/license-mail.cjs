// Envío de email por SMTP, sin dependencias (lo usan los avisos de compra, de vencimiento y el panel).
//
// Variables de entorno (en /etc/zscore-license.env, nunca en el repo):
//   SMTP_HOST   servidor de correo (por ejemplo smtp.gmail.com, o el de tu hosting)
//   SMTP_PORT   465 (TLS directo, por defecto) o 587 (STARTTLS)
//   SMTP_USER   usuario (casi siempre el mismo email)
//   SMTP_PASS   contraseña (en Gmail: "contraseña de aplicación", no la normal)
//   SMTP_FROM   remitente: licencias@tudominio.com  o  Z-Score Lite <licencias@tudominio.com>
//   SMTP_SECURE tls | starttls | none (solo none para pruebas locales contra 127.0.0.1)
//   SMTP_CA_FILE (opcional) certificado propio en el que confiar, si tu servidor de correo no usa uno público

'use strict';

const net = require('net');
const tls = require('tls');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');

const TIMEOUT_MS = 20000;

const cfg = () => {
  const port = Number(process.env.SMTP_PORT) || 465;
  return {
    host: process.env.SMTP_HOST || '',
    port,
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || '',
    mode: process.env.SMTP_SECURE || (port === 465 ? 'tls' : 'starttls'),
    ca: process.env.SMTP_CA_FILE ? fs.readFileSync(process.env.SMTP_CA_FILE) : undefined,
  };
};

const ADDRESS = /^[^\s@<>,;"'()]+@[^\s@<>,;"'()]+\.[^\s@<>,;"'()]+$/;

/** "Nombre <a@b.com>" o "a@b.com" -> { name, address } (o null si no sirve). */
function parseFrom(value) {
  const m = /^\s*(?:"?([^"<>]*?)"?\s*)?<([^<>\s]+)>\s*$/.exec(String(value));
  const address = m ? m[2] : String(value).trim();
  if (!ADDRESS.test(address)) return null;
  return { name: m && m[1] ? m[1].trim() : '', address };
}

function isConfigured() {
  const c = cfg();
  return !!(c.host && parseFrom(c.from));
}

/** Texto de encabezado: ASCII tal cual, lo demás en UTF-8 codificado (RFC 2047). Sin saltos de línea. */
function encodeWord(text) {
  const clean = String(text).replace(/[\r\n]+/g, ' ').trim();
  return /^[\x20-\x7e]*$/.test(clean) ? clean : `=?UTF-8?B?${Buffer.from(clean, 'utf8').toString('base64')}?=`;
}

const base64Body = (s) => Buffer.from(String(s).replace(/\r?\n/g, '\r\n'), 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');

/** Con `html` arma un multipart/alternative (texto + HTML); sin `html`, un texto simple. */
function buildMessage({ from, to, subject, text, html }) {
  const fromHeader = from.name ? `${encodeWord(from.name)} <${from.address}>` : from.address;
  const domain = from.address.split('@')[1];
  const head = [
    `From: ${fromHeader}`,
    `To: ${to}`,
    `Subject: ${encodeWord(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomBytes(12).toString('hex')}@${domain}>`,
    'MIME-Version: 1.0',
  ];
  if (!html) {
    return [...head, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', base64Body(text)].join('\r\n');
  }
  const boundary = `zs_${crypto.randomBytes(12).toString('hex')}`;
  const part = (type, content) => [`--${boundary}`, `Content-Type: ${type}; charset=UTF-8`, 'Content-Transfer-Encoding: base64', '', base64Body(content)].join('\r\n');
  return [
    ...head,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    part('text/plain', text),
    part('text/html', html),
    `--${boundary}--`,
  ].join('\r\n');
}

/** Lector de respuestas SMTP (una respuesta puede venir en varias líneas "250-..." y termina en "250 ..."). */
function session(socket) {
  let buffer = '';
  let lines = [];
  const queue = [];
  const waiting = [];
  let failure = null;

  const deliver = (reply) => (waiting.length ? waiting.shift().resolve(reply) : queue.push(reply));
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    buffer += chunk;
    for (let i = buffer.indexOf('\r\n'); i >= 0; i = buffer.indexOf('\r\n')) {
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + 2);
      lines.push(line);
      if (/^\d{3}( |$)/.test(line)) {
        deliver({ code: Number(line.slice(0, 3)), text: lines.join('\n') });
        lines = [];
      }
    }
  });
  const fail = (err) => {
    failure = failure || err;
    while (waiting.length) waiting.shift().reject(failure);
  };
  socket.on('error', fail);
  socket.on('close', () => fail(new Error('el servidor de correo cortó la conexión')));
  socket.setTimeout(TIMEOUT_MS, () => { fail(new Error('el servidor de correo no respondió a tiempo')); socket.destroy(); });

  const read = () => {
    if (queue.length) return Promise.resolve(queue.shift());
    if (failure) return Promise.reject(failure);
    return new Promise((resolve, reject) => waiting.push({ resolve, reject }));
  };
  return {
    socket,
    read,
    write: (line) => socket.write(`${line}\r\n`),
    async command(line, ok, secret = false) {
      socket.write(`${line}\r\n`);
      const reply = await read();
      if (!ok.includes(reply.code)) {
        throw new Error(`el servidor de correo respondió ${reply.code} a ${secret ? 'la autenticación' : line.split(' ')[0]}: ${reply.text.replace(/\s+/g, ' ').slice(0, 160)}`);
      }
      return reply;
    },
  };
}

function connect(c) {
  return new Promise((resolve, reject) => {
    const done = (socket) => { socket.removeListener('error', reject); resolve(socket); };
    let socket;
    if (c.mode === 'tls') {
      socket = tls.connect({ host: c.host, port: c.port, servername: c.host, ca: c.ca }, () => done(socket));
    } else {
      if (c.mode === 'none' && !['127.0.0.1', 'localhost'].includes(c.host)) {
        reject(new Error('SMTP_SECURE=none solo se permite contra 127.0.0.1 (pruebas)'));
        return;
      }
      socket = net.connect({ host: c.host, port: c.port }, () => done(socket));
    }
    socket.once('error', reject);
    socket.setTimeout(TIMEOUT_MS, () => { reject(new Error('no se pudo conectar al servidor de correo')); socket.destroy(); });
  });
}

/** Manda un email de texto. Lanza un Error con un mensaje entendible si no se pudo. */
async function sendMail({ to, subject, text, html }) {
  const c = cfg();
  const from = parseFrom(c.from);
  if (!c.host || !from) throw new Error('el correo no está configurado en el servidor (SMTP_HOST y SMTP_FROM)');
  if (!ADDRESS.test(String(to))) throw new Error('la dirección de destino no es válida');

  let s;
  try {
    s = session(await connect(c));
    const greeting = await s.read();
    if (greeting.code !== 220) throw new Error(`el servidor de correo respondió ${greeting.code} al conectar`);
    const me = `zscore-lite.${os.hostname().replace(/[^A-Za-z0-9.-]/g, '') || 'local'}`;
    await s.command(`EHLO ${me}`, [250]);
    if (c.mode === 'starttls') {
      await s.command('STARTTLS', [220]);
      s.socket.removeAllListeners('data');
      const secure = tls.connect({ socket: s.socket, servername: c.host, ca: c.ca });
      await new Promise((resolve, reject) => { secure.once('secureConnect', resolve); secure.once('error', reject); });
      s = session(secure);
      await s.command(`EHLO ${me}`, [250]);
    }
    if (c.user) await s.command(`AUTH PLAIN ${Buffer.from(`\0${c.user}\0${c.pass}`).toString('base64')}`, [235], true);
    await s.command(`MAIL FROM:<${from.address}>`, [250]);
    await s.command(`RCPT TO:<${to}>`, [250, 251]);
    await s.command('DATA', [354]);
    s.write(`${buildMessage({ from, to, subject, text, html })}\r\n.`);
    const accepted = await s.read();
    if (accepted.code !== 250) throw new Error(`el servidor de correo no aceptó el mensaje (${accepted.code})`);
    try { await s.command('QUIT', [221]); } catch (e) { /* ya está enviado */ }
  } finally {
    if (s) s.socket.destroy();
  }
}

module.exports = { isConfigured, sendMail, buildMessage, parseFrom, encodeWord };
