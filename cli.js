/**
 * Shared CLI, close-code and exit helpers for the JavaScript samples.
 * `asr-file-ws.js` and `asr-mic.js` both use these, so the two clients cannot
 * drift apart the way the WAV handling once did.
 */

// The gateway reports failures as close codes, not as JSON error messages.
// These are the codes it raises itself; anything else it relays verbatim from
// the upstream ASR engine (see simple-websocket-proxy.gateway.ts, the
// `banafoWs.on('close')` handler, which calls `client.close(code, reason)`).
export const CLOSE_EXPLANATIONS = {
  1008: 'Unsupported language code, a model this account is not entitled to, or a per-tenant rate limit',
  1011: 'ASR engine unavailable, timed out, or not configured for this language',
  1013: 'Server at capacity - back off and retry',
};

// 1006 means the connection vanished without a close frame: a pod eviction, a
// proxy idle timeout, a TCP reset. It is never a successful session.
const ABNORMAL_CLOSE = 1006;

export function describeClose(code, reason) {
  let detail = reason ? reason.toString() : '';
  if (detail.startsWith('{')) {
    try {
      const payload = JSON.parse(detail);
      detail = payload.message || detail;
      if (payload.retryAfterMs) detail += ` (retry after ${payload.retryAfterMs} ms)`;
    } catch {
      /* not JSON */
    }
  }
  console.log(`Connection closed by server: code ${code}${detail ? ' - ' + detail : ''}`);
  if (CLOSE_EXPLANATIONS[code]) console.log(`  ${CLOSE_EXPLANATIONS[code]}`);
}

/**
 * Decide the process exit status for a finished session.
 *
 * Success means the session actually completed: the whole input was sent (so a
 * `Done` flush was issued) AND at least one final result came back AND the
 * connection did not die abnormally. A close code alone cannot express that —
 * the gateway relays the upstream engine's code verbatim, so an unusual code
 * after a complete transcript is fine, while a "clean-looking" code after a
 * mid-upload teardown is not.
 */
export function closeExitCode(code, { doneSent = false, receivedFinal = false } = {}) {
  if (CLOSE_EXPLANATIONS[code]) return 1; // documented server-side failure
  if (code === ABNORMAL_CLOSE) return 1; // no close frame: torn down, not finished
  if (!doneSent) return 1; // input was never fully sent
  if (!receivedFinal) return 1; // nothing was transcribed
  return 0;
}

/** True when the close is worth explaining to the user. */
export function shouldReportClose(code, status) {
  return status !== 0 || !(code === 1000 || code === 1005);
}

/**
 * End the process without truncating output, but never hang.
 *
 * `process.exit()` discards whatever is still queued on stdout when stdout is a
 * pipe or a file. Setting `exitCode` lets the loop drain first — but if some
 * handle (a capture process that ignores SIGTERM, a socket that will not close)
 * keeps the loop alive, the process would never exit at all, and because these
 * clients trap SIGINT it could not even be interrupted. The unref'd timer is the
 * backstop: it cannot by itself hold the process open, and it only fires if
 * something else already is.
 */
export function exitCleanly(code, forceAfterMs = 2000) {
  process.exitCode = code;
  const timer = setTimeout(() => process.exit(code), forceAfterMs);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

/** Parse and validate `--punctuation-mode=MODE` / `--punctuation-mode MODE`. */
export function parsePunctuationMode(args) {
  const index = args.findIndex((a) => a.startsWith('--punctuation-mode'));
  if (index === -1) return null;

  const inline = args[index].split('=')[1];
  const mode = inline || args[index + 1];
  args.splice(index, inline ? 1 : 2);

  if (!['Generated', 'Dictated'].includes(mode)) {
    console.error(`Error: --punctuation-mode must be Generated or Dictated (got "${mode}")`);
    process.exit(1);
  }
  return mode;
}
