// Process snapshot, item binding, kill and launch (CONTRACT §11.2.1-.6).
//
// ENGINE PRIORITY (highest first) — every response reports which one answered as `engine`:
//   1. native     `native/packdeck-procs.exe` (C#, .NET Framework, built on demand by native/
//                  build.ps1). One spawn carries the whole process table; warm refreshes are
//                  ~17 ms internally / ~45 ms wall, and platform build.ps1 has no SDK requirem.
//                  Command lines come from a per-pid on-disk cache (`--cache`), because WMI's
//                  Win32_Process class has a ~230-270 ms materialisation floor that does not
//                  shrink with a narrower filter — so it is paid once and reused.
//   2. powershell The §11.2.1 implementation kept as a fallback: one `tasklist` + one
//                  `Get-CimInstance Win32_Process` pass filtered inside PowerShell, CPU from
//                  TotalProcessorTime deltas. Used only when the native helper cannot be built
//                  or has vanished (no .NET Framework, blocked working dir, corrupt binary).
//   3. fallback   The existing JS path when PowerShell is unavailable too: the request still
//                  answers with an empty table + `degraded` note instead of failing.
//
// Process *detail* (env / cwd) has its own chain, documented in lib/procdetail.js:
//   native PEB -> psutil -> null with envError + installHint.
//
// Read-only apart from `processKillPayload()` / `launchPayload()`. Environment values and
// command lines are never logged from this module.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { badRequest, ApiError } from './errors.js';
import { decodeBuffer, oneLine } from './text.js';
import { cacheGet, cacheSet, TTL } from './cache.js';
import { detectAll } from './detect.js';
import { managerSnapshot } from './managers.js';
import { MANAGER_IDS } from './catalog.js';
import { getArpIndex, matchArpEntry, parseDisplayIcon } from './iconres.js';
import { findInstallLocation } from './winpath.js';
import { resolveExecutable } from './run.js';

const IS_WIN = process.platform === 'win32';
const KB = 1024;

/** §11.2.3: independent 3 s cache for the `processes` action. */
export const PROCESSES_TTL_MS = 3_000;
/** §11.2.6: `snapshot` waits at most this long for process data. */
export const SNAPSHOT_PROCESS_WAIT_MS = 600;
/** How long `processes` may wait for an in-flight warm-up before answering `partial`.
 *  Only ever paid on a cold host whose item build has not finished; the steady-state path
 *  (material already built by `snapshot`) returns in well under 100 ms. Kept short so the
 *  first frame still paints a loading state quickly instead of stalling the poll. */
const WARM_JOIN_MS = 1_200;

const NATIVE_BUDGET_MS = 15_000; // first call may include a build
const NATIVE_WARM_BUDGET_MS = 3_000;
const BUILD_TIMEOUT_MS = 120_000;
const CIM_BUDGET_MS = 1_200;
const TASK_LIST_BUDGET_MS = 10_000;
const EXE_LOOKUP_TTL_MS = 5 * 60_000;
const MATERIAL_TTL_MS = 60_000;
const LAST_SNAPSHOT_MAX_AGE_MS = 10_000; // kill validation window
const DETAIL_PID_LIMIT = 40;
/** Image names whose command lines the binder needs; passed to the native helper as --filter. */
const CANDIDATE_NAMES = [
  'node', 'nodejs', 'bun', 'deno', 'electron', 'npm', 'npx', 'pnpm', 'yarn', 'corepack',
  'python', 'pythonw', 'python3', 'pip', 'pip3', 'uv', 'uvx',
  'cargo', 'rustc', 'rustup', 'go', 'gopls', 'ruby', 'gem', 'bundle', 'dotnet',
  'cmd', 'powershell', 'pwsh', 'conhost', 'WindowsTerminal',
  'code', 'PinK', 'pink', 'cursor', 'windsurf',
];

const pct1 = (value) => Math.round(value * 10) / 10;

/**
 * Interpreters shared by many unrelated programs. Matching one by bare executable name would
 * attribute the whole machine to a single item, so those names only bind when the item's
 * install directory (or a package directory) is known.
 */
const GENERIC_INTERPRETERS = new Set([
  '\\node.exe', '\\nodejs.exe', '\\bun.exe', '\\deno.exe', '\\electron.exe',
  '\\python.exe', '\\pythonw.exe', '\\python3.exe', '\\pip.exe', '\\pip3.exe', '\\uv.exe', '\\uvx.exe',
  '\\cargo.exe', '\\rustc.exe', '\\go.exe', '\\ruby.exe', '\\gem.exe', '\\dotnet.exe',
  '\\npm.cmd', '\\npx.cmd', '\\pnpm.cmd', '\\yarn.cmd', '\\corepack.cmd',
  '\\cmd.exe', '\\powershell.exe', '\\pwsh.exe', '\\conhost.exe',
]);

/* ============================================================ native helper == */

const NATIVE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'native');
const NATIVE_EXE = path.join(NATIVE_DIR, 'packdeck-procs.exe');
const NATIVE_SOURCE = path.join(NATIVE_DIR, 'packdeck-procs.cs');
const NATIVE_BUILD = path.join(NATIVE_DIR, 'build.ps1');

/** `{ available, reason, builtAt }` — resolved once per host process. */
let nativeState = null;
let nativeBuildInflight = null;
let nativeCachePath = null;

/** Where the native helper keeps its command-line cache (per user, no secrets in the repo). */
function commandLineCacheFile() {
  if (nativeCachePath) return nativeCachePath;
  const base = process.env.PACKDECK_DATA_DIR || path.join(os.tmpdir(), 'packdeck');
  try {
    fs.mkdirSync(base, { recursive: true });
    nativeCachePath = path.join(base, 'procs-cmdline-cache.tsv');
  } catch {
    nativeCachePath = null;
  }
  return nativeCachePath;
}

/**
 * Ensure `packdeck-procs.exe` exists and is newer than its source.
 *
 * Runs `native/build.ps1`, which is idempotent (one stat + compare when current). Never blocks
 * a request for longer than BUILD_TIMEOUT_MS, and never throws: a failed build simply selects
 * the PowerShell engine.
 *
 * @param {{force?: boolean}} [opts]
 * @returns {Promise<{available: boolean, reason: string|null, durationMs: number}>}
 */
export async function ensureNative(opts = {}) {
  // Once the helper is known to work, never probe again in this host process: `engineStatus()`
  // and every refresh read this value directly.
  if (nativeState && nativeState.available && !opts.force) return nativeState;
  if (nativeState && !nativeState.available && !opts.force && opts.retry !== true) return nativeState;
  if (nativeBuildInflight) return nativeBuildInflight;

  nativeBuildInflight = (async () => {
    const startedAt = Date.now();
    if (!IS_WIN) {
      nativeState = { available: false, reason: '仅 Windows 支持原生进程助手', durationMs: 0 };
      return nativeState;
    }
    if (!fs.existsSync(NATIVE_BUILD) || !fs.existsSync(NATIVE_SOURCE)) {
      nativeState = { available: false, reason: '缺少 native/build.ps1 或 native/packdeck-procs.cs', durationMs: 0 };
      return nativeState;
    }
    // Fast path: a current binary is reused without starting PowerShell at all.
    if (!opts.force && fs.existsSync(NATIVE_EXE)) {
      try {
        const exeTime = fs.statSync(NATIVE_EXE).mtimeMs;
        const sourceTime = fs.statSync(NATIVE_SOURCE).mtimeMs;
        if (exeTime >= sourceTime) {
          nativeState = { available: true, reason: null, durationMs: Date.now() - startedAt, built: false };
          return nativeState;
        }
      } catch {
        /* fall through to the build script */
      }
    }
    const build = await spawnCollect(
      powershellExe(),
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', NATIVE_BUILD],
      BUILD_TIMEOUT_MS,
    );
    const available = build.code === 0 && fs.existsSync(NATIVE_EXE);
    nativeState = {
      available,
      reason: available ? null : oneLine(build.stderr || build.stdout || '原生助手不可用', 300),
      durationMs: Date.now() - startedAt,
      built: available,
    };
    return nativeState;
  })().finally(() => {
    nativeBuildInflight = null;
  });
  return nativeBuildInflight;
}

/**
 * Run the native helper and settle as soon as stdout is complete.
 *
 * The helper flushes its JSON to stdout and only then refills its command-line cache, so
 * waiting for process exit would charge the caller for work it does not need. `close` is still
 * wired up (and the child is detached from our lifetime) so a crash before stdout arrives is
 * not lost.
 *
 * @param {string[]} args helper arguments
 */
async function runNative(args) {
  const startedAt = Date.now();
  const result = await spawnCollect(NATIVE_EXE, args, NATIVE_WARM_BUDGET_MS, { settleOnStdoutEnd: true });
  const text = String(result.stdout || '').trim();
  let json = null;
  let error = null;
  if (result.timedOut) error = '原生助手超时';
  else if (!text) error = result.spawnError || '原生助手没有输出';
  else {
    try {
      json = JSON.parse(text);
    } catch (parseError) {
      error = `原生助手输出不可解析：${oneLine(String(parseError && parseError.message), 120)}`;
    }
  }
  if (!error && json && json.error) error = json.error.message || json.error.code || '原生助手返回错误';
  return {
    ok: !error,
    json,
    error,
    stderr: oneLine(result.stderr, 300),
    durationMs: Date.now() - startedAt,
    code: result.code,
  };
}

/* =============================================================== path helpers == */

/**
 * §11.2.2 canonical form: lowercase, `/` -> `\`, quotes stripped from both ends, no edge spaces.
 * @param {unknown} value raw path / command line / token
 * @returns {string}
 */
export function normalizePathText(value) {
  if (typeof value !== 'string' || value === '') return '';
  let text = value.toLowerCase().replace(/\//g, '\\');
  text = text.replace(/^"+/, '').replace(/"+$/, '');
  return text.trim();
}

function dropTrailingSeparator(text) {
  return String(text || '').replace(/\\+$/, '');
}

/**
 * `target` strictly inside `root` (both normalised). The separator boundary keeps
 * `C:\Program Files\7-Zip2` out of `C:\Program Files\7-Zip`.
 */
function pathInside(root, target) {
  if (!root || !target) return false;
  const base = dropTrailingSeparator(root);
  if (base.length < 3 || target.length <= base.length + 1) return false;
  return target.startsWith(`${base}\\`);
}

/**
 * Split a Windows command line into normalised tokens (no shell semantics).
 * @param {string} commandLine raw command line
 * @returns {string[]}
 */
export function splitCommandLine(commandLine) {
  const text = String(commandLine || '');
  if (!text) return [];
  const tokens = [];
  let current = '';
  let quoted = false;
  for (const ch of text) {
    if (ch === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && (ch === ' ' || ch === '\t')) {
      if (current) tokens.push(normalizePathText(current));
      current = '';
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(normalizePathText(current));
  return tokens;
}

function stemOf(value) {
  return String(value || '').replace(/\.(exe|com|bat|cmd|ps1)$/i, '');
}

function branded(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/* ================================================================ item model == */

/**
 * One item the binder can match.
 * @typedef {object} BindTarget
 * @property {string} id
 * @property {'app'|'pkg'} kind
 * @property {string} manager
 * @property {string[]} roots directories that may contain the item's files, longest first
 * @property {string[]} exes normalised `\name.exe` suffixes; `''` means "any exe"
 * @property {string[]} brand branded stems allowed in a command line
 * @property {string[]} names executable basenames the ARP record points at (apps only)
 * @property {string} packageRel `\<segment>\` inside `node_modules` (packages only)
 * @property {boolean} anchored the item path is known
 */

const GENERIC_ROOTS = new Set([
  'c:',
  'c:\\windows',
  'c:\\program files',
  'c:\\program files (x86)',
  'c:\\programdata',
  'c:\\users',
]);

function pushRoot(list, value) {
  const root = dropTrailingSeparator(normalizePathText(value));
  if (root.length < 4 || GENERIC_ROOTS.has(root)) return;
  if (root.split('\\').filter(Boolean).length < 2) return;
  list.push(root);
}

/**
 * Global roots per manager (§11.2.2 `pkg` rule). Environment variables, resolved manager
 * binaries and the npm/pnpm/bun roots cached during the snapshot — no extra subprocess.
 */
async function managerRoots(hasGoItems) {
  const roots = [];
  const home = process.env.USERPROFILE || os.homedir();
  const appData = process.env.APPDATA || '';
  const localAppData = process.env.LOCALAPPDATA || '';
  const add = (key, value) => {
    if (!value || typeof value !== 'string') return;
    const root = dropTrailingSeparator(normalizePathText(value));
    if (root.length < 4 || GENERIC_ROOTS.has(root)) return;
    if (roots.some((entry) => entry.key === key && entry.root === root)) return;
    roots.push({ key, root });
  };

  add('npm', cacheGet('root:npm'));
  add('pnpm', cacheGet('root:pnpm'));
  add('bun', cacheGet('root:bun'));
  add('npm', appData ? `${appData}\\npm\\node_modules` : '');
  add('yarn', localAppData ? `${localAppData}\\yarn\\bin` : '');
  add('cargo', `${home}\\.cargo\\bin`);
  add('cargo', `${home}\\.cargo\\registry\\src`);
  add('uv', appData ? `${appData}\\uv\\tools` : '');
  add('uv', localAppData ? `${localAppData}\\uv\\tools` : '');
  add('gem', localAppData ? `${localAppData}\\gem` : '');
  add('gem', `${home}\\.gem`);
  add('dotnet', `${home}\\.dotnet\\tools`);

  try {
    const detection = await detectAll();
    const pip = detection.entries.get('pip');
    if (pip && pip.file) {
      const scripts = path.dirname(pip.file);
      if (/[\\/]scripts$/i.test(scripts)) add('pip', path.dirname(scripts));
    }
    const goEntry = detection.entries.get('go');
    if (goEntry && goEntry.file) add('go', path.join(path.dirname(path.dirname(goEntry.file)), 'bin'));
  } catch {
    /* detection is optional here: item paths still bind without it */
  }

  if (hasGoItems) {
    const gopath = await goEnv('GOPATH');
    if (gopath) add('go', path.join(gopath, 'bin'));
  }
  return roots;
}

let goEnvInflight = null;

/** `go env <name>` (bounded, cached 60 s). Only called when `go` owns items. */
function goEnv(name) {
  if (goEnvInflight) return goEnvInflight;
  const cacheKey = `proc:go:${name}`;
  const cached = cacheGet(cacheKey);
  if (cached !== undefined) return Promise.resolve(cached);
  const resolved = resolveExecutable('go');
  if (!resolved) return Promise.resolve('');
  goEnvInflight = spawnCollect(resolved.file, ['env', name], 5_000)
    .then((result) => (result.code === 0 ? String(result.stdout || '').trim().split(/\r?\n/)[0] : ''))
    .then((value) => cacheSet(cacheKey, value, TTL.root))
    .finally(() => {
      goEnvInflight = null;
    });
  return goEnvInflight;
}

/**
 * Build the binder's view of the current item set.
 *
 * @param {object[]} items snapshot items
 * @returns {Promise<{targets: Map<string, BindTarget>, roots: Array<{key:string, root:string}>,
 *   arpByName: Map<string, string>}>}
 */
export async function buildTargets(items) {
  const list = Array.from(items || []);
  const roots = await managerRoots(list.some((item) => item.manager === 'go'));

  let arp = null;
  if (list.some((item) => item.kind === 'app')) {
    try {
      arp = await getArpIndex();
    } catch {
      arp = null;
    }
  }

  /** @type {Map<string, BindTarget>} */
  const targets = new Map();
  /** @type {Map<string, string>} exe basename (no extension) -> item id */
  const arpByName = new Map();

  for (const item of list) {
    // §11.2.2: extensions are not resident, they never bind.
    if (item.kind !== 'app' && item.kind !== 'pkg') continue;
    /** @type {BindTarget} */
    const target = {
      id: item.id,
      kind: item.kind,
      manager: item.manager,
      roots: [],
      exes: [],
      brand: [],
      names: [],
      packageRel: '',
      anchored: false,
    };

    if (item.kind === 'app') {
      let record = null;
      if (!item.path && arp) {
        try {
          record = matchArpEntry(arp, item);
        } catch {
          record = null;
        }
      }
      if (item.path) {
        pushRoot(target.roots, item.path);
        target.anchored = target.roots.length > 0;
      } else if (record && record.installLocation) {
        pushRoot(target.roots, record.installLocation);
      }
      if (record && record.displayIcon) {
        const icon = parseDisplayIcon(record.displayIcon);
        if (icon && icon.file && /\.exe$/i.test(icon.file)) target.names.push(stemOf(path.win32.basename(icon.file)));
      }
      const words = String(item.name || '')
        .toLowerCase()
        .split(/[\s\-_.()[\]]+/)
        .filter((word) => /^[a-z][a-z0-9]{2,}$/.test(word))
        .slice(0, 3);
      for (const word of words) target.names.push(word);
      const tail = String(item.packageId || '').split('.').pop();
      for (const candidate of [tail, String(item.name || '').split(/[\s\-_]+/)[0]]) {
        const stem = stemOf(normalizePathText(candidate));
        if (stem.length >= 3) target.exes.push(`\\${stem}.exe`);
      }
      if (target.exes.length === 0) target.exes.push('');
      target.brand = [...new Set([branded(tail), branded(words.join(''))].filter((value) => value.length >= 3))];
    } else {
      const own = dropTrailingSeparator(normalizePathText(item.path || ''));
      if (own.length >= 4) {
        pushRoot(target.roots, own);
        target.anchored = true;
        const marker = own.indexOf('\\node_modules\\');
        if (marker > 0) {
          pushRoot(target.roots, own.slice(0, marker + '\\node_modules'.length));
          const packageId = String(item.packageId || '');
          const segment = packageId.startsWith('@') ? packageId.split('/')[0] : packageId;
          target.packageRel = `\\${normalizePathText(segment)}\\`;
          target.brand.push(branded(segment));
          if (packageId.includes('/')) target.brand.push(branded(packageId.split('/')[1]));
        }
      }
      for (const entry of roots) {
        if (entry.key !== item.manager) continue;
        pushRoot(target.roots, entry.root);
      }
      const name = String(item.name || item.packageId || '');
      const leaf = stemOf(normalizePathText(name.split('/').pop()));
      if (leaf) target.exes.push(`\\bin\\${leaf}`);
      if (!target.exes.some(Boolean)) target.exes.push('');
      target.brand = [...new Set(target.brand.filter((value) => value.length >= 3))];
    }

    target.roots = [...new Set(target.roots)].sort((left, right) => right.length - left.length);
    target.exes = [...new Set(target.exes)];
    target.names = [...new Set(target.names.filter(Boolean))];
    if (target.roots.length === 0 && !target.exes.some(Boolean) && target.names.length === 0) continue;
    targets.set(item.id, target);
    if (item.kind === 'app') {
      for (const name of target.names) if (!arpByName.has(name)) arpByName.set(name, item.id);
    }
  }
  return { targets, roots, arpByName };
}

/* ============================================================== acquisition == */

/**
 * Minimal bounded spawn returning collected output (never throws).
 *
 * @param {string} file executable
 * @param {string[]} args argv
 * @param {number} timeoutMs hard timeout
 */
function spawnCollect(file, args, timeoutMs, options = {}) {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(file, args, {
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: false,
        env: { ...process.env, NO_COLOR: '1', CI: '1', FORCE_COLOR: '0' },
      });
    } catch (error) {
      resolve({ code: -1, stdout: '', stderr: '', durationMs: 0, timedOut: false, spawnError: String(error && error.message) });
      return;
    }
    const out = [];
    const err = [];
    let settled = false;
    const finish = (code, timedOut, spawnError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code,
        stdout: decodeBuffer(Buffer.concat(out)),
        stderr: decodeBuffer(Buffer.concat(err)),
        durationMs: Date.now() - startedAt,
        timedOut: Boolean(timedOut),
        spawnError: spawnError || null,
      });
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      finish(-1, true);
    }, timeoutMs);
    child.stdout?.on('data', (chunk) => {
      if (out.length < 8192) out.push(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      if (err.length < 128) err.push(chunk);
    });
    if (options.settleOnStdoutEnd) {
      // The helper writes one complete JSON document, then refills its cache for the next call.
      // Settle as soon as the document is complete; the child is left alone to finish (its
      // handles are kept referenced until `close`, so a pending cache write is not truncated).
      child.stdout?.on('data', () => {
        if (settled) return;
        const text = decodeBuffer(Buffer.concat(out)).trim();
        if (text.endsWith('}') && looksComplete(text)) finish(0, false);
      });
    }
    child.on('error', (error) => finish(-1, false, String(error && error.message)));
    child.on('close', (code) => finish(typeof code === 'number' ? code : -1));
  });
}

/** Cheap brace-balance check: true when `text` is one complete JSON document. */
function looksComplete(text) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
  }
  return depth === 0;
}

let powerShellExeCache;

function powershellExe() {
  if (powerShellExeCache !== undefined) return powerShellExeCache;
  powerShellExeCache = 'powershell.exe';
  const resolved = resolveExecutable(powerShellExeCache);
  if (resolved && resolved.kind === 'exe') powerShellExeCache = resolved.file;
  return powerShellExeCache;
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** Shared PowerShell helpers: normaliser, both 5.1-compatible. */
const PS_HELPERS = [
  '$ErrorActionPreference = "SilentlyContinue"',
  '$PSModulePath = ""',
  'function N([string]$v) { if ([string]::IsNullOrEmpty($v)) { return "" } return $v.ToLowerInvariant().Replace("/", "\\").Trim(\'"\', " ", [char]9) }',
].join('\n');

/**
 * Parse `tasklist /FO CSV /NH [/SVC]` output (PowerShell fallback engine).
 *
 * @param {string} text raw output
 * @param {boolean} withServices the command used `/SVC`
 */
export function parseTaskList(text, withServices) {
  const rows = [];
  let services = 0;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith('"')) continue;
    const fields = [];
    let current = '';
    let quoted = false;
    for (const ch of line) {
      if (ch === '"') {
        quoted = !quoted;
        continue;
      }
      if (ch === ',' && !quoted) {
        fields.push(current);
        current = '';
        continue;
      }
      current += ch;
    }
    fields.push(current);
    if (fields.length < 5) continue;
    const pid = Number(String(fields[1]).trim());
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const mem = String(fields[4]).replace(/[^\d]/g, '');
    const svc = withServices && fields.length >= 6;
    if (svc) services += 1;
    rows.push({
      pid,
      name: String(fields[0] || '').toLowerCase(),
      session: Number(String(fields[2]).replace(/[^\d]/g, '')) || 0,
      rss: (Number(mem) || 0) * KB,
      svc,
    });
  }
  return { rows, services };
}

/**
 * One CIM pass restricted in-PowerShell by path fragments (PowerShell engine only).
 *
 * @param {string[]} patterns normalised fragments
 */
async function cimProcesses(patterns) {
  const list = patterns.slice(0, 200);
  const filter = list.length > 0
    ? 'Where-Object { $e = N $_.ExecutablePath; $c = N $_.CommandLine; foreach ($f in $pat) { if ($e.Contains($f) -or $c.Contains($f)) { return $true } }; $false }'
    : 'Where-Object { $true }';
  const script = [
    PS_HELPERS,
    `$pat = @(${list.map(psQuote).join(',')})`,
    `$o = Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, ExecutablePath, CommandLine -ErrorAction SilentlyContinue | ${filter} | Select-Object -First 600 | ForEach-Object { [pscustomobject]@{ p = [int]$_.ProcessId; q = [int]$_.ParentProcessId; e = (N $_.ExecutablePath); c = (N $_.CommandLine) } }`,
    '($o | ConvertTo-Json -Compress -Depth 3)',
  ].join('\n');

  const result = await spawnCollect(
    powershellExe(),
    ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    CIM_BUDGET_MS,
  );
  if (result.spawnError || result.timedOut) {
    return { ok: false, rows: [], durationMs: result.durationMs, error: result.spawnError || 'CIM 查询超时' };
  }
  const text = String(result.stdout || '').trim();
  if (!text) return { ok: true, rows: [], durationMs: result.durationMs, error: null };
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, rows: [], durationMs: result.durationMs, error: 'CIM 输出不可解析' };
  }
  const raw = Array.isArray(parsed) ? parsed : [parsed];
  const rows = [];
  for (const row of raw) {
    const pid = Number(row && row.p);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const ppid = Number(row.q);
    rows.push({
      pid,
      ppid: Number.isInteger(ppid) && ppid > 0 ? ppid : null,
      exe: normalizePathText(typeof row.e === 'string' ? row.e : ''),
      cmd: normalizePathText(typeof row.c === 'string' ? row.c : ''),
    });
  }
  return { ok: true, rows, durationMs: result.durationMs, error: null };
}

/* ------------------------------------------------------------------ snapshot -- */

const sampleState = { at: 0, prev: new Map() }; // pid -> { tptMs } of the previous sample
const planState = { materialAt: 0, widen: 0, lastPaths: [], hadRows: false };

/** CPU% for a pid from counters (native) or the §11.2.3 delta of the previous sample. */
function applyCpu(entries, at, counters) {
  const cpus = Math.max(1, os.cpus().length || 1);
  const elapsed = at - sampleState.at;
  const next = new Map();
  for (const entry of entries) {
    if (counters) {
      const counter = counters.get(entry.pid);
      if (counter && counter.cpuPercent !== null) {
        entry.cpuPercent = counter.cpuPercent;
        continue;
      }
    }
    const before = sampleState.prev.get(entry.pid);
    next.set(entry.pid, { tptMs: entry.tptMs || 0 });
    if (!before || elapsed < 300) {
      entry.cpuPercent = null;
      continue;
    }
    const delta = (entry.tptMs || 0) - before.tptMs;
    entry.cpuPercent = delta < 0 ? null : pct1((delta / elapsed / cpus) * 100);
  }
  sampleState.prev = next;
  sampleState.at = at;
}

/**
 * §11.2.2 binder. Longest install-root prefix wins; a pid binds to at most one item.
 *
 * @param {object[]} entries mutable entries (`exe`/`cmd` filled by the acquisition stage)
 * @param {Map<string, BindTarget>} targets
 * @param {Map<string, string>} arpByName exe stem -> item id
 * @returns {Map<number, string>} pid -> item id
 */
export function bindProcesses(entries, targets, arpByName = new Map()) {
  const flat = [];
  const byExeName = new Map(); // `\name.exe` -> { id }
  const wordNames = []; // [name, itemId] longest first (apps)
  for (const target of targets.values()) {
    for (const root of target.roots) flat.push({ root, target });
    for (const suffix of target.exes) {
      if (!suffix) continue;
      if (!byExeName.has(suffix)) byExeName.set(suffix, { id: target.id });
    }
    if (target.kind !== 'app') continue;
    for (const name of target.names) if (name.length >= 4) wordNames.push([name, target.id]);
  }
  flat.sort((left, right) => right.root.length - left.root.length);
  wordNames.sort((left, right) => right[0].length - left[0].length);

  const bindings = new Map();
  for (const entry of entries) {
    let itemId = null;
    let reason = '';
    const exeName = entry.exe ? `\\${path.win32.basename(entry.exe)}` : entry.name ? `\\${entry.name}` : '';

    // 1. Install root contains the executable (longest root first).
    if (entry.exe) {
      for (const item of flat) {
        if (!pathInside(item.root, entry.exe)) continue;
        // §11.2.2 tightening: an *app* root only claims an executable that looks like the app's
        // own binary. Without this a language runtime installed under `C:\Program Files` would
        // absorb every node/python process on the machine just because it lives in a package
        // root. The exe must sit at most one directory below the root and match the item's
        // executable name (or, when the item names no executable, any exe is acceptable at depth 1).
        if (item.target.kind === 'app' && item.target.exes.some(Boolean)) {
          const relative = entry.exe.slice(dropTrailingSeparator(item.root).length + 1);
          const depth = relative.split('\\').length;
          const named = item.target.exes.some((suffix) => suffix && exeName.endsWith(suffix));
          if (!named && depth > 2) continue;
          if (!named && /[\\](node|npm|npx|pnpm|yarn|bun|deno|python|pythonw|pip|uv|uvx|cargo|rustc|go|ruby|gem|dotnet|java|electron|powershell|pwsh|cmd)\.exe$/i.test(entry.exe)) {
            continue; // a shared interpreter inside an app folder is not that app
          }
        }
        itemId = item.target.id;
        reason = 'path';
        break;
      }
    }
    // 2. Packages win over apps: a command line naming a package directory is stronger evidence
    //    than an executable that merely lives under some application folder.
    if (!itemId && entry.cmd) {
      for (const item of flat) {
        if (item.target.kind !== 'pkg') continue;
        if (!entry.cmd.includes(item.root)) continue;
        if (item.target.packageRel) {
          if (!entry.cmd.includes(item.target.packageRel)) continue;
          if (item.target.brand.length > 0 && !item.target.brand.some((value) => entry.cmd.includes(value))) continue;
        }
        itemId = item.target.id;
        reason = 'cmdline';
        break;
      }
    }
    // 3. Executable name equals the item's binary. A *generic interpreter* name (`node.exe`,
    //    `python.exe`) only ever binds when the process' own executable sits inside the item's
    //    install directory: otherwise every Node.js on the machine would be attributed to
    //    whatever app happens to ship one.
    if (!itemId && exeName) {
      const known = byExeName.get(exeName);
      if (known) {
        const target = targets.get(known.id);
        const genericInterpreter = GENERIC_INTERPRETERS.has(exeName);
        const insideRoot = Boolean(entry.exe) && target.roots.some((root) => pathInside(root, entry.exe));
        if (target && (target.kind === 'pkg' || insideRoot || !genericInterpreter)) {
          itemId = known.id;
          reason = 'exe';
        }
      }
    }
    // 4. Apps: the executable basename the item's ARP record points at, provided the process is
    //    the one installed in that directory (otherwise unrelated same-named binaries bind).
    if (!itemId && entry.exe && arpByName.size > 0) {
      const known = arpByName.get(stemOf(path.win32.basename(entry.exe)));
      if (known && targets.has(known)) {
        const target = targets.get(known);
        const inside = target.roots.some((root) => pathInside(root, entry.exe));
        if (inside) {
          itemId = known;
          reason = 'exe';
        }
      }
    }
    // 5. Apps: a name word of the item appears as an executable in the command line.
    if (!itemId && entry.cmd) {
      for (const [name, candidate] of wordNames) {
        if (!entry.cmd.includes(`\\${name}.exe`) && !entry.cmd.includes(`"${name}"`)) continue;
        itemId = candidate;
        reason = 'word';
        break;
      }
    }
    if (!itemId) continue;
    entry.match = reason;
    bindings.set(entry.pid, itemId);
  }
  return bindings;
}

/**
 * Choose the PowerShell CIM filter for this refresh (fallback engine only).
 * @param {object} material getMaterial() value
 */
function planQuery(material) {
  if (material.at !== planState.materialAt) {
    planState.materialAt = material.at;
    planState.widen = 0;
  }
  const patterns = new Set();
  for (const target of material.targets.values()) {
    if (target.roots.length === 0) continue;
    patterns.add(target.roots[target.roots.length - 1]);
  }
  for (const value of planState.lastPaths) if (value.length >= 12) patterns.add(value);
  if (!planState.hadRows && planState.widen >= 1) {
    for (const entry of material.roots) if (entry.root.length >= 12) patterns.add(entry.root);
  }
  const list = [...patterns].filter((value) => value.length >= 10).sort((left, right) => right.length - left.length);
  if (list.length === 0 || planState.widen >= 2) return { patterns: [], unfiltered: true };
  return { patterns: list.slice(0, 200), unfiltered: false };
}

/** Map a native helper row onto the internal entry shape. */
function entryFromNative(row, counters) {
  const name = String(row.name || '').toLowerCase();
  const counter = counters ? counters.get(row.pid) : null;
  return {
    pid: row.pid,
    ppid: Number.isInteger(row.ppid) ? row.ppid : counter ? counter.ppid : null,
    name,
    exe: normalizePathText(row.exe || ''),
    cmd: normalizePathText(row.cmdline || ''),
    rss: Number(row.rssBytes) || 0,
    tptMs: Number(row.cpuTicks) ? Number(row.cpuTicks) / 10000 : 0,
    startedAt: Number.isFinite(row.startedAt) ? row.startedAt : null,
    threads: counter ? counter.threads : 0,
    status: null,
    user: null,
    session: Number(row.session) || 0,
    cpuPercent: counter ? counter.cpuPercent : null,
    match: '',
    svc: false,
    candidate: row.candidate === true,
  };
}

/**
 * One refresh. Never throws. Picks the native engine first, PowerShell second.
 *
 * @returns {Promise<{entries:object[], bindings:Map<number,string>, info:object}>}
 */
async function refresh() {
  return refreshWith(await getMaterial());
}

/**
 * One refresh against an already-resolved item set.
 *
 * @param {object} material getMaterial() value
 */
async function refreshWith(material) {
  const startedAt = Date.now();
  const state = await ensureNative();
  if (state.available) {
    // The helper carries its own candidate filter (interpreters, managers, editors). Passing
    // ours would just shift the candidate set between calls and defeat the command-line cache.
    // `--wmi async` returns the .NET table immediately (18-100 ms) and refills the command-line
    // cache afterwards; a candidate without a cached command line simply binds on `exe` alone,
    // which is enough for §11.2.2 root matching. `wait` would add the ~230-270 ms WMI floor to
    // every refresh that sees a single new process.
    const args = ['processes', '--wmi', 'async'];
    const cacheFile = commandLineCacheFile();
    if (cacheFile) args.push('--cache', cacheFile);
    const native = await runNative(args);
    if (native.ok && native.json && Array.isArray(native.json.processes)) {
      const payload = native.json;
      const entries = payload.processes.map((row) => entryFromNative(row, null));
      const bindings = bindProcesses(entries, material.targets, material.arpByName);
      applyCpu(entries, startedAt, null);
      const info = {
        engine: 'native',
        durationMs: Date.now() - startedAt,
        nativeMs: native.durationMs,
        timings: payload.timings || null,
        totals: payload.totals || null,
        degraded: null,
      };
      rememberPlan(material, entries, bindings);
      return { entries, bindings, info };
    }
    nativeState = { ...state, available: false, reason: native.error || '原生助手调用失败' };
  }

  // ---- PowerShell fallback (CONTRACT §11.2.1 shape) ----
  const plan = planQuery(material);
  const [list, cim] = await Promise.all([
    spawnCollect('tasklist', ['/FO', 'CSV', '/NH', '/SVC'], TASK_LIST_BUDGET_MS),
    cimProcesses(plan.patterns),
  ]);
  const info = {
    engine: 'powershell',
    durationMs: 0,
    listMs: list.durationMs,
    cimMs: cim.durationMs,
    patterns: plan.patterns.length,
    degraded: null,
  };
  if (list.code !== 0 || !String(list.stdout || '').trim()) {
    info.degraded = '无法读取进程列表（tasklist 与原生助手均不可用）';
    info.durationMs = Date.now() - startedAt;
    return { entries: [], bindings: new Map(), info };
  }
  if (!cim.ok) info.degraded = cim.error;
  const parsed = parseTaskList(list.stdout, true);
  const where = new Map();
  for (const row of cim.rows) where.set(row.pid, row);
  const entries = parsed.rows.map((row) => {
    const location = where.get(row.pid);
    return {
      pid: row.pid,
      ppid: location ? location.ppid : null,
      name: row.name,
      exe: location ? location.exe : '',
      cmd: location ? location.cmd : '',
      rss: row.rss,
      tptMs: 0,
      startedAt: null,
      threads: 0,
      status: null,
      user: null,
      session: row.session,
      cpuPercent: null,
      match: '',
      svc: row.svc,
      candidate: false,
    };
  });
  const bindings = bindProcesses(entries, material.targets, material.arpByName);
  applyCpu(entries, startedAt, null);
  rememberPlan(material, entries, bindings);
  info.durationMs = Date.now() - startedAt;
  return { entries, bindings, info };
}

/** Feed the widening heuristics for the next refresh. */
function rememberPlan(material, entries, bindings) {
  planState.hadRows = bindings.size > 0;
  planState.lastPaths = [];
  for (const pid of bindings.keys()) {
    const entry = entries.find((item) => item.pid === pid);
    if (!entry || !entry.exe) continue;
    const cut = entry.exe.lastIndexOf('\\');
    if (cut > 3) planState.lastPaths.push(entry.exe.slice(0, cut));
  }
}

/* ------------------------------------------------------------------- material -- */

let materialInflight = null;
const materialCache = { at: 0, value: null };
/** One-shot guard so a cold host triggers at most one background load. */
let warmUpKicked = false;

/**
 * Build binding material from an explicit item list (no `managerSnapshot`).
 *
 * @param {object[]} items snapshot items, already resolved by lib/api.js
 * @param {string} [source] `tier1` (cached managers) | `tier2` (full catalog) | `snapshot`
 * @returns {Promise<object>} material value
 */
async function buildMaterialFromItems(items, source = 'snapshot') {
  const list = Array.isArray(items) ? items : [];
  const built = await buildTargets(list);
  return {
    at: Date.now(),
    items: list,
    itemsById: new Map(list.map((item) => [item.id, item])),
    targets: built.targets,
    roots: built.roots,
    arpByName: built.arpByName,
    partial: false,
    fromSnapshot: true,
    source,
  };
}

/**
 * Which load produced the material behind one `processes` response.
 *
 * @param {object|null} material the material the bind used
 * @param {object|null} staged the material the warm path returned before the refresh
 * @returns {'tier1'|'full'|'empty'}
 */
function materialSourceOf(material, staged) {
  if (!material || !(material.targets instanceof Map) || material.targets.size === 0) return 'empty';
  const source = material.source || (staged && staged.source) || null;
  if (source === 'tier1') return 'tier1';
  if (source === 'tier2' || source === 'snapshot') return 'full';
  return material.partial === true ? 'empty' : 'full';
}

/**
 * Binding material for the current item set.
 *
 * `processes` must answer inside 400 ms, so the default path only ever reads what is already
 * cached and hands back `emptyMaterial()` otherwise; the expensive load runs behind the caller.
 *
 * Cold cost is NOT one manager pass: the editor/CLI probes (`npm`/`pip`/`vscode`… each ~2-3 s)
 * run inside every `managerSnapshot`, so a cold sweep measured ~19 s in total even in parallel.
 * The load therefore runs in two tiers and publishes each tier as soon as it is complete:
 *   tier 1 — the managers that appear in the current package snapshot (usually already cached
 *            from the `snapshot` the user triggered), published first;
 *   tier 2 — the rest of the catalog, loaded in the background and published when done.
 * `processes` reports `partial: true` only until tier 1 lands.
 *
 * @param {{allowCold?: boolean}} [opts] `allowCold` waits for the load (warmUp only)
 */
async function getMaterial(opts = {}) {
  if (materialCache.value && Date.now() - materialCache.at < MATERIAL_TTL_MS) return materialCache.value;
  if (materialInflight) {
    // A load already runs: join it only when the caller can afford to wait.
    return opts.allowCold ? materialInflight : (materialCache.value || emptyMaterial());
  }
  const load = (async () => {
    // Tier 1: whatever a recent snapshot already knows about (usually warm from `managerSnapshot`).
    const ready = [];
    const rest = [];
    for (const id of MANAGER_IDS) {
      const cached = tryCachedManagerItems(id);
      if (cached) ready.push(...cached);
      else rest.push(id);
    }
    if (ready.length > 0) {
      const first = await buildMaterialFromItems(ready, 'tier1');
      materialCache.at = Date.now();
      materialCache.value = first;
    }
    // Tier 2: the remaining managers, plus anything the snapshot knows that is newer.
    const results = await Promise.all(rest.map((id) => managerSnapshot(id, {}).catch(() => ({ items: [] }))));
    const items = ready.concat(results.flatMap((result) => (Array.isArray(result.items) ? result.items : [])));
    const value = await buildMaterialFromItems(items, ready.length > 0 ? 'tier2' : 'full');
    materialCache.at = value.at;
    materialCache.value = value;
    return value;
  })().finally(() => {
    materialInflight = null;
  });
  materialInflight = load;
  if (opts.allowCold) return load;
  // Warm path: answer immediately with the previous (or empty) material.
  load.catch(() => {});
  return materialCache.value || emptyMaterial();
}

/**
 * Items a recent `managerSnapshot` already holds. Reading the public snapshot cache lets the
 * process layer reuse the exact sweep the user's `snapshot` request paid for.
 *
 * @param {string} managerId catalog id
 * @returns {object[] | null} items, or null when this manager has no fresh cache entry
 */
function tryCachedManagerItems(managerId) {
  try {
    const cached = cacheGet(`snapshot:${managerId}`);
    if (cached && Array.isArray(cached.items)) return cached.items;
  } catch {
    /* cache helper unavailable: fall through to the full load */
  }
  return null;
}

/** Placeholder material for the first paint of a cold host. */
function emptyMaterial() {
  return {
    at: 0,
    items: [],
    itemsById: new Map(),
    targets: new Map(),
    roots: [],
    arpByName: new Map(),
    partial: true,
  };
}

/**
 * Idempotent warm-up for the binding material, plus one process refresh.
 *
 * Two call sites:
 *  - `lib/api.js` calls `warmUp(snapshotItems)` after a successful `snapshot`, so the targets are
 *    built straight from items the snapshot already produced (no second `managerSnapshot` sweep —
 *    that duplicate sweep was the 19 s cold start);
 *  - `processes` / `process-detail` call `warmUp()` lazily on their first invocation, which falls
 *    back to `getMaterial({ allowCold: true })`.
 *
 * Never throws, and never runs more than one load at a time.
 *
 * @param {object[]} [items] snapshot items to build targets from
 * @returns {Promise<boolean>} true when material is ready afterwards
 */
export function warmUp(items) {
  if (Array.isArray(items) && items.length > 0) {
    // Fresh items from a snapshot: rebuild targets directly, replacing whatever was cached.
    if (materialInflight) return materialInflight.then(() => true, () => false);
    materialInflight = (async () => {
      const value = await buildMaterialFromItems(items, 'snapshot');
      materialCache.at = value.at;
      materialCache.value = value;
      return value;
    })()
      .then(() => true, () => false)
      .finally(() => {
        materialInflight = null;
      });
    warmUpKicked = true;
    return materialInflight;
  }
  if (materialCache.value && Date.now() - materialCache.at < MATERIAL_TTL_MS) return Promise.resolve(true);
  if (materialInflight) return materialInflight.then(() => true, () => false);
  warmUpKicked = true;
  return getMaterial({ allowCold: true }).then(() => true, () => false);
}

/* ------------------------------------------------------------------ processes -- */

let inflight = null;
let lastSnapshot = null; // { at, entries, bindings }

function totalsOf(entries, bindings, targets) {
  const acc = new Map();
  for (const entry of entries) {
    const itemId = bindings.get(entry.pid);
    if (!itemId) continue;
    let sum = acc.get(itemId);
    if (!sum) {
      sum = { procCount: 0, cpuPercent: 0, cpuKnown: false, rssBytes: 0 };
      acc.set(itemId, sum);
    }
    sum.procCount += 1;
    sum.rssBytes += entry.rss || 0;
    if (entry.cpuPercent !== null) {
      sum.cpuPercent += entry.cpuPercent;
      sum.cpuKnown = true;
    }
  }
  const items = [];
  for (const [itemId, sum] of acc) {
    const target = targets.get(itemId);
    items.push({
      id: itemId,
      manager: target ? target.manager : itemId.split(':')[0],
      procCount: sum.procCount,
      cpuPercent: sum.cpuKnown ? pct1(sum.cpuPercent) : null,
      rssBytes: sum.rssBytes,
    });
  }
  items.sort((left, right) => right.procCount - left.procCount || right.rssBytes - left.rssBytes || left.id.localeCompare(right.id));
  return items;
}

/**
 * §11.2.3 `processes` payload (independent 3 s cache, coalesced).
 *
 * Never waits for a cold item set: while the package snapshot is still being resolved the
 * payload reports `partial: true` with whatever it can bind (usually nothing), and one
 * background warm-up is kicked off so the next poll already has targets.
 *
 * @param {{force?:boolean}} [opts]
 */
export async function processesPayload(opts = {}) {
  if (!opts.force) {
    const cached = cacheGet('procs:processes');
    // A cached answer computed while the item set was still a placeholder is worth less than a
    // fresh one: the material may have landed in the meantime (the `snapshot` warm-up finishes
    // within a few seconds). Re-derive in that case instead of repeating `items: []`.
    if (cached && (cached.partial !== true || cached.materialReady === true)) return cached;
  }
  if (inflight) return inflight;

  inflight = (async () => {
    const startedAt = Date.now();
    const stageMaterial = await timed(async () => {
      let material = await getMaterial({ allowCold: false });
      if (material.partial === true) {
        if (warmUpKicked || materialInflight) {
          /* A warm-up is ALREADY building the item set for this very host generation — almost
           * always the one `snapshot` kicked off moments ago. Answering now would bind against
           * the empty placeholder and cache `matched: 0` for 3 s, which is exactly the "第一个
           * 3 秒没有任何进程" the panel showed. Wait for that in-flight warm-up instead; it is
           * bounded by the item build the user just paid for, not by a second sweep. */
          const waiting = materialInflight || Promise.resolve(true);
          await Promise.race([waiting.catch(() => true), new Promise((r) => setTimeout(r, WARM_JOIN_MS))]);
          material = (materialCache.value && materialCache.value.partial !== true) ? materialCache.value : await getMaterial({ allowCold: false });
        } else {
          // First call on a cold host: load the item set behind this response.
          warmUp().catch(() => {});
        }
      }
      return material;
    });
    const stageNative = await timed(() => refreshWith(stageMaterial.value));
    const snapshot = stageNative.value;
    const material = materialCache.value || stageMaterial.value;
    // Bind whenever the material carries targets. `partial` only distinguishes a placeholder
    // (`emptyMaterial()`, no item set at all) from a real one: a tier1 load built from the
    // snapshot's own items is complete enough to bind, and reporting it as partial would throw
    // away the very result the caller just paid for.
    const hasTargets = material && material.targets instanceof Map && material.targets.size > 0;
    const partial = !hasTargets;
    const stageBind = await timed(async () => (hasTargets ? totalsOf(snapshot.entries, snapshot.bindings, material.targets) : []));
    const payload = {
      at: Date.now(),
      durationMs: Date.now() - startedAt,
      engine: snapshot.info.engine,
      items: stageBind.value,
      partial,
      materialReady: hasTargets,
      materialSource: materialSourceOf(material, stageMaterial.value),
      totals: {
        processes: snapshot.entries.length,
        matched: stageBind.value.reduce((sum, item) => sum + item.procCount, 0),
        runningItems: stageBind.value.length,
      },
      timings: {
        material: stageMaterial.ms,
        native: snapshot.info.nativeMs || snapshot.info.durationMs || 0,
        bind: stageBind.ms,
        total: Date.now() - startedAt,
        partial,
        engine: snapshot.info,
      },
    };
    lastSnapshot = { at: payload.at, entries: snapshot.entries, bindings: snapshot.bindings, partial };
    cacheSet('procs:processes', payload, PROCESSES_TTL_MS);
    return payload;
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

/** Run one async stage and report how long it took. */
async function timed(fn) {
  const startedAt = Date.now();
  const value = await fn();
  return { value, ms: Date.now() - startedAt };
}

/** §11.2.6: process data for `snapshot`, `null` when it does not arrive within `ms`. */
export async function snapshotProcesses(ms = SNAPSHOT_PROCESS_WAIT_MS) {
  if (!IS_WIN) return null;
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), Math.max(0, ms));
  });
  const task = processesPayload().catch(() => null);
  task.catch(() => {});
  try {
    return await Promise.race([task, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/* --------------------------------------------------------------------- detail -- */

/**
 * Bound pids of one item, taken from the MOST RECENT binding snapshot only.
 *
 * `process-detail` must answer in well under the 1.5 s budget, so it never resolves the package
 * snapshot itself: without a recent `processes` there is simply nothing to describe yet.
 *
 * @param {string} itemId
 * @returns {Promise<{item: object, entries: object[]}>}
 */
export async function boundEntries(itemId) {
  if (!lastSnapshot) throw badRequest('尚未采集到进程快照');
  const material = materialCache.value;
  const item = material ? material.itemsById.get(itemId) : null;
  if (!item) {
    // A partial first frame (no item set yet) cannot answer for a specific item; say so instead
    // of pretending the item does not exist.
    if (lastSnapshot.partial === true) throw badRequest('尚未采集到进程快照');
    throw badRequest(`未找到条目 ${itemId}`);
  }
  const entries = [];
  for (const entry of lastSnapshot.entries) {
    if (lastSnapshot.bindings.get(entry.pid) === itemId) entries.push(entry);
  }
  entries.sort((left, right) => (right.rss || 0) - (left.rss || 0) || left.pid - right.pid);
  return { item, entries };
}

/**
 * Item lookup for the launch path. Uses cached material and warms it up when needed; launch is
 * an explicit user action so it may pay for a load.
 *
 * @param {string} itemId
 */
export async function getItemAndMaterial(itemId) {
  const material = await getMaterial({ allowCold: true });
  return { item: material.itemsById.get(itemId) || null, material };
}

/** Native `detail` call: cwd/env for a handful of pids. Null when the engine is unavailable. */
export async function nativeDetail(pids) {
  const state = await ensureNative();
  if (!state.available || pids.length === 0) return null;
  const args = ['detail', ...pids.map(String)];
  const cacheFile = commandLineCacheFile();
  if (cacheFile) args.push('--cache', cacheFile);
  const native = await runNative(args);
  if (!native.ok || !native.json || !Array.isArray(native.json.processes)) return null;
  return { rows: native.json.processes, durationMs: native.durationMs, timings: native.json.timings || null };
}

/* ----------------------------------------------------------------------- kill -- */

/**
 * §11.2.5 `process-kill`: only pids bound in the most recent snapshot.
 *
 * @param {{pid?:unknown, id?:unknown, dryRun?:boolean}} body
 */
export async function processKillPayload(body) {
  const pid = Number(body && body.pid);
  if (!Number.isInteger(pid) || pid <= 0 || pid > 4_294_967_295) throw badRequest('缺少合法的 pid');
  const itemId = typeof (body && body.id) === 'string' ? body.id.trim() : '';

  if (!lastSnapshot || Date.now() - lastSnapshot.at > LAST_SNAPSHOT_MAX_AGE_MS) {
    await processesPayload({ force: false }).catch(() => null);
  }
  const boundId = lastSnapshot ? lastSnapshot.bindings.get(pid) : undefined;
  const fresh = lastSnapshot && Date.now() - lastSnapshot.at <= LAST_SNAPSHOT_MAX_AGE_MS;
  if (!fresh || boundId === undefined || boundId === null || pid === process.pid || pid === process.ppid) {
    throw badRequest('该 PID 不属于任何已管理条目');
  }
  if (itemId && boundId !== itemId) throw badRequest('该 PID 不属于该条目');

  if (body && body.dryRun) {
    return { dryRun: true, pid, killed: false, id: boundId, command: `taskkill /PID ${pid} /F` };
  }

  const startedAt = Date.now();
  // Native helper first; taskkill is the documented fallback (§11.2.5 uses taskkill /PID /F).
  const state = await ensureNative();
  let result = null;
  if (state.available) {
    const native = await runNative(['kill', String(pid)]);
    if (native.ok) result = { code: 0, output: '' };
  }
  if (!result) {
    result = await spawnCollect('taskkill', ['/PID', String(pid), '/F'], 15_000);
    result.output = oneLine(result.stderr || result.stdout, 400);
  }
  if (result.code !== 0) {
    throw new ApiError('command-failed', `结束进程 ${pid} 失败：${result.output || `退出码 ${result.code}`}`, result.output || null);
  }
  // The pid is gone: drop it from the cached snapshot so the next poll agrees immediately.
  if (lastSnapshot) lastSnapshot.bindings.delete(pid);
  cacheSet('procs:processes', 0, 0);
  return { pid, killed: true, id: boundId, durationMs: Date.now() - startedAt };
}

/* --------------------------------------------------------------------- launch -- */

const PROGRAM_SUFFIXES = new Set(['.exe', '.com', '.bat', '.cmd']);

function existingProgram(file) {
  if (!file) return '';
  if (!PROGRAM_SUFFIXES.has(path.win32.extname(file).toLowerCase())) return '';
  try {
    return fs.statSync(file).isFile() ? file : '';
  } catch {
    return '';
  }
}

/**
 * The executable that represents an application directory: a single top-level `.exe`, or the
 * one whose name matches the folder. Installer/uninstaller helpers are ignored.
 *
 * @param {string} dir absolute directory
 * @returns {Promise<string>} executable stem (lower case, no extension) or `''`
 */
export async function singleExeIn(dir) {
  const key = `proc:exe:${normalizePathText(dir)}`;
  const cached = cacheGet(key);
  if (cached !== undefined) return cached;
  let stem = '';
  try {
    const dirents = await fsp.readdir(dir, { withFileTypes: true });
    const exes = [];
    for (const dirent of dirents) {
      if (!dirent.isFile() || !/\.exe$/i.test(dirent.name)) continue;
      const lower = dirent.name.toLowerCase();
      if (/^(unins|uninstall|setup|update|updater|maintenancetool|elevate|squirrel|vc_redist|vcredist|python|pythonw|crashpad)/.test(lower)) continue;
      exes.push(path.win32.basename(lower, '.exe'));
    }
    if (exes.length === 1) {
      stem = exes[0];
    } else if (exes.length > 1) {
      const folder = path.win32.basename(dropTrailingSeparator(String(dir))).toLowerCase().replace(/[^a-z0-9]/g, '');
      stem = exes.find((exe) => exe.replace(/[^a-z0-9]/g, '') === folder) || '';
    }
  } catch {
    stem = '';
  }
  return cacheSet(key, stem, EXE_LOOKUP_TTL_MS);
}

/**
 * Best-effort ARP lookup that does not require a `DisplayIcon`: launch only needs an install
 * directory or an icon path, and plenty of records carry just one of the two.
 *
 * @param {object} arp result of getArpIndex()
 * @param {object} item snapshot item
 * @returns {{installLocation?: string, displayIcon?: string}|null}
 */
function findArpByName(arp, item) {
  if (!arp || !Array.isArray(arp.entries)) return null;
  const wanted = String(item.name || '').trim().toLowerCase();
  if (!wanted) return null;
  const wantedLoose = wanted.replace(/\s*\((?:x64|x86|64-bit|32-bit)\)\s*$/i, '').trim();
  let loose = null;
  for (const entry of arp.entries) {
    const name = String(entry.displayName || '').trim().toLowerCase();
    if (!name || (!entry.installLocation && !entry.displayIcon)) continue;
    if (name === wanted) return entry;
    if (!loose && name === wantedLoose) loose = entry;
  }
  return loose;
}

/**
 * §11.3.5 executable resolution: `item.path` -> ARP `DisplayIcon` -> `InstallLocation` scan.
 *
 * @param {object} item snapshot item
 */
export async function resolveLaunchExecutable(item) {
  if (!item || item.kind !== 'app') return null;

  if (item.path) {
    const direct = existingProgram(item.path);
    if (direct) return { exe: direct, source: 'path' };
    const stem = await singleExeIn(item.path);
    const candidate = stem ? existingProgram(path.win32.join(item.path, `${stem}.exe`)) : '';
    if (candidate) return { exe: candidate, source: 'path' };
  }

  let record = null;
  try {
    const arp = await getArpIndex();
    record = arp ? matchArpEntry(arp, item) : null;
    // `matchArpEntry` only returns records that carry a DisplayIcon (icon resolution needs it).
    // Launching only needs an install location, so fall back to a name lookup over every record.
    if (!record && arp) record = findArpByName(arp, item);
  } catch {
    record = null;
  }
  if (!record) {
    try {
      const location = await findInstallLocation(item.name);
      if (location) record = { installLocation: location, displayIcon: '' };
    } catch {
      record = null;
    }
  }
  if (!record) return null;

  if (record.displayIcon) {
    const icon = parseDisplayIcon(record.displayIcon);
    const program = icon && icon.file ? existingProgram(icon.file) : '';
    if (program) return { exe: program, source: 'displayIcon' };
  }
  if (record.installLocation) {
    const stem = await singleExeIn(record.installLocation);
    const program = stem ? existingProgram(path.win32.join(record.installLocation, `${stem}.exe`)) : '';
    if (program) return { exe: program, source: 'installLocation' };
  }
  return null;
}

/**
 * §11.2.5 / §11.3.5 `launch`: detached spawn of the app executable; `bad-request` when it
 * cannot be located. Packages and extensions are refused on principle.
 *
 * @param {{id?:unknown, dryRun?:boolean}} body
 */
export async function launchPayload(body) {
  const itemId = typeof (body && body.id) === 'string' ? body.id.trim() : '';
  if (!itemId) throw badRequest('缺少 id');
  const material = await getMaterial({ allowCold: true });
  const item = material.itemsById.get(itemId);
  if (!item) throw badRequest(`未找到条目 ${itemId}`);
  if (item.kind !== 'app') throw badRequest('只有应用程序可以启动');
  const resolved = await resolveLaunchExecutable(item);
  if (!resolved) throw badRequest('找不到可执行文件');
  if (body && body.dryRun) return { dryRun: true, id: itemId, exe: resolved.exe, source: resolved.source };

  let child;
  try {
    child = spawn(resolved.exe, [], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      cwd: path.win32.dirname(resolved.exe),
    });
  } catch (error) {
    throw new ApiError('command-failed', `无法启动：${oneLine(error && error.message, 200)}`, null);
  }
  child.on('error', () => {});
  child.unref();
  return { id: itemId, launched: true, exe: resolved.exe, source: resolved.source };
}

/* ----------------------------------------------------------------- bookkeeping -- */

/** Engine status for diagnostics (tools/probe.mjs and the response `engine` field). */
export async function engineStatus() {
  const state = await ensureNative();
  return {
    ...state,
    exe: NATIVE_EXE,
    source: NATIVE_SOURCE,
    cache: commandLineCacheFile(),
  };
}

/** Drop every cached piece of process state (tools/probe.mjs only). */
export function resetProcessState() {
  lastSnapshot = null;
  inflight = null;
  materialInflight = null;
  materialCache.at = 0;
  materialCache.value = null;
  warmUpKicked = false;
  sampleState.at = 0;
  sampleState.prev = new Map();
  planState.materialAt = 0;
  planState.widen = 0;
  planState.lastPaths = [];
  planState.hadRows = false;
}

/** Last acquired snapshot (pid -> item id), for tools/probe.mjs evidence. */
export function lastSnapshotView() {
  return lastSnapshot;
}

export const detailPidLimit = DETAIL_PID_LIMIT;
