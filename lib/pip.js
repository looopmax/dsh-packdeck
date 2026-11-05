// pip: packages of the active Python environment (CONTRACT §7.4).
//
// `pip list --format=json` is the source of truth. Real pip builds sometimes append extra
// text after the JSON array (pip-upgrade notices, warnings), which makes a plain
// `JSON.parse` fail with "Extra data"; the parser therefore extracts the first balanced
// `[...]` block and ignores everything after it.
//
// Snapshots may contain hundreds of rows: no size computation, no per-item subprocess,
// and the global 60 s per-manager snapshot cache keeps repeated reads cheap.

import path from 'node:path';
import { run } from './run.js';
import { binaryFor } from './detect.js';
import { makeItem } from './items.js';
import { commandFailed, parseFailed, unavailable } from './errors.js';
import { normalizeOutput, oneLine, tail } from './text.js';

const LIST_ARGS = ['list', '--format=json'];
const LIST_TIMEOUT_MS = 60_000;
const MAX_ITEMS = 2000;

function logOf(result) {
  return tail(`${result.stdout || ''}\n${result.stderr || ''}`, 12 * 1024);
}

/**
 * Extract the first complete JSON array from arbitrary pip output.
 *
 * @param {string} text normalised output
 * @returns {string|null} the raw `[...]` slice, or null when no balanced array exists
 */
export function firstJsonArray(text) {
  const start = text.indexOf('[');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === '[') {
      depth += 1;
    } else if (char === ']') {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

/**
 * Parse `pip list --format=json`, tolerating trailing text.
 *
 * @param {string} output raw CLI output
 * @returns {Array<{name:string, version:string}>}
 */
export function parsePipList(output) {
  const text = normalizeOutput(output);
  const block = firstJsonArray(text);
  if (!block) throw parseFailed('无法解析 pip list 输出（未找到 JSON 数组）', text.slice(0, 2000));

  let parsed;
  try {
    parsed = JSON.parse(block);
  } catch (error) {
    throw parseFailed(`无法解析 pip list 输出：${oneLine(error && error.message, 160)}`, block.slice(0, 2000));
  }
  if (!Array.isArray(parsed)) throw parseFailed('pip list 输出不是数组');

  const entries = [];
  for (const entry of parsed.slice(0, MAX_ITEMS)) {
    if (!entry || typeof entry.name !== 'string' || !entry.name) continue;
    entries.push({ name: entry.name, version: typeof entry.version === 'string' ? entry.version : '' });
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
  if (!bin) throw unavailable('pip 未检测到');

  const result = await run(bin, LIST_ARGS, { timeoutMs: LIST_TIMEOUT_MS });
  if (result.timedOut) throw commandFailed('pip list 超时（60 s）', logOf(result));
  if (result.code !== 0) {
    throw commandFailed(
      `pip list 失败：${oneLine(result.stderr || result.stdout) || `退出码 ${result.code}`}`,
      logOf(result),
    );
  }

  const entries = parsePipList(result.stdout);
  const items = entries.map((entry) => makeItem(def, { name: entry.name, packageId: entry.name, version: entry.version }));
  // pip.exe sits in <prefix>\Scripts; the environment root is its parent.
  return { items, root: path.dirname(path.dirname(bin)) };
}
