# ASR Websocket samples

This repository contains WebSocket client samples for the Voxist ASR (Automatic Speech Recognition) service in both JavaScript and Python.

## OpenAPI documentation is available 
Go [there](https://api-asr.voxist.com/api-documentation/).

## Account @voxist required.
[Contact us](mailto:contact@voxist.com) if interested.

## Environments

The scripts support both staging and production environments:

- **Production**: `api-asr.voxist.com` (default)
- **Staging**: `asr-staging-dev.voxist.com` (with `--staging` flag)

**Important**: Staging and production environments use different API keys. Make sure to use the correct API key for your target environment.

## WebSocket Protocol

### Connection

There are two ways to connect to the WebSocket:

#### Method 1: Direct API Key (File-based scripts)
```
wss://api-asr.voxist.com/ws?api_key=YOUR_API_KEY&lang=fr-medical&sample_rate=16000
```

#### Method 2: Temporary Token (Microphone script)
1. Request a temporary token:
```bash
curl -X 'GET' \
  'https://api-asr.voxist.com/websocket?engine=voxist-rt-2' \
  -H 'accept: application/json' \
  -H 'X-LVL-KEY: YOUR_API_KEY'
```

2. Response:
```json
{
  "url": "wss://api-asr.voxist.com/ws?token=JWT_TOKEN"
}
```

3. Add parameters to the URL:
```
wss://api-asr.voxist.com/ws?token=JWT_TOKEN&lang=fr-medical&sample_rate=16000
```

### Audio Format

Send raw audio data directly to the WebSocket:

- **Format**: Raw PCM audio bytes
- **Encoding**: Signed 16-bit little-endian
- **Channels**: Mono (1 channel)
- **Sample Rate**: 8000 Hz or 16000 Hz (specified in connection URL)
- **Chunk Size**: Recommended 100ms chunks (3200 bytes for 16kHz, 1600 bytes for 8kHz)

### Real-time Streaming

For optimal real-time performance:

- **Timing**: Send approximately 1 second of audio per second
- **Chunk Interval**: 100ms chunks sent every 100ms
- **Buffer Management**: Avoid buffering large amounts of audio
- **Network Latency**: Account for network delays in your timing

**Example timing for 16kHz audio:**
```javascript
const SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 2;
const CHUNK_DURATION_MS = 100;
const CHUNK_SIZE = SAMPLE_RATE * BYTES_PER_SAMPLE * (CHUNK_DURATION_MS / 1000); // 3200 bytes

// Send chunk every 100ms
setInterval(() => {
  const audioChunk = getAudioChunk(CHUNK_SIZE);
  websocket.send(audioChunk);
}, CHUNK_DURATION_MS);
```

### End of Transcription

To signal the end of audio and complete the transcription:

```json
{"eof": 1}
```

Send this JSON message when you finish sending audio data.

### Response Format

The WebSocket returns JSON messages with transcription results. Both partial and final results have the same format, only the `type` field differs:

#### Partial Results (Real-time updates)
```json
{
  "text": " Ceci est un te",
  "type": "partial",
  "startedAt": 0,
  "segment": 0,
  "elements": {
    "segments": [
      {
        "text": " Ceci est un te",
        "type": "segment",
        "startedAt": 0,
        "segment": 0
      }
    ],
    "words": [
      {
        "text": "Ceci",
        "type": "word",
        "startedAt": 1.28,
        "segment": 0
      },
      {
        "text": "est",
        "type": "word",
        "startedAt": 1.8,
        "segment": 0
      },
      {
        "text": "un",
        "type": "word",
        "startedAt": 2.04,
        "segment": 0
      },
      {
        "text": "te",
        "type": "word",
        "startedAt": 2.32,
        "segment": 0
      }
    ]
  }
}
```

#### Final Results (Complete segments)
```json
{
  "text": " Ceci est un test",
  "type": "final",
  "startedAt": 0,
  "segment": 0,
  "elements": {
    "segments": [
      {
        "text": " Ceci est un test",
        "type": "segment",
        "startedAt": 0,
        "segment": 0
      }
    ],
    "words": [
      {
        "text": "Ceci",
        "type": "word",
        "startedAt": 1.28,
        "segment": 0
      },
      {
        "text": "est",
        "type": "word",
        "startedAt": 1.8,
        "segment": 0
      },
      {
        "text": "un",
        "type": "word",
        "startedAt": 2.04,
        "segment": 0
      },
      {
        "text": "test",
        "type": "word",
        "startedAt": 2.32,
        "segment": 0
      }
    ]
  }
}
```

#### Response Fields

- **`text`**: The transcribed text
- **`type`**: `"partial"` for real-time updates, `"final"` for completed segments
- **`startedAt`**: Start time of the segment in seconds
- **`segment`**: Segment number (increments for each completed phrase/sentence)
- **`elements`**: Detailed breakdown with word-level timing
  - **`segments`**: Array of text segments with timing
  - **`words`**: Array of individual words with precise timestamps

**Note**: The only difference between partial and final results is the `type` field. Partial results may have incomplete words (e.g., "te" instead of "test"), while final results contain the complete, corrected transcription.

### Protocol Flow

1. **Connect** to WebSocket with API key or token
2. **Stream audio** in real-time chunks (100ms recommended)
3. **Receive partial results** for immediate feedback
4. **Receive final results** for completed segments with detailed timing
5. **Send EOF** when finished
6. **Close connection**

### Error Handling

- **Authentication errors**: Check API key validity and permissions
- **Connection errors**: Verify network connectivity and URL format
- **Audio format errors**: Ensure correct sample rate and audio format
- **Token expiry**: Temporary tokens expire after 1 hour

## Dependencies

### For Microphone Recording (asr-mic.js only)

The microphone script (`asr-mic.js`) requires [SoX](http://sox.sourceforge.net/) to be installed and available in your $PATH.

#### For Linux

```bash
sudo apt-get install sox libsox-fmt-all
```

#### For MacOS

```bash
brew install sox
```

#### For Windows

[Download the binaries](http://sourceforge.net/projects/sox/files/latest/download)

**Note**: SoX is **only required** for the microphone script (`asr-mic.js`). The file-based scripts (`asr-file-ws.js` and `asr-file-ws.py`) do not require SoX.

## JavaScript Setup

### Install dependencies

```bash
npm install
```

### asr-file-ws.js (Direct WebSocket with API Key)

Direct WebSocket connection using API key authentication with CLI parameters:

```bash
node asr-file-ws.js <API_KEY> <WAV_FILE> [LANG] [SAMPLE_RATE] [--staging]
```

**Examples:**
```bash
# Production environment (default)
node asr-file-ws.js your-prod-api-key audio.wav fr-medical 16000

# Staging environment
node asr-file-ws.js your-staging-api-key audio.wav fr-medical 16000 --staging

# Custom language and sample rate in production
node asr-file-ws.js your-prod-api-key audio.wav fr 8000

# English transcription in staging
node asr-file-ws.js your-staging-api-key audio.wav en 16000 --staging
```

**Parameters:**
- `API_KEY`: Your Voxist API key (different for staging and production)
- `WAV_FILE`: Path to the WAV audio file
- `LANG`: Language code (optional, default: "fr-medical")
- `SAMPLE_RATE`: Sample rate in Hz (optional, default: 16000)
- `--staging`: Use staging environment (optional)

### asr-mic.js (Real-time Microphone Transcription)

Real-time microphone transcription using WebSocket with temporary token authentication:

```bash
node asr-mic.js <API_KEY> [LANG] [SAMPLE_RATE] [--staging]
```

**Examples:**
```bash
# Production environment (default)
node asr-mic.js your-prod-api-key fr-medical 16000

# Staging environment
node asr-mic.js your-staging-api-key fr-medical 16000 --staging

# Custom language and sample rate in production
node asr-mic.js your-prod-api-key fr 8000

# English transcription in staging
node asr-mic.js your-staging-api-key en 16000 --staging
```

**Parameters:**
- `API_KEY`: Your Voxist API key (different for staging and production)
- `LANG`: Language code (optional, default: "fr-medical")
- `SAMPLE_RATE`: Sample rate in Hz (optional, default: 16000)
- `--staging`: Use staging environment (optional)

**Features:**
- Real-time microphone recording and transcription
- Automatic audio configuration (mono 16-bit at specified sample rate)
- Temporary token authentication (more secure than direct API key in WebSocket)
- Live partial results with `[LIVE]` prefix
- Final results with `[FINAL]` prefix
- Graceful shutdown with Ctrl+C
- Proper microphone resource cleanup

**Requirements:**
- **SoX must be installed** and available in PATH
- Working microphone
- Microphone permissions granted to terminal/application

**How it works:**
1. Requests a temporary WebSocket token from the API using your API key
2. Adds language and sample rate parameters to the WebSocket URL
3. Connects to the WebSocket using the temporary token
4. Streams microphone audio in real-time

## Python Setup

### Quick Setup

Run the setup script to create a virtual environment and install dependencies:

```bash
./setup-python.sh
```

### Manual Setup

1. Create a virtual environment:
```bash
python3 -m venv venv
```

2. Activate the virtual environment:
```bash
source venv/bin/activate  # On Linux/Mac
# or
venv\Scripts\activate     # On Windows
```

3. Install dependencies:
```bash
pip install -r requirements.txt
```

### Usage

#### asr-file-ws.py (Direct WebSocket with API Key)

```bash
python asr-file-ws.py <API_KEY> <WAV_FILE> [LANG] [SAMPLE_RATE] [--staging]
```

**Examples:**
```bash
# Production environment (default)
python asr-file-ws.py your-prod-api-key audio.wav fr-medical 16000

# Staging environment
python asr-file-ws.py your-staging-api-key audio.wav fr-medical 16000 --staging

# Custom language and sample rate in production
python asr-file-ws.py your-prod-api-key audio.wav fr 8000

# English transcription in staging
python asr-file-ws.py your-staging-api-key audio.wav en 16000 --staging
```

**Parameters:**
- `API_KEY`: Your Voxist API key (different for staging and production)
- `WAV_FILE`: Path to the WAV audio file
- `LANG`: Language code (optional, default: "fr-medical")
- `SAMPLE_RATE`: Sample rate in Hz (optional, default: 16000)
- `--staging`: Use staging environment (optional)

**Supported Languages:**
- `fr`: French
- `fr-medical`: French Medical
- `en`: English
- `pt`: Portuguese
- `nl`: Dutch
- `it`: Italian
- `sv`: Swedish
- `es`: Spanish
- `de`: German

## Audio Requirements

### For File-based Transcription
- Format: WAV
- Sample Rate: 8000 Hz or 16000 Hz
- Channels: Mono (1 channel)
- Bit Depth: 16-bit

### For Microphone Transcription
- Automatically configured to mono 16-bit at specified sample rate
- SoX handles audio format conversion
- Works with any microphone supported by the system

## API Keys

**Important**: You need different API keys for staging and production environments:

- **Production API Keys**: Used with `api-asr.voxist.com` (default behavior)
- **Staging API Keys**: Used with `asr-staging-dev.voxist.com` (with `--staging` flag)

Contact [Voxist support](mailto:contact@voxist.com) to obtain API keys for both environments.
