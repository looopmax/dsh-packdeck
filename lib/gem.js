// Ruby gems installed globally (CONTRACT §7.4).
//
// `gem list --local` prints `name (1.2.3)` or `name (2.0.0, 1.9.0)`; the first version in
// the list is the active one. Latest versions come from rubygems.org during
// `check-updates` (lib/remotes.js).

import { run } from './run.js';
import { binaryFor } from './detect.js';
import { makeItem } from './items.js';
import { commandFailed, unavailable } from './errors.js';
import { normalizeOutput, oneLine, tail } from './text.js';

const LIST_ARGS = ['list', '--local'];
const LIST_TIMEOUT_MS = 30_000;
const GEM_LINE = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s+\(([^)]*)\)/;

function logOf(result) {
  return tail(`${result.stdout || ''}\n${result.stderr || ''}`, 12 * 1024);
}

/**
 * Parse `gem list --local`.
 *
 * @param {string} output raw CLI output
 * @returns {Array<{name:string, version:string}>}
 */
export function parseGemList(output) {
  const entries = [];
  const seen = new Set();
  for (const rawLine of normalizeOutput(output).split('\n')) {
    const match = GEM_LINE.exec(rawLine.trim());
    if (!match) continue;
    const name = match[1];
    if (seen.has(name)) continue;
    seen.add(name);
    const versions = match[2]
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    entries.push({ name, version: versions[0] || '' });
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
  if (!bin) throw unavailable('gem 未检测到');

  const result = await run(bin, LIST_ARGS, { timeoutMs: LIST_TIMEOUT_MS });
  if (result.timedOut) throw commandFailed('gem list 超时（30 s）', logOf(result));
  if (result.code !== 0) {
    throw commandFailed(
      `gem list 失败：${oneLine(result.stderr || result.stdout) || `退出码 ${result.code}`}`,
      logOf(result),
    );
  }

  const items = parseGemList(result.stdout).map((entry) =>
    makeItem(def, { name: entry.name, packageId: entry.name, version: entry.version }),
  );
  return { items, root: null };
}
