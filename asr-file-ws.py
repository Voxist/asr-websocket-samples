#!/usr/bin/env python3
"""
Python WebSocket client for Voxist ASR streaming
"""

import asyncio
import json
import os
import sys
import time
import wave
import websockets
from pathlib import Path
from urllib.parse import quote

# Only 16 kHz is served by the streaming engines. The gateway does not resample,
# so this is not a knob - it is a property of the audio you must supply.
SAMPLE_RATE = 16000
BYTES_PER_SAMPLE = 2
CHUNK_DURATION_MS = 100


class ASRWebSocketClient:
    def __init__(self, wav_file_path, api_key, lang="fr", is_staging=False):
        self.wav_file_path = Path(wav_file_path)
        self.api_key = api_key
        self.lang = lang
        self.sample_rate = SAMPLE_RATE
        self.is_staging = is_staging

        # Select the appropriate domain based on staging flag.
        # VOXIST_ASR_URL overrides the base URL entirely (self-hosted gateway, local tests).
        self.domain = 'asr-staging-dev.voxist.com' if is_staging else 'api-asr.voxist.com'
        self.base_url = os.environ.get('VOXIST_ASR_URL', f"wss://{self.domain}")
        self.url = (
            f"{self.base_url}/ws"
            f"?api_key={quote(api_key)}&lang={quote(lang)}&sample_rate={self.sample_rate}"
        )

        self.CHUNK_SIZE = int(self.sample_rate * BYTES_PER_SAMPLE * (CHUNK_DURATION_MS / 1000))

        # State tracking
        self.start_time = None
        self.first_word_received = False
        self.last_segment = None

    def clear_line(self):
        """Clear current line and move cursor to beginning"""
        print('\r' + ' ' * 80 + '\r', end='', flush=True)

    def validate_audio(self):
        """Reject anything the gateway would silently mis-transcribe.

        The gateway treats every binary frame as raw PCM: it does not resample,
        does not downmix, and does not inspect the WAV header. Sending 8 kHz or
        stereo audio therefore yields a wrong transcript rather than an error.
        """
        with wave.open(str(self.wav_file_path), 'rb') as wav:
            problems = []
            if wav.getnchannels() != 1:
                problems.append(f"{wav.getnchannels()} channels, expected mono")
            if wav.getsampwidth() != BYTES_PER_SAMPLE:
                problems.append(f"{wav.getsampwidth() * 8}-bit, expected 16-bit")
            if wav.getframerate() != self.sample_rate:
                problems.append(f"{wav.getframerate()} Hz, expected {self.sample_rate} Hz")

            if problems:
                raise ValueError(
                    "Unsupported audio: " + ", ".join(problems) + ".\n"
                    "Convert it first:\n"
                    f"  ffmpeg -i input.wav -ac 1 -ar {self.sample_rate} -sample_fmt s16 output.wav"
                )

    async def send_audio_chunks(self, websocket):
        """Read and send audio frames in chunks"""
        self.start_time = time.time()

        try:
            # wave.readframes() yields the `data` chunk only - the 44-byte header
            # never reaches the socket, where it would be decoded as audio.
            with wave.open(str(self.wav_file_path), 'rb') as wav:
                frames_per_chunk = self.CHUNK_SIZE // BYTES_PER_SAMPLE
                while True:
                    chunk = wav.readframes(frames_per_chunk)
                    if not chunk:
                        break

                    await websocket.send(chunk)
                    await asyncio.sleep(CHUNK_DURATION_MS / 1000)

            # End-of-stream signal. This MUST be the text frame `Done`: it is
            # what flushes the decoder's tail and promotes the last partial to a
            # final. The server closes the socket once the engine has drained.
            await websocket.send('Done')

        except FileNotFoundError:
            print(f"Error: Could not find audio file at {self.wav_file_path}")
            return
        except Exception as e:
            print(f"Error reading audio file: {e}")
            return

    def handle_message(self, message_data):
        """Handle incoming WebSocket messages"""
        try:
            message = json.loads(message_data)

            if message.get('text', '') != '':
                if not self.first_word_received:
                    self.first_word_received = True
                    elapsed = int((time.time() - self.start_time) * 1000)
                    print(f'First word: {elapsed} ms')

                if message.get('type') == 'partial':
                    # Clear line and show partial result (overwriting previous partial)
                    self.clear_line()
                    print(message['text'], end='', flush=True)

                elif message.get('type') == 'final':
                    # Clear the partial result and print final result on new line
                    self.clear_line()
                    current_segment = message.get('segment')
                    # Only print if it's a new segment
                    if current_segment != self.last_segment:
                        print(message['text'])
                        self.last_segment = current_segment

        except json.JSONDecodeError:
            print(f"Error: Could not parse message: {message_data}")
        except Exception as e:
            print(f"Error handling message: {e}")

    async def run(self):
        """Run the WebSocket client"""
        print(f"Environment: {'Staging' if self.is_staging else 'Production'}")
        print(f"Connecting to: {self.base_url}/ws?api_key=***&lang={self.lang}&sample_rate={self.sample_rate}")
        print(f"Audio file: {self.wav_file_path}")
        print(f"Language: {self.lang}")
        print(f"Sample rate: {self.sample_rate} Hz")
        print(f"Chunk size: {self.CHUNK_SIZE} bytes")
        print('')

        try:
            async with websockets.connect(self.url) as websocket:
                print('Connected to WebSocket')

                # Start sending audio chunks
                send_task = asyncio.create_task(self.send_audio_chunks(websocket))

                # Listen for messages
                async for message in websocket:
                    self.handle_message(message)

                await send_task

        except websockets.exceptions.ConnectionClosed:
            # The server closes the socket itself once the engine has drained.
            pass
        except Exception as e:
            print(f"WebSocket error: {e}")
        finally:
            elapsed = int((time.time() - self.start_time) * 1000) if self.start_time else 0
            print(f'\nFinished: {elapsed} ms')


def main():
    # Parse command line arguments
    args = sys.argv[1:]
    is_staging = '--staging' in args

    # Remove --staging from args if present
    if is_staging:
        args.remove('--staging')

    if len(args) < 2:
        print("Usage: python asr-file-ws.py <API_KEY> <WAV_FILE> [LANG] [--staging]")
        print("Example: python asr-file-ws.py your-api-key audio.wav fr")
        print("Example: python asr-file-ws.py your-staging-api-key audio.wav fr-medical --staging")
        print("")
        print("Parameters:")
        print("  API_KEY: Your Voxist API key")
        print("  WAV_FILE: Path to the WAV audio file (16 kHz mono 16-bit PCM)")
        print("  LANG: Language code (optional, default: 'fr')")
        print("  --staging: Use staging environment (optional)")
        print("")
        print("Supported Languages:")
        print("  fr: French")
        print("  fr-medical: French Medical")
        print("  fr-medicalV2-16 / fr-medicalV2-32 / fr-medicalV2-64: French Medical latency tiers")
        print("  en: English")
        print("  de: German")
        print("  es: Spanish")
        print("  it: Italian")
        print("  nl: Dutch")
        print("  pt: Portuguese")
        print("")
        print("Environments:")
        print("  Production: api-asr.voxist.com (default)")
        print("  Staging: asr-staging-dev.voxist.com (with --staging flag)")
        print("")
        print("Note: Staging and production use different API keys")
        sys.exit(1)

    api_key = args[0]
    wav_file = args[1]
    lang = args[2] if len(args) > 2 else "fr"

    client = ASRWebSocketClient(wav_file, api_key, lang, is_staging)

    try:
        client.validate_audio()
    except FileNotFoundError:
        print(f"Error: Could not find audio file at {wav_file}")
        sys.exit(1)
    except (ValueError, wave.Error) as e:
        print(f"Error: {e}")
        sys.exit(1)

    asyncio.run(client.run())


if __name__ == "__main__":
    main()
