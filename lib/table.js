// Parser for winget's fixed-width tables.
//
// winget pads columns in *display cells* (CJK = 2), not characters, so column ranges are
// computed from the header row's token positions and every data row is sliced by display
// width. Real header/separator/data rows look like:
//
//   Name                                                           Id                    ...
//   ---------------------------------------------------------------------------------------
//   微信开发者工具 2.02.2609231                                    Tencent.WeixinDevTools  ...
//
// The `----` row is one continuous dash run (no per-column gaps), so it cannot be used to
// derive columns; it is only recognised and skipped.

import { normalizeOutput, tokenizeWithDisplay, displaySlice } from './text.js';

const HEADER_ALIASES = {
  name: 'name',
  id: 'id',
  version: 'version',
  available: 'available',
  match: 'match',
  source: 'source',
  '名称': 'name',
  '标识': 'id',
  '版本': 'version',
  '可用': 'available',
  '来源': 'source',
  '匹配': 'match',
};

function columnKey(token) {
  return HEADER_ALIASES[String(token).toLowerCase()] || String(token).toLowerCase();
}

function buildColumns(tokens) {
  const columns = tokens
    .map((token) => ({ key: columnKey(token.token), start: token.displayStart }))
    .sort((a, b) => a.start - b.start);
  for (let i = 0; i < columns.length; i += 1) {
    columns[i].end = i + 1 < columns.length ? columns[i + 1].start : Number.POSITIVE_INFINITY;
  }
  return columns;
}

function readCells(line, columns) {
  const cells = {};
  for (const column of columns) {
    if (Object.prototype.hasOwnProperty.call(cells, column.key)) continue;
    cells[column.key] = displaySlice(line, column.start, column.end).trim();
  }
  return cells;
}

function isSeparator(line) {
  return /^[\s-]+$/.test(line) && line.includes('-');
}

function isNoise(line) {
  const text = line.trim();
  if (!text) return true;
  // progress bars / spinners
  if (/^[\\|/\-\s.█▒▓░■□·]+$/.test(text)) return true;
  if (/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(text)) return true;
  // summary lines: "28 upgrades available.", "共 149 个包", "No installed package found."
  if (/^(?:\d+\s+)?(?:upgrades?\s+available|packages?\s+found|个包|项可用)/i.test(text)) return true;
  if (/^no (?:installed )?(?:package|app)s? (?:found|matching)/i.test(text)) return true;
  if (/^no .* found/i.test(text)) return true;
  return false;
}

/**
 * Parse a winget fixed-width table.
 *
 * @param {string} output raw command output
 * @param {{maxRows?: number}} [options]
 * @returns {{found: boolean, columns: Array<{key:string,start:number,end:number}>, rows: Array<Record<string,string>>}}
 */
export function parseWingetTable(output, options = {}) {
  const maxRows = Number.isFinite(options.maxRows) ? options.maxRows : 1000;
  const lines = normalizeOutput(output).split('\n');
  let headerIndex = -1;
  let columns = [];

  for (let i = 0; i < lines.length; i += 1) {
    const tokens = tokenizeWithDisplay(lines[i]);
    const words = tokens.map((token) => token.token);
    if (words.includes('Name') && words.includes('Id')) {
      headerIndex = i;
      columns = buildColumns(tokens);
      break;
    }
    if (i > 400) break;
  }

  if (headerIndex < 0 || columns.length === 0) {
    return { found: false, columns: [], rows: [] };
  }

  const rows = [];
  for (let i = headerIndex + 1; i < lines.length && rows.length < maxRows; i += 1) {
    const line = lines[i];
    if (!line || isSeparator(line) || isNoise(line)) continue;
    const cells = readCells(line, columns);
    const id = (cells.id || '').trim();
    if (!id) continue; // summary lines / partial rows never reach the Id column
    if (/\s{2,}/.test(id)) {
      // Two runs of spaces inside the Id column look like a misaligned row (an over-long name
      // pushing the columns right). winget normally sizes columns to their widest cell, so this
      // is a defensive fallback: split the raw row on runs of 2+ spaces instead.
      // (A single space is legitimate: ARP rows use ids such as `ARP\Machine\X86\Google Chrome`.)
      const parts = line.trim().split(/\s{2,}/);
      if (parts.length >= columns.length) {
        const fallback = {};
        columns.forEach((column, index) => {
          fallback[column.key] = (parts[index] || '').trim();
        });
        if (fallback.id && !/\s{2,}/.test(fallback.id)) rows.push(fallback);
      }
      continue;
    }
    cells.name = (cells.name || '').trim();
    rows.push(cells);
  }

  return { found: true, columns, rows };
}

/**
 * Parse `winget show` style "Key: value" output, keeping indented continuation lines.
 * @returns {Record<string,string>} lower-cased keys -> value
 */
export function parseKeyValueOutput(output) {
  const lines = normalizeOutput(output).split('\n');
  const values = {};
  let currentKey = null;
  for (const rawLine of lines) {
    if (!rawLine.trim()) {
      currentKey = null;
      continue;
    }
    const match = /^([A-Za-z][A-Za-z0-9 _/'-]*?):\s*(.*)$/.exec(rawLine);
    if (match) {
      const key = match[1].trim().toLowerCase();
      const value = match[2].trim();
      if (!(key in values) || !values[key]) values[key] = value;
      currentKey = key;
      continue;
    }
    if (currentKey && /^\s+/.test(rawLine)) {
      const continuation = rawLine.trim();
      if (continuation) {
        values[currentKey] = values[currentKey] ? `${values[currentKey]}\n${continuation}` : continuation;
      }
    }
  }
  return values;
}
