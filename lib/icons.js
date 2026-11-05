// Item-level logo resolution and the `GET /packdeck/icon` route (CONTRACT §8).
//
// Resolution is derived from the item id only (`<manager>:<packageId>`); the client can never
// supply a file path. Sources:
//   ext  -> `<editor extensions root>/<publisher>.<name>-<version>/package.json#icon`
//   app  -> ARP `DisplayIcon` for the matched installed program (.ico as-is, .exe extracted)
//   pkg  -> no logo by design (the client falls back to the manager glyph)
//
// `addLogoUrls()` decorates snapshot items only when existence is already known from the
// cached ARP / extension scans, so a warm snapshot stays a pure in-memory pass. Neither scan
// runs a subprocess per item, and no PowerShell runs during a snapshot.

import path from 'node:path';
import { getManager } from './catalog.js';
import { cacheGet } from './cache.js';
import { managerSnapshot } from './managers.js';
import {
  ICON_SCAN_TTL,
  findExtensionEntry,
  getArpIndex,
  getExtensionIndex,
  isServeableDisplayIcon,
  matchArpEntry,
  matchArpLocation,
  matchArpSize,
  readDisplayIcon,
  readExtensionIcon,
  sha1Hex,
} from './iconres.js';
import { fillDirectorySizes } from './sizes.js';

const MEMO_MAX = 2000;

/** itemId -> {at, displayIcon}; filled while decorating snapshots for the icon route. */
const itemMemo = new Map();

function memoSet(itemId, value) {
  itemMemo.delete(itemId);
  itemMemo.set(itemId, { at: Date.now(), ...value });
  if (itemMemo.size > MEMO_MAX) {
    const oldest = itemMemo.keys().next().value;
    if (oldest !== undefined) itemMemo.delete(oldest);
  }
}

function memoGet(itemId) {
  const entry = itemMemo.get(itemId);
  if (!entry) return null;
  if (entry.at + ICON_SCAN_TTL <= Date.now()) {
    itemMemo.delete(itemId);
    return null;
  }
  return entry;
}

function shortRev(value) {
  return sha1Hex(value).slice(0, 8);
}

/** Same-origin relative URL consumed verbatim by the client (`<img src>`). */
export function buildLogoUrl(itemId, rev) {
  return `/packdeck/icon?id=${encodeURIComponent(itemId)}&r=${rev}`;
}

/* ------------------------------------------------------------------ decoration */

/**
 * Add `logoUrl` and `sizeBytes` to snapshot items (CONTRACT §8.2, §15).
 *
 * Cheapness rules: ext -> icon file confirmed by the cached directory scan; app -> cached ARP
 * record with a serveable DisplayIcon; pkg -> always null. Any failure degrades to null.
 *
 * `sizeBytes` comes from the ARP `EstimatedSize` value of the very scan the icon pass needs, so
 * both fields are filled in one walk. Items with no ARP record keep `sizeBytes: null` and the UI
 * renders "—" rather than a fabricated number.
 *
 * Rows decorated by an earlier snapshot are reused as-is (`logoUrl` is written back onto the
 * per-manager cached row): the snapshot cache lives 60 s while the ARP / extension scans live
 * 5 min, so a URL can never outlive the scan it came from, and a warm snapshot is a plain
 * property check instead of a 200-item walk.
 *
 * @param {object[]} items snapshot items
 * @returns {Promise<object[]>} the same items, each carrying `logoUrl` and `sizeBytes`
 */
export async function addLogoUrls(items) {
  if (!Array.isArray(items) || items.length === 0) return Array.isArray(items) ? items : [];
  /* A row is only "done" when the size attempt has also been made: a cached row may legitimately
   * end with `sizeBytes: null` (no registry record, no measurable directory), and re-walking it
   * on every snapshot would be the one thing this cache exists to avoid. `sizeChecked` marks it. */
  const decorated = (item) =>
    Object.prototype.hasOwnProperty.call(item, 'logoUrl') &&
    Object.prototype.hasOwnProperty.call(item, 'sizeBytes') &&
    (item.sizeChecked === true || item.sizeBytes !== null);
  if (items.every(decorated)) return items;

  try {
    const needsApp = items.some((item) => item.kind === 'app');
    const needsExt = items.some((item) => item.kind === 'ext');
    const arp = needsApp ? await getArpIndex() : null;
    const extensionIndexes = new Map();
    if (needsExt) {
      for (const manager of new Set(items.filter((item) => item.kind === 'ext').map((item) => item.manager))) {
        extensionIndexes.set(manager, await getExtensionIndex(manager));
      }
    }

    for (const item of items) {
      let logoUrl = null;
      try {
        if (item.kind === 'ext') {
          const entry = findExtensionEntry(extensionIndexes.get(item.manager) || null, item.packageId, item.version);
          if (entry && entry.iconExists) {
            const rev = shortRev(`${entry.iconPath}|${Math.trunc(entry.iconMtimeMs)}`);
            logoUrl = buildLogoUrl(item.id, rev);
          }
          /* The extension scan already resolved the folder; handing it to the size pass is what
           * lets an editor extension report a real size instead of "—". */
          if (entry && entry.dir && !item.path) item.path = entry.dir;
        } else if (item.kind === 'app') {
          const record = matchArpEntry(arp, item);
          if (record && isServeableDisplayIcon(record.displayIcon)) {
            memoSet(item.id, { displayIcon: record.displayIcon });
            logoUrl = buildLogoUrl(item.id, shortRev(`${item.id}|${item.version}|${record.displayIcon}`));
          }
        }
      } catch {
        logoUrl = null;
      }
      item.logoUrl = logoUrl;
      /* Installed size rides along on the same pass: `EstimatedSize` is already in the ARP scan
       * this function had to run anyway, so filling `sizeBytes` costs nothing extra (CONTRACT §15). */
      if (item.sizeBytes === undefined || item.sizeBytes === null) {
        try {
          item.sizeBytes = arp ? matchArpSize(arp, item) : null;
        } catch {
          item.sizeBytes = null;
        }
      }
      /* No installer-reported size, but the registry knows where it lives: measure that folder
       * in the bounded pass below (only ~29 of 175 entries carry a location, so this is cheap). */
      if (!item.sizeBytes && !item.path && arp) {
        try {
          const location = matchArpLocation(arp, item);
          if (location) item.path = location;
        } catch {
          /* leave path as-is */
        }
      }
    }
    /* Anything the registry does not know (node packages, extensions, editors) is measured from
     * its own directory under one shared budget — see lib/sizes.js for why this is bounded. */
    await fillDirectorySizes(items);
    for (const item of items) item.sizeChecked = true;
    return items;
  } catch {
    for (const item of items) item.logoUrl = null;
    return items;
  }
}

/* ------------------------------------------------------------------ resolution */

/**
 * Split `<manager>:<packageId>`; the package id may contain dots/slashes but never a colon.
 * @param {unknown} itemId
 * @returns {{manager: string, packageId: string}|null}
 */
export function parseItemId(itemId) {
  if (typeof itemId !== 'string') return null;
  const value = itemId.trim();
  if (!value || value.length > 400 || /[\u0000-\u001f\u007f]/.test(value)) return null;
  const separator = value.indexOf(':');
  if (separator <= 0 || separator === value.length - 1) return null;
  return { manager: value.slice(0, separator), packageId: value.slice(separator + 1) };
}

async function resolveExtensionIcon(manager, packageId, version) {
  const index = await getExtensionIndex(manager);
  if (!index) return null;
  const entry = findExtensionEntry(index, packageId, version);
  if (!entry || !entry.iconExists) return null;
  return readExtensionIcon(index, entry);
}

/** Coalesce concurrent cold snapshot loads for the icon route (one spawn at most). */
const snapshotLoads = new Map();

async function loadManagerSnapshot(manager) {
  const inflight = snapshotLoads.get(manager);
  if (inflight) return inflight;
  const task = managerSnapshot(manager, {}).finally(() => snapshotLoads.delete(manager));
  snapshotLoads.set(manager, task);
  return task;
}

async function resolveAppIcon(manager, packageId) {
  const itemId = `${manager}:${packageId}`;
  let displayIcon = (memoGet(itemId) || {}).displayIcon || '';

  if (!displayIcon) {
    const index = await getArpIndex();
    const cached = cacheGet(`snapshot:${manager}`);
    let item =
      cached && Array.isArray(cached.items) ? cached.items.find((entry) => entry.packageId === packageId) : null;
    // A cold process (or a snapshot cache older than 60 s) can still resolve by id alone: the
    // manager snapshot supplies the winget display name the ARP record is keyed by. In the
    // normal flow this is already cached and never spawns anything.
    if (!item) {
      try {
        const snapshot = await loadManagerSnapshot(manager);
        item = snapshot && Array.isArray(snapshot.items) ? snapshot.items.find((entry) => entry.packageId === packageId) : null;
      } catch {
        item = null;
      }
    }
    const record = item ? matchArpEntry(index, item) : matchArpEntry(index, { packageId });
    if (record && isServeableDisplayIcon(record.displayIcon)) {
      displayIcon = record.displayIcon;
      memoSet(itemId, { displayIcon });
    }
  }
  if (!displayIcon) return null;
  return readDisplayIcon(displayIcon);
}

/**
 * Resolve one item id to icon bytes. Never accepts a path; the only input is the item id
 * (plus an optional version hint from a snapshot row, used to disambiguate extension dirs).
 *
 * @param {string} itemId `<manager>:<packageId>`
 * @param {{version?: string}} [options]
 * @returns {Promise<{bytes: Buffer, contentType: string, path: string, sizeBytes: number}|null>}
 */
export async function resolveIcon(itemId, options = {}) {
  const parsed = parseItemId(itemId);
  if (!parsed) return null;
  const def = getManager(parsed.manager);
  if (!def) return null;
  if (def.itemKind === 'pkg') return null;
  if (def.itemKind === 'ext') {
    const version = typeof options.version === 'string' ? options.version : '';
    return resolveExtensionIcon(parsed.manager, parsed.packageId, version);
  }
  if (def.itemKind === 'app') return resolveAppIcon(parsed.manager, parsed.packageId);
  return null;
}

/* ------------------------------------------------------------------ HTTP route */

const NOT_FOUND_BODY = { ok: false, error: { code: 'not-found', message: '没有可用的图标' } };

// Kept local instead of importing lib/http.js: http.js -> api.js -> icons.js would be an
// import cycle, and this response is the only JSON the icon route ever writes.
function sendJson(res, status, payload, extraHeaders = {}) {
  let body;
  try {
    body = JSON.stringify(payload);
  } catch {
    body = JSON.stringify({ ok: false, error: { code: 'not-found', message: '没有可用的图标' } });
  }
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-length': Buffer.byteLength(body),
    ...extraHeaders,
  };
  try {
    if (res.writableEnded || res.destroyed) return;
    res.writeHead(status, headers);
    res.end(body);
  } catch {
    /* client went away */
  }
}

function notFound(res) {
  sendJson(res, 404, NOT_FOUND_BODY);
}

function readIdParam(rawUrl) {
  try {
    const value = new URL(rawUrl || '/', 'http://127.0.0.1').searchParams.get('id');
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Build the `GET /packdeck/icon?id=<itemId>&r=<rev>` handler for `webServer.register`.
 * Success: 200 with the icon bytes. Every failure (missing id, unknown item, unreadable file,
 * extraction error, internal bug) is a JSON 404: this route never answers 500.
 *
 * @param {{logger?: {warn?: Function}}} [deps]
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export function createIconRequestHandler(deps = {}) {
  const logger = deps.logger;

  return async function iconHandler(req, res) {
    try {
      if (res.writableEnded || res.destroyed) return;
      const method = String(req.method || 'GET').toUpperCase();
      if (method !== 'GET' && method !== 'HEAD') {
        sendJson(res, 405, { ok: false, error: { code: 'bad-request', message: `不支持的请求方法 ${method}` } }, {
          allow: 'GET, HEAD',
        });
        return;
      }

      const itemId = readIdParam(req.url);
      if (!itemId) {
        notFound(res);
        return;
      }

      const icon = await resolveIcon(itemId);
      if (!icon || !icon.bytes || icon.bytes.length === 0) {
        notFound(res);
        return;
      }

      const headers = {
        'content-type': icon.contentType,
        'cache-control': 'public, max-age=86400, immutable',
        'content-length': icon.bytes.length,
        'x-content-type-options': 'nosniff',
      };
      try {
        if (res.writableEnded || res.destroyed) return;
        res.writeHead(200, headers);
        if (method === 'HEAD') res.end();
        else res.end(icon.bytes);
      } catch {
        /* client went away */
      }
    } catch (error) {
      try {
        logger?.warn?.('[packdeck] 图标解析失败', error);
      } catch {
        /* logging must never break the response */
      }
      try {
        notFound(res);
      } catch {
        /* response already gone */
      }
    }
  };
}
