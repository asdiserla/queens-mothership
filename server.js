import express from "express";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const POLL_MS = Number(process.env.POLL_MS || 1500);
const THING_IDS = (process.env.THING_IDS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

const ARDUINO_CLIENT_ID = process.env.ARDUINO_CLIENT_ID || "";
const ARDUINO_CLIENT_SECRET = process.env.ARDUINO_CLIENT_SECRET || "";

const SPACE_ID = process.env.SPACE_ID || "";
const API_BASE = "https://api2.arduino.cc/iot";

// ---- In-memory state (for debugging/demo) ----
const mem = {
  bees: {}, // thingId -> { lastSeen, ldr_value, lastCloudState, lastWriteOk, lastError }
  global: {
    updatedAt: null,
    avgLight: null,
    lowLight: null,
    queenThingId: null,
    reason: null,
  },
  lastSync: { at: null, ok: null, error: null }
};

// Initialize bees
for (const id of THING_IDS) {
  mem.bees[id] = mem.bees[id] || {
    lastSeen: null,
    ldr_value: null,
    lastCloudState: null,
    lastWriteOk: null,
    lastError: null
  };
}

// ---- Arduino Cloud REST helpers ----
let tokenCache = { token: null, exp: 0 }; // exp = unix ms when token should be refreshed

function hasCredentials() {
  return ARDUINO_CLIENT_ID.length > 0 && ARDUINO_CLIENT_SECRET.length > 0;
}

function hasSpace() {
  return SPACE_ID.length > 0;
}

function orgHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    "X-Organization": SPACE_ID,
  };
}

async function getAccessToken() {
  if (!hasCredentials()) throw new Error("Missing ARDUINO_CLIENT_ID/ARDUINO_CLIENT_SECRET");
  if (!hasSpace()) throw new Error("Missing SPACE_ID (required for shared-space Things)");

  const now = Date.now();
  if (tokenCache.token && now < tokenCache.exp) return tokenCache.token;

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: ARDUINO_CLIENT_ID,
    client_secret: ARDUINO_CLIENT_SECRET,
    audience: API_BASE,
    organization_id: SPACE_ID
  });

  const res = await fetch(`${API_BASE}/v1/clients/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Token error: ${res.status} ${txt}`);
  }

  const data = await res.json();
  // expires_in is seconds; refresh a bit early
  const expiresInMs = (data.expires_in || 300) * 1000;
  tokenCache = { token: data.access_token, exp: now + expiresInMs - 30_000 };
  return tokenCache.token;
}

async function listThingProperties(thingId, token) {
  const res = await fetch(`${API_BASE}/v2/things/${thingId}/properties`, {
    headers: orgHeaders(token), // FIX: include X-Organization
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`List props failed (${thingId}): ${res.status} ${txt}`);
  }
  return await res.json();
}

function propValue(p) {
  return (p.last_value !== undefined ? p.last_value : (p.value !== undefined ? p.value : null));
}

function buildPropIndex(props) {
  // Prefer variable_name (matches your sketch identifiers), but fallback to name.
  const byVar = new Map();
  const byName = new Map();

  for (const p of props) {
    if (p.variable_name) byVar.set(p.variable_name, p);
    if (p.name) byName.set(p.name, p);
  }

  // Special-case: you have name "YouAreTheQueen" but variable_name "youAreTheQueen"
  // With byVar-first, publishing with "youAreTheQueen" will still work.
  return { byVar, byName };
}

async function readState(thingId) {
  if (!hasCredentials() || !hasSpace()) {
    // Mock so you can still run the server without creds in dev
    return {
      ldr_value: mem.bees[thingId]?.ldr_value ?? Math.floor(Math.random() * 1024),
      led_count: 0,
      servo_speed: 0,
      isBlinking: false,
      ledcolor: true,
      youAreTheQueen: false,
      _mock: true,
    };
  }

  const token = await getAccessToken();
  const props = await listThingProperties(thingId, token);

  // FIX: map using variable_name when available (more stable than name)
  const state = {};
  for (const p of props) {
    const key = p.variable_name || p.name;
    state[key] = propValue(p);
  }
  return state;
}

function clampInt(n, min, max) {
  const x = Number.parseInt(n, 10);
  if (Number.isNaN(x)) return null;
  return Math.max(min, Math.min(max, x));
}

async function publishByKey(thingId, key, value) {
  if (!hasCredentials() || !hasSpace()) return { ok: true, mocked: true };

  const token = await getAccessToken();
  const props = await listThingProperties(thingId, token);
  const { byVar, byName } = buildPropIndex(props);

  const match = byVar.get(key) || byName.get(key);
  if (!match) {
    throw new Error(`Unknown property "${key}" on thing ${thingId} (checked variable_name + name)`);
  }

  const url = `${API_BASE}/v2/things/${thingId}/properties/${match.id}/publish`;
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      ...orgHeaders(token),               // FIX: include X-Organization
      "content-type": "application/json",
    },
    body: JSON.stringify({ value }),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Publish failed (${thingId}.${key}): ${res.status} ${txt}`);
  }
  return { ok: true };
}


// ---- Decision logic (surplus/low light + queen) ----
function computeGlobal(beesStates) {
  const values = beesStates
    .map((b) => b.ldr_value)
    .filter((v) => typeof v === "number" && !Number.isNaN(v));

  const avg = values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;

  const LOW_LIGHT_THRESHOLD = 200;
  const lowLight = avg !== null ? avg < LOW_LIGHT_THRESHOLD : null;

  let queenThingId = null;
  let max = -Infinity;
  for (const b of beesStates) {
    if (typeof b.ldr_value === "number" && b.ldr_value > max) {
      max = b.ldr_value;
      queenThingId = b.thingId;
    }
  }

  return {
    avgLight: avg,
    lowLight,
    queenThingId,
    reason: queenThingId ? `queen=max_ldr(${max})` : "no_data",
  };
}

function makeOutputsForBee(global, thingId) {
  const isQueen = global.queenThingId === thingId;
  const isBlinking = global.lowLight === true;

  let led_count = 0;
  if (typeof global.avgLight === "number") {
    led_count = clampInt(Math.round((global.avgLight / 1023) * 12), 0, 12) ?? 0;
  }

  const ledcolor = isQueen ? true : false;

  // Servo range should be 0..180 (matches your Servo attach pulse range use)
  const servo_speed = isBlinking ? 140 : 40;

  const youAreTheQueen = isQueen;

  return { isBlinking, led_count, ledcolor, servo_speed, youAreTheQueen };
}

// ---- Sync loop (poll -> compute -> write) ----
async function syncOnce() {
  const beesStates = [];

  for (const thingId of THING_IDS) {
    try {
      const s = await readState(thingId);
      const ldr = typeof s.ldr_value === "number" ? s.ldr_value : Number(s.ldr_value);

      mem.bees[thingId].lastSeen = new Date().toISOString();
      mem.bees[thingId].ldr_value = Number.isFinite(ldr) ? ldr : mem.bees[thingId].ldr_value;
      mem.bees[thingId].lastCloudState = s;
      mem.bees[thingId].lastError = null;

      beesStates.push({ thingId, ldr_value: mem.bees[thingId].ldr_value });
    } catch (e) {
      mem.bees[thingId].lastError = String(e.message ?? e);
    }
  }

  const global = computeGlobal(beesStates);
  mem.global = { ...global, updatedAt: new Date().toISOString() };

  for (const thingId of THING_IDS) {
    try {
      const out = makeOutputsForBee(global, thingId);

      // FIX: publish by "key" which matches variable_name (youAreTheQueen will work)
      for (const [k, v] of Object.entries(out)) {
        await publishByKey(thingId, k, v);
      }

      mem.bees[thingId].lastWriteOk = new Date().toISOString();
    } catch (e) {
      mem.bees[thingId].lastError = String(e.message ?? e);
    }
  }

  mem.lastSync = { at: new Date().toISOString(), ok: true, error: null };
  return mem;
}

let loopTimer = null;
function startLoop() {
  if (loopTimer) return;
  loopTimer = setInterval(() => {
    syncOnce().catch((e) => {
      mem.lastSync = { at: new Date().toISOString(), ok: false, error: String(e.message ?? e) };
    });
  }, POLL_MS);
}

function stopLoop() {
  if (loopTimer) clearInterval(loopTimer);
  loopTimer = null;
}

// ---- Routes ----
app.get("/", (req, res) => res.send("Queens mothership is running"));

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    time: new Date().toISOString(),
    things: THING_IDS,
    hasCredentials: hasCredentials(),
    hasSpace: hasSpace(),
    pollingMs: POLL_MS,
    polling: Boolean(loopTimer),
  });
});

app.get("/state", (_req, res) => {
  const now = Date.now();
  const bees = {};
  for (const [thingId, b] of Object.entries(mem.bees)) {
    const lastSeenMs = b.lastSeen ? Date.parse(b.lastSeen) : 0;
    bees[thingId] = {
      ...b,
      online: lastSeenMs ? now - lastSeenMs < 10_000 : false,
    };
  }
  res.json({ ...mem, bees });
});

app.post("/sync", async (_req, res) => {
  try {
    const out = await syncOnce();
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: String(e.message ?? e) });
  }
});

app.patch("/bee/:thingId", async (req, res) => {
  const { thingId } = req.params;
  if (!THING_IDS.includes(thingId)) {
    return res.status(404).json({ error: "Unknown thingId (not in THING_IDS env var)" });
  }

  const updates = req.body ?? {};
  if ("ldr_value" in updates) {
    return res.status(400).json({ error: "ldr_value is read-only" });
  }

  if ("led_count" in updates) {
    const v = clampInt(updates.led_count, 0, 12);
    if (v === null) return res.status(400).json({ error: "led_count must be int (0–12)" });
    updates.led_count = v;
  }
  if ("servo_speed" in updates) {
    const v = clampInt(updates.servo_speed, 0, 180);
    if (v === null) return res.status(400).json({ error: "servo_speed must be int (0–180)" });
    updates.servo_speed = v;
  }

  try {
    for (const [k, v] of Object.entries(updates)) {
      await publishByKey(thingId, k, v);
    }
    res.json({ ok: true, thingId, updates });
  } catch (e) {
    res.status(502).json({ error: String(e.message ?? e) });
  }
});

app.post("/polling/start", (_req, res) => {
  startLoop();
  res.json({ ok: true, polling: true });
});
app.post("/polling/stop", (_req, res) => {
  stopLoop();
  res.json({ ok: true, polling: false });
});

app.listen(PORT, () => {
  console.log(`Mothership listening on port ${PORT}`);
  startLoop();
});