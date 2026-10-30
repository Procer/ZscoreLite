import { describeConfig } from './scoring-engine.js';
import { listPlayerNames, savePlayerName, deletePlayerName, renamePlayer } from './db.js';
import { initRemoteButton, onRemotePress } from './remote-button.js';
import { firstTapTeam } from './settings.js';
import { createTapChooser, hintText, legendText } from './remote-choice.js';

initRemoteButton();

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Orden maestro de preguntas. isRelevant() decide cuáles se saltean según
// las respuestas ya dadas (así el asistente "guía" sin mostrar pasos que no aplican).
/** Pasos "¿quién saca primero?" de cada pareja; solo si la pareja tiene sus dos jugadores. */
function serverSteps(w) {
  const t = w.mode === 'games' ? { A: w.pairs[0], B: w.pairs[1] } : w.teams;
  return [['server-a', t.A], ['server-b', t.B]].filter(([, p]) => p && p.p1 && p.p2).map(([id]) => id);
}

function stepsFor(w) {
  if (w.mode === 'games') {
    // Formato social: se carga cuántas parejas hay hoy y los dos jugadores de cada una.
    const steps = ['mode', 'targetgames', 'noad', 'paircount'];
    for (let i = 0; i < w.pairCount; i++) steps.push(`spair-${i}-1`, `spair-${i}-2`);
    return [...steps, ...serverSteps(w), 'voice', 'summary'];
  }
  return [
    'mode', 'bestof', 'gamesperset', 'noad',
    ...(w.bestOf > 1 ? ['supertiebreak'] : []),
    'player-a1', 'player-a2', 'player-b1', 'player-b2',
    ...serverSteps(w),
    'voice', 'summary',
  ];
}

export function initSetupWizard(onStartMatch) {
  const stepEl = document.getElementById('wizard-step');
  const progressFill = document.getElementById('wizard-progress-fill');
  const visitedStack = [];
  let currentStepId = null;

  let wizard, playersCache;

  function freshWizard() {
    return {
      mode: 'sets',
      bestOf: 2,
      gamesPerSet: 6,
      targetGames: 4,
      noAd: true,
      superTiebreak: false,
      teams: { A: { p1: '', p2: '' }, B: { p1: '', p2: '' } },
      firstSlot: { A: 'p1', B: 'p1' }, // jugador de cada pareja que saca primero sus games
      pairCount: 4, // parejas que hay hoy (formato social)
      pairs: [],
      voiceLevel: 'full',
    };
  }

  /** Parejas de la jornada social, con el largo justo para pairCount. */
  function socialPairs() {
    return Array.from({ length: wizard.pairCount }, (_, i) => wizard.pairs[i] || { p1: '', p2: '' });
  }

  function buildConfig() {
    return {
      sport: 'padel',
      mode: wizard.mode,
      setsToWin: wizard.mode === 'games' ? 1 : wizard.bestOf,
      gamesPerSet: wizard.mode === 'games' ? wizard.targetGames : wizard.gamesPerSet,
      noAd: wizard.noAd,
      superTiebreakDecider: wizard.mode === 'sets' ? wizard.superTiebreak : false,
      // Formato social: el partido termina apenas una pareja llega a X games.
      ...(wizard.mode === 'games' ? { firstTo: true } : {}),
      // firstServer queda sin definir: lo decide el primer tanto que se
      // toque en el marcador (así se resuelve como en la cancha real,
      // jugando un punto para ver quién saca).
    };
  }

  function updateProgress() {
    const seq = stepsFor(wizard).filter((id) => id !== 'summary');
    const idx = seq.indexOf(currentStepId);
    const pct = idx < 0 ? 100 : Math.round(((idx + 1) / seq.length) * 100);
    progressFill.style.width = pct + '%';
  }

  function goTo(id, { recordHistory = true } = {}) {
    if (recordHistory && currentStepId) visitedStack.push(currentStepId);
    currentStepId = id;
    render(id);
    updateProgress();
  }

  function goNext() {
    const seq = stepsFor(wizard);
    goTo(seq[seq.indexOf(currentStepId) + 1] ?? 'summary');
  }

  function goBack() {
    if (visitedStack.length === 0) {
      document.dispatchEvent(new CustomEvent('navigate', { detail: 'home' }));
      return;
    }
    currentStepId = visitedStack.pop();
    render(currentStepId);
    updateProgress();
  }

  // ---------- Renderizadores de tipos de paso ----------

  // Opciones que el control remoto puede elegir en el paso actual (null = ninguna).
  let remoteOptions = null;

  createTapChooser({
    isActive: () => document.getElementById('view-setup').classList.contains('is-active'),
    getOptions: () => remoteOptions,
    onHint: (taps, options) => {
      const el = document.getElementById('wizard-remote-hint');
      if (el) el.textContent = hintText(taps, options);
    },
    onChoose: (i) => remoteOptions?.[i]?.pick(),
  });

  function renderChoice(question, sub, options, currentValue, onPick, { remote = false } = {}) {
    remoteOptions = remote ? options.map((o) => ({ label: o.title, pick: () => onPick(o.value) })) : null;
    stepEl.innerHTML = `
      <div class="wizard-question">${question}</div>
      ${sub ? `<div class="wizard-sub">${sub}</div>` : ''}
      ${remote ? `<div class="wizard-note">Control remoto — ${escapeHtml(legendText(remoteOptions))}</div><div class="remote-hint" id="wizard-remote-hint"></div>` : ''}
      <div class="option-grid option-grid--wizard" id="wizard-options"></div>
    `;
    const grid = document.getElementById('wizard-options');
    grid.innerHTML = options.map((opt) => `
      <button class="option-card${opt.value === currentValue ? ' is-selected' : ''}" data-value="${escapeHtml(String(opt.value))}">
        <div class="option-title">${escapeHtml(opt.title)}</div>
        ${opt.sub ? `<div class="option-sub">${escapeHtml(opt.sub)}</div>` : ''}
      </button>
    `).join('');
    grid.querySelectorAll('.option-card').forEach((btn, i) => {
      btn.addEventListener('click', () => onPick(options[i].value));
    });
  }

  function renderPick(question, sub, items, onPick, excludeValues = []) {
    remoteOptions = null;
    let editing = false;
    stepEl.innerHTML = `
      <div class="wizard-question">${question}</div>
      ${sub ? `<div class="wizard-sub">${sub}</div>` : ''}
      <input type="text" class="wizard-search" id="wizard-search" placeholder="Buscar o escribir nuevo..." autocomplete="off" />
      <div class="wizard-note">Los jugadores se cargan para llevar sus estadísticas. Escribí nombre y apellido, o el apodo con el que se lo conoce.</div>
      <div class="chip-list" id="wizard-chip-list"></div>
      <button class="btn btn-ghost" id="wizard-edit-btn" style="margin-top:10px;">Editar lista</button>
      <button class="btn btn-primary btn-block" id="wizard-add-btn" style="display:none;"></button>
    `;
    const input = document.getElementById('wizard-search');
    const chipList = document.getElementById('wizard-chip-list');
    const addBtn = document.getElementById('wizard-add-btn');
    const editBtn = document.getElementById('wizard-edit-btn');

    async function refreshItems() {
      playersCache = await listPlayerNames();
      items = playersCache;
      draw(input.value);
    }

    editBtn.addEventListener('click', () => {
      editing = !editing;
      editBtn.textContent = editing ? 'Listo' : 'Editar lista';
      draw(input.value);
    });

    function draw(filterText) {
      const f = (filterText || '').trim().toLowerCase();
      const visible = items.filter((it) => !excludeValues.includes(it) && it.toLowerCase().includes(f));
      editBtn.style.display = items.length ? '' : 'none';
      if (editing) {
        chipList.innerHTML = visible.map((it) => `
          <span class="chip chip--edit">${escapeHtml(it)}
            <button class="chip-act" data-act="rename" data-value="${escapeHtml(it)}" aria-label="Cambiar nombre">✎</button>
            <button class="chip-act" data-act="delete" data-value="${escapeHtml(it)}" aria-label="Eliminar">✕</button>
          </span>`).join('');
        chipList.querySelectorAll('.chip-act').forEach((btn) => {
          btn.addEventListener('click', async () => {
            const name = btn.dataset.value;
            if (btn.dataset.act === 'delete') {
              if (!confirm(`¿Quitar a "${name}" de la lista? Sus partidos y estadísticas no se borran.`)) return;
              await deletePlayerName(name);
            } else {
              const to = (prompt('Nombre correcto:', name) || '').trim().replace(/\s+/g, ' ');
              if (!to || to === name) return;
              try { await renamePlayer(name, to); } catch (err) { alert(err?.message || 'No se pudo cambiar el nombre.'); return; }
            }
            await refreshItems();
          });
        });
      } else {
        chipList.innerHTML = visible.map((it) => `<button class="chip" data-value="${escapeHtml(it)}">${escapeHtml(it)}</button>`).join('');
        chipList.querySelectorAll('.chip').forEach((btn) => {
          btn.addEventListener('click', () => onPick(btn.dataset.value));
        });
      }
      const exact = items.some((it) => it.toLowerCase() === f);
      if (f && !exact) {
        addBtn.style.display = '';
        addBtn.textContent = `Agregar "${filterText.trim()}"`;
      } else {
        addBtn.style.display = 'none';
      }
    }
    draw('');
    input.addEventListener('input', () => draw(input.value));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const val = input.value.trim();
        if (val) onPick(val);
      }
    });
    addBtn.addEventListener('click', () => {
      const val = input.value.trim();
      if (val) onPick(val);
    });
  }

  function renderText(question, sub, currentValue, { optional = false } = {}, onDone) {
    remoteOptions = null;
    stepEl.innerHTML = `
      <div class="wizard-question">${question}</div>
      ${sub ? `<div class="wizard-sub">${sub}</div>` : ''}
      <input type="text" class="wizard-search" id="wizard-text" value="${escapeHtml(currentValue || '')}" autocomplete="off" />
      <div class="step-actions">
        ${optional ? '<button class="btn btn-ghost btn-block" id="wizard-skip">Omitir</button>' : ''}
        <button class="btn btn-primary btn-block" id="wizard-continue">Continuar</button>
      </div>
    `;
    const input = document.getElementById('wizard-text');
    input.focus();
    document.getElementById('wizard-continue').addEventListener('click', () => onDone(input.value.trim()));
    document.getElementById('wizard-skip')?.addEventListener('click', () => onDone(''));
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') onDone(input.value.trim()); });
  }

  // ---------- Definición de cada paso ----------

  function render(id) {
    if (id === 'mode') {
      renderChoice('¿Cómo se juega?', null, [
        { value: 'sets', title: 'Partido a sets', sub: 'Mejor de 1, 3 o 5 sets' },
        { value: 'games', title: 'A X games', sub: 'Formato social, rotación de parejas' },
      ], wizard.mode, (v) => { wizard.mode = v; goNext(); });
    } else if (id === 'bestof') {
      renderChoice('¿Mejor de cuántos sets?', null, [
        { value: 1, title: '1 set' },
        { value: 2, title: 'Mejor de 3' },
        { value: 3, title: 'Mejor de 5' },
      ], wizard.bestOf, (v) => { wizard.bestOf = v; goNext(); });
    } else if (id === 'gamesperset') {
      renderChoice('¿Games por set?', 'Si se empata en games (ej: 6-6), el set se define con un tie-break a 7 puntos (por 2). Es automático, no hay que configurar nada más.', [
        { value: 6, title: '6 games', sub: 'Clásico' },
        { value: 4, title: '4 games', sub: 'Set corto' },
      ], wizard.gamesPerSet, (v) => { wizard.gamesPerSet = v; goNext(); });
    } else if (id === 'targetgames') {
      renderChoice('¿A cuántos games se juega?', 'Gana la primera pareja que llegue. Después rota.', [
        { value: 4, title: '4 games' },
        { value: 6, title: '6 games' },
        { value: 8, title: '8 games' },
      ], wizard.targetGames, (v) => { wizard.targetGames = v; goNext(); });
    } else if (id === 'paircount') {
      renderChoice('¿Cuántas parejas hay hoy?', 'La que gana se queda en cancha y entra la siguiente. Después podés elegir quién sigue.',
        [2, 3, 4, 5, 6, 7, 8].map((n) => ({ value: n, title: `${n} parejas`, sub: n === 2 ? 'Sin rotación' : undefined })),
        wizard.pairCount, (v) => { wizard.pairCount = v; wizard.pairs = socialPairs(); goNext(); });
    } else if (id.startsWith('spair-')) {
      const [, idx, slot] = id.match(/spair-(\d+)-(1|2)/);
      const i = Number(idx);
      wizard.pairs = socialPairs();
      const exclude = wizard.pairs.flatMap((p) => [p.p1, p.p2]).filter(Boolean);
      renderPick(`¿Jugador ${slot} de la Pareja ${i + 1}?`, null, playersCache, (name) => {
        wizard.pairs[i][`p${slot}`] = name;
        savePlayerName(name).then(() => listPlayerNames()).then((list) => { playersCache = list; });
        goNext();
      }, exclude);
    } else if (id === 'noad') {
      renderChoice('¿Punto de oro?', 'Muerte súbita en 40-40, sin ventaja', [
        { value: true, title: 'Sí, punto de oro' },
        { value: false, title: 'No, con ventaja' },
      ], wizard.noAd, (v) => { wizard.noAd = v; goNext(); });
    } else if (id === 'supertiebreak') {
      renderChoice(
        '¿Set decisivo a súper tie-break?',
        'Si empatan 1 set a 1, el 3er set puede jugarse completo (a games, como los anteriores) o reemplazarse por un solo punto extra a 10 (por 2) para definir el partido más rápido.',
        [
          { value: true, title: 'Sí, súper tie-break', sub: 'El 3er set se juega a 10 puntos' },
          { value: false, title: 'No, set completo', sub: 'El 3er set se juega a games, igual que los demás' },
        ],
        wizard.superTiebreak,
        (v) => { wizard.superTiebreak = v; goNext(); }
      );
    } else if (id.startsWith('player-')) {
      const [, team, slot] = id.match(/player-([ab])(1|2)/);
      const teamKey = team.toUpperCase();
      const label = `¿Jugador ${slot} de la Pareja ${teamKey}?`;
      const exclude = [wizard.teams.A.p1, wizard.teams.A.p2, wizard.teams.B.p1, wizard.teams.B.p2].filter(Boolean);
      renderPick(label, null, playersCache, (name) => {
        wizard.teams[teamKey][`p${slot}`] = name;
        savePlayerName(name).then(() => listPlayerNames()).then((list) => { playersCache = list; });
        goNext();
      }, exclude);
    } else if (id === 'server-a' || id === 'server-b') {
      const side = id === 'server-a' ? 'A' : 'B';
      const t = startingTeams()[side];
      renderChoice(`¿Quién saca primero de ${escapeHtml(pairText(t))}?`,
        'Después se alternan los dos en cada game que saque la pareja.',
        [{ value: 'p1', title: t.p1 }, { value: 'p2', title: t.p2 }],
        wizard.firstSlot[side], (v) => { wizard.firstSlot[side] = v; goNext(); }, { remote: true });
    } else if (id === 'voice') {
      renderChoice('¿Anuncio por voz?', null, [
        { value: 'full', title: 'Completo', sub: 'Tanto a tanto, estilo árbitro' },
        { value: 'simple', title: 'Simple', sub: 'Solo el resultado' },
        { value: 'off', title: 'Sin voz' },
      ], wizard.voiceLevel, (v) => { wizard.voiceLevel = v; goNext(); });
    } else if (id === 'summary') {
      renderSummary();
    }
  }

  const pairText = (p) => [p.p1, p.p2].filter(Boolean).join(' / ') || 'Sin nombre';

  /** Equipos del primer partido: en formato social, las dos primeras parejas. */
  function startingTeams() {
    if (wizard.mode !== 'games') return wizard.teams;
    const pairs = socialPairs();
    return { A: pairs[0], B: pairs[1] };
  }

  function renderSummary() {
    remoteOptions = null;
    const cfg = buildConfig();
    const social = wizard.mode === 'games';
    const first = startingTeams();
    const waiting = social ? socialPairs().slice(2) : [];
    stepEl.innerHTML = `
      <div class="wizard-question">Todo listo</div>
      <div class="summary-card">
        <div class="summary-card-row"><strong>${escapeHtml(pairText(first.A))}</strong> vs <strong>${escapeHtml(pairText(first.B))}</strong></div>
        ${waiting.length ? `<div class="summary-card-row muted">Esperan: ${escapeHtml(waiting.map(pairText).join(' · '))}</div>` : ''}
        <div class="summary-card-row muted">${escapeHtml(describeConfig(cfg))}</div>
        <div class="summary-card-row muted">Al empezar, el primer toque elige quién saca. Después suma tantos.</div>
        <div class="summary-card-row muted">Control remoto: ${firstTapTeam() === 'A' ? '1 toque = lado izquierdo, 2 toques = lado derecho' : '1 toque = lado derecho, 2 toques = lado izquierdo'}, 3 toques = deshacer el último tanto.</div>
      </div>
      <div class="toggle-row">
        <div>
          <div style="font-weight:600;">Probar control remoto Bluetooth</div>
          <div class="match-card-meta" id="remote-test-status">Todavía no se detectó ninguna pulsación</div>
        </div>
        <button class="btn btn-ghost" id="wizard-test-remote" style="padding:10px 14px;">Probar</button>
      </div>
      <div class="step-actions">
        <button class="btn btn-primary btn-block" id="wizard-start">Empezar partido</button>
      </div>
    `;
    document.getElementById('wizard-test-remote').addEventListener('click', () => {
      const status = document.getElementById('remote-test-status');
      status.textContent = 'Esperando... presioná el botón del control ahora';
      status.style.color = '';
    });
    document.getElementById('wizard-start').addEventListener('click', async () => {
      const meta = {
        id: `m_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        sport: 'padel',
        config: buildConfig(),
        teams: startingTeams(),
        voiceLevel: wizard.voiceLevel,
        firstSlot: { ...wizard.firstSlot },
        // Con 3 o más parejas se arma una jornada: la que gana sigue y entra la próxima.
        social: wizard.mode === 'games' && wizard.pairCount > 2 ? { pairs: socialPairs(), firstSlot: [wizard.firstSlot.A, wizard.firstSlot.B] } : null,
      };
      onStartMatch(meta);
    });
  }

  onRemotePress(() => {
    const status = document.getElementById('remote-test-status');
    if (status) {
      status.textContent = '¡Detectado! El control remoto funciona en este celular.';
      status.style.color = 'var(--accent)';
    }
  });

  document.getElementById('view-setup').addEventListener('click', (e) => {
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (action === 'setup-back') goBack();
  });

  async function resetWizard() {
    wizard = freshWizard();
    visitedStack.length = 0;
    playersCache = await listPlayerNames();
    currentStepId = null;
    goTo('mode', { recordHistory: false });
  }

  return { resetWizard };
}
