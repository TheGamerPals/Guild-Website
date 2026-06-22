// admin.js (inline password screen → admin panel)
(function () {
  const guild = String(window.APP_CONFIG?.guild || "Guild");
  // ==== tiny helpers ====
  const $ = (sel) => document.querySelector(sel);
  const el = (tag, attrs = {}, html = "") => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    if (html) n.innerHTML = html;
    return n;
  };
  const ago = (tsMs) => {
    if (!tsMs) return "never";
    const diff = Math.max(0, Date.now() - tsMs);
    const m = Math.floor(diff / 60000);
    const h = Math.floor(m / 60);
    const mm = m % 60;
    return `${h} hours ${mm} minutes ago.`;
  };

  // ===== styles (keeps your dark navy / aqua vibe) =====
  const styles = `
    *{box-sizing:border-box}
    body { font-family: system-ui, Arial, sans-serif; margin:0; background:#0b0d12; color:#e7ecf3; }
    .wrap { max-width: 820px; margin: 0 auto; padding: 24px; }
    .centerWrap { min-height: 100dvh; display:flex; align-items:center; justify-content:center; padding:24px; }
    .card { background:#111520; border:1px solid #1c2436; border-radius:14px; padding:18px; box-shadow:0 6px 18px rgba(0,0,0,0.2); }
    h1 { margin:0 0 14px; text-align:center; font-weight:700; letter-spacing:0.2px; }
    .sub { text-align:center; opacity:0.75; margin-top:-6px; margin-bottom:12px; }
    .row { display:flex; gap:10px; align-items:center; }
    .col { display:flex; flex-direction:column; gap:10px; }
    .muted { opacity:0.8; }
    .topbar { display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; }
    input[type="password"], input[type="text"] {
      padding:12px 14px; background:#0e1421; color:#e7ecf3; border:1px solid #27324a; border-radius:12px; width:100%;
      outline:none;
    }
    input::placeholder { color:#a8b3c7; opacity:0.6; }
    button {
      padding:12px 16px; background:#1c2740; color:#e7ecf3; border:1px solid #34456b; border-radius:12px; cursor:pointer;
      font-weight:600;
    }
    button:hover { background:#233255; }
    .btn-green { background:#0f3; color:#000; border:1px solid #0a4; }
    .btn-green:hover { filter:brightness(0.95); }
    .pillLinks { display:flex; gap:12px; flex-wrap:wrap; margin-top:16px; }
    a.pillLink { text-decoration:none; color:#e7ecf3; background:#13223a; border:1px solid #27445e; padding:8px 12px; border-radius:999px; }
    .notice { margin-top:8px; font-size:14px; min-height:1.2em; }
    .notice.err { color:#ff6b6b; }
    .notice.ok { color:#6bff9b; }
    .spacer { height:8px; }
  `;
  document.head.insertAdjacentHTML("beforeend", `<style>${styles}</style>`);

  // ===== initial render: inline password screen =====
  const root = el("div", { class: "centerWrap" });
  root.innerHTML = `
    <div class="card" style="width:min(560px, 100%);">
      <h1>${guild} Admin</h1>
      <div class="sub">Enter password to continue</div>
      <div class="col">
        <div class="row">
          <input id="pwInput" type="password" placeholder="Password" autocomplete="current-password" />
          <button id="pwBtn" class="btn-green">Enter</button>
        </div>
        <div id="pwMsg" class="notice"></div>
      </div>
    </div>
  `;
  document.body.appendChild(root);

  const focusPw = () => $("#pwInput")?.focus();
  setTimeout(focusPw, 0);

  async function unlock(pass) {
    if (!pass) {
      showPwMsg("Please enter the password.", true);
      return;
    }
    try {
      const response = await fetch("/api/admin/status", {
        headers: { "x-admin-pass": pass },
        cache: "no-store",
      });
      if (!response.ok) {
        showPwMsg("Wrong password.", true);
        return;
      }
    } catch {
      showPwMsg("Could not verify the password.", true);
      return;
    }
    // correct → render the admin panel
    renderAdmin(pass);
  }

  function showPwMsg(text, isErr) {
    const box = $("#pwMsg");
    box.textContent = text || "";
    box.classList.toggle("err", !!isErr);
    box.classList.toggle("ok", !isErr);
  }

  $("#pwBtn").addEventListener("click", () => unlock($("#pwInput").value.trim()));
  $("#pwInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") unlock($("#pwInput").value.trim());
  });

  // ===== admin panel (appears after successful password) =====
  function renderAdmin(ADMIN_PASS) {
    document.body.innerHTML = `
      <div class="wrap">
        <h1>${guild} Admin</h1>
        <div class="card">
          <div class="topbar">
            <div class="muted">Admin Panel</div>
            <div class="muted" id="lastUpdated">Last updated —</div>
          </div>

          <div class="row" style="margin-top:8px;">
            <input id="apiInput" type="text" placeholder="Enter Hypixel API key…" />
            <button id="applyBtn" class="btn-green">Apply</button>
          </div>
          <div id="applyMsg" class="notice"></div>
          
          <div class="spacer"></div>
          <div class="row">
            <input
              id="placeInput"
              type="text"
              inputmode="numeric"
              pattern="[0-9]{1,2}"
              maxlength="2"
              placeholder="Placement (00–99, 0 = hide)" />
            <button id="placeBtn" class="btn-green">Update Placement</button>
          </div>
          <div id="placeMsg" class="notice"></div>
        </div>
      </div>
    `;

    // timers + calls
    let serverUpdatedAt = 0;
    let localAppliedAt = 0;

    async function refreshStatus() {
      try {
        const r = await fetch("/api/admin/status", {
          headers: { "x-admin-pass": ADMIN_PASS },
          cache: "no-store",
        });
        if (r.ok) {
          const j = await r.json();
          serverUpdatedAt = j.lastUpdatedAt ? new Date(j.lastUpdatedAt).getTime() : 0;
        }
      } catch {}
    }

    function renderClock() {
      const t = localAppliedAt || serverUpdatedAt || 0;
      $("#lastUpdated").textContent = "Last updated " + ago(t);
    }

    // init
    (async () => {
      await refreshStatus();
      renderClock();
      setInterval(refreshStatus, 30 * 1000);
      setInterval(renderClock, 1000);
    })();

    $("#applyBtn").addEventListener("click", applyKey);
    $("#apiInput").addEventListener("keydown", (e) => {
      if (e.key === "Enter") applyKey();
    });
    $("#placeBtn").addEventListener("click", applyPlacement);
    $("#placeInput").addEventListener("keydown", (e) => {
      if (e.key === "Enter") applyPlacement();
    });
    async function applyKey() {
      const val = $("#apiInput").value.trim();
      const msg = $("#applyMsg");
      msg.textContent = "";
      msg.className = "notice";

      if (!val) {
        msg.textContent = "Please enter an API key.";
        msg.classList.add("err");
        return;
      }
      try {
        const r = await fetch("/api/admin/setApiKey", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-admin-pass": ADMIN_PASS
          },
          body: JSON.stringify({ apiKey: val })
        });
        if (!r.ok) {
          const t = await r.text().catch(() => "");
          throw new Error(t || `HTTP ${r.status}`);
        }
        localAppliedAt = Date.now(); // instant feedback in RAM
        msg.textContent = "API key saved.";
        msg.classList.add("ok");
      } catch (e) {
        msg.textContent = "Failed to save: " + (e?.message || e);
        msg.classList.add("err");
      }
    }
      async function applyPlacement() {
      const inp = $("#placeInput");
      const msg = $("#placeMsg");
      msg.textContent = "";
      msg.className = "notice";
      // sanitize to 0–99 (two digits max)
      const raw = String(inp.value || "").replace(/[^\d]/g, "").slice(0, 2);
      if (raw.length === 0) {
        msg.textContent = "Enter a number 0–99 (0 hides).";
        msg.classList.add("err");
        return;
      }
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0 || n > 99) {
        msg.textContent = "Placement must be 0–99.";
        msg.classList.add("err");
        return;
      }
      try {
        const r = await fetch("/api/admin/setPlacement", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-admin-pass": ADMIN_PASS
          },
          body: JSON.stringify({ placement: n })
        });
        if (!r.ok) {
          const t = await r.text().catch(() => "");
          throw new Error(t || `HTTP ${r.status}`);
        }
        localAppliedAt = Date.now();
        msg.textContent = `Placement updated to ${n === 0 ? "hidden (0)" : n}.`;
        msg.classList.add("ok");
      } catch (e) {
        msg.textContent = "Failed to update: " + (e?.message || e);
        msg.classList.add("err");
      }
    }

  }
})();
