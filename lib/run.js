// Unified child-process runner.
// - spawn(..., { shell: false, windowsHide: true }) for real executables.
// - Windows `.cmd` / `.bat` shims cannot be spawned directly on modern Node
//   (EINVAL), so they go through `cmd.exe /d /s /c "<quoted command>"`.
// - `.ps1`-only shims go through powershell.exe -File.
// - stdout/stderr are capped at 256 KiB each, ANSI + `\r` overwrite removed by text.js.
// - On timeout the whole process tree is killed (taskkill /T /F on win32).
// - Child spawns are capped at 4 concurrently; mutations are serialised through a queue.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { badRequest, unavailable } from './errors.js';
import { decodeBuffer } from './text.js';
import { getManager, isManagerId } from './catalog.js';

const IS_WIN = process.platform === 'win32';
const MAX_STREAM_BYTES = 256 * 1024;
const MAX_CHILDREN = 4;
const BASE_ENV = { NO_COLOR: '1', CI: '1', FORCE_COLOR: '0' };

/* ------------------------------------------------------------------ limiter */

let activeChildren = 0;
const waiting = [];

function acquireSlot() {
  if (activeChildren < MAX_CHILDREN) {
    activeChildren += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiting.push(resolve));
}

function releaseSlot() {
  const next = waiting.shift();
  if (next) next(); // hand the slot over; activeChildren stays the same
  else activeChildren -= 1;
}

/* --------------------------------------------------------------- resolution */

const resolutionCache = new Map();

function candidatePaths(name) {
  const candidates = [];
  const override = process.env[`PACKDECK_${name.toUpperCase()}_BIN`];
  if (override) candidates.push(override);

  if (IS_WIN) {
    const localAppData = process.env.LOCALAPPDATA || '';
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
    const nodeDir = path.dirname(process.execPath);
    if (name === 'winget') {
      if (localAppData) candidates.push(path.join(localAppData, 'Microsoft', 'WindowsApps', 'winget.exe'));
      candidates.push(path.join(programFiles, 'WindowsApps', 'winget.exe'));
    }
    if (name === 'bun') {
      candidates.push(path.join(os.homedir(), '.bun', 'bin', 'bun.exe'));
      candidates.push(path.join(os.homedir(), '.bun', 'bin', 'bun'));
    }
    if (name === 'npm' || name === 'pnpm' || name === 'npx') {
      candidates.push(path.join(nodeDir, `${name}.cmd`));
      candidates.push(path.join(nodeDir, `${name}.exe`));
      candidates.push(path.join(nodeDir, `${name}.ps1`));
    }
    const pathDirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
    for (const dir of pathDirs) {
      for (const ext of ['.exe', '.cmd', '.bat', '.ps1', '']) {
        if (ext) candidates.push(path.join(dir, name + ext));
      }
    }
  } else {
    for (const dir of String(process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
      candidates.push(path.join(dir, name));
    }
  }
  return candidates;
}

function kindOf(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.cmd' || ext === '.bat') return 'cmd';
  if (ext === '.ps1') return 'ps1';
  return 'exe';
}

/**
 * Locate a tool. Logical names (`winget`, `npm`, `pnpm`, `bun`) are resolved against
 * well-known install locations first, then PATH. Returns `{ file, kind }` or null.
 */
export function resolveExecutable(name) {
  if (typeof name !== 'string' || !name) return null;
  if (name.includes('/') || name.includes('\\')) {
    const file = name;
    // App Execution Aliases (winget.exe under WindowsApps) are reparse points whose target
    // cannot be stat()ed; lstat() is the existence check that works for both.
    try {
      const stat = fs.lstatSync(file);
      return stat.isFile() || stat.isSymbolicLink() ? { file, kind: kindOf(file) } : null;
    } catch {
      return null;
    }
  }
  if (resolutionCache.has(name)) return resolutionCache.get(name);
  let found = null;
  for (const candidate of candidatePaths(name)) {
    try {
      // Winget/Store tools live behind App Execution Aliases: a reparse point whose target
      // cannot be stat()ed (EACCES), so lstat() is the right existence check.
      const stat = fs.lstatSync(candidate);
      if (stat.isFile() || stat.isSymbolicLink()) {
        found = { file: candidate, kind: kindOf(candidate) };
        break;
      }
    } catch {
      /* unreadable candidate: keep looking */
    }
  }
  if (found) resolutionCache.set(name, found);
  return found;
}

/** Quote one token for a `cmd.exe` command line (never used for shell:false spawns). */
function quoteForCmd(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function displayCommand(exe, args) {
  return [exe, ...args].map((token) => (/\s/.test(String(token)) ? quoteForCmd(token) : String(token))).join(' ');
}

/* ------------------------------------------------------------------ killing */

function killTree(pid) {
  if (!pid) return;
  if (IS_WIN) {
    try {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
      killer.on('error', () => {});
      killer.unref?.();
    } catch {
      /* best effort */
    }
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* best effort */
    }
  }
}

/* ------------------------------------------------------------------ running */

function spawnSpec(resolved, args) {
  if (!IS_WIN || resolved.kind === 'exe') {
    return { file: resolved.file, args, options: {} };
  }
  if (resolved.kind === 'ps1') {
    return {
      file: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', resolved.file, ...args],
      options: {},
    };
  }
  // .cmd / .bat shims
  const line = [quoteForCmd(resolved.file), ...args.map(quoteForCmd)].join(' ');
  return {
    file: process.env.ComSpec || process.env.COMSPEC || 'cmd.exe',
    args: ['/d', '/s', '/c', `"${line}"`],
    options: { windowsVerbatimArguments: true },
  };
}

function collect(child, timeoutMs, commandText, resolve) {
  const startedAt = Date.now();
  const stdoutChunks = [];
  const stderrChunks = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let truncated = false;
  let timedOut = false;
  let settled = false;

  const finish = (code, extra) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve({
      code,
      stdout: decodeBuffer(Buffer.concat(stdoutChunks)),
      stderr: decodeBuffer(Buffer.concat(stderrChunks)),
      durationMs: Date.now() - startedAt,
      timedOut,
      truncated,
      command: commandText,
      ...(extra || {}),
    });
  };

  const timer = setTimeout(() => {
    timedOut = true;
    killTree(child.pid);
    // Give the tree a moment to die, then settle anyway.
    setTimeout(() => finish(-1), 2500).unref?.();
  }, timeoutMs);

  child.stdout?.on('data', (chunk) => {
    if (stdoutBytes >= MAX_STREAM_BYTES) {
      truncated = true;
      return;
    }
    stdoutBytes += chunk.length;
    if (stdoutBytes > MAX_STREAM_BYTES) {
      truncated = true;
      const keep = MAX_STREAM_BYTES - (stdoutBytes - chunk.length);
      if (keep > 0) stdoutChunks.push(chunk.subarray(0, keep));
      return;
    }
    stdoutChunks.push(chunk);
  });
  child.stderr?.on('data', (chunk) => {
    if (stderrBytes >= MAX_STREAM_BYTES) {
      truncated = true;
      return;
    }
    stderrBytes += chunk.length;
    if (stderrBytes > MAX_STREAM_BYTES) {
      truncated = true;
      const keep = MAX_STREAM_BYTES - (stderrBytes - chunk.length);
      if (keep > 0) stderrChunks.push(chunk.subarray(0, keep));
      return;
    }
    stderrChunks.push(chunk);
  });
  child.on('error', (error) => finish(-1, { spawnError: error && error.message ? error.message : String(error) }));
  child.on('close', (code) => finish(typeof code === 'number' ? code : -1));
}

/**
 * Run a command.
 *
 * @param {string} name logical tool name ('winget' | 'npm' | 'pnpm' | 'bun') or an absolute path
 * @param {string[]} args argv array (never a shell string)
 * @param {{timeoutMs?: number, cwd?: string, env?: Record<string,string>, dryRun?: boolean}} [opts]
 * @returns {Promise<{code:number, stdout:string, stderr:string, durationMs:number,
 *   timedOut:boolean, truncated:boolean, command:string, dryRun?:boolean, spawnError?:string}>}
 */
export async function run(name, args, opts = {}) {
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 60_000;
  const argv = Array.isArray(args) ? args.map(String) : [];
  const resolved = resolveExecutable(name);
  const commandText = displayCommand(resolved ? resolved.file : name, argv);

  if (opts.dryRun) {
    return {
      code: 0,
      stdout: '',
      stderr: '',
      durationMs: 0,
      timedOut: false,
      truncated: false,
      dryRun: true,
      command: commandText,
    };
  }

  if (!resolved) throw unavailable(`${name} 未安装或不在 PATH 中`, commandText);

  await acquireSlot();
  try {
    return await new Promise((resolve) => {
      const spec = spawnSpec(resolved, argv);
      const env = { ...process.env, ...BASE_ENV, ...(opts.env || {}) };
      let child;
      try {
        child = spawn(spec.file, spec.args, {
          shell: false,
          windowsHide: true,
          cwd: opts.cwd,
          env,
          ...spec.options,
        });
      } catch (error) {
        resolve({
          code: -1,
          stdout: '',
          stderr: '',
          durationMs: 0,
          timedOut: false,
          truncated: false,
          spawnError: error && error.message ? error.message : String(error),
          command: commandText,
        });
        return;
      }
      collect(child, timeoutMs, commandText, resolve);
    });
  } finally {
    releaseSlot();
  }
}

/** Run and throw unless the command exited 0. */
export async function runOrThrow(name, args, opts = {}) {
  const result = await run(name, args, opts);
  return result;
}

/* --------------------------------------------------------------- mutation queue */

let mutationTail = Promise.resolve();

/**
 * Serialise mutations (install/update/uninstall) behind one module-level promise chain.
 * A rejected task never breaks the chain.
 */
export function enqueueMutation(task) {
  const next = mutationTail.then(task, task);
  mutationTail = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

/* --------------------------------------------------------------- validation */

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
// Version strings travel through `cmd.exe` for the node family and through argument
// arrays elsewhere; keep the historical semver-ish charset for every manager.
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+~-]{0,63}$/;

/**
 * Validate a package id for one manager using the catalog's per-manager charset
 * (winget ids, npm names, crate names, Python package names, Go module paths, editor
 * extension ids ...). A leading `-` is always rejected indirectly: every catalog pattern
 * requires an alphanumeric first character, so nothing can be smuggled in as a flag.
 *
 * @param {unknown} value request `packageId`
 * @param {string} manager manager id
 * @returns {string} trimmed package id
 */
export function assertPackageId(value, manager) {
  const def = getManager(manager);
  if (!def) throw badRequest('未知的包管理器');
  if (typeof value !== 'string' || value.trim() === '') throw badRequest('缺少 packageId');
  const id = value.trim();
  if (id.length > 300 || CONTROL_CHARS.test(id)) throw badRequest('packageId 含非法字符');
  if (def.packagePattern && !def.packagePattern.test(id)) {
    throw badRequest(def.packageHint || 'packageId 不是合法的包名');
  }
  return id;
}

export function assertVersion(value, manager) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') throw badRequest('version 必须是字符串');
  const version = value.trim();
  if (!version) return null;
  if (version.length > 64 || CONTROL_CHARS.test(version)) throw badRequest('version 含非法字符');
  if (manager === 'winget') {
    // winget is spawned with shell:false; only a leading dash (would parse as a flag) is unsafe.
    if (version.startsWith('-')) throw badRequest('version 含非法字符');
    return version;
  }
  if (!VERSION_RE.test(version)) throw badRequest('version 含非法字符');
  return version;
}

export function assertQuery(value) {
  if (typeof value !== 'string') throw badRequest('缺少 query');
  const query = value.trim();
  if (query.length < 1 || query.length > 120) throw badRequest('搜索词长度需在 1–120 之间');
  if (CONTROL_CHARS.test(query)) throw badRequest('搜索词含非法字符');
  return query;
}

export function assertManager(value) {
  const manager = typeof value === 'string' ? value.trim() : '';
  if (!isManagerId(manager)) throw badRequest('未知的包管理器');
  return manager;
}
