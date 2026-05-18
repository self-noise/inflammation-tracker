/* WebDAV sync against Koofr — one file per entry.
 *
 * Why one-file-per-entry?
 *   The previous single-CSV design did GET-then-modify-then-PUT, which is
 *   unsafe whenever the GET returns a stale body (browser HTTP cache, edge
 *   cache, or eventual-consistency at Koofr): the PUT silently overwrites
 *   whatever wasn't in the stale read. The new design never reads before
 *   writing — each saved entry is a PUT to a unique path, so no path can
 *   clobber another.
 *
 * Filename convention. From settings.path (e.g. "/MIT/MIT_log.csv"):
 *     directory = "/MIT/"
 *     prefix    = "MIT_log"
 *     file path = "/MIT/MIT_log__<entry-date>__<write-ms>.csv"
 *     e.g.       "/MIT/MIT_log__2026-05-18__1747584622456.csv"
 *
 * Each per-entry file contains a CSV header row followed by a single data
 * row. The header is included in every file so each file is fully self-
 * describing — opening one in Excel or a text editor shows column names
 * without needing the schema documented elsewhere, and future schema
 * changes leave a clear forensic trail (a file written before a column
 * was added has fewer headers and fewer data fields).
 *
 * Schema (one data row per file, with header):
 *   entry_id, write_timestamp, date, time, score, locations,
 *   dietary_notes, other_notes, methotrexate
 *
 * Authentication is HTTP Basic with email + Koofr app password.
 *
 * CORS caveat: app.koofr.net does not advertise CORS headers for browser
 * origins. The "Proxy URL" setting lets the user point at a Cloudflare
 * Worker that forwards requests with the needed CORS headers — see
 * ../worker/worker.js.
 */

const KOOFR_BASE = "https://app.koofr.net/dav/Koofr";

// Column order must match rowToCsv(). Kept as the source of truth so changes
// here also drive the header line written into each per-entry file.
const CSV_COLUMNS = [
  "entry_id",
  "write_timestamp",
  "date",
  "time",
  "score",
  "locations",
  "dietary_notes",
  "other_notes",
  "methotrexate",
];
const CSV_HEADER = CSV_COLUMNS.join(",") + "\n";

/* ---- helpers ---- */

function b64(str) {
  // btoa needs latin-1; encode utf-8 first.
  return btoa(unescape(encodeURIComponent(str)));
}

function csvEscape(field) {
  // Always quote; double up internal quotes. This keeps Excel/pandas happy.
  const s = String(field ?? "");
  return '"' + s.replace(/"/g, '""') + '"';
}

function rowToCsv(entry) {
  // Single data row, fully quoted. Column order must match CSV_COLUMNS above.
  // locations is pipe-delimited within its quoted field. methotrexate is 0 or 1.
  return [
    entry.entry_id,
    entry.write_timestamp,
    entry.date,
    entry.time,
    entry.score,
    entry.locations.join("|"),
    entry.dietary_notes,
    entry.other_notes,
    entry.methotrexate,
  ].map(csvEscape).join(",") + "\n";
}

function fileContent(entry) {
  // Header + data row. Header is plain unquoted column names; pandas and
  // Excel parse the mixed (unquoted header, quoted data) form transparently.
  return CSV_HEADER + rowToCsv(entry);
}

function splitLogPath(logPath) {
  // "/MIT/MIT_log.csv" -> { dir: "/MIT/", prefix: "MIT_log" }
  // Tolerates missing leading slash, missing .csv, and trailing slash.
  let norm = logPath.startsWith("/") ? logPath : "/" + logPath;
  const lastSlash = norm.lastIndexOf("/");
  const dir = norm.substring(0, lastSlash + 1); // keeps trailing slash
  let base = norm.substring(lastSlash + 1);
  if (base.toLowerCase().endsWith(".csv")) {
    base = base.substring(0, base.length - 4);
  }
  return { dir, prefix: base };
}

function entryFileName(prefix, entry) {
  const ms = new Date(entry.write_timestamp).getTime();
  return prefix + "__" + entry.date + "__" + ms + ".csv";
}

function entryFullPath(settings, entry) {
  const { dir, prefix } = splitLogPath(settings.path);
  return dir + entryFileName(prefix, entry);
}

function buildUrl(settings, path) {
  // Normalise: ensure path begins with "/", strip any trailing slash on base.
  const p = path.startsWith("/") ? path : "/" + path;
  if (settings.proxy && settings.proxy.trim()) {
    // Proxy forwards {proxy}/<koofr-path> to KOOFR_BASE/<koofr-path>.
    return settings.proxy.replace(/\/$/, "") + p;
  }
  return KOOFR_BASE + p;
}

function authHeader(settings) {
  if (!settings.email || !settings.password) return null;
  return "Basic " + b64(settings.email + ":" + settings.password);
}

function classifyError(err) {
  // A CORS-blocked fetch surfaces as a generic TypeError with no further
  // detail. Heuristic: TypeError + no response object.
  if (err instanceof TypeError) {
    return "Network blocked. This is usually CORS: Koofr's WebDAV does not "
      + "send Access-Control-Allow-Origin headers for browser requests. "
      + "Set the Proxy URL in settings to a Cloudflare Worker that "
      + "forwards to Koofr with CORS enabled.";
  }
  return err.message || String(err);
}

/* ---- core operations ---- */

async function davMkcol(settings, dirPath) {
  // Create a collection (directory). Idempotent: 405 means it already exists.
  const url = buildUrl(settings, dirPath);
  const res = await fetch(url, {
    method: "MKCOL",
    cache: "no-store",
    headers: { "Authorization": authHeader(settings) },
  });
  if (res.ok || res.status === 405) return;
  throw new Error("MKCOL " + res.status + " " + res.statusText);
}

// Memoise per session: an MKCOL ladder for a directory only needs to run once.
const _ensuredDirs = new Set();

async function ensureDir(settings) {
  // Walk settings.path's directory and MKCOL each ancestor. Cheap and idempotent.
  const { dir } = splitLogPath(settings.path);
  if (_ensuredDirs.has(dir)) return;
  const parts = dir.split("/").filter(Boolean);
  let cur = "";
  for (const p of parts) {
    cur += "/" + p;
    try {
      await davMkcol(settings, cur);
    } catch (e) {
      throw new Error("Could not create directory " + cur + ": " + e.message);
    }
  }
  _ensuredDirs.add(dir);
}

async function davPropfindDepth1(settings, dirPath) {
  // Returns the raw multistatus XML body, or null on 404.
  const url = buildUrl(settings, dirPath);
  const res = await fetch(url, {
    method: "PROPFIND",
    cache: "no-store",
    headers: {
      "Authorization": authHeader(settings),
      "Depth": "1",
    },
  });
  if (res.status === 404) return null;
  if (!res.ok && res.status !== 207) {
    throw new Error("PROPFIND " + res.status + " " + res.statusText);
  }
  return await res.text();
}

function parseHrefFileNames(xmlText) {
  // Pull the basename out of every <D:href> in a multistatus response.
  // At Depth: 1 the list includes the directory itself plus its children.
  const doc = new DOMParser().parseFromString(xmlText, "application/xml");
  const hrefs = doc.getElementsByTagNameNS("DAV:", "href");
  const out = [];
  for (const h of hrefs) {
    const raw = (h.textContent || "").trim();
    // Some servers return absolute URLs, some return absolute paths; both work
    // with URL() given a dummy base. Then take the last path segment.
    let path;
    try { path = new URL(raw, "http://x/").pathname; } catch { path = raw; }
    const stripped = path.replace(/\/$/, "");
    const last = stripped.split("/").pop() || "";
    if (last) {
      try { out.push(decodeURIComponent(last)); }
      catch { out.push(last); }
    }
  }
  return out;
}

/* ---- public API ---- */

async function testConnection(settings) {
  // PROPFIND on the root with Depth: 0 is the cheapest "auth + reach" probe.
  const url = buildUrl(settings, "/");
  const res = await fetch(url, {
    method: "PROPFIND",
    cache: "no-store",
    headers: {
      "Authorization": authHeader(settings),
      "Depth": "0",
    },
  });
  if (res.status === 401) throw new Error("Auth failed (401). Check email + app password.");
  if (!res.ok && res.status !== 207) throw new Error("PROPFIND " + res.status);
  return true;
}

async function writeEntry(settings, entry) {
  // Write a single-row CSV file at a unique path. Idempotent on retry: a 412
  // back from If-None-Match: * means the file already exists, which only
  // happens if a previous attempt actually wrote it (the path includes a
  // ms-resolution timestamp), so we treat it as success.
  try {
    await ensureDir(settings);
  } catch (e) {
    throw new Error(classifyError(e));
  }
  const body = fileContent(entry);
  const url = buildUrl(settings, entryFullPath(settings, entry));
  let res;
  try {
    res = await fetch(url, {
      method: "PUT",
      cache: "no-store",
      headers: {
        "Authorization": authHeader(settings),
        "Content-Type": "text/csv; charset=utf-8",
        "If-None-Match": "*", // create-only: refuse to overwrite an existing file
      },
      body,
    });
  } catch (e) {
    throw new Error("Could not write entry: " + classifyError(e));
  }
  if (res.status === 412) {
    // File exists at this path => previous attempt succeeded.
    return true;
  }
  if (!res.ok) {
    throw new Error("PUT " + res.status + " " + res.statusText);
  }
  return true;
}

async function countEntriesOnDate(settings, dateStr) {
  // Best-effort count of entries whose entry-date equals dateStr. Lists the
  // log directory and matches files of the form "<prefix>__<dateStr>__*.csv".
  // Returns 0 on any failure (missing dir, auth, network, CORS). Used by
  // the on-load "did I already log today?" hint.
  try {
    const { dir, prefix } = splitLogPath(settings.path);
    const xml = await davPropfindDepth1(settings, dir);
    if (xml === null) return 0;
    const names = parseHrefFileNames(xml);
    const needle = prefix + "__" + dateStr + "__";
    return names.filter(n =>
      n.startsWith(needle) && n.toLowerCase().endsWith(".csv")
    ).length;
  } catch {
    return 0;
  }
}

// Expose to other scripts (no module system — vanilla globals).
window.SyncAPI = {
  testConnection,
  writeEntry,
  countEntriesOnDate,
  classifyError,
  rowToCsv,        // exported for unit-test-style checks in console
  fileContent,     // exported so callers can see exactly what a saved file looks like
  splitLogPath,    // exported for console inspection of the derived prefix
  CSV_COLUMNS,
  CSV_HEADER,
};

// CORS proxy Worker (needed because app.koofr.net doesn't send CORS headers
// for browser origins): see ../worker/worker.js for the deployable source.
