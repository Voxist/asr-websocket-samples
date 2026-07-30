import WebSocket from 'ws';
import fs from 'fs';
import { readWavInfo, assertStreamable } from './wav.js';

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

if (args.length < 2) {
  console.log('Usage: node asr-file-ws.js <API_KEY> <WAV_FILE> [LANG] [--staging]');
  console.log('Example: node asr-file-ws.js your-api-key audio.wav fr');
  console.log('Example: node asr-file-ws.js your-staging-api-key audio.wav fr-medical --staging');
  console.log('');
  console.log('Parameters:');
  console.log('  API_KEY: Your Voxist API key');
  console.log('  WAV_FILE: Path to the WAV audio file (16 kHz mono 16-bit PCM)');
  console.log('  LANG: Language code (optional, default: "fr")');
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
)}&sample_rate=${SAMPLE_RATE}`;

console.log(`Environment: ${isStaging ? 'Staging' : 'Production'}`);
console.log(`Connecting to: ${baseUrl}/ws?api_key=***&lang=${lang}&sample_rate=${SAMPLE_RATE}`);
console.log(`Audio file: ${wavFilePath}`);
console.log(`Language: ${lang}`);
console.log(`Sample rate: ${SAMPLE_RATE} Hz`);
console.log(`Chunk size: ${CHUNK_SIZE} bytes`);
console.log('');

const ws = new WebSocket(url);
let start = Date.now();
let first = true;
let lastSegment = null;

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

  // Skip the WAV header — stream the `data` chunk only.
  const readStream = fs.createReadStream(wavFilePath, {
    start: wavInfo.dataOffset,
    end: wavInfo.dataOffset + wavInfo.dataSize - 1,
    highWaterMark: CHUNK_SIZE,
  });
  start = Date.now();

  readStream.on('data', async (chunk) => {
    if (ws.readyState === WebSocket.OPEN) {
      readStream.pause();
      ws.send(chunk);
      await new Promise((resolve) => setTimeout(resolve, CHUNK_DURATION_MS));
      readStream.resume();
    }
  });

  readStream.on('end', () => {
    if (ws.readyState === WebSocket.OPEN) {
      // End-of-stream signal. This MUST be the text frame `Done`: it is what
      // flushes the decoder's tail and promotes the last partial to a final.
      // The server then closes the socket once the engine has drained, so we
      // wait for `close` rather than hanging up ourselves.
      ws.send('Done');
    }
  });

  readStream.on('error', (error) => {
    console.error(`Error reading file: ${error.message}`);
    ws.close();
  });
});

ws.on('message', (data) => {
  try {
    let message = JSON.parse(data);
    if (message.text !== '') {
      if (first) {
        first = false;
        console.log('First word: ' + (Date.now() - start) + ' ms');
      }

      if (message.type === 'partial') {
        // Clear line and show partial result (overwriting previous partial)
        clearLine();
        process.stdout.write(message.text);
      } else if (message.type === 'final') {
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
  process.exit(1);
});

ws.on('close', (code, reason) => {
  console.log('\nFinished: ' + (Date.now() - start) + ' ms');
  if (code !== 1000) {
    console.log(`Connection closed with code: ${code}, reason: ${reason}`);
  }
  process.exit();
});
