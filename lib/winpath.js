// Best-effort install-location lookup for winget entries via the Windows uninstall registry
// (ARP). `winget list` reports no install path, so without this the drawer's "reveal in
// Explorer" action could never work for winget apps. Read-only, bounded, and fully optional:
// any failure just means `path: null`.

import fs from 'node:fs';
import { run } from './run.js';
import { normalizeOutput } from './text.js';
import { cacheGet, cacheSet, TTL } from './cache.js';

const HIVES = [
  'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
];

const REG_TIMEOUT_MS = 15_000;
const BLOCK_START = /^HKEY_/i;
const VALUE_LINE = /^\s{2,}([^\s]+)\s+(REG_[A-Z_]+)\s?(.*)$/;

function normalizeName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** "Microsoft Visual C++ 2015 Redistributable (x64)" -> "microsoft visual c++ 2015 redistributable" */
function looseName(value) {
  return normalizeName(value)
    .replace(/\s*\((?:x64|x86|32-bit|64-bit|user|machine|当前用户)\)\s*$/i, '')
    .trim();
}

function collectEntries(output) {
  const entries = [];
  let current = null;
  const flush = () => {
    if (current && current.displayName) entries.push(current);
    current = null;
  };
  for (const line of normalizeOutput(output).split('\n')) {
    const trimmed = line.trimEnd();
    if (!trimmed) continue;
    if (BLOCK_START.test(trimmed)) {
      flush();
      current = { key: trimmed };
      continue;
    }
    if (!current) continue;
    const match = VALUE_LINE.exec(line);
    if (!match) continue;
    const key = match[1].toLowerCase();
    const value = match[3].trim();
    if (key === 'displayname' && value) current.displayName = value;
    else if (key === 'installlocation' && value) current.installLocation = value;
  }
  flush();
  return entries;
}

function pickCandidate(entries, displayName) {
  const exact = normalizeName(displayName);
  const loose = looseName(displayName);
  let looseMatch = null;
  for (const entry of entries) {
    if (!entry.installLocation) continue;
    const entryName = normalizeName(entry.displayName);
    if (entryName === exact) return entry.installLocation;
    if (!looseMatch && entryName === loose) looseMatch = entry.installLocation;
  }
  return looseMatch;
}

function usablePath(value) {
  if (!value) return null;
  const candidate = String(value).replace(/^"|"$/g, '').replace(/[\\/]+$/, '');
  try {
    if (!fs.statSync(candidate).isDirectory()) return null;
  } catch {
    return null;
  }
  return candidate;
}

/**
 * Find an installed application's directory by its winget display name.
 * @param {string} displayName e.g. "7-Zip 26.03 (x64 edition)"
 * @returns {Promise<string|null>}
 */
export async function findInstallLocation(displayName) {
  if (process.platform !== 'win32' || !displayName) return null;
  const cacheKey = `winpath:${normalizeName(displayName)}`;
  const cached = cacheGet(cacheKey);
  if (cached !== undefined) return cached || null;

  const results = await Promise.all(HIVES.map((hive) => run('reg', ['query', hive, '/s'], { timeoutMs: REG_TIMEOUT_MS })));
  let found = null;
  for (const result of results) {
    if (!result || result.timedOut || result.code !== 0) continue;
    const path = usablePath(pickCandidate(collectEntries(result.stdout), displayName));
    if (path) {
      found = path;
      break;
    }
  }
  cacheSet(cacheKey, found || '', TTL.checkUpdates);
  return found;
}
