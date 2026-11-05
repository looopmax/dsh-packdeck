// Manager catalog (CONTRACT §7.1 / §7.4).
//
// This file is the single source of truth for *what* managers exist: id, label, vendor,
// language/editor group, item kind, binary candidates on PATH, version probe + parser,
// capabilities, timeouts and the packageId charset accepted from the UI.
//
// Detection (lib/detect.js), snapshot dispatch (lib/managers.js), mutation argv
// (lib/commands.js) and the HTTP layer (lib/api.js) all read this module instead of
// hardcoding manager id arrays. Editor managers come from one descriptor factory so
// vscode / cursor / pink / code-insiders / windsurf can never drift apart.

const TEN_MINUTES = 10 * 60_000;
const FIFTEEN_MINUTES = 15 * 60_000;

/** Ordered groups from CONTRACT §7.1. */
export const GROUPS = [
  { id: 'system', label: '系统', kind: 'system', order: 10 },
  { id: 'node', label: 'Node.js', kind: 'language', order: 20 },
  { id: 'python', label: 'Python', kind: 'language', order: 30 },
  { id: 'rust', label: 'Rust', kind: 'language', order: 40 },
  { id: 'go', label: 'Go', kind: 'language', order: 50 },
  { id: 'ruby', label: 'Ruby', kind: 'language', order: 60 },
  { id: 'dotnet', label: '.NET', kind: 'language', order: 70 },
  { id: 'editors', label: '编辑器扩展', kind: 'editor', order: 80 },
];

/* --------------------------------------------------------------- version parsers */

function firstLine(text) {
  return (
    String(text || '')
      .split('\n')
      .map((line) => line.trim())
      .find(Boolean) || ''
  );
}

/** Parser for `<tool> <version> (...)` output: returns `<prefix><version>` or the first line. */
function versionByPattern(pattern, prefix = '') {
  return (text) => {
    const match = pattern.exec(String(text || ''));
    if (match && match[1]) return `${prefix}${match[1]}`;
    return firstLine(text) || null;
  };
}

/** `winget --version` prints a bare or `v`-prefixed version; keep exactly one leading `v`. */
function wingetVersion(text) {
  const line = firstLine(text);
  if (!line) return null;
  return /^v/i.test(line) ? line : `v${line}`;
}

/* ---------------------------------------------------------------- capabilities */

function capabilities(overrides = {}) {
  return {
    list: true,
    checkUpdates: true,
    search: true,
    install: true,
    update: true,
    uninstall: true,
    detail: true,
    reveal: true,
    ...overrides,
  };
}

/* ------------------------------------------------------------------- patterns */

const NODE_PATTERN = /^[A-Za-z0-9@][A-Za-z0-9@/._~-]{0,213}$/;
const WINGET_PATTERN = /^[^\u0000-\u001f\u007f]{1,300}$/;
const CARGO_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const PYTHON_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}(?:==[A-Za-z0-9][A-Za-z0-9._+!-]{0,63})?$/;
const GO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]*(?:\/[A-Za-z0-9._~-]+){0,20}$/;
const RUBY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DOTNET_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** `publisher.extension` with an optional `@version` suffix (install-by-id, §7.5.5). */
const EXTENSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}\.[A-Za-z0-9][A-Za-z0-9-]{0,63}(?:@[A-Za-z0-9][A-Za-z0-9._+-]{0,63})?$/;

/* ----------------------------------------------------------------- descriptors */

function manager(spec) {
  return {
    // Defaults; every field below can be overridden by the descriptor.
    versionArgs: ['--version'],
    timeouts: { list: 60_000, mutation: TEN_MINUTES },
    packageHint: 'packageId 不是合法的包名',
    capabilities: capabilities(),
    ...spec,
    bin: spec.bin || (Array.isArray(spec.binaries) && spec.binaries[0]) || spec.id,
  };
}

/** npm / pnpm / bun share every field except label, vendor and binary name. */
function nodeManager(id, label, vendor) {
  return manager({
    id,
    label,
    vendor,
    groupId: 'node',
    itemKind: 'pkg',
    scopeLabel: '全局安装',
    binaries: [id],
    adapter: 'node',
    packagePattern: NODE_PATTERN,
    parseVersion: firstLine,
    timeouts: { list: 25_000, mutation: TEN_MINUTES },
    capabilities: capabilities(),
  });
}

/**
 * One descriptor factory for every editor whose CLI speaks the VS Code extension protocol
 * (`--list-extensions --show-versions`, `--install-extension`, `--uninstall-extension`).
 *
 * @param {string} id manager id, also the item `source`
 * @param {string} label human label used by the UI ("VS Code")
 * @param {string} vendor publisher of the editor
 * @param {string[]} binaries logical CLI names tried on PATH, in order
 */
function editorManager(id, label, vendor, binaries) {
  return manager({
    id,
    label,
    vendor,
    groupId: 'editors',
    itemKind: 'ext',
    scopeLabel: '编辑器扩展',
    binaries,
    adapter: 'editor',
    packagePattern: EXTENSION_PATTERN,
    packageHint: '扩展 ID 需形如 publisher.extension（可带 @版本）',
    parseVersion: firstLine,
    timeouts: { list: 60_000, mutation: TEN_MINUTES },
    // Editors expose no latest-version source: `update` means "reinstall latest".
    capabilities: capabilities({ checkUpdates: false, search: false, reveal: false }),
  });
}

/** Catalog order = detection order = `managers[]` order in responses. */
export const MANAGERS = [
  manager({
    id: 'winget',
    label: 'winget',
    vendor: 'Microsoft',
    groupId: 'system',
    itemKind: 'app',
    scopeLabel: '系统应用',
    binaries: ['winget'],
    adapter: 'winget',
    packagePattern: WINGET_PATTERN,
    packageHint: 'packageId 含非法字符',
    parseVersion: wingetVersion,
    rootHint: () => process.env.ProgramFiles || process.env['ProgramFiles(x86)'] || null,
    timeouts: { list: 25_000, mutation: FIFTEEN_MINUTES },
    capabilities: capabilities(),
  }),

  nodeManager('npm', 'npm', 'npm, Inc.'),
  nodeManager('pnpm', 'pnpm', 'pnpm'),
  nodeManager('bun', 'bun', 'Oven'),
  manager({
    id: 'yarn',
    label: 'yarn',
    vendor: 'Yarn',
    groupId: 'node',
    itemKind: 'pkg',
    scopeLabel: '全局安装',
    binaries: ['yarn'],
    adapter: 'yarn',
    packagePattern: NODE_PATTERN,
    parseVersion: firstLine,
    timeouts: { list: 30_000, mutation: TEN_MINUTES },
    capabilities: capabilities(),
  }),

  manager({
    id: 'uv',
    label: 'uv',
    vendor: 'Astral',
    groupId: 'python',
    itemKind: 'pkg',
    scopeLabel: '全局工具',
    binaries: ['uv'],
    adapter: 'uv',
    packagePattern: PYTHON_PATTERN,
    parseVersion: versionByPattern(/^uv\s+(\S+)/m, 'uv '),
    timeouts: { list: 60_000, mutation: TEN_MINUTES },
    // PyPI has no search API; latest versions still come from `pypi.org/pypi/<name>/json`.
    capabilities: capabilities({ search: false, reveal: false }),
  }),
  manager({
    id: 'pip',
    label: 'pip',
    vendor: 'Python Packaging Authority',
    groupId: 'python',
    itemKind: 'pkg',
    scopeLabel: 'Python 环境',
    binaries: ['pip', 'pip3'],
    adapter: 'pip',
    packagePattern: PYTHON_PATTERN,
    parseVersion: versionByPattern(/^pip\s+([0-9][^\s]*)/mi, 'pip '),
    timeouts: { list: 60_000, mutation: TEN_MINUTES },
    capabilities: capabilities({ search: false, reveal: false }),
  }),

  manager({
    id: 'cargo',
    label: 'cargo',
    vendor: 'Rust Foundation',
    groupId: 'rust',
    itemKind: 'pkg',
    scopeLabel: '全局 crate',
    binaries: ['cargo'],
    adapter: 'cargo',
    packagePattern: CARGO_PATTERN,
    packageHint: 'crate 名称不合法',
    parseVersion: versionByPattern(/^cargo\s+(\S+)/m, 'cargo '),
    timeouts: { list: 30_000, mutation: TEN_MINUTES },
    capabilities: capabilities({ reveal: false }),
  }),

  manager({
    id: 'go',
    label: 'go',
    vendor: 'Google',
    groupId: 'go',
    itemKind: 'pkg',
    scopeLabel: '全局二进制',
    binaries: ['go'],
    adapter: 'go',
    packagePattern: GO_PATTERN,
    packageHint: 'Go 模块路径不合法',
    versionArgs: ['version'],
    parseVersion: versionByPattern(/go version go(\S+)/, 'go'),
    timeouts: { list: 60_000, mutation: TEN_MINUTES },
    // No latest-version source (`latest` is always null); `update` = reinstall latest;
    // `go install` cannot uninstall, so the UI must hide the button (capability false).
    capabilities: capabilities({ checkUpdates: false, search: false, uninstall: false, reveal: false }),
  }),

  manager({
    id: 'gem',
    label: 'gem',
    vendor: 'RubyGems',
    groupId: 'ruby',
    itemKind: 'pkg',
    scopeLabel: '全局 gem',
    binaries: ['gem'],
    adapter: 'gem',
    packagePattern: RUBY_PATTERN,
    parseVersion: firstLine,
    timeouts: { list: 30_000, mutation: TEN_MINUTES },
    capabilities: capabilities({ reveal: false }),
  }),

  manager({
    id: 'dotnet',
    label: 'dotnet',
    vendor: 'Microsoft',
    groupId: 'dotnet',
    itemKind: 'pkg',
    scopeLabel: '全局工具',
    binaries: ['dotnet'],
    adapter: 'dotnet',
    packagePattern: DOTNET_PATTERN,
    parseVersion: firstLine,
    timeouts: { list: 60_000, mutation: TEN_MINUTES },
    capabilities: capabilities({ reveal: false }),
  }),

  editorManager('vscode', 'VS Code', 'Microsoft', ['code']),
  editorManager('cursor', 'Cursor', 'Anysphere', ['cursor']),
  editorManager('pink', 'PinK', 'SUD-GLOBAL', ['PinK']),
  editorManager('code-insiders', 'VS Code Insiders', 'Microsoft', ['code-insiders']),
  editorManager('windsurf', 'Windsurf', 'Codeium', ['windsurf']),
];

export const MANAGER_IDS = MANAGERS.map((entry) => entry.id);

export const MANAGER_DEFS = Object.fromEntries(MANAGERS.map((entry) => [entry.id, entry]));

const BY_ID = new Map(MANAGERS.map((entry) => [entry.id, entry]));

export function getManager(id) {
  return typeof id === 'string' ? BY_ID.get(id) || null : null;
}

export function isManagerId(id) {
  return getManager(id) !== null;
}

export function groupOf(groupId) {
  return GROUPS.find((group) => group.id === groupId) || null;
}

export function groupKindOf(groupId) {
  const group = groupOf(groupId);
  return group ? group.kind : 'language';
}

export function groupLabelOf(groupId) {
  const group = groupOf(groupId);
  return group ? group.label : groupId;
}

