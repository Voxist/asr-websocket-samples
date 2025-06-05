import websocket from 'ws';
import AudioRecorder from 'node-audiorecorder';

// Parse command line arguments
const args = process.argv.slice(2);
const stagingIndex = args.indexOf('--staging');
const isStaging = stagingIndex !== -1;

// Remove --staging from args if present
if (isStaging) {
  args.splice(stagingIndex, 1);
}

if (args.length < 1) {
  console.log('Usage: node asr-mic.js <API_KEY> [LANG] [--staging]');
  console.log('Example: node asr-mic.js your-api-key fr');
  console.log('Example: node asr-mic.js your-staging-api-key fr-medical --staging');
  console.log('');
  console.log('Parameters:');
  console.log('  API_KEY: Your Voxist API key');
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
  console.log('Note: This requires SoX to be installed and available in PATH');
  console.log('Audio will be recorded as mono 16-bit at 16kHz sample rate');
  console.log('Note: Staging and production use different API keys');
  process.exit(1);
}

const apiKey = args[0];
const lang = args[1] || 'fr';
const sampleRate = 16000;

// Select the appropriate domain based on staging flag
const domain = isStaging ? 'asr-staging-dev.voxist.com' : 'api-asr.voxist.com';

console.log(`Environment: ${isStaging ? 'Staging' : 'Production'}`);
console.log(`Language: ${lang}`);
console.log(`Sample rate: ${sampleRate} Hz`);
console.log('Audio format: Mono 16-bit');
console.log('');

// Function to get websocket URL with temporary token
async function getWebSocketURL() {
  try {
    console.log('Requesting websocket URL with temporary token...');
    
    const response = await fetch(`https://${domain}/websocket?engine=voxist-rt-2`, {
      method: 'GET',
      headers: {
        'accept': 'application/json',
        'X-LVL-KEY': apiKey
      }
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();
    
    if (!data.url) {
      throw new Error('No websocket URL received from server');
    }

    // Add lang and sample_rate parameters to the websocket URL
    const wsUrl = new URL(data.url);
    wsUrl.searchParams.set('lang', lang);
    wsUrl.searchParams.set('sample_rate', sampleRate.toString());
    
    return wsUrl.toString();
    
  } catch (error) {
    console.error(`Failed to get websocket URL: ${error.message}`);
    console.error('Make sure your API key is valid and you have the correct permissions');
    process.exit(1);
  }
}

// Configure audio recorder for mono 16-bit at specified sample rate
const audioRecorder = new AudioRecorder({
  program: 'sox',
  device: null,
  bits: 16,
  channels: 1,
  encoding: 'signed-integer',
  format: 'wav',
  rate: sampleRate,
  type: 'wav',
  silence: 0,
  thresholdStart: 0.5,
  thresholdStop: 0.5,
  keepSilence: true
}, console);

let ws;
let start = Date.now();
let first = true;
let lastSegment = null;
let recording = false;

// Clear current line and move cursor to beginning
const clearLine = () => {
  process.stdout.clearLine(0);
  process.stdout.cursorTo(0);
};

// Main function to start the microphone transcription
async function startTranscription() {
  try {
    // Get the websocket URL with temporary token
    const wsUrl = await getWebSocketURL();
    console.log(`Connecting to: ${wsUrl}`);
    
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
          if (ws.readyState === websocket.OPEN) {
            ws.send(chunk);
          }
        });
        
        readStream.on('end', () => {
          console.log('\nMicrophone recording ended');
          if (ws.readyState === websocket.OPEN) {
            ws.send('{"eof": 1}');
          }
        });
        
        readStream.on('error', (error) => {
          console.error(`Microphone error: ${error.message}`);
          cleanup();
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
        if (message.text !== '') {
          if (first) {
            first = false;
            console.log('First word: ' + (Date.now() - start) + ' ms');
          }

          if (message.type === 'partial') {
            // Clear line and show partial result (overwriting previous partial)
            clearLine();
            process.stdout.write(`[LIVE] ${message.text}`);
          } else if (message.type === 'final') {
            // Clear the partial result and print final result on new line
            clearLine();
            // Only print if it's a new segment
            const currentSegment = message.segment;
            if (currentSegment !== lastSegment) {
              console.log(`[FINAL] ${message.text}`, message);
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
      cleanup();
    });

    ws.on('close', (code, reason) => {
      console.log('\nWebSocket connection closed');
      console.log('Total session time: ' + (Date.now() - start) + ' ms');
      if (code !== 1000) {
        console.log(`Close code: ${code}, reason: ${reason}`);
      }
      cleanup();
    });
    
  } catch (error) {
    console.error(`Error starting transcription: ${error.message}`);
    process.exit(1);
  }
}

// Cleanup function
function cleanup() {
  if (recording) {
    console.log('\nStopping microphone recording...');
    try {
      audioRecorder.stop();
      recording = false;
    } catch (error) {
      console.error(`Error stopping recorder: ${error.message}`);
    }
  }
  process.exit();
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\nReceived SIGINT, shutting down gracefully...');
  if (ws && ws.readyState === websocket.OPEN) {
    ws.send('{"eof": 1}');
    ws.close();
  } else {
    cleanup();
  }
});

process.on('SIGTERM', () => {
  console.log('\nReceived SIGTERM, shutting down gracefully...');
  cleanup();
});

// Start the transcription
startTranscription();