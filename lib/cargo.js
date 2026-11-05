// cargo globally installed crates (CONTRACT §7.4).
//
// `cargo install --list` prints:
//   <crate-name> v<version>:
//       <binary>.exe
// Empty output means "no crates", which is zero items — never an error. Latest versions
// come from crates.io during `check-updates` (lib/remotes.js), not from this snapshot.

import path from 'node:path';
import { run } from './run.js';
import { binaryFor } from './detect.js';
import { makeItem } from './items.js';
import { commandFailed, unavailable } from './errors.js';
import { normalizeOutput, oneLine, tail } from './text.js';

const LIST_ARGS = ['install', '--list'];
const LIST_TIMEOUT_MS = 30_000;
const ENTRY_LINE = /^(\S+)\s+v(\S+):\s*$/;

function logOf(result) {
  return tail(`${result.stdout || ''}\n${result.stderr || ''}`, 12 * 1024);
}

/**
 * Parse `cargo install --list`. Only the `<name> v<version>:` header lines become entries;
 * the indented binary lines and `Replaced package ...` notes are ignored.
 *
 * @param {string} output raw CLI output
 * @returns {Array<{name:string, version:string}>}
 */
export function parseInstalled(output) {
  const entries = [];
  const seen = new Set();
  for (const rawLine of normalizeOutput(output).split('\n')) {
    const match = ENTRY_LINE.exec(rawLine.trim());
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
  if (!bin) throw unavailable('cargo 未检测到');

  const result = await run(bin, LIST_ARGS, { timeoutMs: LIST_TIMEOUT_MS });
  if (result.timedOut) throw commandFailed('cargo install --list 超时（30 s）', logOf(result));
  if (result.code !== 0) {
    throw commandFailed(
      `cargo install --list 失败：${oneLine(result.stderr || result.stdout) || `退出码 ${result.code}`}`,
      logOf(result),
    );
  }

  const items = parseInstalled(result.stdout).map((entry) =>
    makeItem(def, { name: entry.name, packageId: entry.name, version: entry.version }),
  );
  // Crate directories are not addressable from `cargo install --list`; the bin dir is
  // the only reliable root, which is what the drawer's "reveal" would use anyway.
  return { items, root: path.dirname(bin) };
}
