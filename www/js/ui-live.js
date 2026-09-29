import qrcode from './vendor/qrcode.js';
import { startLive, stopLive, getLiveInfo, onLiveChange } from './live.js';

function qrDataUrl(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createDataURL(8, 2);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function initLiveUi({ getController }) {
  const overlay = document.getElementById('overlay-live');
  const content = document.getElementById('live-content');
  let busy = false;
  let error = '';

  function shareMessage(url) {
    return `Seguí el partido en vivo: ${url}`;
  }

  function render() {
    const info = getLiveInfo();
    if (!info.active) {
      content.innerHTML = `
        <h2>Partido en vivo</h2>
        <p>Armá un link para que el público siga el marcador desde su propio celular, en tiempo real. Hace falta conexión a internet.</p>
        ${error ? `<p class="live-error">${escapeHtml(error)}</p>` : ''}
        <button class="btn btn-primary btn-block" data-live="start" ${busy ? 'disabled' : ''}>${busy ? 'Creando link…' : '📡 Empezar transmisión'}</button>
        <button class="btn btn-ghost btn-block" data-live="close">Cerrar</button>`;
      return;
    }
    const statusText = info.status === 'offline' ? '⚠️ Sin conexión, reintentando…' : '● Transmitiendo en vivo';
    content.innerHTML = `
      <h2>Partido en vivo</h2>
      <div class="live-status ${info.status === 'offline' ? 'is-offline' : ''}">${statusText}</div>
      <img class="live-qr" src="${qrDataUrl(info.url)}" alt="Código QR del partido en vivo" />
      <div class="live-code">${escapeHtml(info.code)}</div>
      <div class="live-url">${escapeHtml(info.url)}</div>
      <p style="text-align:center;">El público escanea el QR o abre el link. No necesita instalar nada.</p>
      <button class="btn btn-primary btn-block" data-live="share">📤 Compartir link</button>
      <button class="btn btn-ghost btn-block" data-live="copy">📋 Copiar link</button>
      <button class="btn btn-danger btn-block" data-live="stop">Dejar de transmitir</button>
      <button class="btn btn-ghost btn-block" data-live="close">Cerrar</button>`;
  }

  async function doStart() {
    const controller = getController();
    if (!controller) return;
    busy = true;
    error = '';
    render();
    try {
      await startLive(controller);
    } catch (e) {
      error = e.message || 'No se pudo empezar la transmisión.';
    }
    busy = false;
    render();
  }

  async function doShare(url) {
    const text = shareMessage(url);
    if (window.ZScoreNative?.shareText && window.ZScoreNative.shareText(text)) return;
    if (navigator.share) {
      try { await navigator.share({ text }); return; } catch (e) { if (e?.name === 'AbortError') return; }
    }
    await doCopy(url);
  }

  async function doCopy(url) {
    let ok = false;
    if (window.ZScoreNative?.copyText) ok = window.ZScoreNative.copyText(url);
    if (!ok) {
      try { await navigator.clipboard.writeText(url); ok = true; } catch (e) { ok = false; }
    }
    alert(ok ? 'Link copiado.' : url);
  }

  content.addEventListener('click', async (e) => {
    const action = e.target.closest('[data-live]')?.dataset.live;
    if (!action) return;
    const info = getLiveInfo();
    if (action === 'start') await doStart();
    else if (action === 'share' && info.url) await doShare(info.url);
    else if (action === 'copy' && info.url) await doCopy(info.url);
    else if (action === 'stop') {
      if (confirm('¿Dejar de transmitir? El link va a dejar de funcionar para el público.')) { await stopLive(); render(); }
    } else if (action === 'close') overlay.classList.remove('is-active');
  });

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.classList.remove('is-active');
  });

  // Punto rojo "en vivo" en el reloj del marcador
  onLiveChange((info) => {
    document.getElementById('match-clock')?.classList.toggle('is-live', info.active);
    if (overlay.classList.contains('is-active')) render();
  });

  return {
    open() {
      error = '';
      render();
      overlay.classList.add('is-active');
    },
  };
}
