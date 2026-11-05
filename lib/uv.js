// uv-managed Python tools (CONTRACT §7.4).
//
// `uv tool list` prints one `<name> v<version>` header per tool followed by indented
// `- <binary>` lines. `No tools installed` (and an empty output) mean zero tools, not an
// error. Latest versions come from PyPI during `check-updates` (lib/remotes.js).

import path from 'node:path';
import { run } from './run.js';
import { binaryFor } from './detect.js';
import { makeItem } from './items.js';
import { commandFailed, unavailable } from './errors.js';
import { normalizeOutput, oneLine, tail } from './text.js';

const LIST_ARGS = ['tool', 'list'];
const LIST_TIMEOUT_MS = 30_000;
const TOOL_LINE = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s+v(\S+)\s*$/;

function logOf(result) {
  return tail(`${result.stdout || ''}\n${result.stderr || ''}`, 12 * 1024);
}

/**
 * Parse `uv tool list`.
 *
 * @param {string} output raw CLI output
 * @returns {Array<{name:string, version:string}>}
 */
export function parseTools(output) {
  const entries = [];
  const seen = new Set();
  for (const rawLine of normalizeOutput(output).split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('-')) continue; // indented binary lines
    if (/^no tools installed\b/i.test(line)) continue;
    if (/^(warning|error|note):/i.test(line)) continue;
    const match = TOOL_LINE.exec(line);
    if (!match) continue;
    const name = match[1];
    if (seen.has(name)) continue;
    seen.add(name);
    entries.push({ name, version: match[2] });
  }
  return entries;
}

/**
 * @param {object} def catalog descriptor
 * @param {{dryRun?: boolean}} [opts]
 * @returns {Promise<{items: object[], root: string|null}>}
 */
export async function list(def, opts = {}) {
  if (opts.dryRun) return { items: [], root: null };
  const bin = binaryFor(def.id);
  if (!bin) throw unavailable('uv 未检测到');

  const result = await run(bin, LIST_ARGS, { timeoutMs: LIST_TIMEOUT_MS });
  if (result.timedOut) throw commandFailed('uv tool list 超时（30 s）', logOf(result));
  if (result.code !== 0) {
    throw commandFailed(
      `uv tool list 失败：${oneLine(result.stderr || result.stdout) || `退出码 ${result.code}`}`,
      logOf(result),
    );
  }

  const items = parseTools(result.stdout).map((entry) =>
    makeItem(def, { name: entry.name, packageId: entry.name, version: entry.version }),
  );
  return { items, root: path.dirname(bin) };
}
