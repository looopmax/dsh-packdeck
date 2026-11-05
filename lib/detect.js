// Manager auto-detection (CONTRACT §7.2).
//
// Rules:
// - resolve each manager's CLI on PATH ourselves (no shell, no `where.exe`): PATH ×
//   PATHEXT with a spawn-friendly extension preference (.exe/.com → .cmd → .bat → .ps1);
// - run the manager's version command with a 6 s timeout, at most 6 probes in flight;
// - the whole sweep has a 15 s budget; a probe that cannot start before the deadline is
//   reported as undetected instead of delaying the request;
// - one manager's failure only marks that manager (`detected:false` + `reason`);
// - the result is cached for 60 s (the `detect` action bypasses the cache with force).

import fs from 'node:fs';
import path from 'node:path';
import { run } from './run.js';
import { cacheGet, cacheSet, TTL } from './cache.js';
import { MANAGERS, getManager } from './catalog.js';
import { normalizeOutput, oneLine } from './text.js';

const PROBE_TIMEOUT_MS = 6_000;
const BUDGET_MS = 15_000;
const CONCURRENCY = 6;
const RESOLUTION_TTL_MS = 60_000;
const DETECTION_CACHE_KEY = 'detection';
const IS_WIN = process.platform === 'win32';

// Ordered by spawn friendliness: native exe first, then cmd/bat shims (handled through
// `cmd.exe /d /s /c` by lib/run.js), powershell scripts last (slowest to start).
const WINDOWS_EXTS = ['.exe', '.com', '.cmd', '.bat', '.ps1'];
const POSIX_EXTS = [''];

const resolution = new Map(); // logical name -> { value: {file,kind}|null, expiresAt }
let inFlight = null;

function kindOf(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.cmd' || ext === '.bat') return 'cmd';
  if (ext === '.ps1') return 'ps1';
  return 'exe';
}

function isUsableFile(file) {
  try {
    // Windows App Execution Aliases (winget.exe and friends) are reparse points whose
    // target cannot be stat()ed (EACCES); lstat() is the right existence check.
    const stat = fs.lstatSync(file);
    return stat.isFile() || stat.isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Resolve one logical command name on PATH, Windows-aware.
 *
 * @param {string} name e.g. `code`, `PinK`, `cargo`
 * @returns {{file:string, kind:'exe'|'cmd'|'ps1'}|null} null when the command is missing
 */
export function resolveOnPath(name) {
  if (typeof name !== 'string' || name === '') return null;
  if (name.includes('/') || name.includes('\\')) {
    return isUsableFile(name) ? { file: name, kind: kindOf(name) } : null;
  }

  const cached = resolution.get(name);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const dirs = String(process.env.PATH || '')
    .split(path.delimiter)
    .filter(Boolean);
  const extensions = IS_WIN ? WINDOWS_EXTS : POSIX_EXTS;
  let found = null;
  for (const dir of dirs) {
    for (const ext of extensions) {
      const candidate = path.join(dir, `${name}${ext}`);
      if (isUsableFile(candidate)) {
        found = { file: candidate, kind: kindOf(candidate) };
        break;
      }
    }
    if (found) break; // PATH order wins, like a shell would
  }

  resolution.set(name, { value: found, expiresAt: Date.now() + RESOLUTION_TTL_MS });
  return found;
}

/* ------------------------------------------------------------------ detection */

function notDetected(id, reason) {
  return {
    id,
    detected: false,
    available: false,
    version: null,
    file: null,
    kind: null,
    root: null,
    reason,
    error: reason,
    durationMs: 0,
  };
}

async function probeOne(def, deadline) {
  const startedAt = Date.now();
  const remaining = deadline - Date.now();
  if (remaining < 250) return notDetected(def.id, '探测总预算（15 s）已耗尽');

  let resolved = null;
  for (const name of def.binaries || [def.id]) {
    resolved = resolveOnPath(name);
    if (resolved) break;
  }
  if (!resolved) {
    return notDetected(def.id, `未找到可执行文件（${(def.binaries || [def.id]).join(' / ')} 不在 PATH 中）`);
  }

  const timeoutMs = Math.max(250, Math.min(PROBE_TIMEOUT_MS, deadline - Date.now()));
  let result;
  try {
    result = await run(resolved.file, def.versionArgs || ['--version'], { timeoutMs });
  } catch (error) {
    return notDetected(def.id, oneLine(error && error.message, 180) || '版本探测失败');
  }

  if (result.timedOut) {
    return notDetected(def.id, `${def.label} 版本探测超时（${Math.round(timeoutMs / 1000)} s）`);
  }
  if (result.code !== 0) {
    const detail = oneLine(result.stderr || result.stdout, 160);
    return notDetected(def.id, `${def.label} 版本探测失败（退出码 ${result.code}${detail ? `：${detail}` : ''}）`);
  }

  const output = normalizeOutput(result.stdout || result.stderr || '');
  const version = def.parseVersion ? def.parseVersion(output) : null;
  if (!version) return notDetected(def.id, `无法解析 ${def.label} 版本输出`);

  return {
    id: def.id,
    detected: true,
    available: true,
    version,
    file: resolved.file,
    kind: resolved.kind,
    root: def.rootHint ? def.rootHint() : path.dirname(resolved.file),
    reason: null,
    error: null,
    durationMs: Date.now() - startedAt,
  };
}

function syntheticDetection() {
  const entries = new Map();
  for (const def of MANAGERS) {
    entries.set(def.id, {
      id: def.id,
      detected: true,
      available: true,
      version: null,
      file: null,
      kind: null,
      root: null,
      reason: null,
      error: null,
      durationMs: 0,
    });
  }
  return { at: Date.now(), probed: MANAGERS.length, found: MANAGERS.length, durationMs: 0, entries };
}

async function runDetection() {
  const startedAt = Date.now();
  const deadline = startedAt + BUDGET_MS;
  const results = new Array(MANAGERS.length);
  let next = 0;

  const worker = async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= MANAGERS.length) return;
      results[index] = await probeOne(MANAGERS[index], deadline);
    }
  };

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, MANAGERS.length) }, worker));

  const entries = new Map();
  for (let index = 0; index < MANAGERS.length; index += 1) {
    entries.set(MANAGERS[index].id, results[index] || notDetected(MANAGERS[index].id, '探测未执行'));
  }
  return {
    at: Date.now(),
    probed: MANAGERS.length,
    found: [...entries.values()].filter((entry) => entry.detected).length,
    durationMs: Date.now() - startedAt,
    entries,
  };
}

/**
 * Detect every manager in the catalog (cached 60 s unless `force`).
 *
 * @param {{force?:boolean, dryRun?:boolean}} [options] `force` re-probes everything
 *   (the `detect` action); `dryRun` synthesises a fully-detected catalog and spawns nothing.
 * @returns {Promise<{at:number, probed:number, found:number, durationMs:number,
 *   entries: Map<string, object>}>}
 */
export async function detectAll(options = {}) {
  if (options.dryRun) return syntheticDetection();
  if (!options.force) {
    const cached = cacheGet(DETECTION_CACHE_KEY);
    if (cached) return cached;
  }
  if (inFlight) return inFlight;

  inFlight = runDetection()
    .then((result) => {
      cacheSet(DETECTION_CACHE_KEY, result, TTL.detection);
      return result;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/** Detection metadata for the response envelope (`detection` field). */
export function detectionMeta(detection) {
  return {
    at: detection.at,
    probed: detection.probed,
    found: detection.found,
    durationMs: detection.durationMs,
  };
}

/** Probe entry for one manager from the latest detection (null when unknown). */
export function detectionEntry(id) {
  const detection = cacheGet(DETECTION_CACHE_KEY);
  if (!detection || !detection.entries) return null;
  return detection.entries.get(id) || null;
}

/**
 * Resolved executable path for a manager, or null when it is not detected.
 * Adapters pass this to lib/run.js so the exact same binary that was probed is spawned.
 *
 * @param {string} id manager id
 * @returns {string|null}
 */
export function binaryFor(id) {
  const def = getManager(id);
  if (!def) return null;
  const entry = detectionEntry(id);
  if (entry) return entry.detected && entry.file ? entry.file : null;
  for (const name of def.binaries || [def.id]) {
    const resolved = resolveOnPath(name);
    if (resolved) return resolved.file;
  }
  return null;
}
