// api.js
// Minimal, CORS-enabled endpoints that return ONLY the specific lists/stat you asked for.
// How to wire this into back.js is below.

// Export an initializer so back.js can pass in its own loadState().
function initApi({ loadState, allowOrigin = "*" } = {}) {
  // tiny helpers
  const json = (res, code, body, extraHeaders = {}) => {
    res.writeHead(code, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": allowOrigin,
      ...extraHeaders,
    });
    res.end(JSON.stringify(body));
  };
  const cors = (req, res) => {
    // handle CORS preflight
    if (req.method === "OPTIONS") {
      json(res, 204, {}, {
        "Access-Control-Allow-Methods": "GET,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Requested-With",
      });
      return true;
    }
    return false;
  };

  // shape a list to the minimal fields for each endpoint
  const mapWins = (p) => ({ uuid: p.uuid, name: p.name, wins: Number(p.wins || 0) });
  const mapDailyWins = (p) => ({ uuid: p.uuid, name: p.name, dailyWins: Number(p.dailyWins || 0) });
  const mapDailyGexp = (p) => ({ uuid: p.uuid, name: p.name, dailyExp: Number(p.dailyExp || 0) });
  const mapWeeklyGexp = (p) => ({ uuid: p.uuid, name: p.name, weeklyExp: Number(p.weeklyExp || 0) });
  const mapWeeklyWins  = (p) => ({ uuid: p.uuid, name: p.name, weeklyWins:  Number(p.weeklyWins  || 0) });
  const mapMonthlyWins = (p) => ({ uuid: p.uuid, name: p.name, monthlyWins: Number(p.monthlyWins || 0) });
  const mapJoined = (p) => ({
    uuid: p.uuid,
    name: p.name,
    joinedAt: p.joinedAt || null,      // ISO or null
    joinedLabel: p.joinedLabel || null // human label (UTC), if present
  });

  // sorting helpers
  const byNumDesc = (key) => (a, b) => Number(b[key] || 0) - Number(a[key] || 0);
  const byDateAsc = (a, b) => {
    const ta = a.joinedAt ? Date.parse(a.joinedAt) : Number.POSITIVE_INFINITY;
    const tb = b.joinedAt ? Date.parse(b.joinedAt) : Number.POSITIVE_INFINITY;
    return ta - tb; // oldest (least recent) first; unknowns at end
  };
  const byDateDesc = (a, b) => {
    const ta = a.joinedAt ? Date.parse(a.joinedAt) : Number.NEGATIVE_INFINITY;
    const tb = b.joinedAt ? Date.parse(b.joinedAt) : Number.NEGATIVE_INFINITY;
    return tb - ta; // newest first; unknowns at end
  };
  // ---- losses list shaped *from persisted state* (no Hypixel calls) ----
  function lossesFromState(state) {
    const lossesMap = state?.lastMemberLosses || {};
    const names     = state?.names || {};
    const players   = Array.isArray(state?.players) ? state.players : [];
    const nameFor = (uuid) => {
      const p = players.find(pp => pp.uuid === uuid);
      return (p && p.name) || names[uuid] || uuid;
    };
    return Object.entries(lossesMap).map(([uuid, losses]) => ({
      uuid, name: nameFor(uuid), losses: Number(losses || 0)
    }));
 }
  // The actual handler that back.js will call early in its request pipeline.
  return async function handleApi(req, res, url) {
    // Only catch our specific routes; otherwise let back.js continue.
    // Endpoints (all GET + CORS preflight):
    // 3)  /api/players/duels-wins
    //     /api/players/duels-losses
    // 4)  /api/players/daily-duels-wins
    // 5)  /api/players/daily-gexp
    // 6)  /api/players/weekly-gexp
    // 7)  /api/players/joined/oldest
    // 8)  /api/players/joined/newest
    // 9)  /api/guild/duels-wins-total
    //     /api/guild/duels-losses-total

    const p = url.pathname;

    // fast exit if path isn't one of ours
    const ours =
      p === "/api/players/duels-wins" ||
      p === "/api/players/duels-losses" ||
      p === "/api/players/daily-duels-wins" ||
      p === "/api/players/weekly-duels-wins" ||
      p === "/api/players/monthly-duels-wins" ||
      p === "/api/players/daily-gexp" ||
      p === "/api/players/weekly-gexp" ||
      p === "/api/players/joined/oldest" ||
      p === "/api/players/joined/newest" ||
      p === "/api/guild/daily-duels-wins-total" ||
      p === "/api/guild/duels-wins-total" ||
      p === "/api/guild/duels-losses-total";

    if (!ours && p.startsWith("/api/")) {
      // allow other /api/* routes in back.js to handle
      return false;
    }
    if (!ours) return false;

    // CORS preflight for our routes
    if (cors(req, res)) return true;

    if (req.method !== "GET") {
      json(res, 405, { error: "Method not allowed" }, { "Allow": "GET,OPTIONS" });
      return true;
    }

    // pull the current state from back.js (no extra Hypixel calls here)
    let state;
    try {
      state = await loadState();
    } catch (e) {
      json(res, 500, { error: "state unavailable" });
      return true;
    }
    const players = Array.isArray(state.players) ? state.players : [];

    try {
      switch (p) {
        case "/api/players/duels-wins": {
          const out = players.map(mapWins).sort(byNumDesc("wins"));
          json(res, 200, out);
          return true;
        }
        case "/api/players/duels-losses": {
          const out = lossesFromState(state).sort(byNumDesc("losses"));
          json(res, 200, out); return true;
        }
        case "/api/players/daily-duels-wins": {
          const out = players.map(mapDailyWins).sort(byNumDesc("dailyWins"));
          json(res, 200, out);
          return true;
        }
        case "/api/players/daily-gexp": {
          const out = players.map(mapDailyGexp).sort(byNumDesc("dailyExp"));
          json(res, 200, out);
          return true;
        }
        case "/api/players/weekly-gexp": {
          const out = players.map(mapWeeklyGexp).sort(byNumDesc("weeklyExp"));
          json(res, 200, out);
          return true;
        }
        case "/api/players/joined/oldest": {
          const out = players.map(mapJoined).sort(byDateAsc);
          json(res, 200, out);
          return true;
        }
        case "/api/players/joined/newest": {
          const out = players.map(mapJoined).sort(byDateDesc);
          json(res, 200, out);
          return true;
        }
        case "/api/guild/duels-wins-total": {
          // compute from current player list (do not trust cached aggregate blindly)
          const totalWins = players.reduce((s, p) => s + Number(p.wins || 0), 0);
          json(res, 200, { totalWins });
          return true;
        }
        case "/api/guild/duels-losses-total": {
          const totalLosses = (state?.lastMemberLosses
            ? Object.values(state.lastMemberLosses).reduce((s, v) => s + Number(v || 0), 0)
            : 0);
          json(res, 200, { totalLosses }); return true;
        }
        case "/api/guild/daily-duels-wins-total": {
          const totalDailyWins = players.reduce((s, p) => s + Number(p.dailyWins || 0), 0);
          json(res, 200, { totalDailyWins });
          return true;
        }
        case "/api/players/weekly-duels-wins": {
          const out = players.map(mapWeeklyWins).sort(byNumDesc("weeklyWins"));
          json(res, 200, out);
          return true;
        }
        case "/api/players/monthly-duels-wins": {
          const out = players.map(mapMonthlyWins).sort(byNumDesc("monthlyWins"));
          json(res, 200, out);
          return true;
        }
        case "/api/guild/weekly-duels-wins-total": {
          const totalWeeklyWins = players.reduce((s,p)=>s+Number(p.weeklyWins||0),0);
          json(res,200,{ totalWeeklyWins }); return true;
        }
        case "/api/guild/monthly-duels-wins-total": {
          const totalMonthlyWins = players.reduce((s,p)=>s+Number(p.monthlyWins||0),0);
          json(res,200,{ totalMonthlyWins }); return true;
        }

      }
    } catch (e) {
      json(res, 500, { error: "server error" });
      return true;
    }
  };
}

module.exports = { initApi };
