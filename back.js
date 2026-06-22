// back.js
// Node 18+ required (uses built-in fetch). Run: HYPIXEL_API_KEY=xxxx node back.js
// Serves a small UI and schedules the 10-minute job.
//
// Endpoints:
//   GET /              -> basic HTML page
//   GET /front.js      -> client script
//   GET /api/state     -> current persisted state for the configured guild
//   GET /api/searchGuild?name=Guild+Name -> on-demand total + players (not persisted)

const http = require("http");
const { readFile, writeFile, access } = require("fs/promises");
const { constants } = require("fs");
const path = require("path");
const { URL } = require("url");

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const SUPABASE_STORAGE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET || "guildinfo";
const SUPABASE_STORAGE_OBJECT = process.env.SUPABASE_STORAGE_OBJECT || "guild.json";
const SUPABASE_TABLE = process.env.SUPABASE_TABLE || "env_vars";
const GUILD = process.env.guild || process.env.GUILD || "";
const DISCORD_URL = process.env.DISCORD_URL || "";
// --- Admin state (RAM) ---
let adminLastUpdatedAtIso = null;   // when the API key was last set via admin
const ADMIN_PASS = process.env.ADMIN_PASS || "";
// Optional separate-host deployment example (not used by the /admin route):
// const ADMIN_HOST = process.env.ADMIN_HOST || "admin.example.com";
const PUBLIC_CONFIG_JSON = JSON.stringify({ guild: GUILD, discordUrl: DISCORD_URL }).replace(/</g, "\\u003c");

const missingRuntimeConfig = [
  ["SUPABASE_URL", SUPABASE_URL],
  ["SUPABASE_KEY", SUPABASE_KEY],
  ["ADMIN_PASS", ADMIN_PASS],
  ["guild", GUILD],
  ["DISCORD_URL", DISCORD_URL],
].filter(([, value]) => !value).map(([name]) => name);
if (missingRuntimeConfig.length) {
  throw new Error(`Missing required environment variable(s): ${missingRuntimeConfig.join(", ")}`);
}
async function upsertEnvVarToSupabase(name, value) {
  // 1) check if exists
  const base = `${SUPABASE_URL}/rest/v1/${encodeURIComponent(SUPABASE_TABLE)}`;
  const sel = await fetch(`${base}?select=name&name=eq.${encodeURIComponent(name)}`, { headers: sbHeaders() });
  if (!sel.ok) throw new Error(`Supabase select failed: ${sel.status}`);

  const hasRow = (await sel.json()).length > 0;

  if (hasRow) {
    const res = await fetch(`${base}?name=eq.${encodeURIComponent(name)}`, {
      method: "PATCH",
      headers: sbHeaders({ "Content-Type": "application/json", "Prefer": "return=representation" }),
      body: JSON.stringify({ value })
    });
    if (!res.ok) throw new Error(`Supabase PATCH failed: ${res.status}`);
    return true;
  } else {
    const res = await fetch(base, {
      method: "POST",
      headers: sbHeaders({ "Content-Type": "application/json", "Prefer": "return=representation" }),
      body: JSON.stringify([{ name, value }])
    });
    if (!res.ok) throw new Error(`Supabase INSERT failed: ${res.status}`);
    return true;
  }
}

// We will refresh these from Supabase on boot and every tick
let API_KEY =
  process.env.HYPIXEL_API_KEY || process.env.SECRET_HYPIXEL_API_KEY || null;

function sbHeaders(extra = {}) {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    ...extra,
  };
}

// GET bucket by name; if missing, create it.
async function ensureBucketExists() {
  // Try to fetch the bucket (by name)
  const getRes = await fetch(`${SUPABASE_URL}/storage/v1/bucket/${encodeURIComponent(SUPABASE_STORAGE_BUCKET)}`, {
    headers: sbHeaders(),
  });

  if (getRes.ok) return; // already exists

  // Some Supabase Storage deployments wrap a missing-bucket 404 in an HTTP 400.
  const getText = await getRes.text().catch(() => "");
  const bucketIsMissing = getRes.status === 404 || /bucket not found/i.test(getText);
  if (bucketIsMissing) {
    // Create the bucket (private by default; change public:true if you want it public)
    const createRes = await fetch(`${SUPABASE_URL}/storage/v1/bucket`, {
      method: "POST",
      headers: sbHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ name: SUPABASE_STORAGE_BUCKET, public: false }),
    });
    if (!createRes.ok) {
      const txt = await createRes.text().catch(() => "");
      throw new Error(`Failed to create bucket "${SUPABASE_STORAGE_BUCKET}": ${createRes.status} ${txt}`);
    }
    return;
  }

  throw new Error(`Bucket check error: ${getRes.status} ${getText}`);
}

// Read JSON object from storage; returns null if not found
async function readStorageJSON(pathInBucket) {
  const res = await fetch(
    `${SUPABASE_URL}/storage/v1/object/${encodeURIComponent(SUPABASE_STORAGE_BUCKET)}/${pathInBucket}`,
    { headers: sbHeaders() }
  );
  if (res.status === 404) return null;
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Storage read error: ${res.status} ${txt}`);
  }
  const text = await res.text();
  return JSON.parse(text);
}

// Upsert JSON object to storage
async function writeStorageJSON(pathInBucket, obj) {
  const res = await fetch(
    `${SUPABASE_URL}/storage/v1/object/${encodeURIComponent(SUPABASE_STORAGE_BUCKET)}/${pathInBucket}?upsert=true`,
    {
      method: "PUT",
      headers: sbHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(obj, null, 2),
    }
  );
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Storage write error: ${res.status} ${txt}`);
  }
}

// --- Live placement badge state ---
let placement = Number(process.env.PLACEMENT || 0) || null;  // initial; can be null
const PLACEMENT_TOKEN = process.env.PLACEMENT_TOKEN || null;
async function initializeLossesOnBoot(guildName) {
  // make sure we have an API key and a state shell
  await refreshEnvFromSupabase();
  if (!API_KEY) {
    console.error("❌ Missing HYPIXEL_API_KEY. Skipping boot losses init.");
    return;
  }
  const st = await loadState(); // ensures file exists

  // 1) get the live member list
  let guild = await getGuildByName(guildName);
  if (!guild) guild = await getGuildByPlayerName(guildName);
  if (!guild) throw new Error(`Guild "${guildName}" not found`);

  const members = Array.isArray(guild.members) ? guild.members : [];
  const uuids = members.map(m => m.uuid);

  // 2) fetch ALL players’ losses in parallel (same /v2/player call)
  const cap = pLimit(10);
  const freshLosses = Object.create(null);
  const freshNames   = Object.create(null);

  await Promise.all(uuids.map(u => cap(async () => {
    const j = await getPlayerByUUID(u);
    const losses = extractDuelsLossesFromPlayer(j);
    const name =
      j?.player?.displayname ||
      j?.player?.playername ||
      st.names?.[u] || (await getNameFromUUID(u)) || u;
    const n = Number(losses || 0);
    if (n > 0) freshLosses[u] = n;
    freshNames[u] = name;
  })));

  // 3) merge into state without touching wins or other fields
  const next = { ...st };
  next.lastMemberLosses = { ...(st.lastMemberLosses || {}), ...freshLosses };
  next.lastTotalLosses  = Object.values(next.lastMemberLosses).reduce((s, v) => s + Number(v || 0), 0);
  next.names = { ...(st.names || {}), ...freshNames };

  await saveState(next);
}

// SSE subscribers for live push:
const placementClients = new Set(); // Set<res>
function broadcastPlacement() {
  const data = JSON.stringify({ placement });
  for (const res of placementClients) {
    res.write(`data: ${data}\n\n`);
  }
}

async function loadState() {
  await ensureDataFile();
  const j = await readStorageJSON(SUPABASE_STORAGE_OBJECT);
  // In the unlikely case of a race on first boot:
  if (!j || typeof j !== "object") {
    throw new Error("State missing or invalid in storage");
  }
  return j;
}

async function setPlacement(newVal) {
  const p = Number(newVal);
  if (!Number.isFinite(p) || p < 0 || p > 99) return false; // 1–2 digits (0 hides)
  placement = p || null; // 0 -> hide
  // also persist into guild.json so reloads see it without SSE
  const st = await loadState();
  st.placement = placement;
  await saveState(st);
  broadcastPlacement();
  return true;
}

const { initApi } = require("./api");
const handleApi = initApi({ loadState, allowOrigin: "*" }); // set to your domain if you want stricter CORS

// ---- Global manual-search rate limit: 3 per 10 minutes (all IPs) ----
const SEARCH_MAX = 1;
const SEARCH_WINDOW_MS = 5 * 60 * 1000;
let searchTimestamps = []; // ascending by time (we only ever push)

function purgeOldSearches(now = Date.now()) {
  searchTimestamps = searchTimestamps.filter((t) => now - t < SEARCH_WINDOW_MS);
}

// Returns { ok:true, remaining } OR { ok:false, retryMs }
function consumeSearchQuota() {
  const now = Date.now();
  purgeOldSearches(now);
  if (searchTimestamps.length >= SEARCH_MAX) {
    const oldest = searchTimestamps[0];
    const retryMs = SEARCH_WINDOW_MS - (now - oldest);
    return { ok: false, retryMs };
  }
  searchTimestamps.push(now);
  return { ok: true, remaining: SEARCH_MAX - searchTimestamps.length };
}

function nextResetMs(now = Date.now()) {
  purgeOldSearches(now);
  if (searchTimestamps.length === 0) return 0;
  return Math.max(0, SEARCH_WINDOW_MS - (now - searchTimestamps[0]));
}

const FRONT_PATH = path.resolve(__dirname, "front.js");
const CALL_EVERY_MS = 10 * 60 * 1000; // 10 minutes
const TARGET_GUILD = GUILD;

// ---- Daily Win Reset Time ----
// Daily Win Reset Time (Pacific, 24h) – tweak for testing:
const DAILY_RESET_HOUR_PT = 21; // 21:00 PT
const DAILY_RESET_MIN_PT = 0;

// returns { dayKey: "YYYY-MM-DD", hour, minute }
function pacificNowParts(d = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).formatToParts(d);
  const get = (t) => Number(parts.find(p => p.type === t)?.value || 0);
  const y = parts.find(p => p.type === 'year')?.value;
  const m = parts.find(p => p.type === 'month')?.value;
  const dd = parts.find(p => p.type === 'day')?.value;
  const hour = get('hour');
  const minute = get('minute');
  return { dayKey: `${y}-${m}-${dd}`, hour, minute };
}

// ---------- tiny utils ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();


// optional helper if your readStorageJSON throws on 404s
function isNotFound(err) {
  return err?.status === 404 ||
         err?.code === 'PGRST116' ||        // common PostgREST not-found
         (typeof err?.message === 'string' && /404|not\s*found/i.test(err.message));
}

async function ensureDataFile() {
  await ensureBucketExists();

  let shouldInitialize = false;

  try {
    // Contract: if the object exists -> returns data; if missing -> returns null
    // If your readStorageJSON *throws* on 404, the catch below will handle it.
    const existing = await readStorageJSON(SUPABASE_STORAGE_OBJECT);
    if (existing !== null) {
      return; // file exists; do nothing
    }
    // explicitly null -> confirmed missing
    shouldInitialize = true;
  } catch (e) {
    // Any non-404 (network hiccup, auth blip, 5xx, rate limit): DO NOT initialize
    if (isNotFound(e)) {
      shouldInitialize = true; // only init on confirmed 404
    } else {
      console.error("ensureDataFile: read error; NOT initializing:", e);
      return;
    }
  }

  if (!shouldInitialize) return;

  // Same structure you had before:
  const initial = {
    guildName: TARGET_GUILD,
    guildId: null,
    lastRunAt: null,
    nextRunAt: null,
    lastExpDateKey: null,
    lastExpByUuid: {},
    lastMemberWins: {},
    lastMemberLosses: {},
    lastMembers: [],
    names: {},
    lastTotalWins: 0,
    lastTotalLosses: 0,
    lastDeltaWins: 0,
    lastJoined: [],
    lastLeft: [],
    players: [],
    joinLog: [],
    leftLog: [],
    placement: null,
    guildLevel: null,
    dailyWinsInitAt: null,
    dailyWinsInitByUuid: {},
    initialFullScanDone: false,
    initialFullScanAt: null,
  };

  await writeStorageJSON(SUPABASE_STORAGE_OBJECT, initial);
}


async function saveState(state) {
  await writeStorageJSON(SUPABASE_STORAGE_OBJECT, state);
}


async function refreshEnvFromSupabase() {
  if (!SUPABASE_URL || !SUPABASE_KEY) return; // not configured; fall back to process.env

  // Pull the whole table once (simple & robust against varying schemas)
  const url = `${SUPABASE_URL}/rest/v1/${encodeURIComponent(SUPABASE_TABLE)}?select=*`;
  const res = await fetch(url, {
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
    },
  });

  if (!res.ok) {
    throw new Error(`Supabase REST error ${res.status}`);
  }

  const rows = await res.json();

  // Helper: find a row by name/key (case-insensitive) then read any plausible value column
  const pick = (wanted) => {
    const row = rows.find((r) => {
      const k = String(r?.name ?? r?.key ?? r?.env ?? r?.k ?? "").toUpperCase();
      return k === wanted.toUpperCase();
    });
    if (!row) return undefined;
    const val = row.value ?? row.val ?? row.v ?? row.secret ?? row.data ?? row.valstr;
    return typeof val === "string" ? val : (val == null ? undefined : String(val));
  };

  const nextKey = pick("HYPIXEL_API_KEY");
  const nextPlacementRaw = pick("PLACEMENT");

  // HYPIXEL_API_KEY
  if (nextKey && nextKey !== API_KEY) {
    API_KEY = nextKey;
    console.log("🔑 HYPIXEL_API_KEY refreshed from Supabase");
  }

  // PLACEMENT
  if (nextPlacementRaw !== undefined) {
    const num = Number(nextPlacementRaw);
    if (Number.isFinite(num)) {
      // setPlacement() also persists to guild.json and pushes via SSE
      const prev = placement ?? null;
      const next = num || null; // 0 hides
      if (prev !== next) {
        await setPlacement(num);
        console.log("🏷️ PLACEMENT refreshed from Supabase →", next ?? "(hidden)");
      }
    }
  }
}


// Simple concurrency limiter
function pLimit(concurrency) {
  const queue = [];
  let active = 0;
  const next = () => {
    if (active >= concurrency || queue.length === 0) return;
    const { fn, resolve, reject } = queue.shift();
    active++;
    Promise.resolve()
      .then(fn)
      .then((v) => {
        active--;
        resolve(v);
        next();
      })
      .catch((e) => {
        active--;
        reject(e);
        next();
      });
  };
  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
}

// ---------- Hypixel helpers ----------
async function fetchHypixelJSON(pathnameWithQuery, retries = 3) {
  const url = `https://api.hypixel.net${pathnameWithQuery}`;
  for (let i = 0; i <= retries; i++) {
    const res = await fetch(url, {
      headers: { "API-Key": API_KEY },
    }).catch(() => null);
    if (!res) {
      if (i === retries) throw new Error("Network error to Hypixel");
      await sleep(500 * (i + 1));
      continue;
    }
    if (res.status >= 500) {
      if (i === retries) throw new Error(`Hypixel 5xx: ${res.status}`);
      await sleep(500 * (i + 1));
      continue;
    }
    const json = await res.json().catch(() => ({}));
    if (json && json.success === false && i < retries) {
      await sleep(500 * (i + 1));
      continue;
    }
    return json;
  }
  throw new Error("Unreachable");
}

async function getGuildByName(name) {
  const data = await fetchHypixelJSON(
    `/v2/guild?name=${encodeURIComponent(name)}`,
  );
  if (!data || !data.guild) return null;
  return data.guild;
}

async function getGuildByPlayerName(ign) {
  const data = await fetchHypixelJSON(
    `/v2/guild?player=${encodeURIComponent(ign)}`,
  );
  if (!data || !data.guild) return null;
  return data.guild;
}

async function getPlayerByUUID(uuid) {
  return await fetchHypixelJSON(`/v2/player?uuid=${uuid}`);
}

async function getNameFromUUID(uuid) {
  // Mojang session server: current name for UUID (no dashes ok)
  try {
    const res = await fetch(
      `https://sessionserver.mojang.com/session/minecraft/profile/${uuid.replace(/-/g, "")}`,
    );
    if (!res.ok) return null;
    const j = await res.json();
    return j && j.name ? j.name : null;
  } catch {
    return null;
  }
}

function latestExpDateKeyFromMembers(members) {
  // Each member has expHistory with keys like 'YYYY-MM-DD'. Grab the max lexicographically.
  let latest = null;
  for (const m of members) {
    const keys = m.expHistory ? Object.keys(m.expHistory) : [];
    for (const k of keys) {
      if (!latest || k > latest) latest = k;
    }
  }
  return latest; // can be null if no expHistory present
}

function topNDatesFromMembers(members, n) {
  const set = new Set();
  for (const m of members) {
    if (m.expHistory) for (const k of Object.keys(m.expHistory)) set.add(k);
  }
  return Array.from(set).sort().reverse().slice(0, n); // newest → oldest
}

function extractDuelsWinsFromPlayer(playerObj) {
  // Prefer stats.Duels.wins; fallback to 0 if missing.
  try {
    const wins = playerObj?.player?.stats?.Duels?.wins;
    if (Number.isFinite(wins)) return wins;
    // Occasionally some accounts only have achievements counted (rare). Try a fallback:
    const ach = playerObj?.player?.achievements?.duels_wins;
    if (Number.isFinite(ach)) return ach;
  } catch {}
  return 0;
}

function extractDuelsLossesFromPlayer(playerObj) {
  try {
    const duels = playerObj?.player?.stats?.Duels || {};
    const top = duels?.losses;
    if (Number.isFinite(top) && top > 0) return top;

    // If top-level is missing or 0, aggregate per-mode *_losses fields.
    let agg = 0;
    for (const [k, v] of Object.entries(duels)) {
      if (typeof v === "number" && v > 0 && /(^|_)losses$/i.test(k) && k !== "losses") {
        agg += v;
      }
    }
    if (agg > 0) return agg;

    // Extremely rare fallback: try achievements if present
    const ach = playerObj?.player?.achievements?.duels_losses;
    if (Number.isFinite(ach) && ach > 0) return ach;
  } catch {}
  return 0;
}


// XP needed for each early level, then 3,000,000 per level afterward.
// Source: staff & community implementations (see notes).
const GUILD_EXP_NEEDED = [
  100000, 150000, 250000, 500000, 750000,
  1000000, 1250000, 1500000, 2000000,
  2500000, 2500000, 2500000, 2500000, 2500000, // levels 10→11 .. 14→15
  3000000                                 // 15+ always 3,000,000 per level
];

function guildLevelFromGuild(guild) {
  // If API already provides it, trust that.
  if (Number.isFinite(guild?.level)) return Number(guild.level);

  let exp = Number(guild?.exp || 0);
  let level = 0;

  // walk levels until we run out of exp; return fractional progress (2 decimals)
  for (let i = 0; i <= 1000; i++) {
    const need = (i >= GUILD_EXP_NEEDED.length)
      ? GUILD_EXP_NEEDED[GUILD_EXP_NEEDED.length - 1]
      : GUILD_EXP_NEEDED[i];

    if (exp < need) {
      return Math.round((level + (exp / need)) * 100) / 100;
    }
    level += 1;
    exp -= need;
  }
  return level; // unreachable in practice
}


// ---------- core j*b ----------
const limit10 = pLimit(10);

async function computeGuildTotals(guildName, persisted) {
  // One-time full scan gate
  const forceFullScan = persisted.initialFullScanDone !== true;
  // --- Daily Wins reset check (Pacific) ---
  const { dayKey, hour, minute } = pacificNowParts();
  const resetWindowReached = (hour > DAILY_RESET_HOUR_PT) || (hour === DAILY_RESET_HOUR_PT && minute >= DAILY_RESET_MIN_PT);
  const baselineDay = persisted.dailyWinsInitAt || null;
  const doDailyReset = resetWindowReached && baselineDay !== dayKey;

  // We'll (re)build nextDailyBaseline after we know current wins.
  let nextDailyBaseline = { ...(persisted.dailyWinsInitByUuid || {}) };
  let nextWeeklyBaseline  = { ...(persisted.weeklyWinsInitByUuid  || {}) };
  let nextMonthlyBaseline = { ...(persisted.monthlyWinsInitByUuid || {}) };
  // Resolve guild by name; fallback to by-player if not found
  let guild = await getGuildByName(guildName);
  const guildLevel = guildLevelFromGuild(guild);
  if (!guild) {
    guild = await getGuildByPlayerName(guildName);
    if (!guild) throw new Error(`Guild "${guildName}" not found`);
  }

  const members = Array.isArray(guild.members) ? guild.members : [];
  const curMemberUUIDs = members.map((m) => m.uuid);
  const prevMemberSet = new Set(persisted.lastMembers || []);
  const curMemberSet = new Set(curMemberUUIDs);

  const joined = curMemberUUIDs.filter((u) => !prevMemberSet.has(u));
  const left = (persisted.lastMembers || []).filter(
    (u) => !curMemberSet.has(u),
  );

  const latestKey = latestExpDateKeyFromMembers(members);
  const sameExpKey = latestKey && persisted.lastExpDateKey === latestKey;
  const weekKeys = topNDatesFromMembers(members, 7);
  const memberByUuid = Object.fromEntries(members.map(m => [m.uuid, m]));


  // Build per-member plan: decide who needs fresh /v2/player call
  const lastExpByUuid = sameExpKey ? persisted.lastExpByUuid || {} : {}; // reset baseline if date changed
  const lastWins = persisted.lastMemberWins || {};
  const lastLosses = persisted.lastMemberLosses || {};
  const names = { ...(persisted.names || {}) };

  const needsFetch = new Set();
  const nextExpByUuid = {};
  const playersOut = [];

  // First pass: decide
  for (const m of members) {
    const u = m.uuid;
    const expToday =
      latestKey && m.expHistory ? Number(m.expHistory[latestKey] || 0) : 0;
    const prevExp = Number(lastExpByUuid[u] || 0);
    const isNew = !(u in lastWins);
    const cachedLoss = Number(lastLosses[u] ?? NaN);
    const needLossInit = !(u in lastLosses) || cachedLoss === 0; // ← zero also triggers fetch
    const nameKnown = !!names[u];
    
    nextExpByUuid[u] = expToday;

    // We must fetch if:
    //  - new member (no cached wins)
    //  - exp increased since last snapshot (contributed this interval)
    //  - we don't have a display name yet (mojang fallback later if needed)
    const contributed = expToday > prevExp;
    if (forceFullScan || isNew || needLossInit || contributed || !nameKnown) {
      needsFetch.add(u);
    }
  }
  // Fetch those who need fresh player data (wins + name)
  const uuidToFresh = {};
  await Promise.all(
    Array.from(needsFetch).map((u) =>
      limit10(async () => {
        const j = await getPlayerByUUID(u);
        const wins   = extractDuelsWinsFromPlayer(j);
        const losses = extractDuelsLossesFromPlayer(j);
        const name =
          j?.player?.displayname ||
          j?.player?.playername ||
          names[u] ||
          (await getNameFromUUID(u)) ||
          u;
        uuidToFresh[u] = { wins, losses, name };
      }),
    ),
  );

  // Second pass: build player list with wins & names, using cache where allowed
  let totalWins = 0;
  let totalLosses = 0;
  for (const u of curMemberUUIDs) {
      let wins, losses, name;
      if (uuidToFresh[u]) {
      wins   = uuidToFresh[u].wins;
      const freshLosses = Number(uuidToFresh[u].losses || 0);
      const cachedLoss  = Number(lastLosses[u] || 0);
      // Never overwrite a good non-zero with a zero coming back
      losses = freshLosses > 0 ? freshLosses : cachedLoss;
      name = uuidToFresh[u].name;
    } else {
      wins = Number(lastWins[u] || 0);
      losses = Number(lastLosses[u] || 0);
      name = names[u] || u;
    }
    names[u] = name;
        // --- Daily Wins baseline & value ---
    // If today has been reset already, every player should have an entry in the baseline.
    // If a player joined after reset (no baseline yet), initialize theirs lazily now.
    const baseline = Number(
      (persisted.dailyWinsInitByUuid && persisted.dailyWinsInitByUuid[u]) ??
      // if no baseline has ever been set, lazily treat NOW as their baseline
      wins
    );
    const dailyWins = Math.max(0, wins - baseline);

    // keep delta (server tick diff) available if you still want it internally,
    // but UI will use dailyWins now.
    const prevWins = Number(lastWins[u] || 0);
    const delta = wins - prevWins;
    // --- Weekly & Monthly Wins baselines (lazily init if missing) ---
    const wBase = Number(
      (persisted.weeklyWinsInitByUuid && persisted.weeklyWinsInitByUuid[u]) ??
      wins
    );
    const mBase = Number(
      (persisted.monthlyWinsInitByUuid && persisted.monthlyWinsInitByUuid[u]) ??
      wins
    );
    const weeklyWins  = Math.max(0, wins - wBase);
    const monthlyWins = Math.max(0, wins - mBase);


    // --- Daily & Weekly GEXP ---
    const member = memberByUuid[u];
    const exph = member?.expHistory || {};
    const dailyExp = latestKey ? Number(exph[latestKey] || 0) : 0;
    let weeklyExp = 0;
    for (const k of weekKeys) weeklyExp += Number(exph[k] || 0);

    // --- Guild role (rank) ---
    let role = member?.rank || 'Member';          // Hypixel guild member rank name
    if (typeof role === 'string') role = role.replace(/_/g, ' '); // nicer display

    // --- Join date (from Unix seconds OR ms) ---
    let joinedAtIso = null;
    let joinedLabel = null;
    const rawJoin = member?.joined ?? member?.joinDate ?? null;
    if (rawJoin != null) {
      const ts = Number(rawJoin);
      if (Number.isFinite(ts)) {
        const ms = ts < 1e12 ? ts * 1000 : ts; // handle seconds or milliseconds
        const d = new Date(ms);
        joinedAtIso = d.toISOString();
        joinedLabel = d.toLocaleDateString('en-US', {
          year: 'numeric',
          month: 'long',
          day: 'numeric',
          timeZone: 'UTC'   // stable, avoids timezone shift
        });
      }
    }
    
    totalWins += wins;
    totalLosses += losses;
    playersOut.push({
      uuid: u, name, wins, delta,
      dailyWins, dailyExp, weeklyExp, role,
      weeklyWins, monthlyWins,
      joinedAt: joinedAtIso, joinedLabel
    });
  }
  // Sort players by wins desc
  playersOut.sort((a, b) => b.wins - a.wins);

  const deltaWins = totalWins - Number(persisted.lastTotalWins || 0);
    // --- Left details (unchanged; still RAM-based) ---
  const leftDetails = (persisted.lastMembers || [])
    .filter((u) => !curMemberSet.has(u))
    .map((u) => ({
      uuid: u,
      name: names[u] || u,
      wins: Number(persisted.lastMemberWins?.[u] || 0),
    }));

  // --- Joined details (NEW: compute from actual join timestamps, not RAM) ---
  const DAY_MS = 24 * 60 * 60 * 1000;
  const nowMs = Date.now();
  const cutoff = nowMs - DAY_MS;

  // Members whose guild join time is within the last 24h
  const joinedWithin24 = members
    .filter((m) => Number(m?.joined) > 0 && m.joined >= cutoff)
    .map((m) => {
      const u = m.uuid;
      const p = playersOut.find((x) => x.uuid === u);
      return {
        uuid: u,
        name: p?.name || names[u] || u,
        wins: Number(p?.wins ?? 0),
        at: new Date(m.joined).toISOString(), // <-- the real join time
      };
    })
    // if you want newest first in the UI:
    .sort((a, b) => new Date(b.at) - new Date(a.at));

  // --- Left log stays RAM-based (keep last 24h and append) ---
  const prevLeftLog = Array.isArray(persisted.leftLog) ? persisted.leftLog : [];
  const prunedLeftLog = prevLeftLog.filter((e) => new Date(e.at).getTime() >= cutoff);
  const nowStr = nowIso();
  const leftLog = prunedLeftLog.concat(leftDetails.map((e) => ({ ...e, at: nowStr })));
// --- Eastern Time helpers (Sunday/Month 00:00 ET resets) ---
function etNow() {
  // robust ET date without deps
  const s = new Date().toLocaleString("en-US", { timeZone: "America/New_York" });
  return new Date(s);
}
function ymd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${da}`;
}
function monthKeyET(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`; // e.g. 2025-09
}
function weekKeyET(d0) {
  // key = YYYY-MM-DD of the most recent Sunday in ET
  const d = new Date(d0);
  const dow = d.getDay(); // 0 = Sun
  const sunday = new Date(d);
  sunday.setHours(0,0,0,0);
  sunday.setDate(sunday.getDate() - dow);
  return ymd(sunday);
}

  // --- Build/refresh the Daily Wins baseline map ---
  const winsByUuid = Object.fromEntries(playersOut.map(p => [p.uuid, p.wins]));

  if (doDailyReset) {
    // 21:00 PT -> reinitialize everyone
    nextDailyBaseline = {};
    for (const u of curMemberUUIDs) {
      // Prefer previous snapshot; if missing (brand-new member), use current wins
      const prev = persisted.lastMemberWins?.[u];
      nextDailyBaseline[u] = Number(
        prev != null ? prev : (winsByUuid[u] ?? 0)
      );
    }
    console.log(`🕘 Daily baseline initialized for PT day ${dayKey}`);
  } else {
    // Not reset time -> initialize baseline lazily for truly new members
    for (const u of curMemberUUIDs) {
      if (!(u in nextDailyBaseline)) {
        nextDailyBaseline[u] = Number(winsByUuid[u] ?? 0); // seed to *current* wins
      }
    }
  }

  // --- WEEKLY reset (every new ET week: key = last Sunday 00:00 ET) ---
{
  const nowET = etNow();
  const wkKey = weekKeyET(nowET);
  const prevKey = persisted.weeklyWinsInitAt || null;

  if (prevKey !== wkKey) {
    nextWeeklyBaseline = {};
    for (const u of curMemberUUIDs) {
      const prev = persisted.lastMemberWins?.[u];
      nextWeeklyBaseline[u] = Number(prev != null ? prev : (winsByUuid[u] ?? 0));
    }
    console.log(`🗓️ Weekly baseline initialized for ET week ${wkKey}`);
  } else {
    // lazy init newcomers during the week
    for (const u of curMemberUUIDs) {
      if (!(u in nextWeeklyBaseline)) {
        nextWeeklyBaseline[u] = Number(winsByUuid[u] ?? 0);
      }
    }
  }
}

// --- MONTHLY reset (first of month 00:00 ET) ---
{
  const nowET = etNow();
  const moKey = monthKeyET(nowET);   // "YYYY-MM"
  const prevKey = persisted.monthlyWinsInitAt || null;

  if (prevKey !== moKey) {
    nextMonthlyBaseline = {};
    for (const u of curMemberUUIDs) {
      const prev = persisted.lastMemberWins?.[u];
      nextMonthlyBaseline[u] = Number(prev != null ? prev : (winsByUuid[u] ?? 0));
    }
    console.log(`🗓️ Monthly baseline initialized for ET month ${moKey}`);
  } else {
    // lazy init newcomers during the month
    for (const u of curMemberUUIDs) {
      if (!(u in nextMonthlyBaseline)) {
        nextMonthlyBaseline[u] = Number(winsByUuid[u] ?? 0);
      }
    }
  }
}

persisted.weeklyWinsInitAt    = persisted.weeklyWinsInitAt    || null;
persisted.weeklyWinsInitByUuid= persisted.weeklyWinsInitByUuid|| {};
persisted.monthlyWinsInitAt   = persisted.monthlyWinsInitAt   || null;
persisted.monthlyWinsInitByUuid= persisted.monthlyWinsInitByUuid|| {};

  // Prepare new state
  const nextState = {
    guildName: guild.name || guildName,
    guildId: guild._id || persisted.guildId || null,
    lastRunAt: nowIso(),
    nextRunAt: new Date(Date.now() + CALL_EVERY_MS).toISOString(),
    lastExpDateKey: latestKey || persisted.lastExpDateKey || null,
    lastExpByUuid: nextExpByUuid,
    lastMemberWins: Object.fromEntries(playersOut.map((p) => [p.uuid, p.wins])),
    lastMembers: curMemberUUIDs,
    names,
    lastTotalWins: totalWins,
    lastDeltaWins: deltaWins,
    lastMemberLosses: Object.fromEntries(curMemberUUIDs.map(u => [
      u,
      (uuidToFresh[u]?.losses ?? Number(lastLosses[u] || 0))
    ])),
    lastTotalLosses:  totalLosses,
    weeklyWinsInitAt: weekKeyET(etNow()),
    weeklyWinsInitByUuid: nextWeeklyBaseline,
    monthlyWinsInitAt: monthKeyET(etNow()),
    monthlyWinsInitByUuid: nextMonthlyBaseline,

    // Provide joined straight from actual join times:
    lastJoined: joinedWithin24, // [{uuid,name,wins,at}]

    // Left uses RAM log
    lastLeft: leftDetails,
    players: playersOut,

    // Keep only LEFT log in RAM; joined is computed fresh each time:
    joinLog: undefined, // or [] if you prefer; not used by /api/state anymore
    leftLog,
    dailyWinsInitAt: doDailyReset ? dayKey : (persisted.dailyWinsInitAt || null),
    dailyWinsInitByUuid: nextDailyBaseline,
    initialFullScanDone: true,
    initialFullScanAt: forceFullScan ? nowIso() : (persisted.initialFullScanAt || null),
    guildLevel
  };


  return nextState;
}

// On-demand compute for any guild (not persisted, no EXP-skip optimization)
async function computeAnyGuildOnce(guildName) {
  let guild = await getGuildByName(guildName);
  if (!guild) guild = await getGuildByPlayerName(guildName);
  if (!guild) throw new Error(`Guild "${guildName}" not found`);

  const members = Array.isArray(guild.members) ? guild.members : [];
  const players = [];
  const limit = pLimit(10);

  await Promise.all(
    members.map((m) =>
      limit(async () => {
        const u = m.uuid;
        const j = await getPlayerByUUID(u);
        const wins = extractDuelsWinsFromPlayer(j);
        const name =
          j?.player?.displayname ||
          j?.player?.playername ||
          (await getNameFromUUID(u)) ||
          u;
        players.push({ uuid: u, name, wins });
      }),
    ),
  );

  players.sort((a, b) => b.wins - a.wins);
  const totalWins = players.reduce((s, p) => s + p.wins, 0);

  return {
    guildName: guild.name || guildName,
    guildId: guild._id || null,
    playerCount: players.length,
    totalWins,
    players,
  };
}

// ---------- schedule loop ----------
let ticking = false;
async function runTick() {
  if (ticking) return; // avoid overlap
  ticking = true;
  try {
    // Always refresh from Supabase right before calling Hypixel
    await refreshEnvFromSupabase();

    if (!API_KEY) {
      console.error("❌ Missing HYPIXEL_API_KEY (Supabase + env both empty). Skipping this tick.");
      return;
    }

    const state = await loadState();
    const next = await computeGuildTotals(TARGET_GUILD, state);
    await saveState(next);
    console.log(
      `[${new Date().toLocaleTimeString()}] Updated "${next.guildName}": total ${next.lastTotalWins} (Δ ${next.lastDeltaWins})`,
    );
  } catch (err) {
    console.error("Update error:", err.message);
  } finally {
    ticking = false;
  }
}


(async () => {
  await ensureDataFile();
  // Force a one-time full losses seed for ALL current members:
  await initializeLossesOnBoot(TARGET_GUILD);
  // Then do your regular tick loop:
  await runTick();
  setInterval(runTick, CALL_EVERY_MS);
})();


// ---------- tiny HTTP server (no deps) ----------
const server = http.createServer(async (req, res) => {
  try {
    // inside: http.createServer(async (req, res) => { ... })
    const url = new URL(req.url, `http://${req.headers.host}`);

    // Hand off to the API module first:
    if (await handleApi(req, res, url)) return;

    // Serve the admin panel on the same host as the public tracker.
    if (url.pathname === "/admin" || url.pathname === "/admin/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(`<!doctype html>
    <html>
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>${GUILD || "Guild"} Admin</title>
    </head>
    <body>
      <script>window.APP_CONFIG = ${PUBLIC_CONFIG_JSON};</script>
      <script src="/admin.js" defer></script>
    </body>
    </html>`);
      return;
    }

    // Serve admin.js
    if (url.pathname === "/admin.js") {
      const fs = require("fs/promises");
      const ADMIN_PATH = require("path").resolve(__dirname, "admin.js");
      const js = await fs.readFile(ADMIN_PATH, "utf8");
      res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-store" });
      res.end(js);
      return;
    }

    // Serve root HTML
    if (url.pathname === "/" || url.pathname === "/index.html") {
      const ua = req.headers["user-agent"] || "";
      const isMobile = /Android|iPhone|iPod|Windows Phone|Mobile|BlackBerry|webOS/i.test(ua);

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
      <title>Guild Duels Wins — ${GUILD || TARGET_GUILD}</title>
  <style>
  /* keep error off to the right; never pushes the button */
  .trackForm { display:flex; gap:6px; align-items:center; position: relative; }
  .trackError {
    position: absolute; left: 100%; margin-left: 8px;
    top: 50%; transform: translateY(-50%);
    color:#ff8080; font-size:12px; white-space: nowrap;
  }
  .trackInput.error { border-color:#7a2a2a; box-shadow: 0 0 0 2px rgba(122,42,42,0.2) inset; }

  /* tracking view with head icon */
  .trackingWrap {
    display: inline-flex; align-items: center; gap: 8px;
    background:#0f1320; border:1px solid #26304a; padding:8px 12px; border-radius: 999px;
    cursor: pointer; user-select: none;
  }
  .trackingText { white-space: nowrap; }
  .trackingHead { width: 22px; height: 22px; border-radius: 4px; image-rendering: pixelated; }
  .closeX { font-size: 14px; opacity: 0.7; transition: color .15s ease, opacity .15s ease; }
  .trackingWrap:hover .closeX { color: #ff5a5a; opacity: 1; }
  .topRight { position: fixed; top: 10px; right: 12px; }
  .trackPill {
    background:#13223a; border:1px solid #27445e; padding:8px 12px; border-radius:999px;
    cursor:pointer; user-select:none;
  }
  .trackForm { display:flex; gap:6px; align-items:center; }
  .trackInput {
    width: 160px; max-width: 50vw;
    padding:6px 8px; background:#0e1421; color:#e7ecf3;
    border:1px solid #27324a; border-radius:10px;
  }
  .trackBtn {
    padding:6px 10px; border-radius:999px; cursor:pointer;
    background:#11351a; border:1px solid #1f5c2b; color:#c8ffd6;
  }
  .trackBtn:hover { background:#144021; }
  .trackError { color:#ff8080; font-size:12px; margin-left:6px; }
  .trackInput.error { border-color:#7a2a2a; box-shadow: 0 0 0 2px rgba(122,42,42,0.2) inset; }
  .sectionHeader { display:flex; align-items:center; justify-content:space-between; gap: 12px; }
  .sortSelect {
    appearance: none;
    -webkit-appearance: none;
    -moz-appearance: none;
    padding: 8px 12px;
    border-radius: 999px;
    background: #13223a;         /* dark navy/aqua-ish to match theme */
    border: 1px solid #27445e;   /* darker outline */
    color: #e7ecf3;
    font-size: 14px;
    cursor: pointer;
    text-align: center;              /* most browsers */
    text-align-last: center;         /* Chrome/Edge */
    -moz-text-align-last: center;    /* Firefox */
  }
  .sortSelect option { text-align: left !important; }  
  .sortSelect:focus { outline: none; box-shadow: 0 0 0 2px rgba(39,68,94,0.5); }
    body { font-family: system-ui, Arial, sans-serif; margin:0; background:#0b0d12; color:#e7ecf3; }
    .wrap { max-width: 1100px; margin: 0 auto; padding: 24px; }
    .countdown { position: fixed; top: 10px; left: 12px; font-weight: 700; opacity: 0.85; }
    h1 { text-align:center; margin: 0 0 12px; }
    .grid {
      display: grid;
      grid-template-rows: 1fr;
      gap: 24px;
      min-height: calc(100vh - 48px);
    }
    .card {
      background: #111520; border: 1px solid #1c2436; border-radius: 14px; padding: 16px;
      box-shadow: 0 6px 18px rgba(0,0,0,0.2);
    }
    .centerTop { display:flex; align-items:flex-start; justify-content:center; }
    .topHalf { display:flex; flex-direction:column; gap:16px; }
    .summary { display:flex; gap:12px; flex-wrap: wrap; justify-content:center; }
    .linksBar { display:flex; gap:12px; flex-wrap:wrap; justify-content:center; }
    a.pillLink { text-decoration:none; color:#e7ecf3; }
    a.pillLink.pill { background:#13223a; border:1px solid #27445e; }
    .changesBar { text-align:center; margin-top: 4px; }
    .changesBar .tag { margin: 4px; }
    .pill { background:#0f1320; border:1px solid #26304a; padding:8px 12px; border-radius:999px; }
    table { width:100%; border-collapse: collapse; margin-top: 8px; }
    th, td { padding: 8px; border-bottom: 1px solid #202a3f; font-size: 14px; }
    th { text-align:left; opacity:0.8; }
    .delta.plus { color:#7fff9f; }
    .delta.minus { color:#ff8989; }
    .muted { opacity:0.7; }
    .cols { display:grid; grid-template-columns: 1fr; gap: 16px; }
    .tag { display:inline-block; margin:2px 6px 0 0; padding:4px 8px; border-radius:8px; background:#0e1626; border:1px solid #27324a; }
    .roleTag {
      display:inline-block;
      margin-left: 8px;
      padding: 2px 10px;
      border-radius: 999px;
      background: #0f1e2b;        /* very dark navy */
      border: 1px solid #0b1622;  /* darker outline */
      color: #ffffff;             /* white text */
      font-size: 12px;
      line-height: 1.6;
      vertical-align: middle;
    }
    /* Name link styling for player column */
    .nameLink,
    .nameLink:visited {           /* keep visited links same color */
      color: inherit;             /* removes blue/purple */
      text-decoration: none;      /* removes underline */
    }
    .nameLink:hover {
      text-decoration: underline; /* underline on hover only */
    }

    .placementTag {
      display:inline-block;
      margin-left: 5px;
      padding: 0.08em 0.6em;
      border-radius: 999px;
      background: #15324a;       /* slightly brighter/different from roleTag to sit on header bg */
      border: 1px solid #0e2232;  /* darker outline */
      color: #ffffff;
      font-size: 0.7em;
      line-height: 1.2;
      vertical-align: middle;
      transform: translateY(-3px);
    }
    .searchArea { max-width: 900px; margin: 0 auto; }
    .searchRow { display:flex; gap:8px; }
    input[type="text"] { flex:1; padding:10px 12px; background:#0e1421; color:#e7ecf3; border:1px solid #27324a; border-radius:10px; }
    button { padding:10px 14px; background:#1c2740; color:#e7ecf3; border:1px solid #34456b; border-radius:10px; cursor:pointer; }
    button:hover { background:#233255; }
    .small { font-size: 12px; }
    .mobile .wrap { margin-top: 50px; }
    .adminFooter { display:flex; justify-content:center; margin:20px 0 4px; }
    .adminFooter a { color:#b9d7ff; font-size:12px; text-decoration:none; opacity:.75; }
    .adminFooter a:hover { opacity:1; text-decoration:underline; }
  </style>
</head>
<body class="${isMobile ? 'mobile' : ''}">
  <div class="countdown"><span id="countdown">—</span></div>
  <div class="topRight" id="trackUi"></div>
  <div class="wrap">
    <h1>
      <span id="titleText">${isMobile ? `${GUILD || TARGET_GUILD} TOP` : `Guild Duels Wins — <span id="titleGuild">${GUILD || TARGET_GUILD}</span>`}</span>
      <span id="placementPill" class="placementTag" style="display:none"></span>
    </h1>

    <div class="grid">
      <div class="card topHalf">
        <div class="summary" id="summaryPills"></div>
        <div class="linksBar" id="linkPills"></div>
        <div id="changesBlock" class="changesBar"></div>
          <div class="cols">
          <div>
            <div class="sectionHeader">
              <div class="muted small">Players & Contributions</div>
              <div>
                <label for="sortSelect" class="muted small" style="margin-right:8px;">Sort</label>
                <select id="sortSelect" class="sortSelect">
                  <option value="wins" selected>Duels Wins</option>
                  <option value="dailywins">Daily Wins</option>
                  <option value="daily">Daily GEXP</option>
                  <option value="weekly">Weekly GEXP</option>
                  <option value="joined">Join Date</option>
                </select>
              </div>
            </div>
            <div id="playersTableWrap"></div>
          </div>
        </div>
      </div>
    </div>
    <footer class="adminFooter"><a href="/admin">Admin</a></footer>
  </div>
  <script>window.APP_CONFIG = ${PUBLIC_CONFIG_JSON};</script>
  <script src="/front.js" defer></script>
</body>
</html>`);
      return;
    }

    // Serve front.js
    if (url.pathname === "/front.js") {
      const js = await readFile(FRONT_PATH, "utf8");
      res.writeHead(200, {
        "Content-Type": "application/javascript; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(js);
      return;
    }

    // API: state
    if (url.pathname === "/api/state") {
      const state = await loadState();
      const payload = {
        guildName: state.guildName,
        guildId: state.guildId,
        playerCount: (state.lastMembers || []).length,
        totalWins: state.lastTotalWins || 0,
        deltaWins: state.lastDeltaWins || 0,
        lastRunAt: state.lastRunAt,
        nextRunAt: state.nextRunAt,
        joined: (state.joinLog || state.lastJoined || []), // [{uuid,name,wins,at}]
        left: (state.leftLog || state.lastLeft || []),     // [{uuid,name,wins,at}]
        players: state.players || [],
        placement: (typeof state.placement === 'number' ? state.placement : (placement ?? null)),
        guildLevel: state.guildLevel ?? null
      };
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(payload));
      return;
    }

    // API: search guild
    if (url.pathname === "/api/searchGuild") {
      const name = (url.searchParams.get("name") || "").trim();
      if (!name) {
        res.writeHead(400, {
          "Content-Type": "application/json; charset=utf-8",
        });
        res.end(JSON.stringify({ error: "Missing name" }));
        return;
      }

      // --- GLOBAL RATE LIMIT: 1 searches / 5 minutes (all IPs) ---
      const token = consumeSearchQuota();
      if (!token.ok) {
        const retrySec = Math.ceil(token.retryMs / 1000);
        res.writeHead(429, {
          "Content-Type": "application/json; charset=utf-8",
          "Retry-After": String(retrySec),
          // Optional UX/debug headers:
          "X-RateLimit-Limit": String(SEARCH_MAX),
          "X-RateLimit-Remaining": "0",
          "X-RateLimit-Reset": new Date(
            Date.now() + token.retryMs,
          ).toISOString(),
        });
        res.end(
          JSON.stringify({
            error: `To keep the service running 24/7, search rates are limited to 1 per 5 minutes, please use responsibly. Try again in ${Math.floor(retrySec / 60)}m ${retrySec % 60}s.`,
          }),
        );
        return;
      }

      try {
        const data = await computeAnyGuildOnce(name);
        // After consuming one token above, expose remaining & reset for client visibility
        const resetMs = nextResetMs();
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
          "X-RateLimit-Limit": String(SEARCH_MAX),
          "X-RateLimit-Remaining": String(Math.max(0, token.remaining)),
          "X-RateLimit-Reset": new Date(Date.now() + resetMs).toISOString(),
        });
        res.end(JSON.stringify(data));
      } catch (e) {
        // Note: still counts against the quota (we consumed on receipt)
        res.writeHead(404, {
          "Content-Type": "application/json; charset=utf-8",
        });
        res.end(JSON.stringify({ error: e.message || "Not found" }));
      }
      return;
    }
    // API: live placement stream (SSE)
    if (url.pathname === '/api/placement/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        'Connection': 'keep-alive',
      });
      res.write('\n');
      placementClients.add(res);
      // send current immediately
      res.write(`data: ${JSON.stringify({ placement })}\n\n`);

      req.on('close', () => {
        placementClients.delete(res);
      });
      return;
    }

    // --- Admin APIs (path-based) ---
    if (url.pathname === "/api/admin/status") {
      if (!ADMIN_PASS || req.headers["x-admin-pass"] !== ADMIN_PASS) {
        res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ lastUpdatedAt: adminLastUpdatedAtIso }));
      return;
    }

    if (url.pathname === "/api/admin/setApiKey" && req.method === "POST") {
      if (!ADMIN_PASS || req.headers["x-admin-pass"] !== ADMIN_PASS) {
        res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      let body = "";
      await new Promise((r) => { req.on("data", (c) => body += c); req.on("end", r); });
      let apiKey = "";
      try { apiKey = (JSON.parse(body || "{}").apiKey || "").trim(); } catch {}
      if (!apiKey) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "Missing apiKey" }));
        return;
      }
      try {
        await upsertEnvVarToSupabase("HYPIXEL_API_KEY", apiKey);
        API_KEY = apiKey; // use instantly
        adminLastUpdatedAtIso = new Date().toISOString();
        // touch state so next run sees consistent timestamps (optional)
        await writeStorageJSON(SUPABASE_STORAGE_OBJECT, { ...(await loadState()), lastRunAt: (await loadState()).lastRunAt });
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, lastUpdatedAt: adminLastUpdatedAtIso }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: e.message || "failed" }));
      }
      return;
    }
    // /api/admin/setPlacement  (POST { placement: <0-99> })
    if (url.pathname === "/api/admin/setPlacement" && req.method === "POST") {
      if (!ADMIN_PASS || req.headers["x-admin-pass"] !== ADMIN_PASS) {
        res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      let body = "";
      await new Promise((r) => { req.on("data", (c) => body += c); req.on("end", r); });
      let placementRaw = null;
      try { placementRaw = JSON.parse(body || "{}").placement; } catch {}
      const num = Number(String(placementRaw ?? "").trim());
      if (!Number.isFinite(num) || num < 0 || num > 99) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "placement must be an integer 0–99 (0 hides)" }));
        return;
      }
      try {
        // Persist to Supabase env table and update live state
        await upsertEnvVarToSupabase("PLACEMENT", String(num));
        await setPlacement(num);
        adminLastUpdatedAtIso = new Date().toISOString();
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, placement: num, lastUpdatedAt: adminLastUpdatedAtIso }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: e.message || "failed" }));
      }
      return;
    }

    // Not found
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  } catch (err) {
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Server error");
    console.error(err);
  }
});

server.listen(PORT, () =>
  console.log(`✅ Server running on http://localhost:${PORT}`),
);
