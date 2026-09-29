// Imagen del resultado del partido (PNG dibujado en canvas) para copiar o
// copiar. Se dibuja a mano, sin librerías, para que funcione sin conexión.

const W = 1080;
const H = 1440;
const GREEN = '#8ce23a';
const RED = '#ff3b3b';
const FONT = '-apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

function loadImage(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Escribe texto achicando la letra hasta que entre en maxWidth. */
function fitText(ctx, text, x, y, maxWidth, size, weight = 800) {
  let s = size;
  ctx.font = `${weight} ${s}px ${FONT}`;
  while (ctx.measureText(text).width > maxWidth && s > 16) {
    s -= 2;
    ctx.font = `${weight} ${s}px ${FONT}`;
  }
  ctx.fillText(text, x, y);
}

function formatDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleDateString('es-AR', { day: '2-digit', month: 'long', year: 'numeric' });
}

export async function renderMatchImage(record, stats) {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  // Fondo
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, '#111722');
  bg.addColorStop(1, '#070a0f');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  const glowA = ctx.createRadialGradient(140, 330, 0, 140, 330, 560);
  glowA.addColorStop(0, 'rgba(140,226,58,0.16)');
  glowA.addColorStop(1, 'rgba(140,226,58,0)');
  ctx.fillStyle = glowA;
  ctx.fillRect(0, 0, W, H);
  const glowB = ctx.createRadialGradient(940, 620, 0, 940, 620, 560);
  glowB.addColorStop(0, 'rgba(255,59,59,0.16)');
  glowB.addColorStop(1, 'rgba(255,59,59,0)');
  ctx.fillStyle = glowB;
  ctx.fillRect(0, 0, W, H);

  // Encabezado
  const logo = await loadImage('icons/icon-192.png');
  if (logo) {
    ctx.save();
    roundRect(ctx, 60, 56, 92, 92, 22);
    ctx.clip();
    ctx.drawImage(logo, 60, 56, 92, 92);
    ctx.restore();
  }
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.fillStyle = '#f5f7fa';
  ctx.font = `800 44px ${FONT}`;
  ctx.fillText('Z-Score ', 176, 116);
  const zw = ctx.measureText('Z-Score ').width;
  ctx.fillStyle = GREEN;
  ctx.fillText('Lite', 176 + zw, 116);
  ctx.textAlign = 'right';
  ctx.fillStyle = '#9aa4b2';
  ctx.font = `600 30px ${FONT}`;
  ctx.fillText(formatDate(record.startedAt), W - 60, 116);

  // Tablero: una fila por pareja, una columna por set
  const sets = record.finalState?.completedSets || [];
  const winner = record.finalState?.winner || null;
  const top = 220;
  const rowH = 190;
  const colW = 120;
  const colsW = Math.max(1, sets.length) * colW;
  const left = 60;
  const right = W - 60;

  roundRect(ctx, left, top, right - left, rowH * 2 + 70, 36);
  ctx.fillStyle = 'rgba(21,26,34,0.92)';
  ctx.fill();
  ctx.strokeStyle = '#262e3b';
  ctx.lineWidth = 2;
  ctx.stroke();

  // Encabezados de set
  ctx.textAlign = 'center';
  ctx.fillStyle = '#6b7686';
  ctx.font = `700 24px ${FONT}`;
  sets.forEach((s, i) => {
    const cx = right - 30 - colsW + i * colW + colW / 2;
    ctx.fillText(s.superTiebreak ? 'STB' : `SET ${i + 1}`, cx, top + 50);
  });

  ['A', 'B'].forEach((side, idx) => {
    const y = top + 70 + idx * rowH;
    const color = side === 'A' ? GREEN : RED;
    const isWinner = winner === side;
    const dim = winner && !isWinner;

    // Barra de color del equipo
    roundRect(ctx, left + 26, y + 30, 14, rowH - 60, 7);
    ctx.fillStyle = color;
    ctx.globalAlpha = dim ? 0.45 : 1;
    ctx.fill();

    ctx.textAlign = 'left';
    ctx.fillStyle = dim ? '#8b95a3' : '#f5f7fa';
    const nameMax = right - left - 80 - colsW - 60;
    fitText(ctx, String(record.teamNames[side]).toUpperCase(), left + 64, y + rowH / 2 + 14, nameMax, 52, 800);

    if (isWinner) {
      ctx.fillStyle = color;
      ctx.font = `800 26px ${FONT}`;
      ctx.fillText('🏆 GANADOR', left + 64, y + rowH / 2 - 44);
    }

    ctx.textAlign = 'center';
    sets.forEach((s, i) => {
      const cx = right - 30 - colsW + i * colW + colW / 2;
      const mine = side === 'A' ? s.gamesA : s.gamesB;
      const theirs = side === 'A' ? s.gamesB : s.gamesA;
      ctx.fillStyle = mine > theirs ? color : '#8b95a3';
      ctx.font = `800 ${mine > theirs ? 96 : 84}px ${FONT}`;
      ctx.fillText(String(mine), cx, y + rowH / 2 + 34);
    });
    ctx.globalAlpha = 1;
  });

  // Divisor entre filas
  ctx.strokeStyle = '#262e3b';
  ctx.beginPath();
  ctx.moveTo(left + 26, top + 70 + rowH);
  ctx.lineTo(right - 26, top + 70 + rowH);
  ctx.stroke();

  // Estadísticas
  const rows = [];
  if (stats && stats.totalPoints) {
    rows.push(['Tantos ganados', stats.pointsWonA, stats.pointsWonB]);
    if (stats.servePctA !== null) rows.push(['Efectividad al saque', `${stats.servePctA}%`, `${stats.servePctB}%`]);
  }
  if (record.finalState) rows.push(['Quiebres de saque', record.finalState.breaksA, record.finalState.breaksB]);

  let y = top + rowH * 2 + 70 + 90;
  if (rows.length) {
    ctx.textAlign = 'left';
    ctx.fillStyle = '#6b7686';
    ctx.font = `700 26px ${FONT}`;
    ctx.fillText('ESTADÍSTICAS', left, y);
    y += 30;
    rows.forEach(([label, a, b]) => {
      y += 100;
      ctx.textAlign = 'left';
      ctx.fillStyle = GREEN;
      ctx.font = `800 58px ${FONT}`;
      ctx.fillText(String(a), left, y);
      ctx.textAlign = 'right';
      ctx.fillStyle = RED;
      ctx.fillText(String(b), right, y);
      ctx.textAlign = 'center';
      ctx.fillStyle = '#c3cad4';
      ctx.font = `600 30px ${FONT}`;
      ctx.fillText(label, W / 2, y - 6);
      ctx.strokeStyle = '#1c2330';
      ctx.beginPath();
      ctx.moveTo(left, y + 28);
      ctx.lineTo(right, y + 28);
      ctx.stroke();
    });
  }

  // Pie: modalidad, duración, lugar
  const durationMin = record.endedAt && record.startedAt
    ? Math.max(1, Math.round((record.endedAt - record.startedAt) / 60000)) : null;
  const meta = [record.club, record.court, durationMin ? `${durationMin} min` : null].filter(Boolean).join('  ·  ');
  ctx.textAlign = 'center';
  if (meta) {
    ctx.fillStyle = '#9aa4b2';
    ctx.font = `600 30px ${FONT}`;
    ctx.fillText(meta, W / 2, H - 120);
  }
  ctx.fillStyle = '#5c6675';
  ctx.font = `600 26px ${FONT}`;
  ctx.fillText('zscore.ar  ·  Creado por ZSG', W / 2, H - 64);

  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/png'));
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

/** Copiar la imagen al portapapeles. 'copied' | 'downloaded' | 'failed' */
export async function copyMatchImage(record, stats) {
  let blob;
  try { blob = await renderMatchImage(record, stats); } catch (e) { return 'failed'; }
  if (!blob) return 'failed';

  // App nativa (Android): el WebView no permite copiar imágenes con la API
  // web, así que se copia con el puente nativo (ver MainActivity.java).
  if (window.ZScoreNative?.copyImage) {
    try {
      const base64 = await blobToBase64(blob);
      if (window.ZScoreNative.copyImage(base64)) return 'copied';
    } catch (e) { /* sigue con la API web */ }
  }

  // Navegador / PWA
  try {
    if (navigator.clipboard?.write && window.ClipboardItem) {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      return 'copied';
    }
  } catch (e) { /* cae a descarga */ }

  // Último recurso: descargar el archivo.
  try {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'zscore-partido.png';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    return 'downloaded';
  } catch (e) {
    return 'failed';
  }
}

/** Mensaje para el usuario según el resultado. */
export function copyResultMessage(result) {
  if (result === 'copied') return 'Imagen copiada. Pegala en WhatsApp o donde quieras.';
  if (result === 'downloaded') return 'Se descargó la imagen del partido.';
  return 'No se pudo copiar la imagen.';
}
