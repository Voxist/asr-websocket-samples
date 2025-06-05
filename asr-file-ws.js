import websocket from 'ws';
import fs from 'fs';

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
  console.log('  WAV_FILE: Path to the WAV audio file');
  console.log('  LANG: Language code (optional, default: "fr")');
  console.log('  --staging: Use staging environment (optional)');
  console.log('');
  console.log('Supported Languages:');
  console.log('  fr: French');
  console.log('  fr-medical: French Medical');
  console.log('  en: English');
  console.log('  pt: Portuguese');
  console.log('  nl: Dutch');
  console.log('  it: Italian');
  console.log('  sv: Swedish');
  console.log('  es: Spanish');
  console.log('  de: German');
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
const sampleRate = 16000;

// Validate file exists
if (!fs.existsSync(wavFilePath)) {
  console.error(`Error: Could not find audio file at ${wavFilePath}`);
  process.exit(1);
}

// Select the appropriate domain based on staging flag
const domain = isStaging ? 'asr-staging-dev.voxist.com' : 'api-asr.voxist.com';
const url = `wss://${domain}/ws?api_key=${apiKey}&lang=${lang}&sample_rate=${sampleRate}`;

const BYTES_PER_SAMPLE = 2;
const CHUNK_DURATION_MS = 100;
const CHUNK_SIZE = Math.floor(
  sampleRate * BYTES_PER_SAMPLE * (CHUNK_DURATION_MS / 1000),
);

console.log(`Environment: ${isStaging ? 'Staging' : 'Production'}`);
console.log(`Connecting to: ${url}`);
console.log(`Audio file: ${wavFilePath}`);
console.log(`Language: ${lang}`);
console.log(`Sample rate: ${sampleRate} Hz`);
console.log(`Chunk size: ${CHUNK_SIZE} bytes`);
console.log('');

const ws = new websocket(url);
let start = Date.now();
let first = true;
let lastSegment = null;

// Clear current line and move cursor to beginning
const clearLine = () => {
  process.stdout.clearLine(0);
  process.stdout.cursorTo(0);
};

ws.on('open', async () => {
  console.log('Connected to WebSocket');
  const readStream = fs.createReadStream(wavFilePath, {
    highWaterMark: CHUNK_SIZE,
  });
  start = Date.now();

  readStream.on('data', async (chunk) => {
    readStream.pause();
    ws.send(chunk);
    await new Promise((resolve) => setTimeout(resolve, CHUNK_DURATION_MS));
    readStream.resume();
  });

  readStream.on('end', () => {
    ws.send('{"eof": 1}');
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
        // Only print if it's a new segment AND we haven't seen this exact text before
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
});

ws.on('close', (code, reason) => {
  console.log('\nFinished: ' + (Date.now() - start) + ' ms');
  if (code !== 1000) {
    console.log(`Connection closed with code: ${code}, reason: ${reason}`);
  }
  process.exit();
});
