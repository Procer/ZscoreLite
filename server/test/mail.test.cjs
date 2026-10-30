// Pruebas del envío de email contra servidores SMTP simulados (plano, TLS directo y STARTTLS). node --test server/test/

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const net = require('net');
const tls = require('tls');
const mail = require('../license-mail.cjs');

const FIXTURES = path.join(__dirname, 'fixtures');
const CA_FILE = path.join(FIXTURES, 'smtp-test-cert.pem');
const TLS_OPTS = { key: fs.readFileSync(path.join(FIXTURES, 'smtp-test-key.pem')), cert: fs.readFileSync(CA_FILE) };

// ---- SMTP simulado ----
const inbox = [];
const mock = { user: 'licencias@ejemplo.com', pass: 'clave-de-prueba', rcptError: false, dropOnConnect: false, rejectData: false };
const servers = [];
let port;

/** Atiende una conexión SMTP. `canStartTls`: ofrece STARTTLS y pasa a cifrado a mitad de la sesión. */
function handle(socket, { greet = true, canStartTls = false } = {}) {
  if (mock.dropOnConnect) { socket.destroy(); return; }
  let mode = 'cmd';
  let envelope = { from: '', to: [] };
  let buffer = '';
  let upgraded = false;
  const CRLF = '\r\n';
  const send = (line) => socket.write(line + CRLF);
  if (greet) send('220 mock ESMTP listo');

  socket.on('data', (chunk) => {
    if (upgraded) return;
    buffer += chunk.toString('utf8');
    for (;;) {
      if (mode === 'data') {
        const end = buffer.indexOf(CRLF + '.' + CRLF);
        if (end < 0) return;
        const data = buffer.slice(0, end);
        buffer = buffer.slice(end + 5);
        mode = 'cmd';
        if (mock.rejectData) { send('554 rechazado'); continue; }
        inbox.push({ ...envelope, raw: data, secure: socket.encrypted === true });
        send('250 aceptado');
        continue;
      }
      const i = buffer.indexOf(CRLF);
      if (i < 0) return;
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + 2);
      if (/^EHLO/i.test(line)) {
        send('250-mock');
        if (canStartTls && !socket.encrypted) send('250-STARTTLS');
        send('250 AUTH PLAIN');
      } else if (/^STARTTLS/i.test(line) && canStartTls) {
        send('220 listo para TLS');
        upgraded = true;
        socket.removeAllListeners('data');
        const secure = new tls.TLSSocket(socket, { isServer: true, ...TLS_OPTS });
        secure.on('error', () => {});
        handle(secure, { greet: false, canStartTls: true });
        return;
      } else if (/^AUTH PLAIN/i.test(line)) {
        const [, user, pass] = Buffer.from(line.split(' ')[2], 'base64').toString('utf8').split('\0');
        send(user === mock.user && pass === mock.pass ? '235 autenticado' : '535 credenciales incorrectas');
      } else if (/^MAIL FROM:/i.test(line)) {
        envelope = { from: /<(.*)>/.exec(line)[1], to: [] };
        send('250 ok');
      } else if (/^RCPT TO:/i.test(line)) {
        if (mock.rcptError) send('550 no existe ese buzón');
        else { envelope.to.push(/<(.*)>/.exec(line)[1]); send('250 ok'); }
      } else if (/^DATA/i.test(line)) {
        mode = 'data';
        send('354 adelante');
      } else if (/^QUIT/i.test(line)) {
        send('221 chau');
        socket.end();
        return;
      } else send('500 comando desconocido');
    }
  });
  socket.on('error', () => {});
}

function listen(srv) {
  servers.push(srv);
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(srv.address().port)));
}

function configure(over = {}) {
  Object.assign(process.env, {
    SMTP_HOST: '127.0.0.1', SMTP_PORT: String(port), SMTP_SECURE: 'none',
    SMTP_USER: mock.user, SMTP_PASS: mock.pass, SMTP_FROM: 'Z-Score Lite <licencias@ejemplo.com>', ...over,
  });
  if (!('SMTP_CA_FILE' in over)) delete process.env.SMTP_CA_FILE;
}

/** Lee un mensaje guardado: encabezados, asunto decodificado y cuerpo. */
function parse(raw) {
  const [head, ...rest] = raw.split('\r\n\r\n');
  const headers = {};
  for (const line of head.split('\r\n')) { const k = line.indexOf(':'); headers[line.slice(0, k).toLowerCase()] = line.slice(k + 1).trim(); }
  const subject = headers.subject.replace(/=\?UTF-8\?B\?(.*?)\?=/g, (m, b) => Buffer.from(b, 'base64').toString('utf8'));
  const rawBody = rest.join('\r\n\r\n');
  const body = Buffer.from(rawBody.replace(/\r\n/g, ''), 'base64').toString('utf8');
  return { headers, subject, body, rawBody };
}

test.before(async () => { port = await listen(net.createServer((socket) => handle(socket))); });
test.after(() => { for (const srv of servers) srv.close(); });

test('con HTML sale un multipart/alternative: texto plano + HTML, ambos íntegros', () => {
  const text = 'Hola Ñandú\nTu código: ZSL-AAAA-BBBB';
  const html = '<p>Hola <b>Ñandú</b></p><p>Tu código: ZSL-AAAA-BBBB</p>';
  const raw = mail.buildMessage({ from: { name: 'Z-Score Lite', address: 'licencias@ejemplo.com' }, to: 'cliente@ejemplo.com', subject: 'Prueba', text, html });
  assert.match(raw, /Content-Type: multipart\/alternative; boundary="(zs_[0-9a-f]+)"/);
  const boundary = /boundary="([^"]+)"/.exec(raw)[1];
  const parts = raw.split(`--${boundary}`).slice(1, -1).map((p) => {
    const [h, ...b] = p.replace(/^\r\n/, '').split('\r\n\r\n');
    return { type: /Content-Type: ([a-z/]+)/.exec(h)[1], body: Buffer.from(b.join('').replace(/\r\n/g, ''), 'base64').toString('utf8') };
  });
  assert.deepEqual(parts.map((p) => p.type), ['text/plain', 'text/html']);
  assert.equal(parts[0].body.replace(/\r\n/g, '\n'), text);
  assert.equal(parts[1].body, html);
  assert.ok(raw.trimEnd().endsWith(`--${boundary}--`), 'el multipart se cierra');
});

test('manda un email con acentos, asunto codificado y cuerpo íntegro', async () => {
  configure();
  inbox.length = 0;
  const text = 'Hola Ñandú,\n\nTu código es ZSL-AAAA-BBBB.\n.línea que empieza con punto\nÚltima línea: ¡gracias!';
  await mail.sendMail({ to: 'cliente@ejemplo.com', subject: 'Tu licencia de Z-Score Lite · código', text });
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].from, 'licencias@ejemplo.com');
  assert.deepEqual(inbox[0].to, ['cliente@ejemplo.com']);
  const m = parse(inbox[0].raw);
  assert.equal(m.subject, 'Tu licencia de Z-Score Lite · código');
  assert.equal(m.body.replace(/\r\n/g, '\n'), text);
  assert.match(m.headers.from, /Z-Score Lite <licencias@ejemplo\.com>/);
  assert.equal(m.headers.to, 'cliente@ejemplo.com');
  assert.match(m.headers['content-type'], /text\/plain; charset=UTF-8/);
  assert.match(m.headers['message-id'], /^<[0-9a-f]{24}@ejemplo\.com>$/);
});

test('un cuerpo largo se parte en líneas de hasta 76 caracteres', async () => {
  configure();
  inbox.length = 0;
  await mail.sendMail({ to: 'a@b.com', subject: 'largo', text: 'x'.repeat(5000) });
  const m = parse(inbox[0].raw);
  assert.equal(m.body, 'x'.repeat(5000));
  assert.ok(m.rawBody.split('\r\n').every((l) => l.length <= 76));
});

test('contraseña incorrecta: error entendible y sin mostrar la contraseña', async () => {
  configure({ SMTP_PASS: 'otra-clave-secreta' });
  inbox.length = 0;
  await assert.rejects(() => mail.sendMail({ to: 'a@b.com', subject: 's', text: 't' }), (e) => {
    assert.match(e.message, /535/);
    assert.match(e.message, /autenticación/);
    assert.ok(!e.message.includes('otra-clave-secreta'));
    return true;
  });
  assert.equal(inbox.length, 0);
});

test('destinatario inválido o con intento de inyectar encabezados: se rechaza sin conectarse', async () => {
  configure();
  inbox.length = 0;
  for (const to of ['sin-arroba', 'a@b.com\r\nBcc: otro@x.com', 'a@b.com,c@d.com', '', 'a b@c.com']) {
    await assert.rejects(() => mail.sendMail({ to, subject: 's', text: 't' }), /destino no es válida/, JSON.stringify(to));
  }
  assert.equal(inbox.length, 0);
});

test('el asunto no puede colar encabezados nuevos', async () => {
  configure();
  inbox.length = 0;
  await mail.sendMail({ to: 'a@b.com', subject: 'hola\r\nBcc: espia@x.com', text: 't' });
  assert.ok(!/^bcc:/im.test(inbox[0].raw.split('\r\n\r\n')[0]));
});

test('buzón inexistente (550) y mensaje rechazado: se informan', async () => {
  configure();
  mock.rcptError = true;
  await assert.rejects(() => mail.sendMail({ to: 'a@b.com', subject: 's', text: 't' }), /550/);
  mock.rcptError = false;
  mock.rejectData = true;
  await assert.rejects(() => mail.sendMail({ to: 'a@b.com', subject: 's', text: 't' }), /no aceptó el mensaje/);
  mock.rejectData = false;
});

test('servidor caído o que corta la conexión: error claro', async () => {
  configure();
  mock.dropOnConnect = true;
  await assert.rejects(() => mail.sendMail({ to: 'a@b.com', subject: 's', text: 't' }), /cortó la conexión|ECONNRESET/);
  mock.dropOnConnect = false;
  configure({ SMTP_PORT: '1' });
  await assert.rejects(() => mail.sendMail({ to: 'a@b.com', subject: 's', text: 't' }));
});

test('configuración: se detecta lo que falta y SMTP_SECURE=none solo vale contra 127.0.0.1', async () => {
  configure();
  assert.equal(mail.isConfigured(), true);
  configure({ SMTP_FROM: 'esto-no-es-un-mail' });
  assert.equal(mail.isConfigured(), false);
  configure({ SMTP_HOST: '' });
  assert.equal(mail.isConfigured(), false);
  await assert.rejects(() => mail.sendMail({ to: 'a@b.com', subject: 's', text: 't' }), /no está configurado/);
  configure({ SMTP_HOST: 'smtp.ejemplo.com', SMTP_SECURE: 'none' });
  await assert.rejects(() => mail.sendMail({ to: 'a@b.com', subject: 's', text: 't' }), /solo se permite contra 127\.0\.0\.1/);
});

test('remitente: con y sin nombre', () => {
  assert.deepEqual(mail.parseFrom('Z-Score Lite <licencias@x.com>'), { name: 'Z-Score Lite', address: 'licencias@x.com' });
  assert.deepEqual(mail.parseFrom('"Zárate System" <l@x.com>'), { name: 'Zárate System', address: 'l@x.com' });
  assert.deepEqual(mail.parseFrom('licencias@x.com'), { name: '', address: 'licencias@x.com' });
  assert.equal(mail.parseFrom('<>'), null);
  assert.equal(mail.parseFrom('nada'), null);
});

test('TLS directo (puerto 465): se cifra, se autentica y se entrega', async () => {
  const tlsPort = await listen(tls.createServer(TLS_OPTS, (socket) => handle(socket)));
  configure({ SMTP_HOST: 'localhost', SMTP_PORT: String(tlsPort), SMTP_SECURE: 'tls', SMTP_CA_FILE: CA_FILE });
  inbox.length = 0;
  await mail.sendMail({ to: 'a@b.com', subject: 'por TLS', text: 'cifrado' });
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].secure, true);
  assert.equal(parse(inbox[0].raw).body, 'cifrado');
});

test('STARTTLS (puerto 587): pasa a cifrado antes de autenticarse', async () => {
  const stPort = await listen(net.createServer((socket) => handle(socket, { canStartTls: true })));
  configure({ SMTP_HOST: 'localhost', SMTP_PORT: String(stPort), SMTP_SECURE: 'starttls', SMTP_CA_FILE: CA_FILE });
  inbox.length = 0;
  await mail.sendMail({ to: 'a@b.com', subject: 'por STARTTLS', text: 'cifrado tras negociar' });
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].secure, true, 'el mensaje viajó cifrado');
  assert.equal(parse(inbox[0].raw).body, 'cifrado tras negociar');
});

test('con TLS, un certificado que no es de confianza se rechaza', async () => {
  const tlsPort = await listen(tls.createServer(TLS_OPTS, (socket) => handle(socket)));
  configure({ SMTP_HOST: 'localhost', SMTP_PORT: String(tlsPort), SMTP_SECURE: 'tls' }); // sin SMTP_CA_FILE: un certificado propio no vale
  inbox.length = 0;
  await assert.rejects(() => mail.sendMail({ to: 'a@b.com', subject: 's', text: 't' }), /self.signed|certificate|unable to verify/i);
  assert.equal(inbox.length, 0);
});
