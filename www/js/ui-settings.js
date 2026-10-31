import { getSettings, saveSettings, feedbackTap, BALL_SIZES } from './settings.js';
import { getLicense, describeLicense, renew, LICENSE_REQUIRED } from './license.js';
import { exportBackup, importBackup, listMatches, listPlayerNames, savePlayerName, deletePlayerName, renamePlayer } from './db.js';

import { listVoices, neuralVoices, downloadNeural, speak } from './tts.js';

function escapeAttr(t) {
  return String(t).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

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

  function licenseCard() {
    const lic = getLicense();
    if (!lic.info) {
      return LICENSE_REQUIRED ? '' : `
      <div class="section-title">Licencia</div>
      <div class="set-card">
        <div class="match-card-meta">Esta app todavía no tiene una licencia activada.</div>
        <button class="btn btn-ghost btn-block" data-action="go-license" style="margin-top:10px;">Activar con un código</button>
      </div>`;
    }
    return `
      <div class="section-title">Licencia</div>
      <div class="set-card">
        <div class="set-title">${describeLicense(lic)}</div>
        <div class="match-card-meta">Código ${lic.info.code}</div>
        ${lic.info.exp != null ? '<button class="btn btn-ghost btn-block" id="license-renew" style="margin-top:10px;">Renovar ahora</button>' : ''}
      </div>`;
  }

  function legacyVoiceCard(s) {
    const voices = listVoices();
    const canInstall = !!window.ZScoreNative?.openVoiceInstall;
    if (voices.length < 2 && !canInstall) return '';
    const row = (v, icon, title, sub) => `
      <div class="voice-row${v.name === (s.voiceName || '') ? ' is-active' : ''}" data-voice="${escapeAttr(v.name)}">
        <div class="voice-avatar">${icon}</div>
        <div class="voice-info"><div class="voice-name">${escapeAttr(title)}</div><div class="voice-sub">${escapeAttr(sub)}</div></div>
        <div class="voice-check">✓</div>
      </div>`;
    const icon = (v) => (v.gender === 'femenina' ? '♀' : v.gender === 'masculina' ? '♂' : '🎙');
    const group = (region, label) => {
      const list = voices.filter((v) => v.region === region);
      return list.length
        ? `<div class="voice-group">${label}</div>${list.map((v) => row(v, icon(v), v.title, v.sub)).join('')}`
        : '';
    };
    return `
      <div class="section-title">Voz del anuncio</div>
      <div class="set-card voice-card">
        <div class="match-card-meta" style="margin-bottom:10px;">Tocá una voz para elegirla y escucharla.</div>
        ${row({ name: '' }, '✨', 'Automática', 'La mejor en español disponible')}
        ${group('Argentina', '🇦🇷 Argentina')}
        ${group('Latina', '🌎 Latinoamérica')}
        ${group('Otras', '🌍 España y EE. UU.')}
        ${canInstall ? `<button class="btn btn-ghost btn-block" id="voice-install" style="margin-top:12px;">⬇ Descargar más voces</button>
        ${window.ZScoreNative.openTtsSettings ? '<button class="btn btn-ghost btn-block" id="voice-settings" style="margin-top:8px;">⚙ Ajustes de voz de Android</button>' : ''}
        <div class="match-card-meta" style="margin-top:8px;">Si no ves la voz que buscás, descargala o cambiá el motor de voz en Android y volvé a abrir Ajustes para ver las nuevas.</div>` : ''}
      </div>`;
  }

  function voiceCard(s) {
    const voices = neuralVoices();
    if (!voices.length) return legacyVoiceCard(s); // APK anterior, sin voces propias
    const row = (v) => {
      const active = s.neuralVoice === v.id;
      const state = v.installed
        ? '<div class="voice-check">✓</div>'
        : `<button class="btn btn-ghost voice-get" data-get="${v.id}">Bajar · ${v.mb} MB</button>`;
      return `
      <div class="voice-row${active ? ' is-active' : ''}${v.installed ? '' : ' is-pending'}" data-neural="${v.id}">
        <div class="voice-avatar">${v.gender === 'femenina' ? '♀' : '♂'}</div>
        <div class="voice-info"><div class="voice-name">${escapeAttr(v.name)}</div><div class="voice-sub" data-sub="${v.id}">${v.country}${v.id === 'martin' ? ' · grave' : ''}</div></div>
        ${state}
      </div>`;
    };
    const system = `
      <div class="voice-row${!s.neuralVoice ? ' is-active' : ''}" data-neural="">
        <div class="voice-avatar">📱</div>
        <div class="voice-info"><div class="voice-name">Voz del celular</div><div class="voice-sub">Cambia según el equipo</div></div>
        <div class="voice-check">✓</div>
      </div>`;
    return `
      <div class="section-title">Voz del anuncio</div>
      <div class="set-card voice-card">
        <div class="match-card-meta" style="margin-bottom:10px;">Voces latinas propias de la app: suenan igual en cualquier celular y funcionan sin internet. Bajá la que quieras una sola vez y tocala para elegirla.</div>
        <div class="voice-grid">${voices.map(row).join('')}</div>
        ${system}
        <div class="match-card-meta" style="margin-top:10px;">Voces: Piper (licencias Unlicense, Apache 2.0 y CC BY-SA 4.0; la de Daniela es del corpus OpenSLR 61).</div>
      </div>`;
  }

  async function render() {
    const s = getSettings();
    const total = (await listMatches()).length;
    const players = (await listPlayerNames()).sort((a, b) => a.localeCompare(b, 'es'));
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

      ${voiceCard(s)}

      <div class="section-title">Pantalla</div>
      ${toggle('highContrast', 'Alto contraste', 'Fondo negro puro y colores más fuertes, para sol directo', s.highContrast)}
      <div class="set-card">
        <div class="set-title">Tamaño de la pelota de saque</div>
        ${seg('ballSize', Object.entries(BALL_SIZES).map(([k, v]) => [k, v.label]), s.ballSize)}
      </div>

      <div class="section-title">Partido en vivo</div>
      ${toggle('liveAuto', 'Transmitir cada partido', 'Genera el link para el público apenas empieza el partido. También se puede activar desde el menú del marcador.', s.liveAuto)}

      ${licenseCard()}

      <div class="section-title">Jugadores</div>
      <div class="set-card">
        <div class="match-card-meta" style="margin-bottom:10px;">Cargalos acá para tenerlos a mano al armar un partido y llevar sus estadísticas. Escribí nombre y apellido, o el apodo con el que se lo conoce.</div>
        <div class="player-add">
          <input type="text" class="wizard-search" id="player-new" placeholder="Nombre y apellido o apodo" autocomplete="off" />
          <button class="btn btn-primary" id="player-add">Agregar</button>
        </div>
        <div class="chip-list player-list">
          ${players.length
            ? players.map((n) => `<span class="chip chip--edit">${escapeAttr(n)}
                <button class="chip-act" data-act="rename" data-player="${escapeAttr(n)}" aria-label="Cambiar nombre">✎</button>
                <button class="chip-act" data-act="delete" data-player="${escapeAttr(n)}" aria-label="Quitar">✕</button>
              </span>`).join('')
            : '<div class="match-card-meta">Todavía no hay jugadores cargados.</div>'}
        </div>
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

  // El APK avisa el avance de cada descarga de voz.
  window.__zsVoice = (id, state, percent) => {
    const sub = body.querySelector(`[data-sub="${id}"]`);
    const btn = body.querySelector(`[data-get="${id}"]`);
    if (state === 'descargando' && btn) btn.textContent = `Bajando… ${percent}%`;
    if (state === 'error') {
      if (btn) { btn.disabled = false; btn.textContent = 'Reintentar'; }
      if (sub) sub.textContent = 'No se pudo bajar. Revisá tu conexión.';
    }
    if (state.startsWith('fallo')) { alert(`No se pudo reproducir la voz.
${state}`); return; }
    if (state === 'listo') {
      saveSettings({ neuralVoice: id });
      render().then(() => speak('Quince a treinta. Juego, Argentina.'));
    }
  };

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
    if (e.target.id === 'voice-install') {
      if (!window.ZScoreNative.openVoiceInstall()) alert('Abrí Ajustes de Android → Salida de texto a voz para descargar voces.');
      return;
    }
    if (e.target.id === 'voice-settings') {
      if (!window.ZScoreNative.openTtsSettings()) alert('Abrí Ajustes de Android → Salida de texto a voz.');
      return;
    }
    const legacyRow = e.target.closest('.voice-row[data-voice]');
    if (legacyRow) {
      saveSettings({ voiceName: legacyRow.dataset.voice });
      body.querySelectorAll('.voice-row').forEach((r) => r.classList.toggle('is-active', r === legacyRow));
      speak('Quince a treinta. Juego, Argentina.');
      return;
    }
    const getBtn = e.target.closest('[data-get]');
    if (getBtn) {
      const id = getBtn.dataset.get;
      getBtn.disabled = true;
      getBtn.textContent = 'Bajando… 0%';
      if (!downloadNeural(id)) { getBtn.disabled = false; getBtn.textContent = 'Reintentar'; }
      return;
    }
    const voiceRow = e.target.closest('.voice-row');
    if (voiceRow && !voiceRow.classList.contains('is-pending')) {
      saveSettings({ neuralVoice: voiceRow.dataset.neural });
      body.querySelectorAll('.voice-row').forEach((r) => r.classList.toggle('is-active', r === voiceRow));
      speak('Quince a treinta. Juego, Argentina.');
      return;
    }
    if (e.target.id === 'license-renew') {
      e.target.disabled = true;
      e.target.textContent = 'Consultando…';
      const ok = await renew({ force: true });
      alert(ok ? 'Licencia renovada.' : 'No hay una renovación disponible (revisá tu conexión o el pago).');
      render();
      return;
    }
    if (e.target.id === 'player-add') { await addPlayer(); return; }
    const chip = e.target.closest('[data-player]');
    if (chip) {
      const name = chip.dataset.player;
      if (chip.dataset.act === 'rename') {
        const to = (prompt('Nombre correcto:', name) || '').trim().replace(/\s+/g, ' ');
        if (!to || to === name) return;
        try { await renamePlayer(name, to); } catch (err) { alert(err?.message || 'No se pudo cambiar el nombre.'); return; }
        onDataChanged?.();
        render();
      } else if (confirm(`¿Quitar a "${name}" de la lista? Sus partidos y estadísticas no se borran.`)) {
        await deletePlayerName(name);
        render();
      }
      return;
    }
    if (e.target.id === 'backup-export') { await doExport(); return; }
    if (e.target.id === 'backup-import') { fileInput.click(); }
  });

  async function addPlayer() {
    const input = document.getElementById('player-new');
    const name = input.value.trim().replace(/\s+/g, ' ');
    if (!name) return;
    const exists = (await listPlayerNames()).some((n) => n.toLowerCase() === name.toLowerCase());
    if (!exists) await savePlayerName(name);
    await render();
    document.getElementById('player-new').focus();
  }

  body.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.id === 'player-new') addPlayer();
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
