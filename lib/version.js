// Semver-ish version comparison.
// Contract: hasUpdate === latest != null && latest !== version && semverishGreater(latest, version);
// non-semver versions degrade to "string not equal".

/** Leading dotted numeric core, e.g. "26.03.00.0" -> [26,3,0,0], "v1.29.380" -> [1,29,380]. */
function numericCore(value) {
  const text = String(value ?? '').trim().replace(/^[vV]/, '');
  const match = /^\d+(?:\.\d+)*/.exec(text);
  if (!match) return null;
  return match[0].split('.').map((part) => Number.parseInt(part, 10));
}

function compareNumeric(left, right) {
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    const a = left[i] ?? 0;
    const b = right[i] ?? 0;
    if (a !== b) return a > b ? 1 : -1;
  }
  return 0;
}

/** True when `candidate` is strictly greater than `current`. */
export function semverishGreater(candidate, current) {
  const a = numericCore(candidate);
  const b = numericCore(current);
  if (a && b) {
    // Same numeric core (e.g. "26.05" vs "26.05.0") means "no update", even though the
    // raw strings differ: padding zeros carry no meaning.
    return compareNumeric(a, b) > 0;
  }
  return String(candidate ?? '').trim() !== String(current ?? '').trim();
}

/** Contract helper: does this item need an update? */
export function hasUpdate(latest, version) {
  if (latest === null || latest === undefined) return false;
  const next = String(latest).trim();
  const current = String(version ?? '').trim();
  if (!next) return false;
  if (next === current) return false;
  return semverishGreater(next, current);
}
