// Packdeck — Cordis plugin entry (Host half).
//
// Registers two exact HTTP routes on the host `webServer` service — `POST /packdeck/api`
// (actions) and `GET /packdeck/icon` (auto-retrieved logos, CONTRACT §8) — and delegates to
// lib/. The plugin stays inert when the service is missing, and never throws from `apply`.
//
// Only node:* builtins are used; there is no build step.

import { createRequestHandler } from './lib/http.js';
import { createIconRequestHandler } from './lib/icons.js';

const ROUTE = { kind: 'exact', path: '/packdeck/api' };
const ICON_ROUTE = { kind: 'exact', path: '/packdeck/icon' };

/** Cordis plugin name (matches the Loader row id). */
export const name = 'packdeck';

// Hard dependency on the HTTP carrier: with `inject` Cordis keeps this plugin inactive until
// `webServer` is provided, so a cold start can never race the service and silently end up
// inert (and the fiber is re-created if the service is replaced). Without a Web carrier in the
// composition the plugin simply never activates, which is the intended behaviour.
//
// Export form matters: the Loader reads `inject`/`apply` as named exports (see the shipped
// `@deepseek-ai/dsh-client-hmr`). Adding a `default` export makes the Loader take that object
// instead and silently drop `inject`, which is exactly what broke the first cold start.
export const inject = ['webServer'];

/**
 * @param {object} ctx Cordis context
 * @param {Record<string, unknown>} [config] plugin config (currently unused)
 */
export function apply(ctx, config) {
  // `inject` above guarantees this property is readable; touching it without the declaration
  // throws in Cordis ("cannot get property without inject"), which is what made a cold start
  // end up inactive. The guard keeps a future composition that lacks the service inert rather
  // than failing the entry outright.
  let web;
  try {
    web = ctx.webServer;
  } catch {
    web = undefined;
  }
  if (!web || typeof web.register !== 'function') {
    try {
      ctx?.logger?.info?.('[packdeck] webServer 服务不可用，插件保持静默');
    } catch {
      /* never break apply */
    }
    return;
  }

  const handler = createRequestHandler({ logger: ctx?.logger, config });
  // CONTRACT §8.2: icons are served from their own exact route, resolved from the item id only.
  const iconHandler = createIconRequestHandler({ logger: ctx?.logger });

  ctx.effect(() => {
    const dispose = web.register({ ...ROUTE, handler });
    try {
      ctx?.logger?.info?.('[packdeck] 已注册 POST /packdeck/api');
    } catch {
      /* ignore logging failures */
    }
    return () => {
      try {
        if (typeof dispose === 'function') dispose();
      } catch {
        /* disposal is best effort */
      }
    };
  });

  ctx.effect(() => {
    const dispose = web.register({ ...ICON_ROUTE, handler: iconHandler });
    try {
      ctx?.logger?.info?.('[packdeck] 已注册 GET /packdeck/icon');
    } catch {
      /* ignore logging failures */
    }
    return () => {
      try {
        if (typeof dispose === 'function') dispose();
      } catch {
        /* disposal is best effort */
      }
    };
  });
}
