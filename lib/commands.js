// Single source of truth for every mutating command line (CONTRACT §2.3–2.5 + §7.4).
// Adapters execute whatever this returns; tools/probe.mjs uses it with dryRun to verify
// construction without touching the machine.
//
// The command table below is the literal §7.4 matrix. When a caller supplies `version`
// for managers whose table row has no version syntax, the ecosystem's own form is used
// (cargo `--version`, gem `-v`, dotnet `--version`, pip/uv `==`, go/editor `@`), and the
// no-version invocation is byte-identical to the table.

import { MANAGER_IDS, getManager } from './catalog.js';
import { badRequest } from './errors.js';

export { MANAGER_IDS };

export const MUTATION_ACTIONS = ['install', 'update', 'uninstall'];

const WINGET_SOURCE_FLAGS = ['--accept-source-agreements', '--disable-interactivity'];
const WINGET_PACKAGE_FLAGS = ['--accept-package-agreements', ...WINGET_SOURCE_FLAGS];
const TEN_MINUTES = 10 * 60_000;

/* ------------------------------------------------------------------- builders */

function wingetBuilder(action, packageId, version) {
  if (action === 'install') {
    const args = ['install', '--id', packageId, '-e', '--silent', ...WINGET_PACKAGE_FLAGS];
    if (version) args.push('--version', version);
    return args;
  }
  if (action === 'update') {
    const args = ['upgrade', '--id', packageId, '-e', '--silent', ...WINGET_PACKAGE_FLAGS];
    if (version) args.push('--version', version);
    return args;
  }
  if (action === 'uninstall') {
    return ['uninstall', '--id', packageId, '-e', '--silent', ...WINGET_SOURCE_FLAGS];
  }
  throw badRequest('winget 不支持该操作');
}

function npmBuilder(action, packageId, version) {
  if (action === 'install') {
    return ['install', '-g', version ? `${packageId}@${version}` : packageId, '--no-fund', '--no-audit'];
  }
  if (action === 'update') {
    return ['install', '-g', `${packageId}@latest`, '--no-fund', '--no-audit'];
  }
  if (action === 'uninstall') return ['uninstall', '-g', packageId];
  throw badRequest('npm 不支持该操作');
}

function pnpmBuilder(action, packageId, version) {
  if (action === 'install') return ['add', '-g', version ? `${packageId}@${version}` : packageId];
  if (action === 'update') return ['update', '-g', packageId, '--latest'];
  if (action === 'uninstall') return ['remove', '-g', packageId];
  throw badRequest('pnpm 不支持该操作');
}

function bunBuilder(action, packageId, version) {
  if (action === 'install') return ['add', '-g', version ? `${packageId}@${version}` : packageId];
  if (action === 'update') return ['update', '-g', packageId];
  if (action === 'uninstall') return ['remove', '-g', packageId];
  throw badRequest('bun 不支持该操作');
}

function yarnBuilder(action, packageId, version) {
  if (action === 'install') return ['global', 'add', version ? `${packageId}@${version}` : packageId];
  if (action === 'update') return ['global', 'upgrade', packageId, '--latest'];
  if (action === 'uninstall') return ['global', 'remove', packageId];
  throw badRequest('yarn 不支持该操作');
}

function cargoBuilder(action, packageId, version) {
  if (action === 'install') {
    return version ? ['install', packageId, '--version', version] : ['install', packageId];
  }
  if (action === 'update') {
    return version ? ['install', packageId, '--force', '--version', version] : ['install', packageId, '--force'];
  }
  if (action === 'uninstall') return ['uninstall', packageId];
  throw badRequest('cargo 不支持该操作');
}

function uvBuilder(action, packageId, version) {
  if (action === 'install') return ['tool', 'install', version ? `${packageId}==${version}` : packageId];
  if (action === 'update') return ['tool', 'upgrade', packageId];
  if (action === 'uninstall') return ['tool', 'uninstall', packageId];
  throw badRequest('uv 不支持该操作');
}

function pipBuilder(action, packageId, version) {
  if (action === 'install') return ['install', version ? `${packageId}==${version}` : packageId];
  if (action === 'update') return ['install', '--upgrade', version ? `${packageId}==${version}` : packageId];
  if (action === 'uninstall') return ['uninstall', '-y', packageId];
  throw badRequest('pip 不支持该操作');
}

function goBuilder(action, packageId, version) {
  if (action === 'install' || action === 'update') return ['install', `${packageId}@${version || 'latest'}`];
  throw badRequest('go install 没有卸载命令');
}

function gemBuilder(action, packageId, version) {
  if (action === 'install') return version ? ['install', packageId, '-v', version] : ['install', packageId];
  if (action === 'update') return ['update', packageId];
  if (action === 'uninstall') return ['uninstall', '-x', packageId, '-I'];
  throw badRequest('gem 不支持该操作');
}

function dotnetBuilder(action, packageId, version) {
  if (action === 'install') {
    return version ? ['tool', 'install', '-g', packageId, '--version', version] : ['tool', 'install', '-g', packageId];
  }
  if (action === 'update') {
    return version ? ['tool', 'update', '-g', packageId, '--version', version] : ['tool', 'update', '-g', packageId];
  }
  if (action === 'uninstall') return ['tool', 'uninstall', '-g', packageId];
  throw badRequest('dotnet 不支持该操作');
}

/** One builder for every editor descriptor: `update` is a forced reinstall of latest. */
function editorBuilder(action, packageId, version) {
  const target = !version || packageId.includes('@') ? packageId : `${packageId}@${version}`;
  if (action === 'install' || action === 'update') return ['--install-extension', target, '--force'];
  if (action === 'uninstall') return ['--uninstall-extension', packageId];
  throw badRequest('编辑器扩展不支持该操作');
}

const BUILDERS = {
  winget: wingetBuilder,
  npm: npmBuilder,
  pnpm: pnpmBuilder,
  bun: bunBuilder,
  yarn: yarnBuilder,
  cargo: cargoBuilder,
  uv: uvBuilder,
  pip: pipBuilder,
  go: goBuilder,
  gem: gemBuilder,
  dotnet: dotnetBuilder,
  // Every editor manager resolves to the same builder through its `editor` adapter.
};

const EDITOR_ADAPTER_BUILDER = editorBuilder;

/**
 * Build the command for a mutating action.
 *
 * @param {string} manager manager id (catalog)
 * @param {'install'|'update'|'uninstall'} action
 * @param {{packageId: string, version?: string|null}} params
 * @returns {{manager:string, action:string, bin:string, args:string[], timeoutMs:number}}
 */
export function buildMutationCommand(manager, action, params) {
  const def = getManager(manager);
  if (!def) throw badRequest('未知的包管理器');
  if (!MUTATION_ACTIONS.includes(action)) throw badRequest('未知的操作');

  const packageId = params && params.packageId;
  if (!packageId) throw badRequest('缺少 packageId');
  const version = (params && params.version) || null;

  const builder =
    def.adapter === 'editor' ? EDITOR_ADAPTER_BUILDER : Object.prototype.hasOwnProperty.call(BUILDERS, manager) ? BUILDERS[manager] : null;
  if (!builder) throw badRequest(`${def.label} 不支持变更操作`);

  const args = builder(action, packageId, version);
  return {
    manager,
    action,
    bin: def.bin,
    args,
    timeoutMs: (def.timeouts && def.timeouts.mutation) || TEN_MINUTES,
  };
}
