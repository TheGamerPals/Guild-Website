// front.js
(async function () {
  const $ = (sel) => document.querySelector(sel);
  const countdownEl = $("#countdown");
  const pillsEl = $("#summaryPills");
  const playersWrap = $("#playersTableWrap");
  const changesEl = $("#changesBlock");
  const placementPill = document.getElementById('placementPill');
  const guild = String(window.APP_CONFIG?.guild || 'Guild');
const sortSelect = document.getElementById('sortSelect');
let currentSort = 'wins';
function agoSimpleFromMs(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const diff = Date.now() - ms;
  if (diff < 0) return "0 minutes ago";
  const MIN = 60 * 1000, H = 60 * MIN, D = 24 * H;
  if (diff < H)    return `${Math.floor(diff / MIN)} minutes ago`;
  if (diff < D)    return `${Math.floor(diff / H)} hours ago`;
  return `${Math.floor(diff / D)} days ago`;
}

function sortPlayers(list, key) {
  const a = [...(list || [])];

  // helpers for lastLogin sorting
  const lastLogin = (p) => {
    const t = Number(p.lastLoginMs || 0);
    return Number.isFinite(t) && t > 0 ? t : 0; // 0 => missing -> goes to bottom for "recent"
  };
  const lastLoginOrInf = (p) => {
    const t = Number(p.lastLoginMs || 0);
    return Number.isFinite(t) && t > 0 ? t : Number.POSITIVE_INFINITY; // missing -> bottom for "oldest"
  };

  switch (key) {
    case 'dailywins':
      a.sort((x, y) => Number(y.dailyWins || 0) - Number(x.dailyWins || 0));
      break;

    case 'daily':
      a.sort((x, y) => (Number(y.dailyExp || 0) - Number(x.dailyExp || 0)));
      break;

    case 'weekly':
      a.sort((x, y) => (Number(y.weeklyExp || 0) - Number(x.weeklyExp || 0)));
      break;

    case 'joined':
      // Oldest first: smaller timestamp -> earlier join -> rank #1
      const t = (p) => {
        if (p.joinedAt) return new Date(p.joinedAt).getTime();
        return Number.POSITIVE_INFINITY; // missing => bottom
      };
      a.sort((x, y) => t(x) - t(y));
      break;

    case 'wins':
    default:
      a.sort((x, y) => (Number(y.wins || 0) - Number(x.wins || 0)));
      break;
  }
  return a;
}


  function renderPlacement(p) {
    const n = Number(p);
    if (!Number.isFinite(n) || n <= 0) {
      placementPill.style.display = 'none';
      placementPill.textContent = '';
      return;
    }
    placementPill.style.display = '';
    placementPill.textContent = `#${n}`;
  }

  let nextRunAt = null;
  let lastState = null;

  function agoLabel(iso) {
    const t = new Date(iso).getTime();
    if (!Number.isFinite(t)) return "";
    const diffMs = Date.now() - t;
    const mins = Math.max(0, Math.floor(diffMs / 60000));
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.max(1, Math.min(24, Math.floor(mins / 60)));
    return `${hours}h ago`;
  }

  function fmtDelta(n) {
    if (n > 0) return `+${n}`;
    if (n < 0) return `${n}`;
    return "±0";
  }

  function renderCountdown() {
    if (!nextRunAt) {
      countdownEl.textContent = "—";
      return;
    }
    const ms = Math.max(0, new Date(nextRunAt).getTime() - Date.now());
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const r = s % 60;
    countdownEl.textContent = `Next update in ${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
  }

  function renderPills(state) {
    pillsEl.innerHTML = "";
    const add = (text, extraClass = "") => {
      const d = document.createElement("div");
      d.className = `pill ${extraClass}`;
      d.textContent = text;
      pillsEl.appendChild(d);
    };
    const lvl = Number(state.guildLevel);
    add(Number.isFinite(lvl) ? `Level ${lvl.toFixed(2)}` : `Level —`);
    add(`Total Duels Wins: ${state.totalWins.toLocaleString()}`);
    add(`Players: ${state.playerCount}`);
    const deltaClass = state.deltaWins >= 0 ? "delta plus" : "delta minus";
    const delta = document.createElement("div");
    delta.className = `pill ${deltaClass}`;
    delta.textContent = `Δ since last: ${fmtDelta(state.deltaWins)}`;
    pillsEl.appendChild(delta);

    const when = document.createElement("div");
    when.className = "pill muted";
    when.textContent = `Last call: ${state.lastRunAt ? new Date(state.lastRunAt).toLocaleString() : "—"}`;
    pillsEl.appendChild(when);
  }
  const linkPills = document.getElementById('linkPills');
  function renderLinks() {
    if (!linkPills) return;
    linkPills.innerHTML = `
      <a class="pill pillLink" href="https://sk1er.club/guild/name/${encodeURIComponent(guild)}" target="_blank" rel="noopener">
        See ${guild} on sk1er
      </a>
      <a class="pill pillLink" href="https://sk1er.club/leaderboards/guild_wins_duels" target="_blank" rel="noopener">
        View ${guild} Duels Guild Wins Leaderboard
      </a>
    `;
  }
    const trackUi = document.getElementById('trackUi');

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[c]));
  }

    // Track-UI outside-click guard
  let _trackOutsideHandler = null;
  function addOutsideClickToIdle() {
    removeOutsideClick();
    _trackOutsideHandler = (ev) => {
      // If click occurs outside our trackUi container, revert to idle
      if (trackUi && !trackUi.contains(ev.target)) {
        renderTrackIdle();
      }
    };
    document.addEventListener('pointerdown', _trackOutsideHandler, true);
  }
  function removeOutsideClick() {
    if (_trackOutsideHandler) {
      document.removeEventListener('pointerdown', _trackOutsideHandler, true);
      _trackOutsideHandler = null;
    }
  }

  // Case-insensitive lookup against the guild roster; returns canonical name if found.
  function findGuildNameCanonical(input) {
    const want = String(input || '').trim().toLowerCase();
    if (!want) return null;
    const list = (lastState && Array.isArray(lastState.players)) ? lastState.players : [];
    const hit = list.find(p => String(p.name || '').toLowerCase() === want);
    return hit ? String(hit.name) : null;
  }

  function findPlayerByCanonicalName(name) {
    const list = (lastState && Array.isArray(lastState.players)) ? lastState.players : [];
    return list.find(p => String(p.name) === String(name)) || null;
  }

  // Free head render with overlay; default=steve ensures an image even if no custom skin.
  // 22px matches the CSS. Increase if you want it a bit larger.
  function headUrlFromUuid(uuid, size = 22) {
    return `https://crafatar.com/avatars/${encodeURIComponent(uuid)}?size=${size}&overlay&default=steve`;
  }

  function renderTrackIdle() {
    if (!trackUi) return;
    removeOutsideClick();
    trackUi.innerHTML = `<div class="trackPill" id="trackPill">Track Player</div>`;
    const pill = document.getElementById('trackPill');
    if (!pill) return;
    const showForm = () => renderTrackForm();
    pill.addEventListener('pointerenter', showForm, { once: true });
    pill.addEventListener('click', showForm, { once: true });
  }


  function renderTrackForm() {
    if (!trackUi) return;
    trackUi.innerHTML = `
      <div class="trackForm">
        <input id="trackInput" class="trackInput" type="text" maxlength="16" placeholder="Player name" />
        <button id="trackBtn" class="trackBtn">Track</button>
        <span id="trackErr" class="trackError" style="display:none">Player not found</span>
      </div>
    `;

    const input = document.getElementById('trackInput');
    const btn   = document.getElementById('trackBtn');
    const err   = document.getElementById('trackErr');

    const showError = (msg = 'Player not found') => {
      if (err) { err.textContent = msg; err.style.display = ''; }
      if (input) input.classList.add('error');
    };
    const clearError = () => {
      if (err) err.style.display = 'none';
      if (input) input.classList.remove('error');
    };

    const submit = () => {
      clearError();
      const raw = (input.value || '').trim().slice(0, 16);
      if (!raw) { renderTrackIdle(); return; }
      const canonical = findGuildNameCanonical(raw);
      if (!canonical) {
        showError(); // keep the form open so they can correct it
        return;
      }
      renderTracking(canonical);
    };

    btn.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit();
      if (e.key === 'Escape') renderTrackIdle();
    });

    // Click-away should revert to Idle state
    addOutsideClickToIdle();

    // Focus on show for quick typing
    setTimeout(() => input && input.focus(), 0);
  }


  function renderTracking(name) {
    if (!trackUi) return;
    removeOutsideClick();

    const player = findPlayerByCanonicalName(name);
    if (!player || !player.uuid) {
      renderTrackForm();
      const err = document.getElementById('trackErr');
      const input = document.getElementById('trackInput');
      if (err) err.style.display = '';
      if (input) input.classList.add('error');
      return;
    }

    // NOTE: head image moved before the text ↓↓↓
    trackUi.innerHTML = `
      <div class="trackingWrap" id="trackingWrap" title="Click to stop tracking">
        <img class="trackingHead" id="trackingHead" alt="${escapeHtml(name)}'s head" />
        <span class="trackingText">Tracking ${escapeHtml(name)}</span>
        <span class="closeX" aria-hidden="true">×</span>
      </div>
    `;

    const wrap = document.getElementById('trackingWrap');
    const img  = document.getElementById('trackingHead');
    if (wrap) wrap.addEventListener('click', renderTrackIdle);

    const url = headUrlFromUuid(player.uuid, 22);
    const probe = new Image();
    probe.crossOrigin = 'anonymous';
    probe.onload = () => { if (img) img.src = url; };
    probe.onerror = () => { if (img) img.src = headUrlFromUuid('00000000000000000000000000000000', 22); };
    probe.src = url;
  }




  // Initialize the control immediately
  renderTrackIdle();


  function renderPlayersTable(players) {
    if (!players || players.length === 0) {
      playersWrap.innerHTML = '<div class="muted">No players</div>';
      return;
    }
    const rows = players.map((p, i) => `
      <tr>
        <td style="width:56px; text-align:right; padding-right:12px;">${i + 1}</td>
        <td>
          <a class="nameLink" href="https://www.memum.io/player/${encodeURIComponent(p.name)}" target="_blank" rel="noopener">
            ${p.name}
          </a>
          ${p.role ? ` <span class="roleTag">${p.role}</span>` : ''}
        </td>
        <td class="muted small">${p.joinedLabel || '—'}</td>
        <td style="text-align:right">${p.wins.toLocaleString()}</td>
        <td style="text-align:right">${Number(p.dailyWins || 0).toLocaleString()}</td>
        <td style="text-align:right">${Number(p.dailyExp || 0).toLocaleString()}</td>
        <td style="text-align:right">${Number(p.weeklyExp || 0).toLocaleString()}</td>
      </tr>
    `).join('');


    playersWrap.innerHTML = `
      <table>
        <thead>
          <tr>
            <th style="width:56px; text-align:right; padding-right:12px;">#</th>
            <th>Player</th>
            <th class="muted small">Join Date</th>
            <th style="text-align:right">Duels Wins</th>
            <th style="text-align:right" title="wins since the last daily reset">Daily Wins</th>
            <th style="text-align:right">Daily GEXP</th>
            <th style="text-align:right">Weekly GEXP</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  function renderChanges(state) {
    const joined = state.joined || []; // [{uuid,name,wins}]
    const left = state.left || []; // [{uuid,name,wins}]
    const jTags =
      (joined.map(o =>
        `<span class="tag">+ ${o.name} <span class="muted small">(${o.wins.toLocaleString()} wins · ${o.at ? agoLabel(o.at) : ""})</span></span>`
      ).join("")) || '<span class="muted small">None</span>';

    const lTags =
      (left.map(o =>
        `<span class="tag">− ${o.name} <span class="muted small">(${o.wins.toLocaleString()} wins · ${o.at ? agoLabel(o.at) : ""})</span></span>`
      ).join("")) || '<span class="muted small">None</span>';

    changesEl.innerHTML = `
      <div style="margin-bottom:10px;"><strong>Joined:</strong><div style="margin-top:6px;">${jTags}</div></div>
      <div><strong>Left:</strong><div style="margin-top:6px;">${lTags}</div></div>
    `;
  }

  async function loadState() {
    const res = await fetch("/api/state", { cache: "no-store" });
    if (!res.ok) throw new Error("Failed to load state");
    const state = await res.json();
    nextRunAt = state.nextRunAt || null;
    renderPills(state);
    renderLinks()
    renderPlayersTable(sortPlayers(state.players, currentSort));
    renderChanges(state);
    renderPlacement(state.placement);
    lastState = state
  }

  if (sortSelect) {
    sortSelect.addEventListener('change', () => {
      currentSort = sortSelect.value || 'wins';
      if (lastState) renderPlayersTable(sortPlayers(lastState.players, currentSort));
    });
  }


  // initial load + periodic refresh
  await loadState();
  setInterval(() => renderCountdown(), 250);
  setInterval(loadState, 30 * 1000);
  try {
  const es = new EventSource('/api/placement/stream');
    es.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data || '{}');
        renderPlacement(data.placement);
      } catch {}
    };
  } catch {}
  setInterval(() => { if (lastState) renderChanges(lastState); }, 10 * 1000);
})();
