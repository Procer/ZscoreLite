// Cobro con Mercado Pago (Checkout Pro, pago único por período) y entrega automática de la licencia.
//
// Dos formas de cobrar:
//   COMPRA NUEVA  El cliente entra a https://lite.zscore.ar/api/license/comprar (el botón "Comprar" del sitio) y paga.
//                 Al aprobarse el pago se CREA una licencia paga, se le manda por email el código, el link de descarga
//                 y los pasos, y se te avisa a vos.
//   RENOVACIÓN    Desde el panel (o en el aviso de vencimiento por email) sale un link de pago para una licencia que ya
//                 existe. Al aprobarse se extiende sola y se manda el recibo.
//
// Cómo se cuida el dinero:
//   - Cada link de pago lleva una referencia propia (CÓDIGO|NEW : DÍAS : REF). La REF vuelve acá en una tabla (payLinks)
//     con el monto y los días esperados: nada de lo que dice el pago se toma por cierto.
//   - El aviso (webhook) se valida con su firma, se le pregunta el pago a la API de Mercado Pago y se comprueba
//     referencia, moneda y monto antes de tocar nada. Un mismo pago nunca se aplica dos veces.
//   - Reintegros y contracargos se anotan para revisar a mano; no tocan la licencia solos.
//
// Variables de entorno (en el servicio systemd, archivo /etc/zscore-license.env; nada de esto va al repo):
//   MP_ACCESS_TOKEN, MP_WEBHOOK_SECRET   credenciales de Mercado Pago
//   MP_API                               solo para pruebas (por defecto https://api.mercadopago.com)
//   PUBLIC_URL                           https://lite.zscore.ar
//   ZS_JOBS_MS                           cada cuánto corren los reintentos y avisos (10 minutos; solo cambia en pruebas)
// El precio de venta y el email para avisos se cargan en el panel (pestaña Cobros) y se guardan en la base.

'use strict';

const crypto = require('crypto');
const lib = require('./license-lib.cjs');
const ops = require('./license-ops.cjs');
const mailer = require('./license-mail.cjs');
const texts = require('./license-texts.cjs');

const DEFAULT_PAY_DAYS = 30;
const MAX_BODY = 16 * 1024;
const MP_TIMEOUT_MS = 10000;
const LINK_VALID_DAYS = 7; // el link de pago de una renovación vence a los 7 días
const SALE_LINK_REUSE_DAYS = 5; // el link de compra se reutiliza mientras dure su vigencia
const SALE_LINK_VALID_DAYS = 6;
const LINK_KEEP_DAYS = 90; // cuánto se guarda la referencia de un link que nadie pagó
const DOWNLOAD_LINK_HOURS = 72;
const DOWNLOAD_LINK_USES = 5;
const MAIL_MAX_TRIES = 5;
const DEFAULT_REMIND_DAYS = 5;
const SALE_HITS_PER_HOUR = 30;

const cfg = () => {
  const publicUrl = (process.env.PUBLIC_URL || 'https://lite.zscore.ar').replace(/\/+$/, '');
  const from = mailer.parseFrom(process.env.SMTP_FROM || '');
  return {
    token: process.env.MP_ACCESS_TOKEN || '',
    secret: process.env.MP_WEBHOOK_SECRET || '',
    api: (process.env.MP_API || 'https://api.mercadopago.com').replace(/\/+$/, ''),
    publicUrl,
    webUrl: `${publicUrl}/app/`,
    panelUrl: `${publicUrl}/admin`,
    saleUrl: `${publicUrl}/api/license/comprar`,
    siteUrl: 'https://www.zscore.ar',
    support: from ? from.address : '',
  };
};

function isConfigured() {
  const c = cfg();
  return !!(c.token && c.secret);
}

class MpError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

async function mp(method, pathname, body) {
  const c = cfg();
  let res;
  try {
    res = await fetch(`${c.api}${pathname}`, {
      method,
      headers: { Authorization: `Bearer ${c.token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(MP_TIMEOUT_MS),
    });
  } catch (e) {
    throw new MpError('No hubo respuesta de Mercado Pago', 502);
  }
  let data = null;
  try { data = await res.json(); } catch (e) { /* sin cuerpo */ }
  if (!res.ok) throw new MpError(`Mercado Pago respondió ${res.status}`, res.status >= 500 ? 502 : res.status);
  return data;
}

const asOpError = (e) => (e instanceof MpError ? Object.assign(new ops.OpError(e.message), { status: 502 }) : e);

// ---------- Ajustes de la venta (se cargan en el panel) ----------

function parseAmount(value, fallback) {
  const raw = value != null && value !== '' ? value : fallback;
  const n = Number(raw);
  if (!(n > 0) || n > 10000000) throw new ops.OpError('el monto tiene que ser mayor a 0');
  return Math.round(n * 100) / 100;
}

function parseDays(value, fallback) {
  const days = value != null && value !== '' ? Number(value) : fallback;
  if (!Number.isInteger(days) || days < 1 || days > 366) throw new ops.OpError('los días tienen que ser un entero de 1 a 366');
  return days;
}

/** Guarda precio de venta, email para avisos y días de aviso de vencimiento. `amount: ''` apaga la venta online. */
function saveConfig(fields) {
  return lib.update((db) => {
    const config = db.config;
    if (fields.amount !== undefined || fields.currency !== undefined || fields.days !== undefined) {
      if (fields.amount === '' || fields.amount === null) {
        delete config.sale;
      } else {
        const previous = config.sale || {};
        const currency = String(fields.currency || previous.currency || 'ARS').trim().toUpperCase();
        if (!/^[A-Z]{3}$/.test(currency)) throw new ops.OpError('la moneda tiene que ser un código de 3 letras (ARS, USD)');
        config.sale = {
          amount: parseAmount(fields.amount, previous.amount),
          currency,
          days: parseDays(fields.days, previous.days || DEFAULT_PAY_DAYS),
        };
      }
    }
    if (fields.adminEmail !== undefined) config.adminEmail = ops.parseEmail(fields.adminEmail);
    if (fields.remindDays !== undefined) {
      const d = Number(fields.remindDays);
      if (!Number.isInteger(d) || d < 0 || d > 30) throw new ops.OpError('los días de aviso tienen que ser de 0 (apagado) a 30');
      config.remindDays = d;
    }
    return config;
  });
}

// ---------- Links de pago ----------

/** Link de pago de una licencia que ya existe (renovación). Devuelve { url, amount, currency, days }. */
async function createLink(code, opts, actor) {
  if (!isConfigured()) throw new ops.OpError('Mercado Pago no está configurado en el servidor (faltan MP_ACCESS_TOKEN y MP_WEBHOOK_SECRET)');
  const db = lib.readDb();
  const lic = ops.getLicense(db, code);
  if (lic.revoked) throw new ops.OpError('la licencia está revocada: reactivala antes de cobrar');
  if (lic.type === 'cortesia') throw new ops.OpError('las cortesías no se cobran: convertila a paga primero');
  const days = parseDays(opts.days, (db.config.sale && db.config.sale.days) || DEFAULT_PAY_DAYS);
  const amount = parseAmount(opts.amount, lic.price != null ? lic.price : (db.config.sale && db.config.sale.amount));
  const currency = lic.currency;

  const c = cfg();
  const ref = crypto.randomBytes(5).toString('hex');
  let pref;
  try {
    pref = await mp('POST', '/checkout/preferences', {
      items: [{ id: lic.code, title: `Z-Score Lite · licencia ${days} días`, quantity: 1, unit_price: amount, currency_id: currency }],
      external_reference: `${lic.code}:${days}:${ref}`,
      notification_url: `${c.publicUrl}/api/license/pago`,
      back_urls: { success: `${c.publicUrl}/api/license/gracias`, failure: `${c.publicUrl}/api/license/gracias?estado=fallo`, pending: `${c.publicUrl}/api/license/gracias?estado=pendiente` },
      statement_descriptor: 'ZSCORE LITE',
      expires: true,
      expiration_date_to: new Date(Date.now() + LINK_VALID_DAYS * lib.DAY).toISOString(),
    });
  } catch (e) { throw asOpError(e); }
  if (!pref || typeof pref.init_point !== 'string') throw Object.assign(new ops.OpError('Mercado Pago no devolvió el link de pago'), { status: 502 });

  lib.update((d) => {
    const now = Date.now();
    for (const [k, l] of Object.entries(d.payLinks)) if (now - l.at > LINK_KEEP_DAYS * lib.DAY) delete d.payLinks[k];
    d.payLinks[ref] = { code: lic.code, days, amount, currency, at: now, prefId: String(pref.id || '') };
    lib.addEvent(d.licenses[lic.code], 'link_pago', actor, `${amount} ${currency}, ${days} días`);
  });
  return { url: pref.init_point, amount, currency, days };
}

/** Link de compra nueva con el precio vigente. Se reutiliza mientras valga, así no se crea uno por cada visita. */
async function saleLink() {
  if (!isConfigured()) throw new ops.OpError('Mercado Pago no está configurado en el servidor');
  const sale = lib.readDb().config.sale;
  if (!sale) throw new ops.OpError('la venta online no está configurada: cargá el precio en la pestaña Cobros');

  const now = Date.now();
  const same = (l) => l.kind === 'new' && l.url && l.amount === sale.amount && l.currency === sale.currency && l.days === sale.days
    && now - l.at < SALE_LINK_REUSE_DAYS * lib.DAY;
  const existing = Object.values(lib.readDb().payLinks).find(same);
  if (existing) return existing.url;

  const c = cfg();
  const ref = crypto.randomBytes(5).toString('hex');
  let pref;
  try {
    pref = await mp('POST', '/checkout/preferences', {
      items: [{ id: 'licencia-lite', title: `Z-Score Lite · licencia ${sale.days} días`, quantity: 1, unit_price: sale.amount, currency_id: sale.currency }],
      external_reference: `NEW:${sale.days}:${ref}`,
      notification_url: `${c.publicUrl}/api/license/pago`,
      back_urls: { success: `${c.publicUrl}/api/license/gracias`, failure: `${c.publicUrl}/api/license/gracias?estado=fallo`, pending: `${c.publicUrl}/api/license/gracias?estado=pendiente` },
      statement_descriptor: 'ZSCORE LITE',
      expires: true,
      expiration_date_to: new Date(now + SALE_LINK_VALID_DAYS * lib.DAY).toISOString(),
    });
  } catch (e) { throw asOpError(e); }
  if (!pref || typeof pref.init_point !== 'string') throw Object.assign(new ops.OpError('Mercado Pago no devolvió el link de pago'), { status: 502 });

  lib.update((d) => {
    for (const [k, l] of Object.entries(d.payLinks)) if (now - l.at > LINK_KEEP_DAYS * lib.DAY) delete d.payLinks[k];
    d.payLinks[ref] = { kind: 'new', days: sale.days, amount: sale.amount, currency: sale.currency, at: now, prefId: String(pref.id || ''), url: pref.init_point };
  });
  return pref.init_point;
}

// ---------- Aplicar un pago ----------

const REF_PATTERN = /^(ZSL-[A-Z0-9]{4}-[A-Z0-9]{4}|NEW):(\d{1,3}):([0-9a-f]{10})$/;
const REVERSED = new Set(['refunded', 'charged_back', 'cancelled']);

function payerOf(payment) {
  const p = payment.payer || {};
  let email = '';
  try { email = ops.parseEmail(p.email); } catch (e) { email = ''; }
  const name = [p.first_name, p.last_name].filter(Boolean).join(' ').trim().slice(0, 120);
  return { email, name };
}

/** Aplica (o anota) un pago ya traído de Mercado Pago. Corre dentro de lib.update. Devuelve qué pasó. */
function applyPayment(db, payment, now = Date.now()) {
  const id = String(payment.id);
  const known = db.payments[id];

  if (payment.status === 'approved') {
    if (known) return { result: 'repetido' }; // el mismo pago ya se aplicó: no se suma dos veces
    const m = REF_PATTERN.exec(String(payment.external_reference || ''));
    const link = m && db.payLinks[m[3]];
    if (!link || link.days !== Number(m[2])) return { result: 'sin_referencia' };
    const isNew = m[1] === 'NEW';
    if (isNew ? link.kind !== 'new' : link.code !== m[1]) return { result: 'sin_referencia' };
    let lic = isNew ? null : db.licenses[link.code];
    if (!isNew && !lic) return { result: 'sin_referencia' };

    const payer = payerOf(payment);
    const paid = Number(payment.transaction_amount);
    if (payment.currency_id !== link.currency || !(paid >= link.amount)) {
      db.payments[id] = { code: lic ? lic.code : '', status: 'monto_incorrecto', amount: paid, currency: payment.currency_id, days: 0, at: now, ref: m[3], kind: isNew ? 'new' : 'renewal', payerEmail: payer.email, payerName: payer.name };
      if (lic) lib.addEvent(lic, 'pago_revisar', 'mp', `pago ${id}: llegaron ${paid} ${payment.currency_id}, se esperaban ${link.amount} ${link.currency}; no se sumaron días`);
      return { result: 'monto_incorrecto' };
    }

    if (isNew) {
      lic = ops.crear(db, { type: 'paga', days: link.days, customer: payer.name, email: payer.email, price: paid, currency: link.currency, note: 'Compra online (Mercado Pago)' }, 'mp');
    } else {
      lic.type = 'paga'; // una prueba que paga pasa a paga
      lic.paidUntil = Math.max(lic.paidUntil || 0, now) + link.days * lib.DAY;
    }
    db.payments[id] = {
      code: lic.code, status: 'approved', amount: paid, currency: link.currency, days: link.days, at: now, ref: m[3],
      kind: isNew ? 'new' : 'renewal', payerEmail: payer.email, payerName: payer.name, mail: { status: 'pendiente', tries: 0 },
    };
    lib.addEvent(lic, 'pago', 'mp', `${paid} ${link.currency}, +${link.days} días, vence ${new Date(lic.paidUntil).toISOString().slice(0, 10)} (pago ${id})`
      + (isNew && !payer.email ? ' · el pagador no dejó email: entregá el código a mano' : '')
      + (lic.revoked ? ' · LICENCIA REVOCADA: el pago se registró pero sigue revocada, revisala' : ''));
    return { result: 'aplicado', code: lic.code, kind: isNew ? 'new' : 'renewal', id };
  }

  if (REVERSED.has(payment.status) && known && known.status === 'approved') {
    known.status = payment.status;
    known.revertedAt = now;
    const lic = db.licenses[known.code];
    if (lic) lib.addEvent(lic, 'pago_revertido', 'mp', `pago ${id} ${payment.status}: revisá si hay que dar de baja la licencia (los días no se descontaron solos)`);
    return { result: 'revertido', code: known.code };
  }

  return { result: 'ignorado' }; // pendiente, rechazado, etc.: todavía no hay nada que hacer
}

// ---------- Emails ----------

function downloadLinkFor(code) {
  if (!lib.readApkMeta()) return null;
  const token = lib.update((db) => {
    const lic = db.licenses[code];
    return lic && !lib.blockReason(lic) ? lib.newLink(db, code, { hours: DOWNLOAD_LINK_HOURS, maxUses: DOWNLOAD_LINK_USES }) : null;
  });
  if (!token) return null;
  const base = cfg().publicUrl;
  // pageUrl: página con el botón de descarga (la que va primero en el email); downloadUrl: el APK directo, plan B.
  return { pageUrl: `${base}/api/license/app?t=${token}`, downloadUrl: `${base}/api/license/descargar?t=${token}` };
}

const paymentInfo = (id, p) => ({ id, amount: p.amount, currency: p.currency, days: p.days });

/** Manda por email lo que corresponde a un pago ya aplicado (bienvenida o recibo) y el aviso al dueño. */
async function notifyPayment(id) {
  const db0 = lib.readDb();
  const p0 = db0.payments[id];
  if (!p0 || p0.status !== 'approved' || !p0.mail || p0.mail.status === 'enviado') return;
  const lic0 = db0.licenses[p0.code];
  if (!lic0) return;
  const to = lic0.email || p0.payerEmail;
  const c = cfg();

  const setMail = (patch, event) => lib.update((db) => {
    const p = db.payments[id];
    if (!p) return;
    p.mail = { ...p.mail, ...patch };
    if (event && db.licenses[p.code]) lib.addEvent(db.licenses[p.code], 'email', 'mp', event);
  });

  if (!mailer.isConfigured()) { setMail({ status: 'sin_smtp' }); return; }
  if (!to) { setMail({ status: 'sin_email' }); return; }

  let message;
  if (p0.kind === 'new') {
    message = texts.instructions({
      code: lic0.code, name: lic0.customer, expiresAt: lic0.paidUntil, ...downloadLinkFor(lic0.code), webUrl: c.webUrl,
      support: c.support, siteUrl: c.siteUrl, payment: paymentInfo(id, p0), linkHours: DOWNLOAD_LINK_HOURS,
    });
  } else {
    message = texts.receipt({ code: lic0.code, name: lic0.customer, expiresAt: lic0.paidUntil, payment: paymentInfo(id, p0), support: c.support, siteUrl: c.siteUrl });
  }

  try {
    await mailer.sendMail({ to, ...message });
    setMail({ status: 'enviado', sentAt: Date.now(), to, lastError: '', tries: p0.mail.tries + 1 }, `${p0.kind === 'new' ? 'instrucciones' : 'recibo'} enviado a ${to}`);
  } catch (e) {
    console.error(`pago ${id}: no se pudo mandar el email: ${e.message}`);
    setMail({ status: 'error', tries: p0.mail.tries + 1, lastError: String(e.message).slice(0, 200) });
  }

  // Aviso al dueño (una sola vez, sin frenar nada si falla).
  const db1 = lib.readDb();
  const admin = db1.config.adminEmail;
  if (admin && mailer.isConfigured() && !db1.payments[id].adminNotified) {
    try {
      const lic = db1.licenses[p0.code];
      await mailer.sendMail({ to: admin, ...texts.adminSale({
        code: lic.code, customer: lic.customer || p0.payerName, email: lic.email || p0.payerEmail, payment: paymentInfo(id, p0), kind: p0.kind, expiresAt: lic.paidUntil, panelUrl: c.panelUrl,
      }) });
      lib.update((db) => { if (db.payments[id]) db.payments[id].adminNotified = true; });
    } catch (e) {
      console.error(`pago ${id}: no se pudo avisar al dueño: ${e.message}`);
    }
  }
}

/** Vuelve a mandar los emails que fallaron (o que quedaron a medias si el servicio se reinició). */
async function retryPending() {
  const now = Date.now();
  const pending = Object.entries(lib.readDb().payments).filter(([, p]) => p.status === 'approved' && p.mail
    && ((p.mail.status === 'error' && p.mail.tries < MAIL_MAX_TRIES) || (p.mail.status === 'pendiente' && now - p.at > 2 * 60000) || p.mail.status === 'sin_smtp') && (p.mail.status !== 'sin_smtp' || mailer.isConfigured()));
  for (const [id] of pending.slice(0, 20)) await notifyPayment(id);
}

/** Manda los datos de la licencia (código, descarga y pasos) al email del cliente. Lo usa el botón del panel. */
async function sendInstructions(code, actor) {
  if (!mailer.isConfigured()) throw new ops.OpError('El envío de emails no está configurado en el servidor (faltan las variables SMTP_*)');
  const lic = ops.getLicense(lib.readDb(), code);
  if (!lic.email) throw new ops.OpError('la licencia no tiene email: cargalo en "Datos del cliente"');
  if (lic.revoked) throw new ops.OpError('la licencia está revocada');
  const c = cfg();
  const message = texts.instructions({
    code: lic.code, name: lic.customer, type: lic.type, expiresAt: lic.paidUntil, ...downloadLinkFor(lic.code), webUrl: c.webUrl,
    support: c.support, siteUrl: c.siteUrl, linkHours: DOWNLOAD_LINK_HOURS,
  });
  try {
    await mailer.sendMail({ to: lic.email, ...message });
  } catch (e) {
    throw Object.assign(new ops.OpError(`No se pudo enviar el email: ${e.message}`), { status: 502 });
  }
  lib.update((db) => { if (db.licenses[code]) lib.addEvent(db.licenses[code], 'email', actor, `instrucciones enviadas a ${lic.email}`); });
  return { to: lic.email };
}

/** Email de prueba al correo de avisos, para comprobar que el envío funciona. */
async function sendTest() {
  if (!mailer.isConfigured()) throw new ops.OpError('El envío de emails no está configurado en el servidor (faltan las variables SMTP_*)');
  const to = lib.readDb().config.adminEmail;
  if (!to) throw new ops.OpError('cargá primero el "email para avisos de venta" y guardá');
  try {
    await mailer.sendMail({ to, ...texts.test({ panelUrl: cfg().panelUrl }) });
  } catch (e) {
    throw Object.assign(new ops.OpError(`No se pudo enviar el email: ${e.message}`), { status: 502 });
  }
  return { to };
}

/** Avisa por email, unos días antes, a los clientes con licencia paga que están por vencer. Incluye el link para renovar. */
async function remindExpiring() {
  if (!isConfigured() || !mailer.isConfigured()) return;
  const db = lib.readDb();
  const remindDays = db.config.remindDays === undefined ? DEFAULT_REMIND_DAYS : db.config.remindDays;
  if (remindDays <= 0) return;
  const now = Date.now();
  const due = Object.values(db.licenses).filter((l) => l.type === 'paga' && l.email && !l.revoked && l.paidUntil != null
    && l.paidUntil > now && l.paidUntil - now <= remindDays * lib.DAY && l.reminderFor !== l.paidUntil);

  const c = cfg();
  for (const lic of due.slice(0, 20)) {
    try {
      const amountKnown = lic.price != null || (db.config.sale && db.config.sale.amount);
      if (!amountKnown) continue; // sin precio no se puede armar el link: se ve en el panel
      const link = await createLink(lic.code, {}, 'mp');
      await mailer.sendMail({ to: lic.email, ...texts.reminder({
        code: lic.code, name: lic.customer, type: lic.type, expiresAt: lic.paidUntil, payUrl: link.url, amount: link.amount, currency: link.currency, days: link.days, support: c.support, siteUrl: c.siteUrl,
      }) });
      lib.update((d) => {
        const l = d.licenses[lic.code];
        l.reminderFor = lic.paidUntil;
        l.reminderFails = 0;
        lib.addEvent(l, 'email', 'mp', `aviso de vencimiento enviado a ${lic.email}`);
      });
    } catch (e) {
      console.error(`aviso de vencimiento ${lic.code}: ${e.message}`);
      lib.update((d) => {
        const l = d.licenses[lic.code];
        l.reminderFails = (l.reminderFails || 0) + 1;
        if (l.reminderFails >= 3) l.reminderFor = lic.paidUntil; // se deja de insistir para este vencimiento
      });
    }
  }
}

let jobsRunning = false;

/** Tareas periódicas: reintentar emails pendientes y mandar avisos de vencimiento. */
function startJobs() {
  const every = Number(process.env.ZS_JOBS_MS) || 10 * 60000;
  const tick = async () => {
    if (jobsRunning) return;
    jobsRunning = true;
    try { await retryPending(); await remindExpiring(); } catch (e) { console.error(`tareas de cobro: ${e.message}`); } finally { jobsRunning = false; }
  };
  setInterval(tick, every).unref();
}

// ---------- Webhook ----------

function reply(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('grande')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Firma de Mercado Pago: x-signature "ts=...,v1=..." sobre "id:<data.id en minúscula>;request-id:<x-request-id>;ts:<ts>;". */
function signatureOk(req, dataId) {
  const header = String(req.headers['x-signature'] || '');
  const parts = {};
  for (const piece of header.split(',')) {
    const i = piece.indexOf('=');
    if (i > 0) parts[piece.slice(0, i).trim()] = piece.slice(i + 1).trim();
  }
  if (!parts.ts || !parts.v1) return false;
  let manifest = '';
  if (dataId) manifest += `id:${String(dataId).toLowerCase()};`;
  if (req.headers['x-request-id']) manifest += `request-id:${req.headers['x-request-id']};`;
  manifest += `ts:${parts.ts};`;
  const expected = crypto.createHmac('sha256', cfg().secret).update(manifest).digest('hex');
  const got = Buffer.from(parts.v1, 'utf8');
  const want = Buffer.from(expected, 'utf8');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

/** POST /api/license/pago. `onBadSignature` cuenta el intento fallido de esa IP. */
async function handleWebhook(req, res, url, onBadSignature) {
  if (req.method !== 'POST') { reply(res, 405, { error: 'método' }); return; }
  if (!isConfigured()) { reply(res, 503, { error: 'sin_cobro' }); return; }

  let body = {};
  try { body = JSON.parse(await readBody(req)) || {}; } catch (e) { body = {}; }
  const dataId = url.searchParams.get('data.id') || (body.data && body.data.id) || '';
  const type = url.searchParams.get('type') || url.searchParams.get('topic') || body.type || '';

  // MP_SKIP_SIGNATURE=1: SOLO para pruebas con dinero de prueba. El pago igual se consulta a Mercado Pago y se valida monto/referencia.
  const skipSig = process.env.MP_SKIP_SIGNATURE === '1';
  if (skipSig) console.warn('pago: ATENCION - MP_SKIP_SIGNATURE=1, la firma NO se verifica (apagar antes de producción)');
  if (!skipSig && !signatureOk(req, url.searchParams.get('data.id') || '')) {
    try { // diagnóstico temporal: ¿alguna variante del cálculo coincide con la firma recibida?
      const sig = String(req.headers['x-signature'] || ''); const ts = (/ts=([^,]+)/.exec(sig) || [])[1] || ''; const v1 = (/v1=([0-9a-f]+)/.exec(sig) || [])[1] || '';
      const did = url.searchParams.get('data.id') || ''; const rid = req.headers['x-request-id'] || '';
      const hm = (m) => crypto.createHmac('sha256', cfg().secret).update(m).digest('hex') === v1;
      const hit = [];
      if (hm(`id:${did.toLowerCase()};request-id:${rid};ts:${ts};`)) hit.push('normal');
      if (hm(`id:${did};request-id:${rid};ts:${ts};`)) hit.push('id-sin-minuscula');
      if (hm(`id:${did.toLowerCase()};ts:${ts};`)) hit.push('sin-request-id');
      if (hm(`ts:${ts};`)) hit.push('solo-ts');
      console.warn(`pago: diagnóstico firma -> coincide: ${hit.join(',') || 'ninguna'}; data.id=${did ? 'si' : 'no'}; request-id=${rid ? 'si' : 'no'}; ts=${ts ? 'si' : 'no'}; v1_largo=${v1.length}; secreto_largo=${String(cfg().secret).length}`);
    } catch (e) { console.warn('pago: diagnóstico falló'); }
    onBadSignature();
    console.warn(`pago: aviso con firma inválida (${req.headers['x-signature'] ? 'trae x-signature: el secreto no coincide' : 'sin x-signature: aviso viejo o ajeno'}; ${url.searchParams.get('data.id') ? 'data.id' : 'id/topic'})`);
    reply(res, 401, { error: 'firma' });
    return;
  }
  if (type !== 'payment' || !/^\d{1,20}$/.test(String(dataId))) { reply(res, 200, { ok: true, ignorado: true }); return; }

  let payment;
  try {
    payment = await mp('GET', `/v1/payments/${encodeURIComponent(String(dataId))}`);
  } catch (e) {
    console.error(`pago: no se pudo consultar el pago ${dataId}: ${e.message}`);
    // 502: Mercado Pago reintenta el aviso más tarde. Si el pago no existe (404) no tiene sentido reintentar.
    reply(res, e.status === 404 ? 200 : 502, { error: 'consulta' });
    return;
  }
  if (!payment || String(payment.id) !== String(dataId)) { reply(res, 200, { ok: true, ignorado: true }); return; }

  const outcome = lib.update((db) => applyPayment(db, payment));
  console.log(`pago: ${payment.id} (${payment.status}) -> ${outcome.result}${outcome.code ? ` ${outcome.code}` : ''}`);
  reply(res, 200, { ok: true }); // se responde ya (Mercado Pago espera menos de 22 s); el email sale aparte
  if (outcome.result === 'aplicado') setImmediate(() => notifyPayment(String(payment.id)).catch((e) => console.error(`pago ${payment.id}: ${e.message}`)));
}

// ---------- Páginas públicas: comprar y gracias ----------

function htmlPage(res, status, title, text) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'", 'X-Content-Type-Options': 'nosniff' });
  res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + `<title>${title}</title><body style="font-family:system-ui,sans-serif;background:#0b0e13;color:#f5f7fa;padding:40px 20px;text-align:center;line-height:1.5">`
    + `<h2 style="color:#8ce23a">Z-Score Lite</h2><h3>${title}</h3><p style="max-width:460px;margin:12px auto">${text}</p>`
    + `<p><a style="color:#8ce23a" href="${cfg().siteUrl}">Volver al sitio</a></p></body>`);
}

const saleHits = new Map(); // ip -> [timestamps]

/** GET /api/license/comprar: lleva al checkout de Mercado Pago con el precio vigente. */
async function handleSale(req, res, ip) {
  if (req.method !== 'GET') { reply(res, 405, { error: 'método' }); return; }
  const now = Date.now();
  const recent = (saleHits.get(ip) || []).filter((t) => now - t < 3600000);
  recent.push(now);
  saleHits.set(ip, recent);
  if (recent.length > SALE_HITS_PER_HOUR) { htmlPage(res, 429, 'Demasiados intentos', 'Probá de nuevo en un rato.'); return; }
  try {
    const url = await saleLink();
    res.writeHead(302, { Location: url, 'Cache-Control': 'no-store' });
    res.end();
  } catch (e) {
    console.error(`compra: ${e.message}`);
    htmlPage(res, 503, 'La compra online todavía no está disponible', 'Escribinos y te enviamos tu licencia.' + (cfg().support ? ` <b>${cfg().support}</b>` : ''));
  }
}

/** GET /api/license/gracias: adonde vuelve el cliente después de pagar. */
function handleThanks(req, res, url) {
  const estado = url.searchParams.get('estado');
  if (estado === 'pendiente') htmlPage(res, 200, 'Tu pago está pendiente', 'Apenas se acredite te mandamos por email tu código y los pasos para instalar la app. Revisá también la carpeta de spam.');
  else if (estado === 'fallo') htmlPage(res, 200, 'No se pudo completar el pago', 'No se te cobró nada. Podés volver a intentarlo desde el sitio.');
  else htmlPage(res, 200, '¡Gracias por tu compra!', 'En unos minutos te llega un email con tu código de licencia, el link de descarga y los pasos para activarla. Si no lo ves, revisá la carpeta de spam.');
}

// ---------- Resumen para el panel ----------

function summary(db = lib.readDb(), now = new Date()) {
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const totals = {};
  const review = [];
  const rows = [];
  for (const [id, p] of Object.entries(db.payments)) {
    if (p.status === 'approved' && p.at >= monthStart) {
      const t = totals[p.currency] || (totals[p.currency] = { currency: p.currency, total: 0, count: 0 });
      t.total += p.amount;
      t.count += 1;
    } else if (p.status !== 'approved') {
      review.push({ id, code: p.code, status: p.status, amount: p.amount, currency: p.currency, at: p.revertedAt || p.at });
    }
    const lic = db.licenses[p.code];
    rows.push({
      id, at: p.at, code: p.code, kind: p.kind || 'renewal', status: p.status, amount: p.amount, currency: p.currency, days: p.days,
      customer: (lic && lic.customer) || p.payerName || '', email: (lic && lic.email) || p.payerEmail || '',
      paidUntil: lic ? lic.paidUntil : null, licState: lic ? ops.stateOf(lic) : '',
      mail: p.mail ? p.mail.status : '', mailTo: p.mail && p.mail.to ? p.mail.to : '', mailError: p.mail && p.mail.lastError ? p.mail.lastError : '',
    });
  }
  review.sort((a, b) => b.at - a.at);
  rows.sort((a, b) => b.at - a.at);
  const c = cfg();
  return {
    configured: isConfigured(),
    mailConfigured: mailer.isConfigured(),
    saleUrl: c.saleUrl,
    config: {
      sale: db.config.sale || null,
      adminEmail: db.config.adminEmail || '',
      remindDays: db.config.remindDays === undefined ? DEFAULT_REMIND_DAYS : db.config.remindDays,
    },
    month: Object.values(totals),
    review: review.slice(0, 20),
    rows: rows.slice(0, 200),
  };
}

module.exports = {
  isConfigured, createLink, saleLink, saveConfig, applyPayment, notifyPayment, retryPending, sendInstructions, sendTest, remindExpiring, startJobs,
  handleWebhook, handleSale, handleThanks, summary, REF_PATTERN,
};
