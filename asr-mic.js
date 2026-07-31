import websocket from 'ws';
import AudioRecorder from 'node-audiorecorder';
import { closeExitCode, describeClose, exitCleanly, parsePunctuationMode } from './cli.js';

// Only 16 kHz is served by the streaming engines. The gateway does not resample.
const SAMPLE_RATE = 16000;

// Parse command line arguments
const args = process.argv.slice(2);
const stagingIndex = args.indexOf('--staging');
const isStaging = stagingIndex !== -1;

// Remove --staging from args if present
if (isStaging) {
  args.splice(stagingIndex, 1);
}

// Optional --punctuation-mode=Generated|Dictated
const punctuationMode = parsePunctuationMode(args);

if (args.length < 1) {
  console.log('Usage: node asr-mic.js <API_KEY> [LANG] [--punctuation-mode=MODE] [--staging]');
  console.log('Example: node asr-mic.js your-api-key fr');
  console.log('Example: node asr-mic.js your-staging-api-key fr-medical --staging');
  console.log('');
  console.log('Parameters:');
  console.log('  API_KEY: Your Voxist API key');
  console.log('  LANG: Language code (optional, default: "fr")');
  console.log('  --punctuation-mode: Generated (default) or Dictated, for spoken punctuation');
  console.log('  --staging: Use staging environment (optional)');
  console.log('');
  console.log('Supported Languages:');
  console.log('  fr: French');
  console.log('  fr-medical: French Medical');
  console.log('  fr-medicalV2-16 / fr-medicalV2-32 / fr-medicalV2-64: French Medical latency tiers');
  console.log('  en: English');
  console.log('  de: German');
  console.log('  es: Spanish');
  console.log('  it: Italian');
  console.log('  nl: Dutch');
  console.log('  pt: Portuguese');
  console.log('');
  console.log('Environments:');
  console.log('  Production: api-asr.voxist.com (default)');
  console.log('  Staging: asr-staging-dev.voxist.com (with --staging flag)');
  console.log('');
  console.log('Note: This requires SoX to be installed and available in PATH');
  console.log('Audio will be recorded as mono 16-bit at 16kHz sample rate');
  console.log('Note: Staging and production use different API keys');
  process.exit(1);
}

const apiKey = args[0];
const lang = args[1] || 'fr';

// Select the appropriate domain based on staging flag
const domain = isStaging ? 'asr-staging-dev.voxist.com' : 'api-asr.voxist.com';
// VOXIST_ASR_API_URL / VOXIST_ASR_URL override the HTTP and WebSocket base URLs
// entirely (self-hosted gateway, local tests).
const apiBaseUrl = process.env.VOXIST_ASR_API_URL || `https://${domain}`;

console.log(`Environment: ${isStaging ? 'Staging' : 'Production'}`);
console.log(`Language: ${lang}`);
console.log(`Punctuation mode: ${punctuationMode || 'Generated (default)'}`);
console.log(`Sample rate: ${SAMPLE_RATE} Hz`);
console.log('Audio format: Mono 16-bit');
console.log('');

// Function to get websocket URL with temporary token
async function getWebSocketURL() {
  try {
    console.log('Requesting websocket URL with temporary token...');

    const response = await fetch(`${apiBaseUrl}/websocket?engine=voxist-rt-2`, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        'X-LVL-KEY': apiKey,
      },
      // Without this an unreachable host hangs before the socket is ever opened.
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();

    if (!data.url) {
      throw new Error('No websocket URL received from server');
    }

    // The returned URL carries only the token. Language and sample rate are
    // per-connection parameters, so they are appended here.
    const wsUrl = new URL(data.url);
    if (process.env.VOXIST_ASR_URL) {
      const override = new URL(process.env.VOXIST_ASR_URL);
      wsUrl.protocol = override.protocol;
      wsUrl.host = override.host;
    }
    wsUrl.searchParams.set('lang', lang);
    wsUrl.searchParams.set('sample_rate', SAMPLE_RATE.toString());
    if (punctuationMode) {
      wsUrl.searchParams.set('punctuation_mode', punctuationMode);
    }

    return wsUrl.toString();
  } catch (error) {
    console.error(`Failed to get websocket URL: ${error.message}`);
    console.error('Make sure your API key is valid and you have the correct permissions');
    process.exit(1);
  }
}

// Configure audio recorder for mono 16-bit at the required sample rate.
// `type: 'raw'` matters: the gateway forwards every binary frame to the decoder
// as PCM, so a WAV-framed stream would feed it a 44-byte RIFF header as audio.
const audioRecorder = new AudioRecorder(
  {
    program: 'sox',
    device: null,
    bits: 16,
    channels: 1,
    encoding: 'signed-integer',
    rate: SAMPLE_RATE,
    type: 'raw',
    silence: 0,
    thresholdStart: 0.5,
    thresholdStop: 0.5,
    keepSilence: true,
  },
  console,
);


let ws;
let start = Date.now();
let first = true;
let lastSegment = null;
let recording = false;
let doneSent = false;
let drainTimedOut = false;
let receivedFinal = false;
let shuttingDown = false;
let drainTimer = null;
let flushTimer = null;

// How long to wait for the engine's tail after `Done` before giving up. The
// server normally closes first; this is only a backstop against a hung session.
const DRAIN_TIMEOUT_MS = 15000;
// Backstop for the recorder's stream never emitting `end` after being killed.
const FLUSH_TIMEOUT_MS = 1000;

// The gateway matches on `text.includes('Done')` and, per `Done`, emits a usage
// analytics event and forwards another flush upstream — so it must be sent
// exactly once per session.
function sendDone() {
  if (doneSent) return;
  doneSent = true;
  if (!ws || ws.readyState !== websocket.OPEN) return;

  ws.send('Done');

  // Backstop for every flush path, not just Ctrl+C. If the gateway's upstream
  // engine socket was not OPEN when `Done` arrived it drops the flush and never
  // closes us, so waiting unconditionally would hang forever.
  if (drainTimer) clearTimeout(drainTimer);
  console.log('Waiting for the final transcription result...');
  drainTimer = setTimeout(() => {
    console.error(`\nNo response from server ${DRAIN_TIMEOUT_MS} ms after Done - closing.`);
    console.error('The final segment may be missing.');
    drainTimedOut = true;
    if (ws.readyState === websocket.OPEN) {
      ws.close(1000, 'Client drain timeout');
    } else {
      cleanup(1);
    }
  }, DRAIN_TIMEOUT_MS);
}

function stopRecording() {
  if (!recording) return;
  recording = false;
  try {
    audioRecorder.stop();
  } catch (error) {
    console.error(`Error stopping recorder: ${error.message}`);
  }
}

// Clear current line and move cursor to beginning.
// Guarded: these are TTY-only APIs and throw when stdout is a pipe or a file.
const clearLine = () => {
  if (process.stdout.isTTY) {
    process.stdout.clearLine(0);
    process.stdout.cursorTo(0);
  } else {
    process.stdout.write('\n');
  }
};

// Main function to start the microphone transcription
async function startTranscription() {
  try {
    // Get the websocket URL with temporary token
    const wsUrl = await getWebSocketURL();
    const redacted = new URL(wsUrl);
    console.log(
      `Connecting to: ${redacted.origin}${redacted.pathname}?token=***&lang=${lang}&sample_rate=${SAMPLE_RATE}`,
    );

    // Create websocket connection
    ws = new websocket(wsUrl);

    ws.on('open', () => {
      console.log('Connected to WebSocket');
      console.log('Starting microphone recording...');
      console.log('Press Ctrl+C to stop recording and disconnect');
      console.log('');

      try {
        const readStream = audioRecorder.start().stream();
        start = Date.now();
        recording = true;

        readStream.on('data', (chunk) => {
          // Never send audio after `Done`: the engine is already draining and
          // trailing frames would be dropped, or worse, restart the segment.
          if (!doneSent && ws.readyState === websocket.OPEN) {
            ws.send(chunk);
          }
        });

        readStream.on('end', () => {
          console.log('\nMicrophone recording ended');
          // End-of-stream signal: the text frame `Done` flushes the decoder's
          // tail and promotes the last partial to a final. Killing sox does not
          // drain its stdout synchronously, so waiting for `end` is what keeps
          // the last buffered audio ahead of the flush.
          if (flushTimer) clearTimeout(flushTimer);
          sendDone();
        });

        readStream.on('error', (error) => {
          console.error(`Microphone error: ${error.message}`);
          cleanup(1);
        });
      } catch (error) {
        console.error(`Failed to start microphone: ${error.message}`);
        console.error('Make sure SoX is installed and your microphone is available');
        process.exit(1);
      }
    });

    ws.on('message', (data) => {
      try {
        let message = JSON.parse(data);
        // Not every server message is a transcript: `text` may be absent.
        if (typeof message.text === 'string' && message.text !== '') {
          if (first) {
            first = false;
            console.log('First word: ' + (Date.now() - start) + ' ms');
          }

          if (message.type === 'partial') {
            // Clear line and show partial result (overwriting previous partial)
            clearLine();
            process.stdout.write(`[LIVE] ${message.text}`);
          } else if (message.type === 'final') {
            receivedFinal = true;
            // Clear the partial result and print final result on new line
            clearLine();
            // Only print if it's a new segment
            const currentSegment = message.segment;
            if (currentSegment !== lastSegment) {
              console.log(`[FINAL] ${message.text}`);
              lastSegment = currentSegment;
            }
          }
        }
      } catch (error) {
        console.error(`Error parsing message: ${error.message}`);
      }
    });

    ws.on('error', (error) => {
      console.error(`WebSocket error: ${error.message}`);
      cleanup(1);
    });

    ws.on('close', (code, reason) => {
      console.log('\nWebSocket connection closed');
      console.log('Total session time: ' + (Date.now() - start) + ' ms');
      if (drainTimedOut) {
        cleanup(1);
        return;
      }
      const status = closeExitCode(code, receivedFinal);
      if (status !== 0) describeClose(code, reason);
      cleanup(status);
    });
  } catch (error) {
    console.error(`Error starting transcription: ${error.message}`);
    process.exit(1);
  }
}

// Cleanup function
function cleanup(exitCode = 0) {
  if (drainTimer) clearTimeout(drainTimer);
  if (flushTimer) clearTimeout(flushTimer);
  if (recording) {
    console.log('\nStopping microphone recording...');
    stopRecording();
  }
  if (ws && (ws.readyState === websocket.OPEN || ws.readyState === websocket.CONNECTING)) {
    ws.close(1000, 'Client exiting');
  }
  // Setting exitCode rather than calling process.exit() keeps queued stdout
  // from being truncated when output is piped.
  exitCleanly(exitCode);
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  // A second Ctrl+C abandons the drain instead of waiting it out.
  if (shuttingDown) {
    console.log('\nSecond interrupt - exiting without waiting for the final result');
    cleanup(130);
    return;
  }
  shuttingDown = true;
  console.log('\nReceived SIGINT, shutting down gracefully...');

  if (!ws || ws.readyState !== websocket.OPEN) {
    cleanup(130);
    return;
  }

  // Stop the microphone and let the stream's `end` event send `Done`, so any
  // audio still buffered in sox's stdout reaches the engine before the flush.
  // Stop the microphone and let the stream's `end` event send `Done`, so any
  // audio still buffered in sox's stdout reaches the engine before the flush.
  // sendDone() arms the drain backstop; we then wait for the server's close,
  // which is what guarantees the last `final` has been delivered.
  stopRecording();
  flushTimer = setTimeout(sendDone, FLUSH_TIMEOUT_MS);
});

// SIGTERM (docker stop, kubectl delete pod, systemd, `timeout`) takes the same
// path as Ctrl+C. Calling process.exit() in this tick would discard the queued
// `Done` frame and lose the tail — the defect this client exists to avoid.
process.on('SIGTERM', () => {
  if (shuttingDown) {
    cleanup(143);
    return;
  }
  shuttingDown = true;
  console.log('\nReceived SIGTERM, shutting down gracefully...');

  if (!ws || ws.readyState !== websocket.OPEN) {
    cleanup(143);
    return;
  }
  stopRecording();
  flushTimer = setTimeout(sendDone, FLUSH_TIMEOUT_MS);
});

// Start the transcription
startTranscription();
