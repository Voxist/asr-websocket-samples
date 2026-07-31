import WebSocket from 'ws';
import fs from 'fs';
import { readWavInfo, assertStreamable } from './wav.js';
import { closeExitCode, describeClose, exitCleanly, parsePunctuationMode, shouldReportClose } from './cli.js';

// If the gateway's upstream engine socket is not yet OPEN when `Done` arrives,
// the gateway drops the flush and never closes us (gateway `Done` handler), so
// waiting for the close frame unconditionally would hang forever.
const DRAIN_TIMEOUT_MS = 30000;

// Only 16 kHz is served by the streaming engines. The gateway does not resample,
// so this is not a knob — it is a property of the audio you must supply.
const SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 2;
const CHUNK_DURATION_MS = 100;
const CHUNK_SIZE = Math.floor(SAMPLE_RATE * BYTES_PER_SAMPLE * (CHUNK_DURATION_MS / 1000));

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

if (args.length < 2) {
  console.log('Usage: node asr-file-ws.js <API_KEY> <WAV_FILE> [LANG] [--punctuation-mode=MODE] [--staging]');
  console.log('Example: node asr-file-ws.js your-api-key audio.wav fr');
  console.log('Example: node asr-file-ws.js your-staging-api-key audio.wav fr-medical --staging');
  console.log('');
  console.log('Parameters:');
  console.log('  API_KEY: Your Voxist API key');
  console.log('  WAV_FILE: Path to the WAV audio file (16 kHz mono 16-bit PCM)');
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
  console.log('Note: Staging and production use different API keys');
  process.exit(1);
}

const apiKey = args[0];
const wavFilePath = args[1];
const lang = args[2] || 'fr';

// Validate file exists
if (!fs.existsSync(wavFilePath)) {
  console.error(`Error: Could not find audio file at ${wavFilePath}`);
  process.exit(1);
}

// Validate the audio up front. The gateway accepts any binary frame as PCM, so a
// stereo / 8 kHz / MP3-in-a-.wav file produces a plausible-looking but wrong
// transcript instead of an error.
let wavInfo;
try {
  wavInfo = readWavInfo(wavFilePath);
  assertStreamable(wavInfo, SAMPLE_RATE);
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exit(1);
}

// Select the appropriate domain based on staging flag.
// VOXIST_ASR_URL overrides the base URL entirely (self-hosted gateway, local tests).
const domain = isStaging ? 'asr-staging-dev.voxist.com' : 'api-asr.voxist.com';
const baseUrl = process.env.VOXIST_ASR_URL || `wss://${domain}`;
const url = `${baseUrl}/ws?api_key=${encodeURIComponent(apiKey)}&lang=${encodeURIComponent(
  lang,
)}&sample_rate=${SAMPLE_RATE}${punctuationMode ? `&punctuation_mode=${punctuationMode}` : ''}`;

console.log(`Environment: ${isStaging ? 'Staging' : 'Production'}`);
console.log(`Connecting to: ${baseUrl}/ws?api_key=***&lang=${lang}&sample_rate=${SAMPLE_RATE}`);
console.log(`Audio file: ${wavFilePath}`);
console.log(`Language: ${lang}`);
console.log(`Punctuation mode: ${punctuationMode || 'Generated (default)'}`);
console.log(`Sample rate: ${SAMPLE_RATE} Hz`);
console.log(`Chunk size: ${CHUNK_SIZE} bytes`);
console.log('');


const ws = new WebSocket(url);
let start = Date.now();
let first = true;
let lastSegment = null;
let receivedFinal = false;
let doneSent = false;
let drainTimedOut = false;
let readFailed = false;
let bytesSent = 0;
let drainTimer = null;

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

ws.on('open', async () => {
  console.log('Connected to WebSocket');

  // Skip the WAV header — stream the `data` chunk only. readWavInfo guarantees
  // dataSize > 0, so the range below is always valid; the guard keeps any
  // surprise from becoming an unhandled rejection inside this async handler.
  let readStream;
  try {
    readStream = fs.createReadStream(wavFilePath, {
      start: wavInfo.dataOffset,
      end: wavInfo.dataOffset + wavInfo.dataSize - 1,
      highWaterMark: CHUNK_SIZE,
    });
  } catch (error) {
    console.error(`Error opening audio data: ${error.message}`);
    ws.close(1000, 'Client aborted');
    process.exit(1);
  }
  start = Date.now();

  readStream.on('data', async (chunk) => {
    if (ws.readyState === WebSocket.OPEN) {
      readStream.pause();
      bytesSent += chunk.length;
      ws.send(chunk);
      await new Promise((resolve) => setTimeout(resolve, CHUNK_DURATION_MS));
      readStream.resume();
    }
  });

  readStream.on('end', () => {
    // A short read ends the stream normally, so without this check a file
    // truncated underneath us would flush, transcribe a fragment, and exit 0.
    if (bytesSent < wavInfo.dataSize) {
      console.error(
        `\nWarning: sent ${bytesSent} of ${wavInfo.dataSize} declared audio bytes ` +
          '- the file was shorter than its header claims.',
      );
      readFailed = true;
    }
    if (ws.readyState === WebSocket.OPEN) {
      // End-of-stream signal. This MUST be the text frame `Done`: it is what
      // flushes the decoder's tail and promotes the last partial to a final.
      // The server then closes the socket once the engine has drained, so we
      // wait for `close` rather than hanging up ourselves.
      ws.send('Done');
      doneSent = true;

      // Backstop: if the gateway dropped the flush (upstream engine still
      // connecting) it will never close us, and this would otherwise hang.
      drainTimer = setTimeout(() => {
        console.error(`\nNo response from server ${DRAIN_TIMEOUT_MS} ms after Done - closing.`);
        console.error('The final segment may be missing.');
        drainTimedOut = true;
        ws.close(1000, 'Client drain timeout');
      }, DRAIN_TIMEOUT_MS);
    }
  });

  readStream.on('error', (error) => {
    // A partial upload is a failed run. Close with an explicit code: a bare
    // ws.close() surfaces locally as 1005, which reads as a clean shutdown.
    console.error(`Error reading file: ${error.message}`);
    readFailed = true;
    ws.close(1000, 'Client read error');
  });
});

ws.on('message', (data) => {
  try {
    let message = JSON.parse(data);
    // Not every server message is a transcript: `text` may be absent entirely.
    if (typeof message.text === 'string' && message.text !== '') {
      if (first) {
        first = false;
        console.log('First word: ' + (Date.now() - start) + ' ms');
      }

      if (message.type === 'partial') {
        // Clear line and show partial result (overwriting previous partial)
        clearLine();
        process.stdout.write(message.text);
      } else if (message.type === 'final') {
        receivedFinal = true;
        // Clear the partial result and print final result on new line
        clearLine();
        // Only print if it's a new segment
        const currentSegment = message.segment;
        if (currentSegment !== lastSegment) {
          console.log(message.text);
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
  console.error(`Failed to connect to: ${baseUrl}/ws`);
  exitCleanly(1);
});

ws.on('close', (code, reason) => {
  if (drainTimer) clearTimeout(drainTimer);
  console.log('\nFinished: ' + (Date.now() - start) + ' ms');

  // A drain timeout or a read error closes with 1000, but the run did not
  // succeed, so neither can be inferred from the close code alone.
  const status =
    drainTimedOut || readFailed ? 1 : closeExitCode(code, { doneSent, receivedFinal });

  // Reporting the code matters: without it a capacity rejection or an
  // unsupported-language close is indistinguishable from a clean run.
  if (shouldReportClose(code, status)) describeClose(code, reason);
  if (status !== 0 && !doneSent && !readFailed) {
    console.log('  The audio was not fully sent - the transcript is incomplete.');
  }
  if (status !== 0 && !receivedFinal) console.log('  No final transcription was received.');
  exitCleanly(status);
});
