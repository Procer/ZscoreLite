// Textos de los emails de Z-Score Lite (compra, renovación, aviso de vencimiento y aviso de venta para el dueño).
// Cada email sale en dos versiones: `text` (texto plano) y `html` (el que ve casi todo el mundo).
// Solo arman contenido: el envío lo hace license-mail.cjs y la lógica license-pay.cjs.

'use strict';

const TZ = 'America/Argentina/Buenos_Aires';

const fmtDate = (ms) => new Date(ms).toLocaleDateString('es-AR', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric' });
const fmtMoney = (n, currency) => `${new Intl.NumberFormat('es-AR', { maximumFractionDigits: 2 }).format(n)} ${currency}`.trim();
const greeting = (name) => (name ? `Hola ${name},` : 'Hola,');

const FOOTER = (support, siteUrl) => ['', '--', 'Zarate System Group · Z-Score Lite', siteUrl].concat(support ? [`¿Dudas? Escribinos a ${support}`] : []).join('\n');

// ---------- Piezas del HTML (tablas y estilos en línea: es lo que entienden todos los programas de correo) ----------

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const FONT = "-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const INK = '#111827';
const MUTED = '#6b7280';
const GREEN = '#16a34a';

const button = (url, label) => `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0"><tr>`
  + `<td align="center" bgcolor="${GREEN}" style="border-radius:10px"><a href="${esc(url)}" style="display:inline-block;padding:15px 32px;font:700 17px ${FONT};color:#ffffff;text-decoration:none;border-radius:10px">${esc(label)}</a></td></tr></table>`;

const heading = (t) => `<h1 style="margin:0 0 6px;font:800 24px/1.25 ${FONT};color:${INK}">${esc(t)}</h1>`;
const para = (html, extra = '') => `<p style="margin:0 0 16px;font:16px/1.55 ${FONT};color:#374151;${extra}">${html}</p>`;
const small = (html) => `<span style="font:13px/1.5 ${FONT};color:${MUTED}">${html}</span>`;
const section = (t) => `<h2 style="margin:26px 0 14px;font:700 13px ${FONT};letter-spacing:1.2px;text-transform:uppercase;color:${MUTED}">${esc(t)}</h2>`;

const codeBox = (code, detail) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:18px 0 6px;background:#f3f4f6;border:2px dashed #cbd5e1;border-radius:12px"><tr>`
  + `<td align="center" style="padding:20px 12px"><div style="font:700 12px ${FONT};letter-spacing:1.4px;color:${MUTED}">TU CÓDIGO DE LICENCIA</div>`
  + `<div style="margin:8px 0;font:800 30px 'Courier New',Courier,monospace;letter-spacing:2px;color:${INK};-webkit-user-select:all;user-select:all">${esc(code)}</div>`
  + `<div style="font:14px ${FONT};color:${MUTED}">${detail}</div></td></tr></table>`;

const steps = (list) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${list.map(([title, body], i) => (
  `<tr><td valign="top" width="46" style="padding:0 0 18px"><div style="width:32px;height:32px;line-height:32px;border-radius:16px;background:#0b0e13;color:#ffffff;text-align:center;font:700 15px ${FONT}">${i + 1}</div></td>`
  + `<td valign="top" style="padding:3px 0 18px;font:15px/1.5 ${FONT};color:#374151"><b style="font-size:16px;color:${INK}">${title}</b>${body ? `<br>${body}` : ''}</td></tr>`
)).join('')}</table>`;

const panelBox = (html) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:6px 0 4px;background:#f8fafc;border:1px solid #e5e7eb;border-radius:10px"><tr><td style="padding:14px 16px;font:14px/1.55 ${FONT};color:#374151">${html}</td></tr></table>`;

const bullets = (items) => `<ul style="margin:0;padding:0 0 0 20px;font:14px/1.7 ${FONT};color:#374151">${items.map((i) => `<li>${i}</li>`).join('')}</ul>`;

const rows = (list) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:14px 0;border-top:1px solid #e5e7eb">${list.map(([k, v]) => (
  `<tr><td style="padding:10px 0;border-bottom:1px solid #e5e7eb;font:14px ${FONT};color:${MUTED}" width="35%">${esc(k)}</td>`
  + `<td style="padding:10px 0;border-bottom:1px solid #e5e7eb;font:600 15px ${FONT};color:${INK}">${v}</td></tr>`
)).join('')}</table>`;

const logoUrl = () => `${(process.env.PUBLIC_URL || 'https://lite.zscore.ar').replace(/\/+$/, '')}/api/license/logo.png`;

function layout({ title, preheader, body, support, siteUrl }) {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<meta name="color-scheme" content="light"><title>${esc(title)}</title></head>`
    + `<body style="margin:0;padding:0;background:#eef1f5">`
    + `<div style="display:none;max-height:0;overflow:hidden;opacity:0;font-size:1px;color:#eef1f5">${esc(preheader)}</div>`
    + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef1f5"><tr><td align="center" style="padding:24px 12px">`
    + `<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px">`
    + `<tr><td style="background:#0b0e13;border-radius:16px 16px 0 0;padding:18px 28px"><table role="presentation" cellpadding="0" cellspacing="0"><tr>`
    + `<td valign="middle" style="padding-right:12px"><img src="${esc(logoUrl())}" width="46" height="43" alt="Z" style="display:block;border:0;width:46px;height:43px"></td>`
    + `<td valign="middle" style="font:800 21px ${FONT};letter-spacing:.6px;color:#ffffff">Z-SCORE <span style="color:#a3e635">LITE</span></td></tr></table></td></tr>`
    + `<tr><td style="background:#ffffff;border-radius:0 0 16px 16px;padding:30px 28px">${body}</td></tr>`
    + `<tr><td align="center" style="padding:18px 8px;font:12px/1.7 ${FONT};color:${MUTED}">Zarate System Group · Z-Score Lite<br>`
    + `<a href="${esc(siteUrl)}" style="color:${MUTED}">${esc(siteUrl)}</a>`
    + `${support ? `<br>¿Dudas? Escribinos a <a href="mailto:${esc(support)}" style="color:${MUTED}">${esc(support)}</a>` : ''}</td></tr>`
    + `</table></td></tr></table></body></html>`;
}

// ---------- Emails ----------

/**
 * Email de bienvenida: código, vencimiento, cómo instalarla.
 * `pageUrl` es la página de descarga (la que conviene mandar); `downloadUrl` es el link directo al APK, como plan B.
 * Ambos pueden ser null si todavía no hay APK.
 */
function instructions({ code, name, type = 'paga', expiresAt, pageUrl, downloadUrl, webUrl, support, siteUrl, payment, linkHours = 72 }) {
  const mainUrl = pageUrl || downloadUrl;
  const kindName = { cortesia: 'de cortesía', prueba: 'de prueba' }[type] || '';
  const daysLeft = expiresAt == null ? null : Math.max(1, Math.ceil((expiresAt - Date.now()) / 86400000));
  const vence = expiresAt == null ? 'Esta licencia no tiene vencimiento.'
    : type === 'prueba' ? `Es una licencia de prueba de ${daysLeft} ${daysLeft === 1 ? 'día' : 'días'}: vence el ${fmtDate(expiresAt)}.`
      : `Vence el ${fmtDate(expiresAt)}.`;
  const tag = type === 'cortesia' ? 'Licencia de cortesía · sin vencimiento'
    : type === 'prueba' ? `Licencia de prueba · ${daysLeft} ${daysLeft === 1 ? 'día' : 'días'}` : '';
  const intro = payment ? '¡Gracias por tu compra! Tu licencia de Z-Score Lite ya está lista.'
    : kindName ? `Te damos una licencia ${kindName} de Z-Score Lite. Estos son sus datos.` : 'Estos son los datos de tu licencia de Z-Score Lite.';

  const lines = [greeting(name), '', intro, ''];
  lines.push('TU CÓDIGO DE LICENCIA', `    ${code}`, '', ...(tag ? [`Tipo: ${tag}`] : []), vence, '');
  if (mainUrl) {
    lines.push(
      'CÓMO INSTALARLA EN ANDROID',
      `1. Descargá la app con este link personal (vale ${linkHours} horas):`,
      `   ${mainUrl}`,
    );
    if (pageUrl && downloadUrl) lines.push('   Si no se descarga, copiá este otro link y pegalo en Chrome:', `   ${downloadUrl}`);
    lines.push(
      '2. Abrí el archivo descargado (tocá la notificación de descarga o buscalo en "Descargas").',
      '3. Abrí Z-Score Lite, escribí el código de arriba y tocá "Activar".',
      '   Queda atado a ese celular y después funciona sin internet en la cancha.',
      '',
      'SI ANDROID TE BLOQUEA LA INSTALACIÓN (es normal: la app no viene de Google Play)',
      '- Si dice "tu teléfono no puede instalar aplicaciones desconocidas desde esta fuente": tocá "Ajustes", activá',
      '  "Permitir desde esta fuente", volvé atrás y tocá "Instalar".',
      '- Si aparece un aviso de "Play Protect": tocá "Más detalles" y después "Instalar de todos modos".',
      '',
    );
  } else {
    lines.push(
      'CÓMO ACTIVARLA',
      '1. Abrí Z-Score Lite en tu celular, escribí el código de arriba y tocá "Activar".',
      '   Queda atado a ese celular y después funciona sin internet en la cancha.',
      '',
    );
  }
  lines.push(
    '¿PREFERÍS USARLA EN EL NAVEGADOR (por ejemplo en iPhone)?',
    `Entrá a ${webUrl} y activá el mismo código.`,
    '',
    'TENÉ EN CUENTA',
    '- Un código funciona en un solo celular. Si cambiás de celular, escribinos y te lo liberamos.',
    '- Guardá este email: tiene tu código.',
    ...(type === 'paga' ? ['- Unos días antes de que venza te mandamos un link para renovarla.'] : []),
  );
  if (payment) lines.push('', `Pago registrado: ${fmtMoney(payment.amount, payment.currency)} · ${payment.days} días · Mercado Pago #${payment.id}`);
  lines.push(FOOTER(support, siteUrl));

  // HTML
  const install = mainUrl
    ? steps([
      ['Descargá la app', `Tocá el botón desde tu celular Android.<div style="padding:12px 0 6px">${button(mainUrl, 'Descargar la app')}</div>${small(`El link es personal y vale ${linkHours} horas.`)}`],
      ['Instalala', 'Abrí el archivo descargado (tocá la notificación de descarga, o buscalo en «Descargas»). Android te va a mostrar avisos de seguridad: son normales, '
        + 'porque la app no viene de Google Play. Más abajo te explicamos cómo pasarlos.'],
      ['Activá tu licencia', 'Abrí Z-Score Lite, escribí el código de arriba y tocá «Activar». Queda atado a ese celular y después funciona sin internet en la cancha.'],
    ])
    : steps([['Activá tu licencia', 'Abrí Z-Score Lite en tu celular, escribí el código de arriba y tocá «Activar». Queda atado a ese celular y después funciona sin internet en la cancha.']]);
  const androidHelp = mainUrl
    ? section('Si Android te bloquea la instalación')
      + panelBox('<b>1. «Por tu seguridad, tu teléfono no puede instalar aplicaciones desconocidas desde esta fuente»</b><br>'
        + 'Tocá <b>«Ajustes»</b>, activá <b>«Permitir desde esta fuente»</b>, volvé atrás con la flecha y tocá <b>«Instalar»</b>. '
        + 'Es un permiso para el navegador o el programa desde donde descargaste; lo podés quitar después.')
      + '<div style="height:10px"></div>'
      + panelBox('<b>2. Aviso de «Play Protect»</b><br>Tocá <b>«Más detalles»</b> y después <b>«Instalar de todos modos»</b>. '
        + 'Aparece porque la app todavía no está en Google Play; no significa que sea peligrosa.')
    : '';
  const fallback = pageUrl && downloadUrl
    ? panelBox(`<b>¿No se descarga?</b> Copiá este link, pegalo en la barra de Chrome y tocá Ir:<br><span style="word-break:break-all;color:${MUTED}">${esc(downloadUrl)}</span>`)
    : '';
  const html = layout({
    title: payment ? 'Tu licencia de Z-Score Lite está lista' : `Tu licencia ${kindName} de Z-Score Lite`.replace('  ', ' '),
    preheader: `Tu código: ${code}. Descargá la app y activala en 3 pasos.`,
    support,
    siteUrl,
    body: heading(payment ? '¡Tu licencia está lista!' : kindName ? `Tu licencia ${kindName}` : 'Los datos de tu licencia')
      + para(`${esc(greeting(name))} ${esc(intro)}`, 'margin-top:8px')
      + codeBox(code, `${tag ? `<b>${esc(tag)}</b><br>` : ''}${esc(vence)} Funciona en 1 celular.`)
      + section(mainUrl ? 'Instalala en 3 pasos' : 'Cómo activarla')
      + install + fallback + androidHelp
      + section('¿iPhone o preferís el navegador?')
      + para(`Entrá a <a href="${esc(webUrl)}" style="color:${GREEN};font-weight:700">${esc(webUrl)}</a> y activá el mismo código.`, 'margin-bottom:6px')
      + section('Tené en cuenta')
      + bullets([
        'Un código funciona en <b>un solo celular</b>. Si cambiás de celular, escribinos y te lo liberamos.',
        '<b>Guardá este email</b>: tiene tu código.',
        ...(type === 'paga' ? ['Unos días antes de que venza te mandamos un link para renovarla.'] : []),
      ])
      + (payment ? `<p style="margin:26px 0 0;padding-top:14px;border-top:1px solid #e5e7eb;font:13px ${FONT};color:${MUTED}">Pago registrado: ${esc(fmtMoney(payment.amount, payment.currency))} · ${esc(payment.days)} días · Mercado Pago #${esc(payment.id)}</p>` : ''),
  });
  return { subject: payment ? 'Tu licencia de Z-Score Lite está lista' : kindName ? `Tu licencia ${kindName} de Z-Score Lite` : 'Los datos de tu licencia de Z-Score Lite', text: lines.join('\n'), html };
}

/** Recibo cuando alguien renueva una licencia que ya tenía. */
function receipt({ code, name, expiresAt, payment, support, siteUrl }) {
  const lines = [
    greeting(name), '',
    `¡Gracias! Recibimos tu pago de ${fmtMoney(payment.amount, payment.currency)} (${payment.days} días, Mercado Pago #${payment.id}).`, '',
    `Tu licencia ${code} sigue activa y ahora vence el ${fmtDate(expiresAt)}.`,
    'No tenés que hacer nada: la app se actualiza sola la próxima vez que se conecte a internet.',
    FOOTER(support, siteUrl),
  ];
  const subject = `Recibimos tu pago: tu licencia vence el ${fmtDate(expiresAt)}`;
  const html = layout({
    title: subject,
    preheader: `Tu licencia ${code} ahora vence el ${fmtDate(expiresAt)}.`,
    support,
    siteUrl,
    body: heading('¡Gracias por tu pago!')
      + para(`${esc(greeting(name))} recibimos tu pago y tu licencia ya está al día.`, 'margin-top:8px')
      + rows([
        ['Licencia', `<span style="font-family:'Courier New',monospace">${esc(code)}</span>`],
        ['Pago', `${esc(fmtMoney(payment.amount, payment.currency))} · ${esc(payment.days)} días`],
        ['Vence el', esc(fmtDate(expiresAt))],
        ['Mercado Pago', `#${esc(payment.id)}`],
      ])
      + para('No tenés que hacer nada: la app se actualiza sola la próxima vez que se conecte a internet.', 'margin-bottom:0'),
  });
  return { subject, text: lines.join('\n'), html };
}

/** Aviso unos días antes de vencer, con el link para renovar. */
function reminder({ code, name, expiresAt, payUrl, amount, currency, days, support, siteUrl }) {
  const lines = [
    greeting(name), '',
    `Tu licencia de Z-Score Lite (${code}) vence el ${fmtDate(expiresAt)}.`, '',
    `Para seguir usándola, renovala acá (${fmtMoney(amount, currency)} por ${days} días):`,
    `   ${payUrl}`, '',
    'Pagás con Mercado Pago y se extiende sola. Si ya pagaste, ignorá este mensaje.',
    FOOTER(support, siteUrl),
  ];
  const subject = `Tu licencia de Z-Score Lite vence el ${fmtDate(expiresAt)}`;
  const html = layout({
    title: subject,
    preheader: `Renovala por ${fmtMoney(amount, currency)} y seguí usando la app.`,
    support,
    siteUrl,
    body: heading('Tu licencia vence pronto')
      + para(`${esc(greeting(name))} tu licencia <b style="font-family:'Courier New',monospace">${esc(code)}</b> vence el <b>${esc(fmtDate(expiresAt))}</b>.`, 'margin-top:8px')
      + para(`Para seguir usándola, renovala por <b>${esc(fmtMoney(amount, currency))}</b> (${esc(days)} días):`)
      + `<div style="padding:4px 0 18px">${button(payUrl, 'Renovar mi licencia')}</div>`
      + para('Pagás con Mercado Pago y se extiende sola, sin reinstalar nada. Si ya pagaste, ignorá este mensaje.', 'margin-bottom:0')
      + `<p style="margin:16px 0 0">${small(`¿No funciona el botón? Copiá este link en tu navegador:<br><span style="word-break:break-all">${esc(payUrl)}</span>`)}</p>`,
  });
  return { subject, text: lines.join('\n'), html };
}

/** Aviso para el dueño cada vez que entra un pago. */
function adminSale({ code, customer, email, payment, kind, expiresAt, panelUrl }) {
  const title = kind === 'new' ? 'Nueva venta por Mercado Pago' : 'Renovación por Mercado Pago';
  const lines = [
    title, '',
    `Monto:    ${fmtMoney(payment.amount, payment.currency)} (${payment.days} días)`,
    `Cliente:  ${customer || '(sin nombre)'}`,
    `Email:    ${email || '(sin email)'}`,
    `Licencia: ${code}`,
    `Vence:    ${fmtDate(expiresAt)}`,
    `Pago:     Mercado Pago #${payment.id}`, '',
    `Verlo en el panel: ${panelUrl}`,
  ];
  const subject = `${kind === 'new' ? 'Nueva venta' : 'Renovación'}: ${fmtMoney(payment.amount, payment.currency)} · ${code}`;
  const html = layout({
    title: subject,
    preheader: `${fmtMoney(payment.amount, payment.currency)} · ${customer || email || code}`,
    support: '',
    siteUrl: 'https://www.zscore.ar',
    body: heading(title)
      + rows([
        ['Monto', `${esc(fmtMoney(payment.amount, payment.currency))} (${esc(payment.days)} días)`],
        ['Cliente', esc(customer || '(sin nombre)')],
        ['Email', esc(email || '(sin email)')],
        ['Licencia', `<span style="font-family:'Courier New',monospace">${esc(code)}</span>`],
        ['Vence el', esc(fmtDate(expiresAt))],
        ['Mercado Pago', `#${esc(payment.id)}`],
      ])
      + `<div style="padding:6px 0 0">${button(panelUrl, 'Abrir el panel')}</div>`,
  });
  return { subject, text: lines.join('\n'), html };
}

function test({ panelUrl }) {
  return {
    subject: 'Prueba de email de Z-Score Lite',
    text: ['Si estás leyendo esto, el envío de emails del servidor funciona.', '', `Panel: ${panelUrl}`].join('\n'),
  };
}

module.exports = { instructions, receipt, reminder, adminSale, test, fmtDate, fmtMoney, esc };
