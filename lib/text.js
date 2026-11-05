// ANSI / control-character / width-aware text helpers for Packdeck.
// No dependencies; Node >= 22 ESM.

const ANSI_CSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const ANSI_OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g;
const ANSI_ESC = /\x1b[()#][0-9A-Za-z]|\x1b[=>c]/g;

/** Remove ANSI escape sequences (CSI / OSC / charset selectors). */
export function stripAnsi(input) {
  if (typeof input !== 'string' || input.length === 0) return '';
  return input.replace(ANSI_OSC, '').replace(ANSI_CSI, '').replace(ANSI_ESC, '');
}

/**
 * Normalise CLI output: strip ANSI, BOM, CRLF, and progress-bar `\r` overwrites.
 * A line that was redrawn with `\r` keeps only the text after the last `\r`.
 * Some Windows launchers (pip.exe) terminate lines with `\r\r\n`, which is still one line.
 */
export function normalizeOutput(input) {
  if (typeof input !== 'string' || input.length === 0) return '';
  let text = stripAnsi(input.replace(/^\uFEFF/, ''));
  text = text.replace(/\r+\n/g, '\n');
  if (text.includes('\r')) {
    text = text
      .split('\n')
      .map((line) => {
        const i = line.lastIndexOf('\r');
        if (i < 0) return line;
        const rest = line.slice(i + 1);
        if (rest.length > 0) return rest;
        // Trailing `\r` (redrawn without a newline): keep the text that was drawn.
        return line.replace(/\r+$/, '');
      })
      .join('\n');
  }
  return text;
}

/** Terminal display width of one code point (CJK / fullwidth = 2 columns). */
export function charWidth(codePoint) {
  if (!Number.isFinite(codePoint) || codePoint <= 0) return 0;
  if (codePoint < 32 || (codePoint >= 0x7f && codePoint < 0xa0)) return 0;
  if (codePoint < 0x0300) return 1;
  if (codePoint >= 0x0300 && codePoint <= 0x036f) return 0; // combining marks
  if (codePoint === 0x200b || codePoint === 0x200c || codePoint === 0x200d || codePoint === 0xfeff) return 0;
  if (
    codePoint === 0x2329 ||
    codePoint === 0x232a ||
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2e80 && codePoint <= 0x303e) ||
    (codePoint >= 0x3041 && codePoint <= 0x33ff) ||
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0xa000 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xa960 && codePoint <= 0xa97f) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xd7b0 && codePoint <= 0xd7ff) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1f64f) ||
    (codePoint >= 0x1f900 && codePoint <= 0x1f9ff) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

/** Display width of a whole string. */
export function displayWidth(value) {
  if (!value) return 0;
  let width = 0;
  for (const ch of String(value)) width += charWidth(ch.codePointAt(0));
  return width;
}

/**
 * Slice a line by *display* columns: cells in [start, end) are kept.
 * Used to read fixed-width CLI tables whose padding is computed in cells, not chars.
 */
export function displaySlice(line, start, end = Number.POSITIVE_INFINITY) {
  if (!line) return '';
  let out = '';
  let pos = 0;
  for (const ch of line) {
    if (pos >= end) break;
    const width = charWidth(ch.codePointAt(0));
    if (pos >= start && width > 0) out += ch;
    pos += width;
  }
  return out;
}

/** Tokenise a line and report each token's display-column start. */
export function tokenizeWithDisplay(line) {
  const tokens = [];
  if (!line) return tokens;
  const chars = Array.from(line);
  let pos = 0;
  let i = 0;
  while (i < chars.length) {
    const ch = chars[i];
    if (/\s/.test(ch)) {
      pos += charWidth(ch.codePointAt(0));
      i += 1;
      continue;
    }
    const start = pos;
    let token = '';
    while (i < chars.length && !/\s/.test(chars[i])) {
      token += chars[i];
      pos += charWidth(chars[i].codePointAt(0));
      i += 1;
    }
    tokens.push({ token, displayStart: start });
  }
  return tokens;
}

/** Decode child-process bytes: UTF-8 when valid, GBK for legacy Windows console tools, lossy UTF-8 last. */
export function decodeBuffer(buffer) {
  if (!buffer || buffer.length === 0) return '';
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    /* not UTF-8 */
  }
  try {
    return new TextDecoder('gbk', { fatal: false }).decode(buffer);
  } catch {
    /* no GBK decoder in this build */
  }
  return buffer.toString('utf8');
}

/** Keep the last `maxBytes` bytes of a string (log tails only). */
export function tail(text, maxBytes) {
  const value = typeof text === 'string' ? text.trim() : String(text ?? '');
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  let out = '';
  let used = 0;
  const chars = Array.from(value).reverse();
  for (const ch of chars) {
    const size = Buffer.byteLength(ch, 'utf8');
    if (used + size > maxBytes) break;
    used += size;
    out = ch + out;
  }
  return out;
}

/** Collapse whitespace/newlines so a CLI error can be shown as a one-line message. */
export function oneLine(text, maxLength = 220) {
  const value = stripAnsi(String(text ?? ''))
    .replace(/\s+/g, ' ')
    .trim();
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}
