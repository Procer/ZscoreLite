// Cobro con Mercado Pago (Checkout Pro, pago único por período).
//
// Cómo funciona:
//   1. Desde el panel se genera un link de pago para una licencia (monto y días). Se crea una "preferencia" en
//      Mercado Pago con una referencia propia: CÓDIGO:DÍAS:REF. La REF vuelve a este servidor en una tabla
//      (payLinks) que guarda el monto y los días esperados: nada de lo que dice el pago se toma por cierto.
//   2. El cliente paga. Mercado Pago avisa a POST /api/license/pago (webhook).
//   3. El servicio valida la firma del aviso (x-signature), le pregunta el pago a la API de Mercado Pago (no confía
//      en el cuerpo del aviso), comprueba referencia, moneda y monto y recién ahí suma los días a la licencia.
//   4. Un mismo pago nunca se aplica dos veces (se anota por id). Reintegros y contracargos se anotan para
//      revisar a mano; no tocan la licencia solos.
//
// Variables de entorno (en el servicio systemd; el token NO va al repo):
//   MP_ACCESS_TOKEN   token de producción (o de prueba) de la cuenta vendedora
//   MP_WEBHOOK_SECRET "clave secreta" de la firma de webhooks (Tus integraciones > Webhooks)
//   MP_API            solo para pruebas (por defecto https://api.mercadopago.com)
//   PUBLIC_URL        https://lite.zscore.ar

'use strict';

const crypto = require('crypto');
const lib = require('./license-lib.cjs');
const ops = require('./license-ops.cjs');

const DEFAULT_PAY_DAYS = 30;
const MAX_BODY = 16 * 1024;
const MP_TIMEOUT_MS = 10000;
const LINK_VALID_DAYS = 7; // el link de pago vence a los 7 días
const LINK_KEEP_DAYS = 90; // cuánto se guarda la referencia de un link que nadie pagó

const cfg = () => ({
  token: process.env.MP_ACCESS_TOKEN || '',
  secret: process.env.MP_WEBHOOK_SECRET || '',
  api: (process.env.MP_API || 'https://api.mercadopago.com').replace(/\/+$/, ''),
  publicUrl: (process.env.PUBLIC_URL || 'https://lite.zscore.ar').replace(/\/+$/, ''),
});

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

// ---------- Link de pago ----------

function parseAmount(value, fallback) {
  const raw = value != null && value !== '' ? value : fallback;
  const n = Number(raw);
  if (!(n > 0) || n > 10000000) throw new ops.OpError('el monto tiene que ser mayor a 0 (cargá el precio de la licencia o escribilo acá)');
  return Math.round(n * 100) / 100;
}

/** Crea el link de pago de una licencia. Devuelve { url, amount, currency, days }. */
async function createLink(code, opts, actor) {
  if (!isConfigured()) throw new ops.OpError('Mercado Pago no está configurado en el servidor (faltan MP_ACCESS_TOKEN y MP_WEBHOOK_SECRET)');
  const days = opts.days != null && opts.days !== '' ? Number(opts.days) : DEFAULT_PAY_DAYS;
  if (!Number.isInteger(days) || days < 1 || days > 366) throw new ops.OpError('los días tienen que ser un entero de 1 a 366');

  const lic = ops.getLicense(lib.readDb(), code);
  if (lic.revoked) throw new ops.OpError('la licencia está revocada: reactivala antes de cobrar');
  if (lic.type === 'cortesia') throw new ops.OpError('las cortesías no se cobran: convertila a paga primero');
  const amount = parseAmount(opts.amount, lic.price);
  const currency = lic.currency;

  const c = cfg();
  const ref = crypto.randomBytes(5).toString('hex');
  let pref;
  try {
    pref = await mp('POST', '/checkout/preferences', {
    items: [{ id: lic.code, title: `Z-Score Lite · licencia ${days} días`, quantity: 1, unit_price: amount, currency_id: currency }],
    external_reference: `${lic.code}:${days}:${ref}`,
    notification_url: `${c.publicUrl}/api/license/pago`,
    back_urls: { success: c.publicUrl, failure: c.publicUrl, pending: c.publicUrl },
    statement_descriptor: 'ZSCORE LITE',
    expires: true,
    expiration_date_to: new Date(Date.now() + LINK_VALID_DAYS * lib.DAY).toISOString(),
    });
  } catch (e) {
    if (e instanceof MpError) throw Object.assign(new ops.OpError(e.message), { status: 502 });
    throw e;
  }
  if (!pref || typeof pref.init_point !== 'string') throw Object.assign(new ops.OpError('Mercado Pago no devolvió el link de pago'), { status: 502 });

  lib.update((db) => {
    const now = Date.now();
    for (const [k, l] of Object.entries(db.payLinks)) if (now - l.at > LINK_KEEP_DAYS * lib.DAY) delete db.payLinks[k];
    db.payLinks[ref] = { code: lic.code, days, amount, currency, at: now, prefId: String(pref.id || '') };
    lib.addEvent(db.licenses[lic.code], 'link_pago', actor, `${amount} ${currency}, ${days} días`);
  });
  return { url: pref.init_point, amount, currency, days };
}

// ---------- Aplicar un pago ----------

const REF_PATTERN = /^(ZSL-[A-Z0-9]{4}-[A-Z0-9]{4}):(\d{1,3}):([0-9a-f]{10})$/;
const REVERSED = new Set(['refunded', 'charged_back', 'cancelled']);

/** Aplica (o anota) un pago ya traído de Mercado Pago. Corre dentro de lib.update. Devuelve qué pasó. */
function applyPayment(db, payment, now = Date.now()) {
  const id = String(payment.id);
  const known = db.payments[id];

  if (payment.status === 'approved') {
    if (known) return { result: 'repetido' }; // el mismo pago ya se aplicó: no se suma dos veces
    const m = REF_PATTERN.exec(String(payment.external_reference || ''));
    const link = m && db.payLinks[m[3]];
    if (!link || link.code !== m[1] || link.days !== Number(m[2])) return { result: 'sin_referencia' };
    const lic = db.licenses[link.code];
    if (!lic) return { result: 'sin_referencia' };

    const paid = Number(payment.transaction_amount);
    if (payment.currency_id !== link.currency || !(paid >= link.amount)) {
      db.payments[id] = { code: link.code, status: 'monto_incorrecto', amount: paid, currency: payment.currency_id, days: 0, at: now, ref: m[3] };
      lib.addEvent(lic, 'pago_revisar', 'mp', `pago ${id}: llegaron ${paid} ${payment.currency_id}, se esperaban ${link.amount} ${link.currency}; no se sumaron días`);
      return { result: 'monto_incorrecto' };
    }

    if (lic.type !== 'paga') {
      lic.type = 'paga'; // una prueba que paga pasa a paga
    }
    lic.paidUntil = Math.max(lic.paidUntil || 0, now) + link.days * lib.DAY;
    db.payments[id] = { code: link.code, status: 'approved', amount: paid, currency: link.currency, days: link.days, at: now, ref: m[3] };
    lib.addEvent(lic, 'pago', 'mp', `${paid} ${link.currency}, +${link.days} días, vence ${new Date(lic.paidUntil).toISOString().slice(0, 10)} (pago ${id})`
      + (lic.revoked ? ' · LICENCIA REVOCADA: el pago se registró pero sigue revocada, revisala' : ''));
    return { result: 'aplicado', code: link.code, days: link.days };
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

/** POST /api/license/pago. Devuelve true si atendió el pedido. `onBadSignature` cuenta el intento fallido de esa IP. */
async function handleWebhook(req, res, url, onBadSignature) {
  if (req.method !== 'POST') { reply(res, 405, { error: 'método' }); return; }
  if (!isConfigured()) { reply(res, 503, { error: 'sin_cobro' }); return; }

  let body = {};
  try { body = JSON.parse(await readBody(req)) || {}; } catch (e) { body = {}; }
  const dataId = url.searchParams.get('data.id') || (body.data && body.data.id) || '';
  const type = url.searchParams.get('type') || url.searchParams.get('topic') || body.type || '';

  if (!signatureOk(req, url.searchParams.get('data.id') || ''))  {
    onBadSignature();
    console.warn('pago: aviso con firma inválida');
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
  reply(res, 200, { ok: true });
}

// ---------- Resumen para el panel ----------

function summary(db = lib.readDb(), now = new Date()) {
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const totals = {};
  const review = [];
  for (const [id, p] of Object.entries(db.payments)) {
    if (p.status === 'approved' && p.at >= monthStart) {
      const t = totals[p.currency] || (totals[p.currency] = { currency: p.currency, total: 0, count: 0 });
      t.total += p.amount;
      t.count += 1;
    } else if (p.status !== 'approved') {
      review.push({ id, code: p.code, status: p.status, amount: p.amount, currency: p.currency, at: p.revertedAt || p.at });
    }
  }
  review.sort((a, b) => b.at - a.at);
  return { configured: isConfigured(), month: Object.values(totals), review: review.slice(0, 20) };
}

module.exports = { isConfigured, createLink, applyPayment, handleWebhook, summary, REF_PATTERN };
