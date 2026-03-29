import { useState, useEffect, useCallback, useRef } from "react";

// ── Push Notification Helpers ────────────────────────────────
async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return null;
  try {
    const reg = await navigator.serviceWorker.register("/sw.js");
    console.log("[SW] Registered");
    return reg;
  } catch (e) {
    console.error("[SW] Registration failed:", e);
    return null;
  }
}

async function subscribeToPush(reg) {
  if (!("PushManager" in window)) return null;
  try {
    // Get VAPID key from server
    const resp = await fetch("/api/vapid-public-key");
    const { key } = await resp.json();
    const vapidKey = urlBase64ToUint8Array(key);

    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: vapidKey,
      });
    }
    return sub;
  } catch (e) {
    console.error("[Push] Subscribe failed:", e);
    return null;
  }
}

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

// ── App ────────────────────────────────────────────
export default function App() {
  const [status, setStatus] = useState(null);
  const [history, setHistory] = useState([]);
  const [userName, setUserName] = useState(() => localStorage.getItem("dogmed-name") || "");
  const [showSetup, setShowSetup] = useState(false);
  const [pushEnabled, setPushEnabled] = useState(false);
  const [pushSupported] = useState("PushManager" in window && "serviceWorker" in navigator);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState(null);
  const [nameInput, setNameInput] = useState("");
  const [drugConfig, setDrugConfig] = useState(null);
  const [configSaving, setConfigSaving] = useState(false);
  const pollRef = useRef(null);
  const swRegRef = useRef(null);

  // Fetch status from relay server
  const fetchStatus = useCallback(async () => {
    try {
      const [statusResp, historyResp] = await Promise.all([
        fetch("/api/status"),
        fetch("/api/history"),
      ]);
      if (statusResp.ok) {
        setStatus(await statusResp.json());
        setError(null);
      }
      if (historyResp.ok) setHistory(await historyResp.json());
    } catch (e) {
      setError("Can't reach server");
    }
  }, []);

  // Register SW + setup polling
  useEffect(() => {
    fetchStatus();
    pollRef.current = setInterval(fetchStatus, 10000);

    registerServiceWorker().then((reg) => {
      swRegRef.current = reg;
      if (reg) {
        reg.pushManager.getSubscription().then((sub) => {
          if (sub) setPushEnabled(true);
        });
      }
    });

    fetch("/api/drug-config")
      .then((r) => r.json())
      .then(setDrugConfig)
      .catch(() => {});

    // Show setup if no name saved
    if (!userName) setShowSetup(true);

    return () => clearInterval(pollRef.current);
  }, [fetchStatus, userName]);

  const handleSaveDrugConfig = async () => {
    if (!drugConfig) return;
    setConfigSaving(true);
    try {
      const resp = await fetch("/api/drug-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(drugConfig),
      });
      if (!resp.ok) {
        const { error } = await resp.json();
        setError(error || "Failed to save config");
      }
    } catch {
      setError("Failed to save config");
    }
    setConfigSaving(false);
  };

  const updateDoseTime = (index, time) => {
    setDrugConfig((c) => {
      const doses = [...c.doses];
      doses[index] = { time };
      return { ...c, doses };
    });
  };

  const addDose = () => {
    setDrugConfig((c) => ({ ...c, doses: [...c.doses, { time: "08:00" }] }));
  };

  const removeDose = (index) => {
    setDrugConfig((c) => ({ ...c, doses: c.doses.filter((_, i) => i !== index) }));
  };

  const handleEnablePush = async () => {
    if (!swRegRef.current) return;
    const permission = await Notification.requestPermission();
    if (permission !== "granted") return;

    const sub = await subscribeToPush(swRegRef.current);
    if (sub) {
      await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subscription: sub.toJSON(), name: userName || "Unknown" }),
      });
      setPushEnabled(true);
    }
  };

  const handleConfirm = async () => {
    if (confirming) return;
    setConfirming(true);
    try {
      const resp = await fetch("/api/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: userName || "Web App" }),
      });
      if (resp.ok) {
        await fetchStatus();
      }
    } catch (e) {
      setError("Confirm failed");
    }
    setConfirming(false);
  };

  const handleSaveName = () => {
    const n = nameInput.trim();
    if (!n) return;
    setUserName(n);
    localStorage.setItem("dogmed-name", n);
    setShowSetup(false);
  };

  const formatTime = (dtStr) => {
    if (!dtStr || dtStr.startsWith("2000")) return "";
    try {
      const d = new Date(dtStr.includes("T") ? dtStr : dtStr.replace(" ", "T"));
      return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    } catch {
      return dtStr;
    }
  };

  const formatDate = (dateStr) => {
    try {
      const d = new Date(dateStr + "T12:00:00");
      return d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
    } catch {
      return dateStr;
    }
  };

  const isGiven = status?.given;
  const todayStr = new Date().toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });

  return (
    <div style={s.wrapper}>
      {/* Header */}
      <header style={s.header}>
        <div style={s.headerLeft}>
          <span style={s.headerIcon}>🐕</span>
          <span style={s.headerTitle}>Med Tracker</span>
        </div>
        <button style={s.gearBtn} onClick={() => setShowSetup((v) => !v)}>
          ⚙
        </button>
      </header>

      {/* Setup panel */}
      {showSetup && (
        <div style={s.setupPanel}>
          <h3 style={s.setupTitle}>Setup</h3>
          <label style={s.label}>Your Name</label>
          <input
            style={s.input}
            value={nameInput || userName}
            onChange={(e) => setNameInput(e.target.value)}
            placeholder="Michael"
          />
          <button style={s.saveBtn} onClick={handleSaveName}>
            Save
          </button>

          <div style={s.pushSection}>
            <label style={s.label}>Push Notifications</label>
            {!pushSupported ? (
              <p style={s.pushNote}>Push not supported in this browser</p>
            ) : pushEnabled ? (
              <p style={s.pushEnabled}>✅ Push notifications enabled</p>
            ) : (
              <button style={s.pushBtn} onClick={handleEnablePush}>
                Enable Push Notifications
              </button>
            )}
          </div>

          {status?.haConnected !== undefined && (
            <p style={s.connStatus}>
              HA Connection: {status.haConnected ? "🟢 Connected" : "🔴 Disconnected"}
            </p>
          )}

          {drugConfig && (
            <div style={s.doseSection}>
              <label style={s.label}>Doses per Day</label>
              {drugConfig.doses.map((dose, i) => (
                <div key={i} style={s.doseRow}>
                  <span style={s.doseLabel}>Dose {i + 1}</span>
                  <input
                    type="time"
                    style={s.timeInput}
                    value={dose.time}
                    onChange={(e) => updateDoseTime(i, e.target.value)}
                  />
                  {drugConfig.doses.length > 1 && (
                    <button style={s.removeBtn} onClick={() => removeDose(i)}>✕</button>
                  )}
                </div>
              ))}
              <button style={s.addDoseBtn} onClick={addDose}>+ Add Dose</button>

              <label style={{ ...s.label, marginTop: 16 }}>Escalation Time</label>
              <input
                type="time"
                style={s.timeInput}
                value={drugConfig.escalationTime || ""}
                onChange={(e) => setDrugConfig((c) => ({ ...c, escalationTime: e.target.value }))}
              />

              <button
                style={{ ...s.saveBtn, marginTop: 16, opacity: configSaving ? 0.6 : 1 }}
                onClick={handleSaveDrugConfig}
                disabled={configSaving}
              >
                {configSaving ? "Saving..." : "Save Schedule"}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Error bar */}
      {error && <div style={s.errorBar}>⚠ {error}</div>}

      {/* Main */}
      <main style={s.main}>
        <p style={s.dateText}>{todayStr}</p>

        {/* Status card */}
        <div
          style={{
            ...s.statusCard,
            background: isGiven
              ? "linear-gradient(135deg, #2d6a4f, #40916c)"
              : "linear-gradient(135deg, #9d4b2a, #c86b3e)",
          }}
        >
          <div style={s.statusIcon}>{isGiven ? "✅" : "💊"}</div>

          <h2 style={s.statusText}>
            {status === null ? "Connecting..." : isGiven ? "Medication Given" : "Not Yet Given"}
          </h2>

          {isGiven && status.confirmedAt && !status.confirmedAt.startsWith("2000") && (
            <p style={s.statusSub}>
              {formatTime(status.confirmedAt)}
              {status.confirmedBy &&
                status.confirmedBy !== "unknown" &&
                status.confirmedBy !== "" &&
                ` · ${status.confirmedBy}`}
            </p>
          )}

          {!isGiven && status !== null && (
            <button
              style={{ ...s.confirmBtn, opacity: confirming ? 0.6 : 1 }}
              onClick={handleConfirm}
              disabled={confirming}
            >
              {confirming ? "Confirming..." : "Mark as Done"}
            </button>
          )}
        </div>

        {/* Push prompt */}
        {pushSupported && !pushEnabled && !showSetup && (
          <button style={s.pushPrompt} onClick={handleEnablePush}>
            🔔 Tap to enable push notifications
          </button>
        )}

        {/* History */}
        {history.length > 0 && (
          <div style={s.historySection}>
            <h3 style={s.historyTitle}>Recent History</h3>
            {history.slice(0, 7).map((entry, i) => (
              <div key={entry.date} style={{ ...s.historyRow, opacity: 1 - i * 0.08 }}>
                <span style={s.historyDot}>●</span>
                <div style={s.historyInfo}>
                  <span style={s.historyDate}>{formatDate(entry.date)}</span>
                  <span style={s.historyMeta}>
                    {formatTime(entry.time)}
                    {entry.by && entry.by !== "Unknown" && ` · ${entry.by}`}
                  </span>
                </div>
                <span style={{ color: "#40916c" }}>✓</span>
              </div>
            ))}
          </div>
        )}

        {/* Streak */}
        {history.length >= 2 && (
          <div style={s.streakCard}>
            <span style={s.streakNum}>{history.length}</span>
            <span style={s.streakLabel}>days tracked</span>
          </div>
        )}
      </main>

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;500;700&family=Fraunces:opsz,wght@9..144,600;9..144,800&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: #1a1410; }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes pulse { 0%,100% { transform: scale(1); } 50% { transform: scale(1.05); } }
      `}</style>
    </div>
  );
}

// ── Styles ───────────────────────────────────────────
const s = {
  wrapper: {
    minHeight: "100vh",
    background: "#1a1410",
    color: "#f0e6d8",
    fontFamily: "'DM Sans', sans-serif",
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "16px 20px",
    borderBottom: "1px solid rgba(240,230,216,0.08)",
  },
  headerLeft: { display: "flex", alignItems: "center", gap: 10 },
  headerIcon: { fontSize: 24 },
  headerTitle: { fontFamily: "'Fraunces', serif", fontSize: 22, fontWeight: 800, letterSpacing: "-0.02em" },
  gearBtn: {
    background: "none",
    border: "none",
    color: "rgba(240,230,216,0.5)",
    fontSize: 20,
    cursor: "pointer",
    padding: 8,
  },
  setupPanel: {
    padding: 20,
    borderBottom: "1px solid rgba(240,230,216,0.08)",
    background: "rgba(30,24,18,0.95)",
    animation: "fadeIn 0.3s ease",
  },
  setupTitle: { fontFamily: "'Fraunces', serif", fontSize: 16, fontWeight: 600, color: "#c0845a", marginBottom: 12 },
  label: {
    display: "block",
    fontSize: 11,
    fontWeight: 500,
    color: "rgba(240,230,216,0.45)",
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    marginBottom: 4,
    marginTop: 12,
  },
  input: {
    width: "100%",
    padding: "10px 12px",
    background: "rgba(240,230,216,0.06)",
    border: "1px solid rgba(240,230,216,0.12)",
    borderRadius: 8,
    color: "#f0e6d8",
    fontSize: 14,
    fontFamily: "'DM Sans', sans-serif",
    outline: "none",
  },
  saveBtn: {
    marginTop: 14,
    padding: "10px 28px",
    background: "#c0845a",
    color: "#1a1410",
    border: "none",
    borderRadius: 8,
    fontSize: 14,
    fontWeight: 700,
    cursor: "pointer",
    fontFamily: "'DM Sans', sans-serif",
  },
  pushSection: { marginTop: 20 },
  pushNote: { fontSize: 13, color: "rgba(240,230,216,0.35)", marginTop: 4 },
  pushEnabled: { fontSize: 13, color: "#40916c", marginTop: 4 },
  pushBtn: {
    marginTop: 6,
    padding: "10px 20px",
    background: "rgba(240,230,216,0.08)",
    color: "#f0e6d8",
    border: "1px solid rgba(240,230,216,0.15)",
    borderRadius: 8,
    fontSize: 13,
    cursor: "pointer",
    fontFamily: "'DM Sans', sans-serif",
  },
  connStatus: { fontSize: 12, color: "rgba(240,230,216,0.4)", marginTop: 16 },
  errorBar: {
    padding: "10px 20px",
    background: "rgba(180,60,40,0.2)",
    borderBottom: "1px solid rgba(180,60,40,0.3)",
    color: "#f0a090",
    fontSize: 14,
  },
  main: {
    padding: "24px 20px 40px",
    maxWidth: 440,
    margin: "0 auto",
    animation: "fadeIn 0.5s ease",
  },
  dateText: {
    fontSize: 13,
    color: "rgba(240,230,216,0.4)",
    fontWeight: 500,
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    marginBottom: 20,
  },
  statusCard: {
    borderRadius: 20,
    padding: "36px 24px",
    textAlign: "center",
    transition: "background 0.5s ease",
  },
  statusIcon: { fontSize: 48, marginBottom: 12 },
  statusText: {
    fontFamily: "'Fraunces', serif",
    fontSize: 26,
    fontWeight: 800,
    letterSpacing: "-0.02em",
    color: "#fff",
    marginBottom: 8,
  },
  statusSub: { fontSize: 14, color: "rgba(255,255,255,0.7)" },
  confirmBtn: {
    marginTop: 24,
    padding: "14px 40px",
    background: "rgba(255,255,255,0.95)",
    color: "#6b3a1f",
    border: "none",
    borderRadius: 12,
    fontSize: 16,
    fontWeight: 700,
    cursor: "pointer",
    fontFamily: "'DM Sans', sans-serif",
    transition: "opacity 0.2s",
  },
  pushPrompt: {
    width: "100%",
    marginTop: 16,
    padding: "14px",
    background: "rgba(192,132,90,0.1)",
    color: "#c0845a",
    border: "1px solid rgba(192,132,90,0.2)",
    borderRadius: 12,
    fontSize: 14,
    fontWeight: 500,
    cursor: "pointer",
    fontFamily: "'DM Sans', sans-serif",
    animation: "pulse 3s infinite",
  },
  historySection: { marginTop: 32 },
  historyTitle: {
    fontFamily: "'Fraunces', serif",
    fontSize: 16,
    fontWeight: 600,
    color: "rgba(240,230,216,0.45)",
    marginBottom: 14,
  },
  historyRow: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "10px 14px",
    background: "rgba(240,230,216,0.04)",
    borderRadius: 10,
    marginBottom: 6,
    color: "rgba(240,230,216,0.7)",
  },
  historyDot: { color: "#40916c", fontSize: 8 },
  historyInfo: { flex: 1, display: "flex", flexDirection: "column", gap: 2 },
  historyDate: { fontSize: 14, fontWeight: 500 },
  historyMeta: { fontSize: 12, color: "rgba(240,230,216,0.35)" },
  streakCard: {
    marginTop: 24,
    padding: 20,
    background: "rgba(192,132,90,0.08)",
    borderRadius: 14,
    border: "1px solid rgba(192,132,90,0.15)",
    display: "flex",
    alignItems: "baseline",
    gap: 8,
    justifyContent: "center",
  },
  streakNum: { fontFamily: "'Fraunces', serif", fontSize: 32, fontWeight: 800, color: "#c0845a" },
  streakLabel: { fontSize: 14, color: "rgba(240,230,216,0.4)" },
  doseSection: { marginTop: 20 },
  doseRow: { display: "flex", alignItems: "center", gap: 10, marginBottom: 8 },
  doseLabel: { fontSize: 13, color: "rgba(240,230,216,0.5)", width: 52, flexShrink: 0 },
  timeInput: {
    flex: 1,
    padding: "8px 10px",
    background: "rgba(240,230,216,0.06)",
    border: "1px solid rgba(240,230,216,0.12)",
    borderRadius: 8,
    color: "#f0e6d8",
    fontSize: 14,
    fontFamily: "'DM Sans', sans-serif",
    outline: "none",
  },
  removeBtn: {
    background: "none",
    border: "none",
    color: "rgba(240,230,216,0.35)",
    fontSize: 14,
    cursor: "pointer",
    padding: "4px 6px",
  },
  addDoseBtn: {
    marginTop: 4,
    padding: "8px 16px",
    background: "rgba(240,230,216,0.06)",
    color: "rgba(240,230,216,0.6)",
    border: "1px solid rgba(240,230,216,0.12)",
    borderRadius: 8,
    fontSize: 13,
    cursor: "pointer",
    fontFamily: "'DM Sans', sans-serif",
  },
};
