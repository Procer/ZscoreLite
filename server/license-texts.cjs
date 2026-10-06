// Textos de los emails de Z-Score Lite (compra, renovación, aviso de vencimiento y aviso de venta para el dueño).
// Solo arman texto: el envío lo hace license-mail.cjs y la lógica license-pay.cjs.

'use strict';

const TZ = 'America/Argentina/Buenos_Aires';

const fmtDate = (ms) => new Date(ms).toLocaleDateString('es-AR', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric' });
const fmtMoney = (n, currency) => `${new Intl.NumberFormat('es-AR', { maximumFractionDigits: 2 }).format(n)} ${currency}`.trim();
const greeting = (name) => (name ? `Hola ${name},` : 'Hola,');

const FOOTER = (support, siteUrl) => ['', '--', 'Zarate System Group · Z-Score Lite', siteUrl].concat(support ? [`¿Dudas? Escribinos a ${support}`] : []).join('\n');

/** Email de bienvenida: código, vencimiento, cómo instalarla. `downloadUrl` puede ser null si todavía no hay APK. */
function instructions({ code, name, expiresAt, downloadUrl, webUrl, support, siteUrl, payment, linkHours = 72 }) {
  const lines = [greeting(name), ''];
  lines.push(payment ? '¡Gracias por tu compra! Tu licencia de Z-Score Lite ya está lista.' : 'Estos son los datos de tu licencia de Z-Score Lite.', '');
  lines.push('TU CÓDIGO DE LICENCIA', `    ${code}`, '', expiresAt == null ? 'Esta licencia no tiene vencimiento.' : `Vence el ${fmtDate(expiresAt)}.`, '');

  if (downloadUrl) {
    lines.push(
      'CÓMO INSTALARLA EN ANDROID',
      `1. Descargá la app con este link personal (vale ${linkHours} horas):`,
      `   ${downloadUrl}`,
      '2. Abrí el archivo descargado. Si Android te lo pide, permití "instalar apps de esta fuente": es normal en las apps que no vienen de Google Play.',
      '3. Abrí Z-Score Lite, escribí el código de arriba y tocá "Activar".',
      '   Queda atado a ese celular y después funciona sin internet en la cancha.',
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
    '- Unos días antes de que venza te mandamos un link para renovarla.',
  );
  if (payment) lines.push('', `Pago registrado: ${fmtMoney(payment.amount, payment.currency)} · ${payment.days} días · Mercado Pago #${payment.id}`);
  lines.push(FOOTER(support, siteUrl));
  return { subject: payment ? 'Tu licencia de Z-Score Lite está lista' : 'Los datos de tu licencia de Z-Score Lite', text: lines.join('\n') };
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
  return { subject: `Recibimos tu pago: tu licencia vence el ${fmtDate(expiresAt)}`, text: lines.join('\n') };
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
  return { subject: `Tu licencia de Z-Score Lite vence el ${fmtDate(expiresAt)}`, text: lines.join('\n') };
}

/** Aviso para el dueño cada vez que entra un pago. */
function adminSale({ code, customer, email, payment, kind, expiresAt, panelUrl }) {
  const lines = [
    kind === 'new' ? 'Nueva venta por Mercado Pago' : 'Renovación por Mercado Pago', '',
    `Monto:    ${fmtMoney(payment.amount, payment.currency)} (${payment.days} días)`,
    `Cliente:  ${customer || '(sin nombre)'}`,
    `Email:    ${email || '(sin email)'}`,
    `Licencia: ${code}`,
    `Vence:    ${fmtDate(expiresAt)}`,
    `Pago:     Mercado Pago #${payment.id}`, '',
    `Verlo en el panel: ${panelUrl}`,
  ];
  return { subject: `${kind === 'new' ? 'Nueva venta' : 'Renovación'}: ${fmtMoney(payment.amount, payment.currency)} · ${code}`, text: lines.join('\n') };
}

function test({ panelUrl }) {
  return {
    subject: 'Prueba de email de Z-Score Lite',
    text: ['Si estás leyendo esto, el envío de emails del servidor funciona.', '', `Panel: ${panelUrl}`].join('\n'),
  };
}

module.exports = { instructions, receipt, reminder, adminSale, test, fmtDate, fmtMoney };
