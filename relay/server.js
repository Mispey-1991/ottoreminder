require("dotenv").config();
const express = require("express");
const path = require("path");
const fs = require("fs");
const WebSocket = require("ws");
const webPush = require("web-push");
const cron = require("node-cron");

// ── Config ───────────────────────────────────────────
const {
  HA_URL,
  HA_TOKEN,
  VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY,
  VAPID_EMAIL = "admin@example.com",
  PORT = 3000,
  // Deprecated: use drug-config.json instead
  REMINDER_TIMES,
  ESCALATION_TIME,
} = process.env;

if (!HA_URL || !HA_TOKEN) {
  console.error("ERROR: HA_URL and HA_TOKEN are required");
  process.exit(1);
}

if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
  console.error("ERROR: VAPID keys required. Run: npx web-push generate-vapid-keys");
  process.exit(1);
}

webPush.setVapidDetails(`mailto:${VAPID_EMAIL}`, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

// ── Subscription Storage ─────────────────────────────────
const SUBS_FILE = path.join(__dirname, "data", "subscriptions.json");
const HISTORY_FILE = path.join(__dirname, "data", "history.json");
const DRUG_CONFIG_FILE = path.join(__dirname, "data", "drug-config.json");

function loadJSON(filepath, fallback = []) {
  try {
    if (fs.existsSync(filepath)) return JSON.parse(fs.readFileSync(filepath, "utf8"));
  } catch (e) {
    console.error(`Error loading ${filepath}:`, e.message);
  }
  return fallback;
}

function saveJSON(filepath, data) {
  try {
    fs.mkdirSync(path.dirname(filepath), { recursive: true });
    fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error(`Error saving ${filepath}:`, e.message);
  }
}

let subscriptions = loadJSON(SUBS_FILE, []);
let history = loadJSON(HISTORY_FILE, []);

// ── Drug Config ──────────────────────────────────────
const DEFAULT_DRUG_CONFIG = {
  doses: [{ time: "08:00" }, { time: "12:00" }, { time: "17:00" }],
  escalationTime: "20:00",
};

function loadDrugConfig() {
  const saved = loadJSON(DRUG_CONFIG_FILE, null);
  if (saved) return saved;
  // Backward compat: migrate from deprecated env vars
  if (REMINDER_TIMES) {
    console.log("[Config] Migrating REMINDER_TIMES/ESCALATION_TIME env vars to drug-config.json");
    const config = {
      doses: REMINDER_TIMES.split(",").map((t) => ({ time: t.trim() })),
      escalationTime: ESCALATION_TIME || "20:00",
    };
    saveJSON(DRUG_CONFIG_FILE, config);
    return config;
  }
  return DEFAULT_DRUG_CONFIG;
}

let drugConfig = loadDrugConfig();
let scheduledTasks = [];

function scheduleCrons(config) {
  scheduledTasks.forEach((t) => t.destroy());
  scheduledTasks = [];

  for (const dose of config.doses) {
    const [hour, minute] = dose.time.split(":");
    const expr = `${parseInt(minute)} ${parseInt(hour)} * * *`;
    const task = cron.schedule(expr, () => {
      if (!haState.given) {
        console.log(`[Reminder] ${dose.time} — medication not given, sending push`);
        sendPushToAll({
          title: "🐕 Dog Medication Reminder",
          body: "Has the dog had his medication today?",
          tag: "dog-medication",
          data: { type: "reminder", actions: ["confirm", "snooze"] },
        });
      } else {
        console.log(`[Reminder] ${dose.time} — medication already given, skipping`);
      }
    });
    scheduledTasks.push(task);
    console.log(`[Cron] Reminder scheduled for ${dose.time}`);
  }

  if (config.escalationTime) {
    const [eH, eM] = config.escalationTime.split(":");
    const task = cron.schedule(`${parseInt(eM)} ${parseInt(eH)} * * *`, () => {
      if (!haState.given) {
        console.log("[Escalation] Evening — medication STILL not given");
        sendPushToAll({
          title: "⚠️ Dog Medication NOT Given!",
          body: `It's ${config.escalationTime} and meds haven't been confirmed yet.`,
          tag: "dog-medication",
          data: { type: "escalation", actions: ["confirm"] },
        });
      }
    });
    scheduledTasks.push(task);
    console.log(`[Cron] Escalation scheduled for ${config.escalationTime}`);
  }
}

// ── HA State ─────────────────────────────────────────
let haState = {
  given: false,
  confirmedBy: "",
  confirmedAt: "",
};
let haConnected = false;
let wsMessageId = 1;
let ws = null;
let reconnectTimer = null;

// ── HA WebSocket Connection ──────────────────────────────
function connectHA() {
  if (reconnectTimer) clearTimeout(reconnectTimer);

  const wsUrl = HA_URL.replace(/^http/, "ws") + "/api/websocket";
  console.log(`[HA] Connecting to ${wsUrl}...`);

  ws = new WebSocket(wsUrl);

  ws.on("open", () => {
    console.log("[HA] WebSocket connected");
  });

  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    // Step 1: Auth required
    if (msg.type === "auth_required") {
      ws.send(JSON.stringify({ type: "auth", access_token: HA_TOKEN }));
    }

    // Step 2: Auth OK → subscribe to state changes
    if (msg.type === "auth_ok") {
      console.log("[HA] Authenticated");
      haConnected = true;

      // Subscribe to state_changed events
      ws.send(JSON.stringify({
        id: wsMessageId++,
        type: "subscribe_events",
        event_type: "state_changed",
      }));

      // Fetch initial states
      fetchInitialStates();
    }

    if (msg.type === "auth_invalid") {
      console.error("[HA] Auth failed:", msg.message);
      haConnected = false;
    }

    // Step 3: Handle state change events
    if (msg.type === "event" && msg.event?.event_type === "state_changed") {
      const { entity_id, new_state } = msg.event.data;
      handleStateChange(entity_id, new_state);
    }
  });

  ws.on("close", () => {
    console.log("[HA] WebSocket closed, reconnecting in 10s...");
    haConnected = false;
    reconnectTimer = setTimeout(connectHA, 10000);
  });

  ws.on("error", (err) => {
    console.error("[HA] WebSocket error:", err.message);
  });
}

async function fetchInitialStates() {
  try {
    const entities = [
      "input_boolean.dog_medication_given",
      "input_text.dog_medication_confirmed_by",
      "input_datetime.dog_medication_confirmed_at",
    ];
    for (const eid of entities) {
      ws.send(JSON.stringify({
        id: wsMessageId++,
        type: "get_states",
      }));
    }

    // Use REST API for initial fetch (simpler)
    const resp = await fetch(`${HA_URL}/api/states`, {
      headers: { Authorization: `Bearer ${HA_TOKEN}` },
    });
    const states = await resp.json();
    for (const s of states) {
      handleStateChange(s.entity_id, s);
    }
    console.log("[HA] Initial state loaded — medication given:", haState.given);
  } catch (e) {
    console.error("[HA] Failed to fetch initial states:", e.message);
  }
}

function handleStateChange(entityId, newState) {
  if (!newState) return;
  const val = newState.state;

  if (entityId === "input_boolean.dog_medication_given") {
    const wasGiven = haState.given;
    haState.given = val === "on";

    // Medication just confirmed
    if (!wasGiven && haState.given) {
      console.log("[HA] Medication marked as given!");
      sendPushToAll({
        title: "✅ Dog Medication Done",
        body: `Confirmed at ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`,
        tag: "dog-medication",
        data: { type: "confirmed" },
      });
      // Add to history
      const today = new Date().toISOString().split("T")[0];
      if (!history.some((h) => h.date === today)) {
        history.unshift({
          date: today,
          time: new Date().toISOString(),
          by: haState.confirmedBy || "Unknown",
        });
        history = history.slice(0, 90);
        saveJSON(HISTORY_FILE, history);
      }
    }

    // Medication reset (new day)
    if (wasGiven && !haState.given) {
      console.log("[HA] Medication reset for new day");
    }
  }

  if (entityId === "input_text.dog_medication_confirmed_by") {
    haState.confirmedBy = val;
  }

  if (entityId === "input_datetime.dog_medication_confirmed_at") {
    haState.confirmedAt = val;
  }
}

// ── Web Push ─────────────────────────────────────────
async function sendPushToAll(payload) {
  const dead = [];

  for (let i = 0; i < subscriptions.length; i++) {
    try {
      await webPush.sendNotification(
        subscriptions[i].subscription,
        JSON.stringify(payload)
      );
    } catch (err) {
      console.error(`[Push] Failed for sub ${i}:`, err.statusCode || err.message);
      if (err.statusCode === 404 || err.statusCode === 410) {
        dead.push(i);
      }
    }
  }

  // Remove dead subscriptions
  if (dead.length > 0) {
    subscriptions = subscriptions.filter((_, i) => !dead.includes(i));
    saveJSON(SUBS_FILE, subscriptions);
    console.log(`[Push] Removed ${dead.length} expired subscriptions`);
  }
}

// ── Scheduled Reminders ──────────────────────────────────
scheduleCrons(drugConfig);

// ── Express Server ───────────────────────────────────────
const app = express();
app.use(express.json());

// Serve PWA static files
app.use(express.static(path.join(__dirname, "public")));

// API: Health check
app.get("/api/health", (req, res) => {
  res.json({ ok: true, haConnected, medicationGiven: haState.given });
});

// API: Get current status
app.get("/api/status", (req, res) => {
  res.json({
    given: haState.given,
    confirmedBy: haState.confirmedBy,
    confirmedAt: haState.confirmedAt,
    haConnected,
  });
});

// API: Get history
app.get("/api/history", (req, res) => {
  res.json(history);
});

// API: VAPID public key (for push subscription)
app.get("/api/vapid-public-key", (req, res) => {
  res.json({ key: VAPID_PUBLIC_KEY });
});

// API: Subscribe to push
app.post("/api/push/subscribe", (req, res) => {
  const { subscription, name } = req.body;
  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ error: "Invalid subscription" });
  }

  // Check if already subscribed
  const exists = subscriptions.some((s) => s.subscription.endpoint === subscription.endpoint);
  if (!exists) {
    subscriptions.push({
      subscription,
      name: name || "Unknown",
      subscribedAt: new Date().toISOString(),
    });
    saveJSON(SUBS_FILE, subscriptions);
    console.log(`[Push] New subscription from ${name || "Unknown"}`);
  }

  res.json({ ok: true });
});

// API: Unsubscribe
app.post("/api/push/unsubscribe", (req, res) => {
  const { endpoint } = req.body;
  subscriptions = subscriptions.filter((s) => s.subscription.endpoint !== endpoint);
  saveJSON(SUBS_FILE, subscriptions);
  res.json({ ok: true });
});

// API: Get drug config
app.get("/api/drug-config", (req, res) => {
  res.json(drugConfig);
});

// API: Save drug config
app.post("/api/drug-config", (req, res) => {
  const { doses, escalationTime } = req.body;
  if (!Array.isArray(doses) || doses.length === 0) {
    return res.status(400).json({ error: "doses must be a non-empty array" });
  }
  for (const d of doses) {
    if (!/^\d{2}:\d{2}$/.test(d.time)) {
      return res.status(400).json({ error: `Invalid time format: ${d.time}` });
    }
  }
  drugConfig = { doses, escalationTime: escalationTime || null };
  saveJSON(DRUG_CONFIG_FILE, drugConfig);
  scheduleCrons(drugConfig);
  console.log("[Config] Drug config updated:", JSON.stringify(drugConfig));
  res.json({ ok: true });
});

// API: Confirm medication (from PWA)
app.post("/api/confirm", async (req, res) => {
  const { name } = req.body;
  try {
    const headers = {
      Authorization: `Bearer ${HA_TOKEN}`,
      "Content-Type": "application/json",
    };

    await fetch(`${HA_URL}/api/services/input_boolean/turn_on`, {
      method: "POST",
      headers,
      body: JSON.stringify({ entity_id: "input_boolean.dog_medication_given" }),
    });

    await fetch(`${HA_URL}/api/services/input_text/set_value`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        entity_id: "input_text.dog_medication_confirmed_by",
        value: name || "Web App",
      }),
    });

    const now = new Date();
    const dtStr = now.toISOString().slice(0, 19).replace("T", " ");
    await fetch(`${HA_URL}/api/services/input_datetime/set_datetime`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        entity_id: "input_datetime.dog_medication_confirmed_at",
        datetime: dtStr,
      }),
    });

    res.json({ ok: true });
  } catch (e) {
    console.error("[API] Confirm failed:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// SPA fallback
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`[Server] Running on port ${PORT}`);
  connectHA();
});
