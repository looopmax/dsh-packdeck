// Per-process detail for the Packdeck drawer (CONTRACT §11.2.4).
//
// ENRICHMENT PRIORITY (a response reports its source as `envSource`):
//   1. peb       native/packdeck-procs.exe `detail <pids>` reads the target's PEB
//                (RTL_USER_PROCESS_PARAMETERS) and returns cwd + environment. Fastest and
//                needs no Python, but a Windows build can move the Environment field, so a
//                PEB miss is normal — never an error.
//   2. psutil    when the PEB could not supply the environment: spawn `python -c <SCRIPT>`
//                with the pid list on stdin (never a long command line). psutil reads
//                another process' environment reliably and takes ~3 ms for a handful.
//                Installed on this machine (7.2.2, Python 3.11.9) but treated as optional.
//   3. none      no native data and no psutil: `env: null`, a user-facing `envError` and an
//                `installHint` pointing at Packdeck's own pip manager.
//
// `cwd` follows the same order (PEB -> psutil.cwd()), independent of the env result.
//
// The script is self-contained (no repo imports), tolerant of AccessDenied per process, and
// prints exactly one UTF-8 JSON document. Environment values reach the local UI only: nothing
// here logs them, and `log` fields never carry them.

import { spawn, spawnSync } from 'node:child_process';
import { badRequest } from './errors.js';
import { decodeBuffer, oneLine } from './text.js';
import { resolveExecutable } from './run.js';
import { boundEntries, nativeDetail } from './procs.js';

const PYTHON_BUDGET_MS = 8_000; // §11.2.4
const PYTHON_PROBE_TTL_MS = 5 * 60_000;
const ENV_LIMIT = 512; // variables kept per process, guard against a hostile env block
const VALUE_LIMIT = 32 * 1024; // per-value guard
/** §11.2.4 budget: environment is read for this many processes per detail request. */
export const ENV_PID_LIMIT = 8;

/** §11.2.4: the drawer's "install psutil" button feeds this straight into the pip manager. */
export const PSUTIL_INSTALL_HINT = Object.freeze({
  manager: 'pip',
  packageId: 'psutil',
  reason: '进程环境变量需要 psutil',
});

/**
 * Self-contained psutil probe/reader. Reads pids from stdin, writes one JSON document.
 * Every per-process failure is captured in that process' own `error` field.
 */
const PYTHON_SCRIPT = `
import json, sys

def main():
    try:
        import psutil
    except Exception as exc:
        print(json.dumps({"psutil": None, "error": str(exc)}))
        return
    pids = []
    try:
        for line in sys.stdin.read().split():
            try:
                value = int(line.strip())
            except Exception:
                continue
            if value > 0:
                pids.append(value)
    except Exception:
        pass
    out = {"psutil": getattr(psutil, "__version__", "?"), "error": None, "processes": []}
    for pid in pids[:64]:
        record = {"pid": pid, "cwd": None, "env": None, "envError": None, "envCode": None}
        try:
            proc = psutil.Process(pid)
        except Exception as exc:
            record["envError"] = "进程不存在"
            record["envCode"] = "gone"
            out["processes"].append(record)
            continue
        try:
            record["cwd"] = proc.cwd()
        except Exception:
            record["cwd"] = None
        try:
            env = proc.environ()
            record["env"] = {str(k): str(v)[:32768] for k, v in list(env.items())[:512]}
        except Exception as exc:
            name = type(exc).__name__
            if name in ("AccessDenied", "PermissionError"):
                record["envError"] = "拒绝访问"
                record["envCode"] = "access-denied"
            else:
                record["envError"] = "无法读取环境变量"
                record["envCode"] = "unsupported"
        out["processes"].append(record)
    print(json.dumps(out, ensure_ascii=False))

main()
`;

/* ------------------------------------------------------------- python probe */

/** `{ file, version, psutil }` resolved once. `psutil === null` means "import failed". */
let pythonState = null;
let pythonInflight = null;

function pythonExe() {
  if (pythonState && pythonState.file) return pythonState.file;
  const resolved = resolveExecutable('python') || resolveExecutable('python3');
  return resolved ? resolved.file : '';
}

/**
 * Detect the Python interpreter and psutil once per host process.
 *
 * @returns {Promise<{file: string, available: boolean, psutil: string|null, reason: string|null}>}
 */
export async function probePython() {
  if (pythonState && Date.now() - (pythonState.at || 0) < PYTHON_PROBE_TTL_MS) return pythonState;
  if (pythonInflight) return pythonInflight;
  pythonInflight = (async () => {
    const file = pythonExe();
    if (!file) {
      pythonState = { at: Date.now(), file: '', available: false, psutil: null, reason: '未找到 python' };
      return pythonState;
    }
    const probe = spawnSync(file, ['-c', 'import sys,json\ntry:\n import psutil;v=psutil.__version__\nexcept Exception: v=None\nprint(json.dumps({"v":v,"py":sys.version.split()[0]}))'], {
      timeout: PYTHON_BUDGET_MS,
      windowsHide: true,
      encoding: 'buffer',
      maxBuffer: 4 * 1024 * 1024,
    });
    const text = decodeBuffer(probe.stdout || Buffer.alloc(0)).trim();
    let parsed = null;
    try {
      parsed = JSON.parse(text.split(/\r?\n/).pop() || 'null');
    } catch {
      parsed = null;
    }
    pythonState = {
      at: Date.now(),
      file,
      available: Boolean(parsed && parsed.py),
      psutil: parsed && parsed.v ? String(parsed.v) : null,
      pythonVersion: parsed && parsed.py ? String(parsed.py) : null,
      reason: parsed && parsed.py ? null : oneLine(decodeBuffer(probe.stderr || Buffer.alloc(0)) || 'python 不可用', 200),
    };
    return pythonState;
  })().finally(() => {
    pythonInflight = null;
  });
  return pythonInflight;
}

/**
 * Read cwd/env for a few pids through psutil. Pids travel on stdin.
 *
 * @param {number[]} pids
 * @returns {Promise<{ok:boolean, rows:Map<number, object>, psutil:string|null, reason:string|null}>}
 */
async function psutilDetail(pids) {
  const state = await probePython();
  if (!state.available) return { ok: false, rows: new Map(), psutil: null, reason: state.reason };
  if (!state.psutil) {
    return { ok: false, rows: new Map(), psutil: null, reason: 'python 环境缺少 psutil' };
  }

  const payload = await new Promise((resolve) => {
    let child;
    try {
      child = spawn(state.file, ['-c', PYTHON_SCRIPT], {
        shell: false,
        windowsHide: true,
        env: {
          ...process.env,
          PYTHONIOENCODING: 'utf-8',
          PYTHONUTF8: '1',
          NO_COLOR: '1',
          CI: '1',
        },
      });
    } catch (error) {
      resolve({ code: -1, stdout: '', stderr: String(error && error.message) });
      return;
    }
    const out = [];
    const err = [];
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout: decodeBuffer(Buffer.concat(out)), stderr: decodeBuffer(Buffer.concat(err)) });
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      finish(-1);
    }, PYTHON_BUDGET_MS);
    child.stdout.on('data', (chunk) => {
      if (out.length < 4096) out.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      if (err.length < 128) err.push(chunk);
    });
    child.on('error', (error) => {
      err.push(Buffer.from(String(error && error.message)));
      finish(-1);
    });
    child.on('close', (code) => finish(typeof code === 'number' ? code : -1));
    child.stdin.on('error', () => {});
    child.stdin.end(pids.map(String).join('\n'), 'utf8');
  });

  const text = String(payload.stdout || '').trim();
  if (!text) return { ok: false, rows: new Map(), psutil: null, reason: oneLine(payload.stderr || 'psutil 无输出', 200) };
  let parsed;
  try {
    parsed = JSON.parse(text.split(/\r?\n/).pop());
  } catch {
    return { ok: false, rows: new Map(), psutil: null, reason: 'psutil 输出不可解析' };
  }
  if (!parsed || !parsed.psutil) {
    return { ok: false, rows: new Map(), psutil: null, reason: parsed && parsed.error ? oneLine(parsed.error, 160) : 'psutil 不可用' };
  }
  const rows = new Map();
  for (const row of Array.isArray(parsed.processes) ? parsed.processes : []) {
    if (!row || !Number.isInteger(Number(row.pid))) continue;
    rows.set(Number(row.pid), row);
  }
  return { ok: true, rows, psutil: String(parsed.psutil), reason: null };
}

/* ------------------------------------------------------------------ shaping */

function clampEnv(env) {
  if (!env || typeof env !== 'object') return null;
  const out = {};
  let count = 0;
  for (const [key, value] of Object.entries(env)) {
    if (count >= ENV_LIMIT) break;
    const name = String(key);
    if (!name) continue;
    const text = typeof value === 'string' ? value : String(value ?? '');
    out[name] = text.length > VALUE_LIMIT ? text.slice(0, VALUE_LIMIT) : text;
    count += 1;
  }
  return out;
}

/**
 * One process row of the §11.2.4 payload.
 * `source` records where cwd/env came from (`peb` | `psutil` | `none`).
 */
function buildRow(entry, nativeRow, psutilRow, childIndex) {
  const envFromPeb = nativeRow && nativeRow.env && typeof nativeRow.env === 'object' ? clampEnv(nativeRow.env) : null;
  const envFromPsutil = psutilRow && psutilRow.env && typeof psutilRow.env === 'object' ? clampEnv(psutilRow.env) : null;
  const env = envFromPeb || envFromPsutil;
  const envSource = envFromPeb ? 'peb' : envFromPsutil ? 'psutil' : 'none';

  const cwd = (nativeRow && typeof nativeRow.cwd === 'string' && nativeRow.cwd)
    ? nativeRow.cwd
    : psutilRow && typeof psutilRow.cwd === 'string' && psutilRow.cwd
      ? psutilRow.cwd
      : null;

  let envError = null;
  let envCode = env ? (envSource === 'peb' ? 'peb' : 'psutil') : null;
  if (!env) {
    const nativeCode = nativeRow && nativeRow.envCode ? String(nativeRow.envCode) : null;
    const psutilCode = psutilRow && psutilRow.envCode ? String(psutilRow.envCode) : null;
    envCode = psutilCode || nativeCode || 'unsupported';
    envError = (psutilRow && psutilRow.envError) || (nativeRow && nativeRow.envError) || '无法读取环境变量';
    if (envCode === 'no-psutil') {
      envCode = 'no-psutil';
      envError = '需要 psutil';
    }
  }

  const row = {
    pid: entry.pid,
    ppid: entry.ppid ?? (nativeRow && Number.isInteger(nativeRow.ppid) ? nativeRow.ppid : null),
    name: (nativeRow && nativeRow.name) || entry.name || null,
    exe: (nativeRow && nativeRow.exe) || entry.exe || null,
    cmdline: splitForDisplay((nativeRow && nativeRow.cmdline) || entry.cmd || ''),
    cwd,
    startedAt: entry.startedAt,
    rssBytes: (nativeRow && Number(nativeRow.rssBytes)) || entry.rss || 0,
    cpuPercent: entry.cpuPercent,
    user: (nativeRow && nativeRow.user) || entry.user || null,
    threads: (nativeRow && Number(nativeRow.threads)) || entry.threads || 0,
    status: (nativeRow && nativeRow.status) || entry.status || null,
    env,
    envCount: env ? Object.keys(env).length : 0,
    envError,
    envCode,
    envSource,
    children: Array.isArray(nativeRow && nativeRow.children) && nativeRow.children.length > 0
      ? nativeRow.children
      : childrenFromIndex(childIndex, entry.pid),
  };
  return row;
}

/** Command lines are shown as argv for readability; falls back to the raw string split on spaces. */
function splitForDisplay(commandLine) {
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
      if (current) tokens.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}

/**
 * Children of one pid, resolved from the bound entry set: a process is a child when its
 * `ppid` is another process bound to the same item. The native helper reports a fuller list
 * (all children of the pid) which wins when present.
 */
function childrenFromIndex(childIndex, pid) {
  return childIndex.get(pid) || [];
}

/* ------------------------------------------------------------------- payload */

/**
 * Build the §11.2.4 `process-detail` payload for one item id.
 *
 * The environment is read for at most {@link ENV_PID_LIMIT} processes (the ones shown first):
 * one psutil spawn for all of them, so the response stays inside the 1.5 s budget even when an
 * item owns dozens of processes. The remaining rows carry `env: null, envCode: 'limited'` and
 * the response advertises the truncation, so the UI can fetch a single pid on demand.
 *
 * @param {unknown} rawId item id (`<manager>:<packageId>`)
 * @param {{pid?: unknown}} [opts] `pid` restricts the environment lookup to one process
 * @returns {Promise<object>} contract payload
 */
export async function processDetailPayload(rawId, opts = {}) {
  const itemId = typeof rawId === 'string' ? rawId.trim() : '';
  if (!itemId) throw badRequest('缺少 id');

  const { item, entries: bound } = await boundEntries(itemId);
  if (item.kind === 'ext') throw badRequest('编辑器扩展不常驻进程，无法查看进程详情');

  const startedAt = Date.now();
  const focusPid = Number(opts && opts.pid);
  const singlePid = Number.isInteger(focusPid) && focusPid > 0 ? focusPid : null;

  // Only the requested pid when one was named; otherwise the first ENV_PID_LIMIT processes by
  // memory, which is the order the drawer renders.
  const entries = singlePid ? bound.filter((entry) => entry.pid === singlePid) : bound;
  const envEntries = singlePid ? entries : entries.slice(0, ENV_PID_LIMIT);
  const pids = entries.map((entry) => entry.pid);
  const envPids = envEntries.map((entry) => entry.pid);

  // 1. Native PEB: cwd for every pid (cheap), environment where the build lets us read it.
  let nativeRows = new Map();
  let nativeTimings = null;
  let nativeMs = 0;
  if (pids.length > 0) {
    const native = await nativeDetail(pids);
    if (native) {
      nativeMs = native.durationMs;
      nativeTimings = native.timings;
      for (const row of native.rows) {
        if (row && Number.isInteger(Number(row.pid))) nativeRows.set(Number(row.pid), row);
      }
    }
  }

  // 2. One psutil spawn covers the pids the PEB could not fully describe.
  const needsPsutil = envEntries.filter((entry) => {
    const nativeRow = nativeRows.get(entry.pid);
    const hasEnv = nativeRow && nativeRow.env && Object.keys(nativeRow.env).length > 0;
    const hasCwd = nativeRow && typeof nativeRow.cwd === 'string' && nativeRow.cwd;
    return !hasEnv || !hasCwd;
  });
  let psutilRows = new Map();
  let psutilVersion = null;
  let psutilReason = null;
  let psutilMs = 0;
  if (needsPsutil.length > 0) {
    const startedPsutil = Date.now();
    const psutil = await psutilDetail(needsPsutil.map((entry) => entry.pid));
    psutilMs = Date.now() - startedPsutil;
    psutilRows = psutil.rows;
    psutilVersion = psutil.psutil;
    psutilReason = psutil.reason;
  }

  const childIndex = new Map();
  for (const entry of entries) {
    if (entry.ppid && pids.includes(entry.ppid)) {
      if (!childIndex.has(entry.ppid)) childIndex.set(entry.ppid, []);
      childIndex.get(entry.ppid).push(entry.pid);
    }
  }
  const envPidSet = new Set(envPids);
  const rows = entries.map((entry) => {
    const row = buildRow(entry, nativeRows.get(entry.pid) || null, psutilRows.get(entry.pid) || null, childIndex);
    if (!envPidSet.has(entry.pid)) {
      // §11.2.4 budget: environment is read for the first processes only. The UI can ask for
      // one pid at a time (`pid` argument) rather than paying for the whole item.
      row.env = null;
      row.envCount = 0;
      row.envError = null;
      row.envCode = 'limited';
      row.envSource = 'none';
    }
    return row;
  });

  // Which source actually answered for the environment, for the whole response.
  const sources = new Set(rows.filter((row) => row.env).map((row) => row.envSource));
  const envSource = sources.has('peb') ? 'peb' : sources.has('psutil') ? 'psutil' : 'none';
  const anyEnv = rows.some((row) => row.env);
  const payload = {
    id: itemId,
    at: Date.now(),
    engine: nativeRows.size > 0 ? 'native' : 'fallback',
    envSource,
    durationMs: Date.now() - startedAt,
    timings: { nativeMs, psutilMs, native: nativeTimings },
    processes: rows,
    item: { id: item.id, kind: item.kind, name: item.name, path: item.path || null },
    truncated: {
      envPids: envPids.length,
      total: entries.length,
      limited: rows.filter((row) => row.envCode === 'limited').length,
    },
    psutil: { installed: psutilVersion !== null, version: psutilVersion, reason: psutilReason },
  };
  if (!anyEnv) {
    // §11.2.4: never an error — the rest of the detail is still usable.
    payload.installHint = PSUTIL_INSTALL_HINT;
    payload.envError = rows.length === 0
      ? null
      : psutilVersion === null
        ? rows[0].envError || '需要 psutil'
        : rows[0].envError || '无法读取环境变量';
  }
  return payload;
}
