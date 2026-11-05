// Go binaries installed with `go install` (CONTRACT §7.4).
//
// `go env GOPATH` gives the workspace; installed commands live in `<GOPATH>\bin` as plain
// executables with no manifest. `go version -m <file>` embeds the module metadata, whose
// `path` line is the module path (used as packageId) and `mod` line carries the version.
// There is no latest-version source: `latest` stays null and `update` = reinstall latest.
// `go install` has no uninstall counterpart, so the capability flag is false.

import fs from 'node:fs/promises';
import path from 'node:path';
import { run } from './run.js';
import { binaryFor } from './detect.js';
import { makeItem } from './items.js';
import { unavailable } from './errors.js';
import { normalizeOutput, oneLine, tail } from './text.js';

const ENV_TIMEOUT_MS = 15_000;
const META_TIMEOUT_MS = 10_000;
const LIST_DEADLINE_MS = 20_000;
const MAX_BINARIES = 200;

function logOf(result) {
  return tail(`${result.stdout || ''}\n${result.stderr || ''}`, 12 * 1024);
}

function firstLine(text) {
  return (
    normalizeOutput(text)
      .split('\n')
      .map((line) => line.trim())
      .find(Boolean) || ''
  );
}

/**
 * Parse `go version -m <file>` metadata lines.
 *
 * @param {string} output raw CLI output
 * @returns {{path:string|null, version:string}}
 */
export function parseVersionM(output) {
  let modulePath = null;
  let version = '';
  for (const rawLine of normalizeOutput(output).split('\n')) {
    const parts = rawLine.trim().split(/\s+/);
    if (parts[0] === 'path' && parts[1]) modulePath = parts[1];
    else if (parts[0] === 'mod' && parts[1] && parts[2]) version = parts[2];
  }
  return { path: modulePath, version: version === '(devel)' ? '' : version };
}

/**
 * @param {object} def catalog descriptor
 * @param {{dryRun?: boolean}} [opts]
 * @returns {Promise<{items: object[], root: string|null}>}
 */
export async function list(def, opts = {}) {
  if (opts.dryRun) return { items: [], root: null };
  const bin = binaryFor(def.id);
  if (!bin) throw unavailable('go 未检测到');

  const env = await run(bin, ['env', 'GOPATH'], { timeoutMs: ENV_TIMEOUT_MS });
  const gopath = env.code === 0 && !env.timedOut ? firstLine(env.stdout) : '';
  if (!gopath) {
    throw unavailable(`无法确定 GOPATH：${oneLine(env.stderr || env.stdout) || `退出码 ${env.code}`}`, logOf(env));
  }

  const binDir = path.join(gopath, 'bin');
  let entries;
  try {
    entries = await fs.readdir(binDir, { withFileTypes: true });
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return { items: [], root: binDir };
    throw unavailable(`无法读取 Go bin 目录：${error.message}`, String(binDir));
  }

  const files = entries
    .filter((entry) => entry.isFile() || entry.isSymbolicLink())
    .map((entry) => path.join(binDir, entry.name))
    .slice(0, MAX_BINARIES);

  const startedAt = Date.now();
  const items = [];
  for (const file of files) {
    if (Date.now() - startedAt > LIST_DEADLINE_MS) break;
    const meta = await run(bin, ['version', '-m', file], { timeoutMs: META_TIMEOUT_MS });
    if (meta.timedOut || meta.code !== 0) continue;
    const info = parseVersionM(meta.stdout);
    if (!info.path) continue;
    items.push(
      makeItem(def, {
        name: path.basename(file),
        packageId: info.path,
        version: info.version,
        path: file,
        source: def.id,
      }),
    );
  }
  return { items, root: binDir };
}
