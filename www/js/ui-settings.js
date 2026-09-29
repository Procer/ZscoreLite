import { getSettings, saveSettings, feedbackTap, BALL_SIZES } from './settings.js';
import { exportBackup, importBackup, listMatches } from './db.js';

function todayStamp() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function toBase64(text) {
  return btoa(unescape(encodeURIComponent(text)));
}

export function initSettings({ onDataChanged }) {
  const body = document.getElementById('settings-body');
  const fileInput = document.getElementById('backup-file');

  function seg(name, options, current) {
    return `<div class="seg" data-seg="${name}">${options.map(([value, label]) =>
      `<button class="seg-btn${value === current ? ' is-active' : ''}" data-value="${value}">${label}</button>`).join('')}</div>`;
  }

  function toggle(name, title, sub, checked) {
    return `
      <label class="toggle-row">
        <div><div style="font-weight:600;">${title}</div>${sub ? `<div class="match-card-meta">${sub}</div>` : ''}</div>
        <span class="switch"><input type="checkbox" data-toggle="${name}" ${checked ? 'checked' : ''} /><span class="switch-track"></span></span>
      </label>`;
  }

  async function render() {
    const s = getSettings();
    const total = (await listMatches()).length;
    body.innerHTML = `
      <div class="section-title">Control remoto</div>
      <div class="set-card">
        <div class="set-row">
          <div>
            <div class="set-title">Tiempo para contar los toques</div>
            <div class="match-card-meta">Cuánto espera antes de aplicar. Si el doble toque se lee como dos toques sueltos, subilo.</div>
          </div>
          <div class="set-value" id="tap-window-value">${(s.tapWindowMs / 1000).toFixed(1)} s</div>
        </div>
        <input type="range" class="range" id="tap-window" min="1000" max="3000" step="100" value="${s.tapWindowMs}" />
        <div class="set-row" style="margin-top:14px;">
          <div>
            <div class="set-title">1 toque suma a</div>
            <div class="match-card-meta">2 toques suman al otro lado. 3 toques deshacen.</div>
          </div>
        </div>
        ${seg('firstTapSide', [['left', 'Izquierda'], ['right', 'Derecha']], s.firstTapSide)}
      </div>
      ${toggle('beep', 'Sonido al tocar', 'Un pitido corto por cada toque del control', s.beep)}
      ${toggle('vibrate', 'Vibración al tocar', 'Confirma cada toque sin mirar la pantalla', s.vibrate)}
      <button class="btn btn-ghost btn-block" id="test-feedback">Probar sonido y vibración</button>

      <div class="section-title">Pantalla</div>
      ${toggle('highContrast', 'Alto contraste', 'Fondo negro puro y colores más fuertes, para sol directo', s.highContrast)}
      <div class="set-card">
        <div class="set-title">Tamaño de la pelota de saque</div>
        ${seg('ballSize', Object.entries(BALL_SIZES).map(([k, v]) => [k, v.label]), s.ballSize)}
      </div>

      <div class="section-title">Datos</div>
      <div class="set-card">
        <div class="set-title">Copia de seguridad</div>
        <div class="match-card-meta" style="margin-bottom:12px;">${total} ${total === 1 ? 'partido guardado' : 'partidos guardados'}. Guardá la copia fuera del celular (WhatsApp, Drive o correo) para no perder el historial ni el ranking.</div>
        <button class="btn btn-primary btn-block" id="backup-export">Exportar copia</button>
        <button class="btn btn-ghost btn-block" id="backup-import" style="margin-top:10px;">Importar copia</button>
      </div>
    `;
  }

  body.addEventListener('input', (e) => {
    if (e.target.id === 'tap-window') {
      const ms = Number(e.target.value);
      saveSettings({ tapWindowMs: ms });
      document.getElementById('tap-window-value').textContent = `${(ms / 1000).toFixed(1)} s`;
    }
  });

  body.addEventListener('change', (e) => {
    const name = e.target.dataset?.toggle;
    if (name) saveSettings({ [name]: e.target.checked });
  });

  body.addEventListener('click', async (e) => {
    const segBtn = e.target.closest('.seg-btn');
    if (segBtn) {
      const name = segBtn.parentElement.dataset.seg;
      saveSettings({ [name]: segBtn.dataset.value });
      segBtn.parentElement.querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('is-active', b === segBtn));
      return;
    }
    if (e.target.id === 'test-feedback') {
      feedbackTap(1);
      setTimeout(() => feedbackTap(2), 450);
      setTimeout(() => feedbackTap(0), 900);
      return;
    }
    if (e.target.id === 'backup-export') { await doExport(); return; }
    if (e.target.id === 'backup-import') { fileInput.click(); }
  });

  async function doExport() {
    try {
      const data = await exportBackup();
      const json = JSON.stringify(data);
      const name = `zscore-copia-${todayStamp()}.json`;
      if (window.ZScoreNative?.shareFile) {
        // Dentro de la app: menú de compartir del sistema (WhatsApp, Drive, correo...)
        if (window.ZScoreNative.shareFile(name, toBase64(json), 'application/json')) return;
      }
      const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    } catch (err) {
      alert('No se pudo crear la copia de seguridad.');
    }
  }

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const count = Array.isArray(data.matches) ? data.matches.length : 0;
      if (!confirm(`Se van a sumar ${count} partidos de la copia. Los que ya existen se actualizan y no se borra nada. ¿Continuar?`)) return;
      const result = await importBackup(data);
      alert(`Listo: se importaron ${result.matches} partidos.`);
      onDataChanged?.();
      render();
    } catch (err) {
      alert(err?.message || 'No se pudo leer la copia de seguridad.');
    }
  });

  return { render };
}
