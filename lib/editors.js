// Editor extension hosts (CONTRACT §7.4): vscode / cursor / pink / code-insiders / windsurf.
//
// Every editor descriptor shares one adapter. The CLI speaks the VS Code extension
// protocol, so listing is `--list-extensions --show-versions` -> `<publisher>.<ext>@<ver>`
// lines. Extensions have no "latest version" source: `latest` stays null and `hasUpdate`
// stays false; `update` means "reinstall latest".

import { run } from './run.js';
import { binaryFor } from './detect.js';
import { makeItem } from './items.js';
import { commandFailed, unavailable } from './errors.js';
import { normalizeOutput, oneLine, tail } from './text.js';

const LIST_ARGS = ['--list-extensions', '--show-versions'];
const EXTENSION_LINE = /^([A-Za-z0-9][A-Za-z0-9-]*(?:\.[A-Za-z0-9][A-Za-z0-9-]*)+)@(\S+)$/;

function logOf(result) {
  return tail(`${result.stdout || ''}\n${result.stderr || ''}`, 12 * 1024);
}

/**
 * Parse `--list-extensions --show-versions` output. Header/footer noise is skipped, and
 * a duplicated extension id (unlikely) keeps its first occurrence.
 *
 * @param {string} output raw CLI output
 * @returns {Array<{extId:string, version:string}>}
 */
export function parseExtensions(output) {
  const entries = [];
  const seen = new Set();
  for (const rawLine of normalizeOutput(output).split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = EXTENSION_LINE.exec(line);
    if (!match) continue; // headers, warnings, blank progress lines
    const extId = match[1];
    if (seen.has(extId)) continue;
    seen.add(extId);
    entries.push({ extId, version: match[2] });
  }
  return entries;
}

/**
 * @param {object} def catalog descriptor
 * @param {{dryRun?: boolean}} [opts]
 * @returns {Promise<{items: object[], root: null}>}
 */
export async function list(def, opts = {}) {
  if (opts.dryRun) return { items: [], root: null };
  const bin = binaryFor(def.id);
  if (!bin) throw unavailable(`${def.label} CLI 未检测到`);

  const result = await run(bin, LIST_ARGS, { timeoutMs: def.timeouts.list });
  if (result.timedOut) throw commandFailed(`${def.label} --list-extensions 超时`, logOf(result));
  if (result.code !== 0) {
    throw commandFailed(
      `${def.label} --list-extensions 失败：${oneLine(result.stderr || result.stdout) || `退出码 ${result.code}`}`,
      logOf(result),
    );
  }

  const items = parseExtensions(result.stdout).map((entry) =>
    makeItem(def, {
      name: entry.extId,
      packageId: entry.extId,
      version: entry.version,
    }),
  );
  return { items, root: null };
}
