/**
 * Shared CLI and close-code helpers for the JavaScript samples.
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

// 1005 is "no status received", which the ws library reports for a close frame
// carrying no code. Neither it nor 1000 indicates a problem.
const CLEAN_CLOSE_CODES = new Set([1000, 1005]);

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
 * Decide the process exit status for a close.
 *
 * A non-1000 code is not automatically a failure: the gateway relays the
 * upstream engine's close code verbatim, so a session that already delivered
 * its transcript can still end on an unusual code. Treat the run as successful
 * when a final result was received, and as a failure otherwise.
 */
export function closeExitCode(code, receivedFinal) {
  if (CLEAN_CLOSE_CODES.has(code)) return 0;
  if (CLOSE_EXPLANATIONS[code]) return 1;
  return receivedFinal ? 0 : 1;
}

/**
 * Exit without truncating output.
 *
 * `process.exit()` discards whatever is still queued on stdout when stdout is a
 * pipe or a file, which silently swallowed the close diagnostic under `| tee`.
 * Setting `exitCode` lets the process end once the event loop is empty.
 */
export function exitCleanly(code) {
  process.exitCode = code;
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
