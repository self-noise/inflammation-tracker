/* Entry form logic, view switching, and offline queue management.
 *
 * Storage model:
 *   localStorage["settings"] -> JSON { email, password, path, proxy }
 *   localStorage["queue"]    -> JSON array of pending entries
 *
 * Queue strategy: every submit goes into the queue first, then we
 * attempt to drain. This means a successful sync and an offline submit
 * follow the same code path — the queue is the single source of truth
 * for "what hasn't reached Koofr yet". A drain only removes an entry
 * after the server confirms.
 *
 * Each entry carries a stable entry_id (UUID v4) and a write_timestamp
 * captured at the moment the user tapped Save (not when the sync
 * eventually fires). These are generated in readEntry() so they survive
 * offline queueing and are written into the per-entry CSV file on Koofr.
 */

// Ordered as L/R pairs by body region so a 2-column grid with default
// row-flow renders all "left" items in column 1 and "right" in column 2.
const LOCATIONS = [
  "Left ring finger",
  "Right ring finger",
  "Left middle finger",
  "Right middle finger",
  "Left wrist",
  "Right wrist",
  "Left elbow",
  "Right elbow",
  "Left knee",
  "Right knee",
];

const DEFAULT_SETTINGS = {
  email: "",
  password: "",
  path: "/inflammation/log.csv",
  proxy: "",
};

/* ---- settings + queue ---- */

function loadSettings() {
  try {
    const raw = localStorage.getItem("settings");
    if (!raw) return { ...DEFAULT_SETTINGS };
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}
function saveSettings(s) {
  localStorage.setItem("settings", JSON.stringify(s));
}
function loadQueue() {
  try {
    return JSON.parse(localStorage.getItem("queue") || "[]");
  } catch {
    return [];
  }
}
function saveQueue(q) {
  localStorage.setItem("queue", JSON.stringify(q));
}

function settingsReady(s) {
  return !!(s.email && s.password && s.path);
}

/* ---- DOM refs ---- */

const $ = (sel) => document.querySelector(sel);
const els = {
  viewEntry: $("#view-entry"),
  viewSettings: $("#view-settings"),
  title: $("#view-title"),
  navSettings: $("#nav-settings"),
  navEntry: $("#nav-entry"),
  queueBadge: $("#queue-badge"),
  queueCount: $("#queue-count"),

  // entry form
  form: $("#entry-form"),
  fDate: $("#f-date"),
  fTime: $("#f-time"),
  fScore: $("#f-score"),
  fDiet: $("#f-diet"),
  fOther: $("#f-other"),
  fMtx: $("#f-mtx"),
  fLocOtherCb: $("#f-loc-other-cb"),
  fLocOtherText: $("#f-loc-other-text"),
  ragButtons: document.querySelectorAll(".rag-btn"),
  locGrid: $("#loc-grid"),
  submitBtn: $("#submit-btn"),
  entryStatus: $("#entry-status"),

  // settings form
  settingsForm: $("#settings-form"),
  sEmail: $("#s-email"),
  sPassword: $("#s-password"),
  sPath: $("#s-path"),
  sProxy: $("#s-proxy"),
  testBtn: $("#test-btn"),
  resyncBtn: $("#resync-btn"),
  settingsStatus: $("#settings-status"),
};

/* ---- UI helpers ---- */

function showStatus(el, msg, kind) {
  el.textContent = msg;
  el.className = "status " + (kind || "info");
  el.classList.remove("hidden");
}
function clearStatus(el) {
  el.classList.add("hidden");
  el.textContent = "";
}

function updateQueueBadge() {
  const n = loadQueue().length;
  els.queueCount.textContent = n;
  if (n > 0) {
    els.queueBadge.textContent = n;
    els.queueBadge.classList.remove("hidden");
  } else {
    els.queueBadge.classList.add("hidden");
  }
}

function showView(name) {
  if (name === "settings") {
    els.viewEntry.classList.add("hidden");
    els.viewSettings.classList.remove("hidden");
    els.title.textContent = "Settings";
    els.navSettings.classList.add("hidden");
    els.navEntry.classList.remove("hidden");
  } else {
    els.viewSettings.classList.add("hidden");
    els.viewEntry.classList.remove("hidden");
    els.title.textContent = "My inflammation tracker";
    els.navSettings.classList.remove("hidden");
    els.navEntry.classList.add("hidden");
  }
}

/* ---- entry form ---- */

function buildLocationGrid() {
  els.locGrid.innerHTML = "";
  LOCATIONS.forEach((label, i) => {
    const id = "loc-" + i;
    const wrap = document.createElement("label");
    wrap.className = "loc-item";
    wrap.innerHTML =
      '<input type="checkbox" id="' + id + '" value="' + label + '">' +
      '<span>' + label + '</span>';
    const cb = wrap.querySelector("input");
    cb.addEventListener("change", () => {
      wrap.classList.toggle("checked", cb.checked);
    });
    els.locGrid.appendChild(wrap);
  });
}

function setScore(score) {
  els.fScore.value = score;
  els.ragButtons.forEach((btn) => {
    const isThis = btn.dataset.score === String(score);
    btn.setAttribute("aria-checked", isThis ? "true" : "false");
  });
}

function fillDateTime() {
  const now = new Date();
  // Use local timezone, not UTC, so the displayed date matches the user.
  const pad = (n) => String(n).padStart(2, "0");
  els.fDate.value = now.getFullYear() + "-" + pad(now.getMonth() + 1) + "-" + pad(now.getDate());
  els.fTime.value = pad(now.getHours()) + ":" + pad(now.getMinutes());
}

function generateEntryId() {
  // crypto.randomUUID is supported in modern browsers (incl. iOS Safari 15.4+).
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Fallback: 32 hex chars from crypto.getRandomValues, formatted as UUID v4.
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0"));
  return h.slice(0, 4).join("") + "-" + h.slice(4, 6).join("") + "-"
       + h.slice(6, 8).join("") + "-" + h.slice(8, 10).join("") + "-"
       + h.slice(10, 16).join("");
}

function nowIsoLocal() {
  // ISO 8601 with the device's local timezone offset, e.g.
  // "2026-05-18T15:30:22+01:00". Pandas / Excel both parse this happily.
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const tz = -d.getTimezoneOffset();
  const sign = tz >= 0 ? "+" : "-";
  const oh = pad(Math.floor(Math.abs(tz) / 60));
  const om = pad(Math.abs(tz) % 60);
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate())
       + "T" + pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds())
       + sign + oh + ":" + om;
}

function readEntry() {
  const checked = Array.from(els.locGrid.querySelectorAll("input:checked"))
    .map((i) => i.value.toLowerCase()); // store lowercase to match spec example
  // Include the user's free-text "Other" location if both tickbox is on
  // and the text field is non-empty. Strip pipes to keep the CSV's
  // pipe-delimited locations field unambiguous.
  if (els.fLocOtherCb.checked) {
    const extra = els.fLocOtherText.value.trim().toLowerCase().replace(/\|/g, " ");
    if (extra) checked.push(extra);
  }
  return {
    entry_id: generateEntryId(),
    write_timestamp: nowIsoLocal(),
    date: els.fDate.value,
    time: els.fTime.value,
    score: parseInt(els.fScore.value, 10),
    locations: checked,
    dietary_notes: els.fDiet.value.trim(),
    other_notes: els.fOther.value.trim(),
    methotrexate: els.fMtx.checked ? 1 : 0,
  };
}

function resetEntryForm() {
  fillDateTime();
  setScore(null);
  els.fScore.value = "";
  els.ragButtons.forEach((b) => b.setAttribute("aria-checked", "false"));
  els.locGrid.querySelectorAll("input").forEach((cb) => {
    cb.checked = false;
    cb.closest(".loc-item").classList.remove("checked");
  });
  els.fDiet.value = "";
  els.fOther.value = "";
  els.fMtx.checked = false;
  els.fMtx.closest(".checkbox-row").classList.remove("checked");
  els.fLocOtherCb.checked = false;
  els.fLocOtherText.value = "";
  els.fLocOtherCb.closest(".loc-other").classList.remove("checked");
}

/* ---- sync orchestration ---- */

async function drainQueue(silent) {
  // Try to upload every queued entry in order. Stops at the first failure
  // so we don't hammer a broken endpoint. Returns { sent, failed, error? }.
  const settings = loadSettings();
  if (!settingsReady(settings)) {
    return { sent: 0, failed: 0, error: "Settings not configured" };
  }
  const queue = loadQueue();
  let sent = 0;
  while (queue.length > 0) {
    const entry = queue[0];
    try {
      await window.SyncAPI.writeEntry(settings, entry);
      queue.shift();
      saveQueue(queue);
      sent++;
    } catch (e) {
      saveQueue(queue);
      updateQueueBadge();
      return { sent, failed: queue.length, error: e.message };
    }
  }
  updateQueueBadge();
  return { sent, failed: 0 };
}

async function submitEntry(e) {
  e.preventDefault();
  clearStatus(els.entryStatus);

  if (!els.fScore.value) {
    showStatus(els.entryStatus, "Please pick a RAG score.", "error");
    return;
  }

  const entry = readEntry();
  const queue = loadQueue();
  queue.push(entry);
  saveQueue(queue);
  updateQueueBadge();

  els.submitBtn.disabled = true;
  els.submitBtn.textContent = "Saving...";

  const result = await drainQueue();

  els.submitBtn.disabled = false;
  els.submitBtn.textContent = "Save entry";

  if (result.failed === 0) {
    showStatus(els.entryStatus, "Saved and synced.", "success");
    resetEntryForm();
  } else if (result.error && result.error.includes("not configured")) {
    showStatus(
      els.entryStatus,
      "Saved locally. Configure Koofr in settings to sync.",
      "info"
    );
    resetEntryForm();
  } else {
    showStatus(
      els.entryStatus,
      "Saved locally (sync failed: " + result.error + "). Will retry.",
      "info"
    );
    resetEntryForm();
  }
}

/* ---- settings form ---- */

function populateSettings() {
  const s = loadSettings();
  els.sEmail.value = s.email;
  els.sPassword.value = s.password;
  els.sPath.value = s.path;
  els.sProxy.value = s.proxy;
}

function readSettingsForm() {
  return {
    email: els.sEmail.value.trim(),
    password: els.sPassword.value,
    path: els.sPath.value.trim() || DEFAULT_SETTINGS.path,
    proxy: els.sProxy.value.trim(),
  };
}

async function saveSettingsAction(e) {
  e.preventDefault();
  const s = readSettingsForm();
  saveSettings(s);
  showStatus(els.settingsStatus, "Settings saved.", "success");
}

async function testConnection() {
  clearStatus(els.settingsStatus);
  const s = readSettingsForm();
  if (!settingsReady(s)) {
    showStatus(els.settingsStatus, "Please enter email, password, and path first.", "error");
    return;
  }
  els.testBtn.disabled = true;
  els.testBtn.textContent = "Testing...";
  try {
    await window.SyncAPI.testConnection(s);
    showStatus(els.settingsStatus, "Connection OK.", "success");
  } catch (err) {
    showStatus(
      els.settingsStatus,
      "Connection failed: " + window.SyncAPI.classifyError(err),
      "error"
    );
  } finally {
    els.testBtn.disabled = false;
    els.testBtn.textContent = "Test connection";
  }
}

async function manualResync() {
  clearStatus(els.settingsStatus);
  els.resyncBtn.disabled = true;
  const result = await drainQueue();
  els.resyncBtn.disabled = false;
  if (result.failed === 0 && result.sent === 0) {
    showStatus(els.settingsStatus, "Nothing to sync.", "info");
  } else if (result.failed === 0) {
    showStatus(els.settingsStatus, "Synced " + result.sent + " entries.", "success");
  } else {
    showStatus(
      els.settingsStatus,
      "Sent " + result.sent + ", " + result.failed + " still queued. " + (result.error || ""),
      "error"
    );
  }
}

/* ---- today-check ---- */

async function checkTodaysEntries() {
  // On app load, surface whether the user has already saved an entry today.
  // Counts both the local unsynced queue and the Koofr CSV (best-effort:
  // if Koofr is unreachable, only the queue is counted). Never blocks
  // submission --- the user can still add another entry if they want.
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const today =
    now.getFullYear() + "-" + pad(now.getMonth() + 1) + "-" + pad(now.getDate());

  const queueToday = loadQueue().filter((e) => e.date === today).length;

  let csvToday = 0;
  const settings = loadSettings();
  if (settingsReady(settings) && navigator.onLine) {
    csvToday = await window.SyncAPI.countEntriesOnDate(settings, today);
  }

  const total = queueToday + csvToday;
  if (total > 0) {
    showStatus(
      els.entryStatus,
      total === 1
        ? "Heads up: you already saved an entry for today. You can still add another if you need to."
        : "Heads up: you already saved " + total + " entries for today. You can still add another if you need to.",
      "info"
    );
  }
}

/* ---- wiring ---- */

function init() {
  buildLocationGrid();
  fillDateTime();
  updateQueueBadge();

  els.ragButtons.forEach((btn) => {
    btn.addEventListener("click", () => setScore(parseInt(btn.dataset.score, 10)));
  });

  els.fMtx.addEventListener("change", () => {
    els.fMtx.closest(".checkbox-row").classList.toggle("checked", els.fMtx.checked);
  });

  // "Other" location: typing auto-ticks the checkbox so the user only needs
  // to fill the text field. Manual tick still works. Visual highlight
  // tracks the checkbox state.
  const locOtherRow = els.fLocOtherCb.closest(".loc-other");
  els.fLocOtherCb.addEventListener("change", () => {
    locOtherRow.classList.toggle("checked", els.fLocOtherCb.checked);
  });
  els.fLocOtherText.addEventListener("input", () => {
    if (els.fLocOtherText.value.trim() && !els.fLocOtherCb.checked) {
      els.fLocOtherCb.checked = true;
      locOtherRow.classList.add("checked");
    }
  });

  els.form.addEventListener("submit", submitEntry);
  els.settingsForm.addEventListener("submit", saveSettingsAction);
  els.navSettings.addEventListener("click", () => {
    populateSettings();
    clearStatus(els.settingsStatus);
    showView("settings");
  });
  els.navEntry.addEventListener("click", () => showView("entry"));
  els.testBtn.addEventListener("click", testConnection);
  els.resyncBtn.addEventListener("click", manualResync);

  // Opportunistic drain when the network comes back or the app is reopened.
  window.addEventListener("online", () => drainQueue(true));
  if (navigator.onLine && loadQueue().length > 0) {
    drainQueue(true);
  }

  // Register service worker for offline shell.
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch((err) => {
      console.warn("Service worker registration failed:", err);
    });
  }

  // Non-blocking check: have we already logged today?
  checkTodaysEntries();
}

document.addEventListener("DOMContentLoaded", init);
