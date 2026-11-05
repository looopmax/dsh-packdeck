// Error type shared by the HTTP layer and the adapters.
// `code` is one of the contract codes: bad-request | unknown-action | unavailable |
// timeout | command-failed | parse-failed | internal.

export class ApiError extends Error {
  /**
   * @param {string} code contract error code
   * @param {string} message user-facing (Chinese) one-liner
   * @param {string|null} [log] raw command output tail, for troubleshooting only
   */
  constructor(code, message, log = null) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.log = log ? String(log) : null;
  }
}

export const badRequest = (message, log) => new ApiError('bad-request', message, log);
export const unavailable = (message, log) => new ApiError('unavailable', message, log);
export const commandFailed = (message, log) => new ApiError('command-failed', message, log);
export const parseFailed = (message, log) => new ApiError('parse-failed', message, log);
export const timedOut = (message, log) => new ApiError('timeout', message, log);

/** Normalise any thrown value into the contract error envelope payload. */
export function toErrorPayload(error) {
  if (error instanceof ApiError) {
    return { code: error.code, message: error.message, log: error.log || undefined };
  }
  const message = error && error.message ? String(error.message) : String(error);
  return { code: 'internal', message: `内部错误：${message}`, log: error && error.stack ? String(error.stack) : undefined };
}
