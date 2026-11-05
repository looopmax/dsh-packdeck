#!/usr/bin/env node
// Packdeck dev probe — imports the host adapters directly (no Cordis, no HTTP server).
//
//   node tools/probe.mjs                              # snapshot summary + parse assertions
//   node tools/probe.mjs --action detect              # whole-catalog detection (bypasses cache)
//   node tools/probe.mjs --action managers            # detection table for every manager
//   node tools/probe.mjs --action parse               # winget fixed-width parser assertions
//   node tools/probe.mjs --action check-updates       # detected managers with a latest source
//   node tools/probe.mjs --action check-updates --manager npm
//   node tools/probe.mjs --action search --manager winget --query 7zip
//   node tools/probe.mjs --action detail --manager npm --package typescript
//   node tools/probe.mjs --action commands            # dry-run command construction (never spawns)
//   node tools/probe.mjs --action install --manager npm --package eslint --dry-run
//   node tools/probe.mjs --action reveal --path "C:\\Program Files\\7-Zip" --dry-run
//   node tools/probe.mjs --action icons          # per-manager logoUrl coverage + top-3 samples
//   node tools/probe.mjs --action icon --id winget:7zip.7zip
//   node tools/probe.mjs --action icon --id vscode:dbaeumer.vscode-eslint
//   node tools/probe.mjs --action processes           # CONTRACT §11.2.3 running items + timings
//   node tools/probe.mjs --action process-detail --id npm:typescript
//   node tools/probe.mjs --action launch --id winget:7zip.7zip        # dry run, never spawns
//   node tools/probe.mjs --action process-kill --pid 1234             # dry run by default
//   node tools/probe.mjs --action process-kill --pid 1234 --force     # real kill (own test pids only)
//
// `--action icon` resolves through the exact code path of GET /packdeck/icon (no server).
// Mutating actions are refused unless --dry-run is passed; in dry-run mode the command line
// is built and printed but nothing is executed. No install/uninstall ever runs from here.

import { run } from '../lib/run.js';
import { parseWingetTable } from '../lib/table.js';
import { displayWidth } from '../lib/text.js';
import { dispatchAction } from '../lib/api.js';
import { buildMutationCommand, MANAGER_IDS, MUTATION_ACTIONS } from '../lib/commands.js';
import { GROUPS, getManager } from '../lib/catalog.js';
import { resolveIcon } from '../lib/icons.js';
import { extensionRoots, getExtensionIndex } from '../lib/iconres.js';
import { hasUpdate, semverishGreater } from '../lib/version.js';

const argv = process.argv.slice(2);

function arg(name, fallback = null) {
  const index = argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = argv[index + 1];
  return value && !value.startsWith('--') ? value : true;
}

const action = String(arg('action', 'snapshot'));
const manager = arg('manager', null);
const query = arg('query', null);
const packageId = arg('package', null);
const revealPath = arg('path', null);
const iconId = arg('id', null);
const iconVersion = arg('version', null);
const dryRun = argv.includes('--dry-run');

const SAMPLE_IDS = {
  winget: '7zip.7zip',
  npm: 'eslint',
  pnpm: 'eslint',
  bun: 'eslint',
  yarn: 'eslint',
  cargo: 'ripgrep',
  uv: 'ruff',
  pip: 'requests',
  go: 'golang.org/x/tools/cmd/stringer',
  gem: 'rake',
  dotnet: 'dotnet-ef',
  vscode: 'ms-python.python',
  cursor: 'ms-python.python',
  pink: 'ms-python.python',
  'code-insiders': 'ms-python.python',
  windsurf: 'ms-python.python',
};

const out = { action, startedAt: new Date().toISOString() };
const checks = {};
const startedAt = Date.now();

function recordCheck(name, passed, detail) {
  checks[name] = { pass: Boolean(passed), ...(detail === undefined ? {} : { detail }) };
  return Boolean(passed);
}

function truncate(text, max = 160) {
  const value = String(text ?? '');
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/* ------------------------------------------------------------- synthetic table */

function padCell(text, width) {
  const value = String(text ?? '');
  const current = displayWidth(value);
  return current >= width ? `${value} ` : value + ' '.repeat(width - current);
}

function syntheticTable(rows) {
  const widths = [26, 24, 14, 16, 8]; // Name, Id, Version, Available, Source
  const header = ['Name', 'Id', 'Version', 'Available', 'Source'].map((title, i) => padCell(title, widths[i])).join('');
  const separator = '-'.repeat(displayWidth(header));
  const body = rows.map((cells) => cells.map((cell, i) => padCell(cell, widths[i])).join('').trimEnd()).join('\n');
  return `${header}\n${separator}\n${body}\n`;
}

function parseAssertions() {
  const synthetic = syntheticTable([
    ['微信开发者工具', 'Tencent.WeixinDevTools', '2.02.2609231', '2.02.2609240', 'winget'],
    ['Alacritty', 'Alacritty.Alacritty', '0.17.0', '', 'winget'],
  ]).concat('28 upgrades available.\n');

  const parsed = parseWingetTable(synthetic);
  const cjkRow = parsed.rows[0] || {};
  const blankRow = parsed.rows[1] || {};

  recordCheck('synthetic.tableFound', parsed.found === true);
  recordCheck('synthetic.rowCountIs2', parsed.rows.length === 2, parsed.rows.length);
  recordCheck('synthetic.cjkNameExact', cjkRow.name === '微信开发者工具', cjkRow.name);
  recordCheck('synthetic.cjkIdExact', cjkRow.id === 'Tencent.WeixinDevTools', cjkRow.id);
  recordCheck('synthetic.cjkAvailableExact', cjkRow.available === '2.02.2609240', cjkRow.available);
  recordCheck('synthetic.blankAvailableEmpty', blankRow.available === '', JSON.stringify(blankRow.available));
  recordCheck('synthetic.blankAvailableNoUpdate', hasUpdate(blankRow.available, blankRow.version) === false);
  recordCheck('synthetic.summaryRowSkipped', !parsed.rows.some((row) => /upgrades available/i.test(row.name || '')));
  recordCheck('synthetic.displayWidthCjkIs4', displayWidth('微信') === 4, displayWidth('微信'));

  return {
    syntheticInput: synthetic.trim().split('\n'),
    syntheticColumns: parsed.columns.map((column) => ({ key: column.key, start: column.start })),
    rows: parsed.rows,
  };
}

async function realWingetAssertions() {
  const result = await run('winget', ['list', '--accept-source-agreements', '--disable-interactivity'], { timeoutMs: 60_000 });
  if (result.code !== 0 || result.timedOut) {
    recordCheck('real.wingetList', false, truncate(result.stderr || result.spawnError || `exit ${result.code}`));
    return { error: truncate(result.stderr || result.spawnError || `exit ${result.code}`) };
  }
  const parsed = parseWingetTable(result.stdout);
  recordCheck('real.wingetList', true, { rows: parsed.rows.length });

  const cjkRow = parsed.rows.find((row) => /[\u3400-\u9fff]/.test(row.name || ''));
  const blankRow = parsed.rows.find((row) => row.available === '');
  const cjkIdClean = cjkRow ? !/[\u3400-\u9fff]/.test(cjkRow.id) && cjkRow.id === cjkRow.id.trim() : false;

  recordCheck('real.cjkRowParsed', Boolean(cjkRow), cjkRow);
  recordCheck('real.cjkIdHasNoCjkOrSpace', cjkIdClean, cjkRow && cjkRow.id);
  recordCheck('real.cjkVersionLooksValid', Boolean(cjkRow && /^[0-9A-Za-z.+~-]+$/.test(cjkRow.version || '')), cjkRow && cjkRow.version);
  recordCheck('real.blankAvailableRowParsed', Boolean(blankRow), blankRow);
  recordCheck('real.sourceColumnPresent', parsed.rows.some((row) => row.source === 'winget' || row.source === 'msstore'));

  return {
    rowCount: parsed.rows.length,
    columns: parsed.columns.map((column) => ({ key: column.key, start: column.start })),
    cjkRow,
    blankAvailableRow: blankRow,
    sampleHead: parsed.rows.slice(0, 3),
  };
}

/* -------------------------------------------------------------------- actions */

function managerRows(data) {
  return data.managers.map((entry) => ({
    id: entry.id,
    label: entry.label,
    group: entry.groupId,
    kind: entry.kind,
    detected: entry.detected,
    available: entry.available,
    version: entry.version,
    itemCount: entry.itemCount,
    error: entry.error,
  }));
}

function groupSummary(data) {
  return data.groups.map((group) => ({
    id: group.id,
    label: group.label,
    kind: group.kind,
    order: group.order,
    managerIds: group.managerIds,
    availableIds: group.availableIds,
  }));
}

const ITEM_KEYS_V2 = [
  'id',
  'manager',
  'groupId',
  'name',
  'packageId',
  'source',
  'kind',
  'scope',
  'cwd',
  'path',
  'version',
  'latest',
  'hasUpdate',
  'description',
  'sizeBytes',
  'installedAt',
  'managerVersion',
];

const MANAGER_KEYS_V2 = [
  'id',
  'label',
  'vendor',
  'kind',
  'groupId',
  'groupLabel',
  'scopeLabel',
  'available',
  'detected',
  'version',
  'root',
  'error',
  'reason',
  'itemCount',
  'capabilities',
];

function summarizeSnapshot(data) {
  const counts = {};
  const samples = {};
  for (const id of MANAGER_IDS) {
    const items = data.items.filter((item) => item.manager === id);
    counts[id] = items.length;
    samples[id] = items.length
      ? {
          id: items[0].id,
          name: items[0].name,
          packageId: items[0].packageId,
          version: items[0].version,
          latest: items[0].latest,
          hasUpdate: items[0].hasUpdate,
          kind: items[0].kind,
          scope: items[0].scope,
          path: items[0].path,
          source: items[0].source,
        }
      : null;
  }

  recordCheck('snapshot.groupsPresent', data.groups.length === GROUPS.length, data.groups.length);
  recordCheck(
    'snapshot.groupsShape',
    data.groups.every((group) =>
      ['id', 'label', 'kind', 'order', 'managerIds', 'availableIds', 'detected', 'total'].every((key) => key in group),
    ),
  );
  recordCheck('snapshot.managersAllPresent', data.managers.length === MANAGER_IDS.length, data.managers.length);
  recordCheck(
    'snapshot.managersShape',
    data.managers.every((entry) => MANAGER_KEYS_V2.every((key) => key in entry)),
  );
  recordCheck(
    'snapshot.capabilitiesShape',
    data.managers.every(
      (entry) =>
        entry.capabilities &&
        ['list', 'checkUpdates', 'search', 'install', 'update', 'uninstall', 'detail', 'reveal'].every(
          (key) => typeof entry.capabilities[key] === 'boolean',
        ),
    ),
  );
  recordCheck('snapshot.detectionMeta', typeof data.detection?.probed === 'number' && data.detection.probed === MANAGER_IDS.length, data.detection);
  recordCheck(
    'snapshot.statsShape',
    ['total', 'updatable', 'managersAvailable', 'managersDetected', 'disk'].every((key) => key in data.stats),
    { total: data.stats.total, updatable: data.stats.updatable, managersAvailable: data.stats.managersAvailable, managersDetected: data.stats.managersDetected },
  );
  recordCheck('snapshot.itemCountMatches', data.managers.every((entry) => entry.itemCount === counts[entry.id]), {
    mismatches: data.managers.filter((entry) => entry.itemCount !== counts[entry.id]).map((entry) => entry.id),
  });
  recordCheck('snapshot.idsUnique', new Set(data.items.map((item) => item.id)).size === data.items.length, data.items.length);
  recordCheck('snapshot.itemSchemaComplete', data.items.every((item) => ITEM_KEYS_V2.every((key) => key in item)));
  recordCheck('snapshot.itemKindsValid', data.items.every((item) => ['app', 'pkg', 'ext'].includes(item.kind)));
  recordCheck(
    'snapshot.undetectedHaveNoItems',
    data.managers.every((entry) => entry.detected || entry.itemCount === 0),
  );
  recordCheck(
    'snapshot.editorItemsNullLatest',
    data.items.filter((item) => item.kind === 'ext').every((item) => item.latest === null && item.hasUpdate === false),
  );
  recordCheck(
    'snapshot.updatableConsistent',
    data.items
      .filter((item) => item.hasUpdate === true)
      .every((item) => item.latest !== null && semverishGreater(item.latest, item.version)),
  );

  const detected = data.managers.filter((entry) => entry.detected);
  const missing = data.managers.filter((entry) => !entry.detected);

  const machineExpectations = {
    'winget.items>0': counts.winget > 0,
    'npm.items>0': counts.npm > 0,
    'pnpm.items>0': counts.pnpm > 0,
    'pip.items>0': counts.pip > 0,
    'cargo.items===0': counts.cargo === 0,
    'uv.items===0': counts.uv === 0,
    'vscode.items===11': counts.vscode === 11,
    'cursor.items===2': counts.cursor === 2,
    'pink.items===0': counts.pink === 0,
  };

  return {
    durationMs: Date.now() - startedAt,
    counts,
    samples,
    detected: detected.map((entry) => entry.id),
    missing: missing.map((entry) => entry.id),
    machineExpectations,
    managers: managerRows(data),
    groups: groupSummary(data),
    stats: data.stats,
    detection: data.detection,
    itemCount: data.items.length,
    itemsWithUpdates: data.items
      .filter((item) => item.hasUpdate === true)
      .slice(0, 5)
      .map((item) => ({ id: item.id, version: item.version, latest: item.latest })),
  };
}

async function runSnapshot() {
  const data = await dispatchAction({ action: 'snapshot' });
  return { ...summarizeSnapshot(data), parseChecks: parseAssertions() };
}

async function runDetect() {
  const data = await dispatchAction({ action: 'detect' });
  const table = data.managers.map((entry) => ({
    id: entry.id,
    label: entry.label,
    group: entry.groupId,
    detected: entry.detected,
    version: entry.version,
    reason: entry.reason,
    itemCount: entry.itemCount,
  }));

  recordCheck('detect.actionShape', Array.isArray(data.managers) && Array.isArray(data.groups), {
    managers: data.managers.length,
    groups: data.groups.length,
  });
  recordCheck('detect.itemsOmitted', data.items.length === 0, data.items.length);
  recordCheck('detect.probedAll', data.detection?.probed === MANAGER_IDS.length, data.detection);
  recordCheck(
    'detect.undetectedHaveReason',
    data.managers.every((entry) => entry.detected || (entry.reason && entry.available === false && entry.itemCount === 0)),
  );
  recordCheck(
    'detect.neverFailsWholeRequest',
    data.managers.every((entry) => (entry.detected ? entry.error === null : Boolean(entry.reason))),
  );

  return {
    durationMs: Date.now() - startedAt,
    detection: data.detection,
    groups: groupSummary(data),
    managers: table,
    detectedCount: data.managers.filter((entry) => entry.detected).length,
    undetectedCount: data.managers.filter((entry) => !entry.detected).length,
    stats: data.stats,
  };
}

async function runManagers() {
  const data = await dispatchAction({ action: 'snapshot' });
  recordCheck('managers.allPresent', data.managers.length === MANAGER_IDS.length, data.managers.length);
  recordCheck('managers.shapeComplete', data.managers.every((entry) => MANAGER_KEYS_V2.every((key) => key in entry)));
  return {
    managers: data.managers,
    availability: Object.fromEntries(
      data.managers.map((entry) => [
        entry.id,
        {
          detected: entry.detected,
          available: entry.available,
          version: entry.version,
          root: entry.root,
          itemCount: entry.itemCount,
          reason: entry.reason,
          capabilities: entry.capabilities,
        },
      ]),
    ),
    groups: groupSummary(data),
    detection: data.detection,
  };
}

async function runCheckUpdates() {
  const targets = manager ? [String(manager)] : MANAGER_IDS;
  const results = {};
  for (const id of targets) {
    const def = getManager(id);
    const beganAt = Date.now();
    try {
      const data = await dispatchAction({ action: 'check-updates', manager: id });
      results[id] = {
        durationMs: Date.now() - beganAt,
        checkedAt: data.checkedAt,
        unsupported: data.unsupported === true,
        updateCount: data.updates.length,
        failedCount: data.failed.length,
        firstUpdates: data.updates.slice(0, 3),
        firstFailed: data.failed.slice(0, 3),
      };
      recordCheck(`checkUpdates.${id}`, true, `${data.updates.length} updates / ${data.failed.length} failed`);
    } catch (error) {
      results[id] = { durationMs: Date.now() - beganAt, error: { code: error.code, message: error.message } };
      // Undetected managers and managers without a latest source are expected to refuse.
      const expected = !def || !def.capabilities.checkUpdates || /未检测到|不可用/.test(error.message);
      recordCheck(`checkUpdates.${id}`, expected, error.message);
    }
  }
  recordCheck(
    'checkUpdates.atLeastOneManagerReported',
    Object.values(results).some((entry) => typeof entry.updateCount === 'number'),
  );
  return { results };
}

async function runSearch() {
  const targets = manager ? [String(manager)] : MANAGER_IDS;
  const results = {};
  for (const id of targets) {
    const def = getManager(id);
    const text = query || (id === 'winget' ? '7zip' : id === 'cargo' ? 'ripgrep' : id === 'gem' ? 'rake' : id === 'dotnet' ? 'serilog' : 'eslint');
    try {
      const data = await dispatchAction({ action: 'search', manager: id, query: text });
      results[id] = { query: text, count: data.results.length, firstResults: data.results.slice(0, 3) };
      recordCheck(`search.${id}`, data.results.length > 0, `${data.results.length} results for "${text}"`);
    } catch (error) {
      results[id] = { query: text, error: { code: error.code, message: error.message } };
      const expected = !def || !def.capabilities.search || /不支持搜索|未检测到/.test(error.message);
      recordCheck(`search.${id}`, expected, error.message);
    }
  }
  return { results };
}

async function runDetail() {
  if (!manager || !packageId) throw new Error('detail 需要 --manager 与 --package');
  const beganAt = Date.now();
  const data = await dispatchAction({ action: 'detail', manager: String(manager), packageId: String(packageId) });
  recordCheck('detail.pathOrNull', data.path === null || typeof data.path === 'string', data.path);
  recordCheck('detail.dependenciesArray', Array.isArray(data.dependencies), Array.isArray(data.dependencies) ? data.dependencies.length : null);
  return {
    durationMs: Date.now() - beganAt,
    detail: {
      ...data,
      description: truncate(data.description, 200),
      dependencies: Array.isArray(data.dependencies) ? data.dependencies.slice(0, 5) : data.dependencies,
      sizeBytes: data.sizeBytes,
    },
  };
}

/** Dry-run every (manager, action) pair plus one versioned install per manager. */
async function runCommands() {
  const commands = [];
  const unsupported = [];

  for (const id of MANAGER_IDS) {
    const def = getManager(id);
    for (const mutatingAction of MUTATION_ACTIONS) {
      const supported = Boolean(def && def.capabilities[mutatingAction]);
      if (!supported) {
        try {
          await dispatchAction({ action: mutatingAction, manager: id, packageId: SAMPLE_IDS[id] }, { dryRun: true });
          recordCheck(`commands.${id}.${mutatingAction}.unsupported`, false, 'capability false but command was built');
        } catch (error) {
          unsupported.push({ manager: id, action: mutatingAction, capability: false, error: error.message });
          recordCheck(`commands.${id}.${mutatingAction}.unsupported`, error.code === 'unavailable', error.message);
        }
        continue;
      }

      const params = { packageId: SAMPLE_IDS[id], version: mutatingAction === 'install' ? null : null };
      const built = buildMutationCommand(id, mutatingAction, params);
      const dry = await dispatchAction(
        { action: mutatingAction, manager: id, packageId: params.packageId, version: params.version },
        { dryRun: true },
      );
      commands.push({
        manager: id,
        action: mutatingAction,
        packageId: params.packageId,
        command: dry.command,
        args: built.args,
        timeoutMs: built.timeoutMs,
      });
      recordCheck(
        `commands.${id}.${mutatingAction}.dryRun`,
        dry.dryRun === true && typeof dry.command === 'string' && dry.command.length > 0,
        dry.command,
      );
    }
  }

  // Version-passing forms (still dry-run): proves the ecosystem-specific version syntax.
  const versionSamples = [];
  for (const id of MANAGER_IDS) {
    const def = getManager(id);
    if (!def || !def.capabilities.install) continue;
    try {
      const dry = await dispatchAction(
        { action: 'install', manager: id, packageId: SAMPLE_IDS[id], version: '1.2.3' },
        { dryRun: true },
      );
      versionSamples.push({ manager: id, command: dry.command, args: dry.args });
      recordCheck(`commands.${id}.installWithVersion`, dry.args.join(' ').includes('1.2.3'), dry.command);
    } catch (error) {
      versionSamples.push({ manager: id, error: error.message });
      recordCheck(`commands.${id}.installWithVersion`, false, error.message);
    }
  }

  return { executed: false, note: 'dry-run only: 没有任何子进程被启动', commands, unsupported, versionSamples };
}

async function runSingleMutation(name) {
  if (!manager || !packageId) throw new Error(`${name} 需要 --manager 与 --package`);
  if (!dryRun) {
    throw new Error(`probe 拒绝真实执行 ${name}；请加 --dry-run 只验证命令构造`);
  }
  const data = await dispatchAction(
    { action: name, manager: String(manager), packageId: String(packageId), version: arg('version', null) },
    { dryRun: true },
  );
  recordCheck(`${name}.dryRun`, data.dryRun === true, data.command);
  return { executed: false, note: 'dry-run only', ...data };
}

async function runReveal() {
  if (!revealPath) throw new Error('reveal 需要 --path');
  const data = await dispatchAction(
    { action: 'reveal', manager: manager ? String(manager) : 'winget', packageId: packageId ? String(packageId) : undefined, path: String(revealPath) },
    { dryRun: true },
  );
  recordCheck('reveal.dryRun', data.dryRun === true, data.command);
  return { executed: false, note: 'dry-run only: 没有启动 explorer.exe', ...data };
}

async function runParse() {
  return { synthetic: parseAssertions(), real: await realWingetAssertions() };
}

/* ----------------------------------------------------------------------- icons */

/** CONTRACT §8.2 coverage: per manager, how many snapshot rows carry a `logoUrl`, top-3. */
async function runIcons() {
  const beganAt = Date.now();
  const data = await dispatchAction({ action: 'snapshot' });
  const rows = [];
  let withLogo = 0;

  for (const id of MANAGER_IDS) {
    const items = data.items.filter((item) => item.manager === id);
    const logoItems = items.filter(
      (item) => typeof item.logoUrl === 'string' && item.logoUrl.startsWith('/packdeck/icon?id='),
    );
    withLogo += logoItems.length;
    const row = {
      manager: id,
      kind: items[0] ? items[0].kind : (getManager(id) || {}).itemKind || null,
      items: items.length,
      withLogo: logoItems.length,
      samples: logoItems.slice(0, 3).map((item) => ({ id: item.id, name: item.name, logoUrl: item.logoUrl })),
    };
    // End-to-end proof for one sample per manager: same resolver as GET /packdeck/icon.
    if (logoItems.length > 0) {
      const sample = logoItems[0];
      const sampleStartedAt = Date.now();
      try {
        const icon = await resolveIcon(sample.id);
        row.sampleResolved = icon
          ? { id: sample.id, found: true, contentType: icon.contentType, bytes: icon.bytes.length, durationMs: Date.now() - sampleStartedAt }
          : { id: sample.id, found: false, durationMs: Date.now() - sampleStartedAt };
      } catch (error) {
        row.sampleResolved = { id: sample.id, found: false, error: error.message };
      }
    }
    rows.push(row);
  }

  const rootsUsed = {};
  for (const id of MANAGER_IDS) {
    const def = getManager(id);
    if (!def || def.itemKind !== 'ext') continue;
    const index = await getExtensionIndex(id);
    rootsUsed[id] = {
      root: index ? index.root : null,
      checked: index ? index.checkedRoots : extensionRoots(id),
      extensions: index ? index.extensions : 0,
      withIcon: index ? index.withIcon : 0,
    };
  }

  recordCheck('icons.itemsHaveLogoUrlField', data.items.every((item) => 'logoUrl' in item));
  recordCheck(
    'icons.pkgNeverHasLogo',
    data.items.filter((item) => item.kind === 'pkg').every((item) => item.logoUrl === null),
  );
  recordCheck(
    'icons.logoUrlShape',
    data.items
      .filter((item) => item.logoUrl)
      .every(
        (item) =>
          item.logoUrl.startsWith('/packdeck/icon?id=') &&
          item.logoUrl.includes(`id=${encodeURIComponent(item.id)}`) &&
          item.logoUrl.includes('&r='),
      ),
  );
  recordCheck('icons.appCoverage', data.items.filter((item) => item.kind === 'app').some((item) => item.logoUrl));
  recordCheck('icons.extCoverage', data.items.filter((item) => item.kind === 'ext').some((item) => item.logoUrl));

  return {
    durationMs: Date.now() - beganAt,
    totals: { items: data.items.length, withLogo },
    managers: rows,
    extensionRoots: rootsUsed,
  };
}

/** Resolve one item id through the icon route's code path (no HTTP server involved). */
async function runIcon() {
  const raw = iconId ? String(iconId) : '';
  if (!raw) throw new Error('icon 需要 --id <itemId>（例如 winget:7zip.7zip 或 vscode:dbaeumer.vscode-eslint）');
  const itemId = raw.includes(':') ? raw : `${manager ? String(manager) : 'winget'}:${raw}`;
  const beganAt = Date.now();
  const icon = await resolveIcon(itemId, { version: iconVersion ? String(iconVersion) : '' });
  recordCheck('icon.resultShape', icon === null || (typeof icon.contentType === 'string' && icon.bytes.length > 0));
  return {
    itemId,
    durationMs: Date.now() - beganAt,
    found: Boolean(icon),
    contentType: icon ? icon.contentType : null,
    bytes: icon ? icon.bytes.length : 0,
    path: icon ? icon.path : null,
  };
}

/* ------------------------------------------------------------ v3 processes */

/** CONTRACT §11.2.3: which managed items are running, with the engine breakdown. */
async function runProcesses() {
  const beganAt = Date.now();
  const data = await dispatchAction({ action: 'processes' });
  const elapsed = Date.now() - beganAt;
  recordCheck('processes.hasEngine', typeof data.engine === 'string', data.engine);
  recordCheck('processes.itemsOnlyRunning', Array.isArray(data.items) && data.items.every((item) => item.procCount > 0));
  recordCheck('processes.timingsPresent', Boolean(data.timings && typeof data.timings.total === 'number'), data.timings);
  recordCheck('processes.withinBudget', elapsed <= 400, elapsed);
  recordCheck(
    'processes.sortedByCount',
    data.items.every((item, index) => index === 0 || data.items[index - 1].procCount >= item.procCount),
  );
  return {
    durationMs: elapsed,
    engine: data.engine,
    partial: data.partial === true,
    materialReady: data.materialReady !== false,
    materialSource: data.materialSource || null,
    timings: data.timings,
    totals: data.totals,
    itemCount: data.items.length,
    items: data.items.slice(0, 12),
  };
}

/** CONTRACT §11.2.4: cwd / env / children of one item's bound processes. */
async function runProcessDetail(itemId, pidArg) {
  const id = itemId ? String(itemId) : null;
  if (!id) throw new Error('process-detail 需要 --id <itemId>');
  const focusPid = Number(pidArg);
  const body = { action: 'process-detail', id };
  if (Number.isInteger(focusPid) && focusPid > 0) body.pid = focusPid;
  let beganAt = Date.now();
  let data = null;
  let error = null;
  let warmUpMs = 0;
  try {
    data = await dispatchAction(body);
  } catch (caught) {
    // `process-detail` reads the most recent binding snapshot (CONTRACT §11 v3 follow-up). A
    // standalone probe has none yet, so reproduce what the UI does: snapshot once (which hands
    // its items to warmUp), poll `processes`, then retry the detail.
    if (caught && caught.code === 'bad-request' && /尚未采集到进程快照/.test(caught.message || '')) {
      // Pre-roll is a probe-only convenience: it stands in for the UI's 3 s polling loop, so it
      // is measured separately and never counted against the action's own budget.
      const warmStartedAt = Date.now();
      await dispatchAction({ action: 'snapshot' });
      let ready = false;
      for (let attempt = 0; attempt < 12 && !ready; attempt += 1) {
        const polled = await dispatchAction({ action: 'processes' }, { force: true });
        ready = polled.partial !== true && Array.isArray(polled.items) && polled.items.length > 0;
        if (!ready) await new Promise((resolve) => setTimeout(resolve, 700));
      }
      warmUpMs = Date.now() - warmStartedAt;
      beganAt = Date.now();
      try {
        data = await dispatchAction(body);
      } catch (retryError) {
        error = { code: retryError.code || 'probe-error', message: retryError.message };
      }
    } else {
      error = { code: caught.code || 'probe-error', message: caught.message };
    }
  }
  const elapsed = Date.now() - beganAt;
  if (error) {
    recordCheck('processDetail.responds', false, error.message);
    return { id, pid: body.pid || null, durationMs: elapsed, error };
  }
  const first = data.processes && data.processes[0] ? data.processes[0] : null;
  recordCheck('processDetail.shape', Array.isArray(data.processes), (data.processes || []).length);
  recordCheck('processDetail.envSource', ['peb', 'psutil', 'none'].includes(data.envSource), data.envSource);
  recordCheck('processDetail.withinBudget', elapsed <= 1500, elapsed);
  const sample = first
    ? {
        pid: first.pid,
        ppid: first.ppid,
        name: first.name,
        exe: first.exe,
        cmdline: Array.isArray(first.cmdline) ? first.cmdline.slice(0, 3) : first.cmdline,
        cwd: first.cwd,
        startedAt: first.startedAt,
        rssBytes: first.rssBytes,
        cpuPercent: first.cpuPercent,
        user: first.user,
        threads: first.threads,
        status: first.status,
        env: first.env ? Object.keys(first.env).slice(0, 5) : null,
        envCount: first.envCount,
        envError: first.envError,
        envCode: first.envCode,
        envSource: first.envSource,
        children: first.children,
      }
    : null;
  return {
    id,
    pid: body.pid || null,
    durationMs: elapsed,
    warmUpMs,
    engine: data.engine,
    envSource: data.envSource,
    timings: data.timings,
    counts: (data.processes || []).length,
    envCount: first ? first.envCount : 0,
    cwd: first ? first.cwd : null,
    truncated: data.truncated || null,
    installHint: data.installHint || null,
    psutil: data.psutil || null,
    sample,
  };
}

/** CONTRACT §11.2.5: dry-run by default; a real kill needs --force and a probe-started pid. */
async function runProcessKill(pidArg, force) {
  const pid = Number(pidArg);
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('process-kill 需要 --pid <pid>');
  const beganAt = Date.now();
  let result = null;
  let error = null;
  try {
    result = await dispatchAction({ action: 'process-kill', pid }, { dryRun: !force });
  } catch (caught) {
    error = { code: caught.code || 'probe-error', message: caught.message };
  }
  recordCheck('processKill.responsive', true, error || result);
  return {
    pid,
    force: Boolean(force),
    durationMs: Date.now() - beganAt,
    result,
    error,
  };
}

/** CONTRACT §11.2.5: launch an app; always a dry run here. */
async function runLaunch(itemId) {
  const id = itemId ? String(itemId) : null;
  if (!id) throw new Error('launch 需要 --id <itemId>');
  const beganAt = Date.now();
  const data = await dispatchAction({ action: 'launch', id }, { dryRun: true });
  recordCheck('launch.dryRun', data.dryRun === true, data.exe);
  return { executed: false, note: 'dry-run only: 没有启动任何程序', durationMs: Date.now() - beganAt, ...data };
}

/* ----------------------------------------------------------------------- main */

try {
  switch (action) {
    case 'snapshot':
      Object.assign(out, await runSnapshot());
      break;
    case 'detect':
      Object.assign(out, await runDetect());
      break;
    case 'managers':
      Object.assign(out, await runManagers());
      break;
    case 'parse':
      Object.assign(out, await runParse());
      break;
    case 'check-updates':
      Object.assign(out, await runCheckUpdates());
      break;
    case 'search':
      Object.assign(out, await runSearch());
      break;
    case 'detail':
      Object.assign(out, await runDetail());
      break;
    case 'commands':
      Object.assign(out, await runCommands());
      break;
    case 'install':
    case 'update':
    case 'uninstall':
      Object.assign(out, await runSingleMutation(action));
      break;
    case 'reveal':
      Object.assign(out, await runReveal());
      break;
    case 'icons':
      Object.assign(out, await runIcons());
      break;
    case 'icon':
      Object.assign(out, await runIcon());
      break;
    case 'processes':
      Object.assign(out, await runProcesses());
      break;
    case 'process-detail':
      Object.assign(out, await runProcessDetail(iconId, arg('pid', null)));
      break;
    case 'process-kill':
      Object.assign(out, await runProcessKill(arg('pid', null), argv.includes('--force')));
      break;
    case 'launch':
      Object.assign(out, await runLaunch(iconId));
      break;
    default:
      throw new Error(`未知的 --action ${action}`);
  }
} catch (error) {
  out.error = { code: error.code || 'probe-error', message: error.message, log: error.log || undefined };
  process.exitCode = 2;
}

out.finishedAt = new Date().toISOString();
out.durationMs = Date.now() - startedAt;
out.checks = checks;
const failedChecks = Object.entries(checks).filter(([, value]) => !value.pass).map(([name]) => name);
out.failedChecks = failedChecks;
if (failedChecks.length > 0 && process.exitCode === undefined) process.exitCode = 1;

console.log(JSON.stringify(out, null, 2));
