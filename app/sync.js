/* WebDAV sync against Koofr.
 *
 * Koofr's WebDAV endpoint is https://app.koofr.net/dav/Koofr/<path>.
 * There is no true "append" verb in WebDAV — PATCH is not standard for
 * file content. The robust approach is:
 *   1. GET the existing file (or 404 -> create new with header)
 *   2. concatenate the new CSV row
 *   3. PUT it back, using If-Match on the ETag when present so a
 *      concurrent write from another device causes 412 rather than a
 *      silent overwrite. On 412 we re-fetch and retry once.
 *
 * Authentication is HTTP Basic with email + Koofr app password.
 *
 * CORS caveat: app.koofr.net does not currently advertise CORS headers
 * for browser origins. A direct fetch will be blocked by the browser
 * (opaque network error). The "Proxy URL" setting lets the user point
 * at a Cloudflare Worker (or similar) that forwards requests with the
 * needed CORS headers — see worker-template comment at bottom of file.
 */

const KOOFR_BASE = "https://app.koofr.net/dav/Koofr";
const CSV_HEADER = "date,time,score,locations,dietary_notes,other_notes,methotrexate\n";

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
  // Schema: date, time, score, locations, dietary_notes, other_notes, methotrexate
  // locations is a pipe-delimited string within the quoted field.
  // methotrexate is 0 (not taken) or 1 (taken in past 24h).
  return [
    entry.date,
    entry.time,
    entry.score,
    entry.locations.join("|"),
    entry.dietary_notes,
    entry.other_notes,
    entry.methotrexate,
  ].map(csvEscape).join(",") + "\n";
}

function buildUrl(settings, path) {
  // Normalise: ensure path begins with "/", strip any trailing slash on base.
  const p = path.startsWith("/") ? path : "/" + path;
  if (settings.proxy && settings.proxy.trim()) {
    // Proxy is expected to forward {proxy}/<koofr-path> to KOOFR_BASE/<koofr-path>.
    return settings.proxy.replace(/\/$/, "") + p;
  }
  return KOOFR_BASE + p;
}

function authHeader(settings) {
  if (!settings.email || !settings.password) return null;
  return "Basic " + b64(settings.email + ":" + settings.password);
}

function classifyError(err) {
  // A CORS-blocked fetch surfaces as a generic TypeError in browsers with
  // no further detail. Heuristic: TypeError + no response object.
  if (err instanceof TypeError) {
    return "Network blocked. This is usually CORS: Koofr's WebDAV does not "
      + "send Access-Control-Allow-Origin headers for browser requests. "
      + "Set the Proxy URL in settings to a Cloudflare Worker that "
      + "forwards to Koofr with CORS enabled.";
  }
  return err.message || String(err);
}

/* ---- core operations ---- */

async function davGet(settings) {
  // Returns { content, etag } or null if 404.
  const url = buildUrl(settings, settings.path);
  const res = await fetch(url, {
    method: "GET",
    headers: {
      "Authorization": authHeader(settings),
    },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error("GET " + res.status + " " + res.statusText);
  const content = await res.text();
  const etag = res.headers.get("ETag");
  return { content, etag };
}

async function davPut(settings, content, ifMatchEtag) {
  const url = buildUrl(settings, settings.path);
  const headers = {
    "Authorization": authHeader(settings),
    "Content-Type": "text/csv; charset=utf-8",
  };
  if (ifMatchEtag) headers["If-Match"] = ifMatchEtag;
  const res = await fetch(url, {
    method: "PUT",
    headers,
    body: content,
  });
  if (res.status === 412) {
    const e = new Error("Precondition Failed (file changed on server)");
    e.code = "ETAG_MISMATCH";
    throw e;
  }
  if (!res.ok) throw new Error("PUT " + res.status + " " + res.statusText);
  return res.headers.get("ETag");
}

async function davMkcol(settings, dirPath) {
  // Create a collection (directory). Idempotent: 405 means it already exists.
  const url = buildUrl(settings, dirPath);
  const res = await fetch(url, {
    method: "MKCOL",
    headers: { "Authorization": authHeader(settings) },
  });
  if (res.ok || res.status === 405) return;
  throw new Error("MKCOL " + res.status + " " + res.statusText);
}

async function ensureParentDirs(settings) {
  // Walk the path and MKCOL each ancestor. Cheap and idempotent.
  const parts = settings.path.split("/").filter(Boolean);
  parts.pop(); // drop filename
  let cur = "";
  for (const p of parts) {
    cur += "/" + p;
    try {
      await davMkcol(settings, cur);
    } catch (e) {
      // Non-fatal: a 409 here means a parent above doesn't exist yet,
      // but we're walking top-down so this would be unusual. Surface it.
      throw new Error("Could not create directory " + cur + ": " + e.message);
    }
  }
}

/* ---- public API ---- */

async function testConnection(settings) {
  // PROPFIND on the root with Depth: 0 is the cheapest "auth + reach" probe.
  const url = buildUrl(settings, "/");
  const res = await fetch(url, {
    method: "PROPFIND",
    headers: {
      "Authorization": authHeader(settings),
      "Depth": "0",
    },
  });
  if (res.status === 401) throw new Error("Auth failed (401). Check email + app password.");
  if (!res.ok && res.status !== 207) throw new Error("PROPFIND " + res.status);
  return true;
}

async function appendEntry(settings, entry) {
  // Returns true on success. Throws on auth/network errors; the caller is
  // responsible for queuing on failure.
  const row = rowToCsv(entry);

  let existing;
  try {
    existing = await davGet(settings);
  } catch (e) {
    throw new Error("Could not read CSV: " + classifyError(e));
  }

  if (existing === null) {
    // File doesn't exist — create parent dirs then PUT header + first row.
    try {
      await ensureParentDirs(settings);
    } catch (e) {
      throw new Error(classifyError(e));
    }
    try {
      await davPut(settings, CSV_HEADER + row, null);
      return true;
    } catch (e) {
      throw new Error("Could not create CSV: " + classifyError(e));
    }
  }

  // File exists. Append, using ETag for optimistic concurrency.
  let content = existing.content;
  if (!content.endsWith("\n") && content.length > 0) content += "\n";
  const newContent = content + row;

  try {
    await davPut(settings, newContent, existing.etag);
    return true;
  } catch (e) {
    if (e.code === "ETAG_MISMATCH") {
      // Someone else wrote in between. Re-fetch and try once more.
      const fresh = await davGet(settings);
      let c = fresh ? fresh.content : CSV_HEADER;
      if (!c.endsWith("\n") && c.length > 0) c += "\n";
      await davPut(settings, c + row, fresh ? fresh.etag : null);
      return true;
    }
    throw new Error("Could not write CSV: " + classifyError(e));
  }
}

async function countEntriesOnDate(settings, dateStr) {
  // Best-effort count of entries whose date column equals dateStr.
  // Never throws; returns 0 on any failure (missing file, auth, network,
  // CORS, etc.). Used by the on-load "did I already log today?" check.
  // Rows are written fully quoted so a today-row begins with `"YYYY-MM-DD",`.
  try {
    const existing = await davGet(settings);
    if (!existing || !existing.content) return 0;
    const prefix = '"' + dateStr + '",';
    return existing.content
      .split("\n")
      .filter((line) => line.startsWith(prefix))
      .length;
  } catch {
    return 0;
  }
}

// Expose to other scripts (no module system — vanilla globals).
window.SyncAPI = {
  testConnection,
  appendEntry,
  countEntriesOnDate,
  classifyError,
  rowToCsv,   // exported for unit-test-style checks in console
};

// CORS proxy Worker (needed because app.koofr.net doesn't send CORS headers
// for browser origins): see ../worker/worker.js for the deployable source.
