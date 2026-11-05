// HTTP plumbing for POST /packdeck/api: method/origin guards, 64 KiB body cap, envelope.
// The route itself is registered by index.js; this module owns the whole response.

import { ApiError, badRequest, toErrorPayload } from './errors.js';
import { dispatchAction } from './api.js';

export const ROUTE_PATH = '/packdeck/api';
export const MAX_BODY_BYTES = 64 * 1024;

const HEALTH_PAYLOAD = { ok: true, data: { service: 'packdeck' } };

function sendJson(res, status, payload, extraHeaders = {}) {
  let body;
  try {
    body = JSON.stringify(payload);
  } catch {
    body = JSON.stringify({ ok: false, error: { code: 'internal', message: '响应序列化失败' } });
    status = 200;
  }
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-length': Buffer.byteLength(body),
    ...extraHeaders,
  };
  try {
    if (res.writableEnded || res.destroyed) return;
    res.writeHead(status, headers);
    res.end(body);
  } catch {
    /* client went away */
  }
}

/** Cross-site guard: an `origin` header must match the request `host`. */
function isSameOrigin(req) {
  const origin = req.headers && req.headers.origin;
  if (!origin) return true;
  if (origin === 'null') return false;
  const host = req.headers && req.headers.host;
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let overflow = false;
    let settled = false;

    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };

    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        overflow = true; // keep draining but stop buffering
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (overflow) {
        settle(reject, badRequest('请求体超过 64 KiB 上限'));
        return;
      }
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) {
        settle(resolve, {});
        return;
      }
      try {
        settle(resolve, JSON.parse(text));
      } catch {
        settle(reject, badRequest('请求体不是合法 JSON'));
      }
    });
    req.on('error', (error) => {
      settle(reject, new ApiError('bad-request', '读取请求体失败', error && error.message ? String(error.message) : null));
    });
    req.on('aborted', () => settle(reject, badRequest('请求已中断')));
  });
}

function pathnameOf(req) {
  try {
    return new URL(req.url || '/', 'http://127.0.0.1').pathname;
  } catch {
    return '/';
  }
}

/**
 * Build the route handler.
 * @param {{logger?: {info?:Function, warn?:Function, error?:Function}}} [deps]
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export function createRequestHandler(deps = {}) {
  const logger = deps.logger;

  return async function handler(req, res) {
    try {
      const pathname = pathnameOf(req).replace(/\/+$/, '') || '/';
      if (pathname !== ROUTE_PATH) {
        sendJson(res, 404, { ok: false, error: { code: 'bad-request', message: '未知的接口路径' } });
        return;
      }

      if (!isSameOrigin(req)) {
        sendJson(res, 403, { ok: false, error: { code: 'bad-request', message: '跨站请求被拒绝' } });
        return;
      }

      const method = String(req.method || 'GET').toUpperCase();
      if (method === 'GET' || method === 'HEAD') {
        sendJson(res, 200, HEALTH_PAYLOAD);
        return;
      }
      if (method !== 'POST') {
        sendJson(res, 405, { ok: false, error: { code: 'bad-request', message: `不支持的请求方法 ${method}` } }, { allow: 'GET, POST' });
        return;
      }

      const body = await readJsonBody(req);
      // The HTTP action surface never accepts dryRun; only tools/probe.mjs passes it.
      const data = await dispatchAction(body, {});
      sendJson(res, 200, { ok: true, data });
    } catch (error) {
      const payload = toErrorPayload(error);
      if (payload.code === 'internal') {
        try {
          logger?.warn?.('[packdeck] action 执行失败', error);
        } catch {
          /* logging must never break the response */
        }
      }
      sendJson(res, 200, { ok: false, error: payload });
    }
  };
}
