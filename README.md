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

Prefer this method for browsers and any client you do not fully control: the
token is short-lived (1 hour) and does not expose your long-lived API key.

#### Connection parameters

| Parameter | Required | Description |
|---|---|---|
| `api_key` or `token` | yes | Authentication. Exactly one of the two. |
| `lang` | no | Language / model. If omitted, the connection waits for a `config` message before it accepts audio — any audio sent before then is **discarded**. |
| `sample_rate` | no | Defaults to `16000`. See the note under [Audio Format](#audio-format). |
| `punctuation_mode` | no | `Generated` (default) or `Dictated`. Only takes effect for accounts with V2 text processing enabled — otherwise accepted and ignored. |

### Audio Format

Send raw audio data directly to the WebSocket:

- **Format**: Raw PCM audio bytes — **not** a WAV file. Strip the 44-byte RIFF
  header; the server forwards every binary frame straight to the decoder, so a
  header sent on the wire is decoded as if it were audio.
- **Encoding**: Signed 16-bit little-endian
- **Channels**: Mono (1 channel)
- **Sample Rate**: 16000 Hz
- **Chunk Size**: Recommended 100ms chunks (3200 bytes at 16kHz)

> **The server does not resample.** `sample_rate` in the connection URL is used
> for duration accounting, not for conversion, and the streaming engines are
> 16 kHz models. Sending 8 kHz audio does not fail — it returns a confidently
> wrong transcript. Convert before you stream:
>
> ```bash
> ffmpeg -i input.wav -ac 1 -ar 16000 -sample_fmt s16 output.wav
> ```

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

### Configuring mid-session

Instead of (or in addition to) URL parameters, send a JSON **text** frame:

```json
{
  "config": {
    "lang": "fr-medical",
    "sample_rate": 16000,
    "punctuation_mode": "Generated"
  }
}
```

This is also how you change settings on a live connection. Changing `lang`
transparently reconnects the session to the new engine — you do not need to open
a new socket. If you connected without a `lang` URL parameter, this message is
what unblocks audio processing.

### End of Transcription

To signal the end of audio and flush the final result, send the text frame:

```
Done
```

That is the literal five-byte string `Done`, sent as a text (not binary) frame:

```javascript
websocket.send('Done');
```

The server forwards it to the engine, which drains its buffer, emits the last
`final` message, and then closes the connection — so **wait for the `close`
event** rather than closing the socket yourself. Hanging up early truncates the
tail of your transcript.

> **Breaking change (July 2026 samples update).** Earlier versions of these
> samples sent `{"eof": 1}`. That message is not part of the protocol: the
> server logs it as an unknown text frame and discards it. The result is a
> transcript missing its final segment and a socket that stays open (and
> metered) until the client gives up. If you copied that pattern, replace it
> with `Done`.

### Response Format

The WebSocket returns JSON messages with transcription results. Both partial and final results have the same format, only the `type` field differs:

#### Partial Results (Real-time updates)
```json
{
  "text": " Ceci est un te",
  "transcript": " Ceci est un te",
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
  "transcript": " Ceci est un test",
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
- **`transcript`**: Same value as `text`, for compatibility with older clients
- **`type`**: `"partial"` for real-time updates, `"final"` for completed segments
- **`startedAt`**: Start time of the segment in seconds
- **`segment`**: Segment number (increments for each completed phrase/sentence)
- **`elements`**: Detailed breakdown with word-level timing
  - **`segments`**: Array of text segments with timing
  - **`words`**: Array of individual words with precise timestamps

**Note**: The only difference between partial and final results is the `type` field. Partial results may have incomplete words (e.g., "te" instead of "test"), while final results contain the complete, corrected transcription.

Word-level timings inside `elements` are produced by the acoustic model and are
not re-aligned after text post-processing, so on medical models the `text` may
be normalized ("15 mg") where the corresponding `words` entries still carry the
spoken tokens.

### Protocol Flow

1. **Connect** to WebSocket with API key or token
2. *(optional)* **Send a `config` message** if you did not pass `lang` in the URL
3. **Stream audio** in real-time chunks (100ms recommended)
4. **Receive partial results** for immediate feedback
5. **Receive final results** for completed segments with detailed timing
6. **Send `Done`** when finished
7. **Wait for the server to close** the connection

### Error Handling

Failures arrive as WebSocket close codes, not as JSON error messages:

| Code | Meaning | What to do |
|---|---|---|
| `1008` | Unsupported language code, or a model your account is not entitled to | Check `lang` against the supported list |
| `1011` | Engine unavailable, engine timeout, or a language with no engine configured in this environment | Retry; escalate if persistent |
| `1013` | Server at capacity. The close reason carries `{"error":"server_overloaded","retryAfterMs":3000}` | Back off and retry after the advertised delay |
| `1006` (no handshake) | Rejected during the HTTP upgrade — bad or missing credentials | Check the API key / token and the target environment |

Other things to watch for:

- **Audio sent before the connection is configured is dropped.** Pass `lang` in
  the URL, or wait after sending your `config` message.
- **Token expiry**: temporary tokens are valid for 1 hour. Long sessions should
  reconnect with a fresh token.
- **Audio format errors do not raise an error** — see the resampling note above.

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

Requires Node.js 18 or later (the microphone script uses the global `fetch`).

### Install dependencies

```bash
npm install
```

### asr-file-ws.js (Direct WebSocket with API Key)

Direct WebSocket connection using API key authentication with CLI parameters:

```bash
node asr-file-ws.js <API_KEY> <WAV_FILE> [LANG] [--staging]
```

**Examples:**
```bash
# Production environment (default)
node asr-file-ws.js your-prod-api-key audio.wav fr-medical

# Staging environment
node asr-file-ws.js your-staging-api-key audio.wav fr-medical --staging

# English transcription in production
node asr-file-ws.js your-prod-api-key audio.wav en
```

**Parameters:**
- `API_KEY`: Your Voxist API key (different for staging and production)
- `WAV_FILE`: Path to the WAV audio file (16 kHz mono 16-bit PCM; the script
  validates this and strips the WAV header before streaming)
- `LANG`: Language code (optional, default: `fr`)
- `--staging`: Use staging environment (optional)

### asr-mic.js (Real-time Microphone Transcription)

Real-time microphone transcription using WebSocket with temporary token authentication:

```bash
node asr-mic.js <API_KEY> [LANG] [--staging]
```

**Examples:**
```bash
# Production environment (default)
node asr-mic.js your-prod-api-key fr-medical

# Staging environment
node asr-mic.js your-staging-api-key fr-medical --staging

# English transcription in production
node asr-mic.js your-prod-api-key en
```

**Parameters:**
- `API_KEY`: Your Voxist API key (different for staging and production)
- `LANG`: Language code (optional, default: `fr`)
- `--staging`: Use staging environment (optional)

**Features:**
- Real-time microphone recording and transcription
- Records headerless mono 16-bit PCM at 16 kHz, ready to stream as-is
- Temporary token authentication (more secure than direct API key in WebSocket)
- Live partial results with `[LIVE]` prefix
- Final results with `[FINAL]` prefix
- Ctrl+C stops the microphone, flushes with `Done`, and waits for the last final

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
python asr-file-ws.py <API_KEY> <WAV_FILE> [LANG] [--staging]
```

**Examples:**
```bash
# Production environment (default)
python asr-file-ws.py your-prod-api-key audio.wav fr-medical

# Staging environment
python asr-file-ws.py your-staging-api-key audio.wav fr-medical --staging

# English transcription in production
python asr-file-ws.py your-prod-api-key audio.wav en
```

## Pointing the samples at another gateway

All three scripts honour two optional environment variables, for self-hosted
deployments and local testing:

| Variable | Overrides |
|---|---|
| `VOXIST_ASR_URL` | WebSocket base URL (default `wss://api-asr.voxist.com`) |
| `VOXIST_ASR_API_URL` | HTTP base URL used for the token request in `asr-mic.js` |

```bash
VOXIST_ASR_URL=ws://127.0.0.1:3000 node asr-file-ws.js your-api-key audio.wav fr
```

## Supported Languages

Real-time streaming models available in production:

| Code | Language |
|---|---|
| `fr` | French |
| `fr-medical` | French Medical |
| `fr-medicalV2-16` | French Medical, 16-frame latency tier |
| `fr-medicalV2-32` | French Medical, 32-frame latency tier (same model as `fr-medical`) |
| `fr-medicalV2-64` | French Medical, 64-frame latency tier |
| `en` | English |
| `de` | German |
| `es` | Spanish |
| `it` | Italian |
| `nl` | Dutch |
| `pt` | Portuguese |

Region-qualified aliases (`fr-FR`, `en-US`, `de-DE`, `nl-NL`) are accepted and
collapse to their base language.

**Not available for streaming**: `sv`, `pl`, `ja`, `he`, `tr`. These codes are
recognized by the API but have no streaming engine deployed in production today
— a connection using them is closed with code `1011`. Swedish is available for
**offline** (file upload) transcription via the REST API. Previous versions of
this README listed `sv` as a supported streaming language; that was incorrect.

## Audio Requirements

### For File-based Transcription
- Format: WAV (the script streams the PCM payload, not the container)
- Sample Rate: 16000 Hz — the server does not resample
- Channels: Mono (1 channel)
- Bit Depth: 16-bit

### For Microphone Transcription
- Automatically configured to headerless mono 16-bit PCM at 16 kHz
- SoX handles audio capture and format conversion
- Works with any microphone supported by the system

## API Keys

**Important**: You need different API keys for staging and production environments:

- **Production API Keys**: Used with `api-asr.voxist.com` (default behavior)
- **Staging API Keys**: Used with `asr-staging-dev.voxist.com` (with `--staging` flag)

Contact [Voxist support](mailto:contact@voxist.com) to obtain API keys for both environments.
