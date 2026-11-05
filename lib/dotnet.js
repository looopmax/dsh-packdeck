// .NET global tools (CONTRACT §7.4).
//
// `dotnet tool list -g` renders a fixed-width table:
//
//   Package Id      Version      Commands
//   --------------------------------------
//   dotnet-ef       8.0.0        dotnet-ef
//
// It is parsed by splitting on runs of 2+ spaces (the columns are padded, package ids and
// versions never contain whitespace). Latest versions come from NuGet during
// `check-updates` (lib/remotes.js).

import { run } from './run.js';
import { binaryFor } from './detect.js';
import { makeItem } from './items.js';
import { commandFailed, unavailable } from './errors.js';
import { normalizeOutput, oneLine, tail } from './text.js';

const LIST_ARGS = ['tool', 'list', '-g'];
const LIST_TIMEOUT_MS = 30_000;

function logOf(result) {
  return tail(`${result.stdout || ''}\n${result.stderr || ''}`, 12 * 1024);
}

/**
 * Parse `dotnet tool list -g`.
 *
 * @param {string} output raw CLI output
 * @returns {Array<{packageId:string, version:string}>}
 */
export function parseToolList(output) {
  const entries = [];
  const seen = new Set();
  let inTable = false;
  for (const rawLine of normalizeOutput(output).split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^package id\b/i.test(line)) {
      inTable = true;
      continue;
    }
    if (!inTable) continue;
    if (/^[-–—\s]+$/.test(line)) continue;
    const parts = line.split(/\s{2,}|\t+/).filter(Boolean);
    if (parts.length < 2) continue;
    const packageId = parts[0];
    const version = parts[1];
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(packageId)) continue;
    if (!/^[A-Za-z0-9][A-Za-z0-9._+~-]*$/.test(version)) continue;
    if (seen.has(packageId)) continue;
    seen.add(packageId);
    entries.push({ packageId, version });
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
  if (!bin) throw unavailable('dotnet 未检测到');

  const result = await run(bin, LIST_ARGS, { timeoutMs: LIST_TIMEOUT_MS });
  if (result.timedOut) throw commandFailed('dotnet tool list 超时（30 s）', logOf(result));
  if (result.code !== 0) {
    throw commandFailed(
      `dotnet tool list 失败：${oneLine(result.stderr || result.stdout) || `退出码 ${result.code}`}`,
      logOf(result),
    );
  }

  const items = parseToolList(result.stdout).map((entry) =>
    makeItem(def, { name: entry.packageId, packageId: entry.packageId, version: entry.version }),
  );
  return { items, root: null };
}
