#!/usr/bin/env python3
"""
Python WebSocket client for Voxist ASR streaming
"""

import asyncio
import contextlib
import json
import os
import sys
import time
import websockets
from pathlib import Path
from urllib.parse import quote

from wav import WavError, assert_streamable, read_wav_info

# Only 16 kHz is served by the streaming engines. The gateway does not resample,
# so this is not a knob - it is a property of the audio you must supply.
SAMPLE_RATE = 16000
BYTES_PER_SAMPLE = 2
CHUNK_DURATION_MS = 100

# If the gateway's upstream engine socket is not yet OPEN when `Done` arrives,
# the gateway drops the flush and never closes us, so waiting for the close
# frame unconditionally would hang forever.
DRAIN_TIMEOUT_S = 30

# 1005 is "no status received". Neither it nor 1000 indicates a problem. Other
# codes may be relayed verbatim from the upstream ASR engine, so they are only
# treated as failures when no final result arrived.
CLEAN_CLOSE_CODES = (1000, 1005)


class ASRWebSocketClient:
    def __init__(self, wav_file_path, api_key, lang="fr", is_staging=False, punctuation_mode=None):
        self.wav_file_path = Path(wav_file_path)
        self.api_key = api_key
        self.lang = lang
        self.sample_rate = SAMPLE_RATE
        self.is_staging = is_staging
        self.punctuation_mode = punctuation_mode
        self.wav_info = None

        # Select the appropriate domain based on staging flag.
        # VOXIST_ASR_URL overrides the base URL entirely (self-hosted gateway, local tests).
        self.domain = 'asr-staging-dev.voxist.com' if is_staging else 'api-asr.voxist.com'
        self.base_url = os.environ.get('VOXIST_ASR_URL', f"wss://{self.domain}")
        self.url = (
            f"{self.base_url}/ws"
            f"?api_key={quote(api_key)}&lang={quote(lang)}&sample_rate={self.sample_rate}"
        )
        if punctuation_mode:
            self.url += f"&punctuation_mode={quote(punctuation_mode)}"

        self.CHUNK_SIZE = int(self.sample_rate * BYTES_PER_SAMPLE * (CHUNK_DURATION_MS / 1000))

        # State tracking
        self.start_time = None
        self.first_word_received = False
        self.last_segment = None
        self.received_final = False

    def clear_line(self):
        """Clear current line and move cursor to beginning"""
        print('\r' + ' ' * 80 + '\r', end='', flush=True)

    def validate_audio(self):
        """Parse the container and reject audio the gateway would mis-transcribe.

        The gateway treats every binary frame as raw PCM: it does not resample,
        does not downmix, and does not inspect the WAV header. Sending 8 kHz or
        stereo audio therefore yields a wrong transcript rather than an error.
        """
        self.wav_info = read_wav_info(str(self.wav_file_path))
        assert_streamable(self.wav_info, self.sample_rate)

    async def send_audio_chunks(self, websocket):
        """Stream the `data` chunk in real-time-sized pieces.

        Reads by offset rather than through the stdlib `wave` module so the
        header never reaches the socket and a pipe-written file (declared data
        length 0) still streams the audio it actually contains.
        """
        self.start_time = time.time()

        try:
            with open(self.wav_file_path, 'rb') as f:
                f.seek(self.wav_info.data_offset)
                remaining = self.wav_info.data_size
                while remaining > 0:
                    chunk = f.read(min(self.CHUNK_SIZE, remaining))
                    if not chunk:
                        break
                    remaining -= len(chunk)

                    await websocket.send(chunk)
                    await asyncio.sleep(CHUNK_DURATION_MS / 1000)
        except OSError as e:
            # File-read failures only. A ConnectionClosed raised by send() must
            # propagate: it carries the close code the caller reports.
            print(f"Error reading audio file: {e}")
            return

        # End-of-stream signal. This MUST be the text frame `Done`: it is what
        # flushes the decoder's tail and promotes the last partial to a final.
        # The server closes the socket once the engine has drained.
        await websocket.send('Done')

    def handle_message(self, message_data):
        """Handle incoming WebSocket messages"""
        try:
            message = json.loads(message_data)

            # Not every server message is a transcript: `text` may be absent.
            text = message.get('text')
            if isinstance(text, str) and text != '':
                if not self.first_word_received:
                    self.first_word_received = True
                    elapsed = int((time.time() - self.start_time) * 1000)
                    print(f'First word: {elapsed} ms')

                if message.get('type') == 'partial':
                    # Clear line and show partial result (overwriting previous partial)
                    self.clear_line()
                    print(message['text'], end='', flush=True)

                elif message.get('type') == 'final':
                    self.received_final = True
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

    def report_close(self, exc):
        """Explain an abnormal close using the gateway's documented codes."""
        code = getattr(exc, 'code', None)
        reason = (getattr(exc, 'reason', '') or '').strip()

        detail = reason
        if reason.startswith('{'):
            try:
                payload = json.loads(reason)
                detail = payload.get('message', reason)
                if payload.get('retryAfterMs'):
                    detail += f" (retry after {payload['retryAfterMs']} ms)"
            except json.JSONDecodeError:
                pass

        explanations = {
            1008: ('Unsupported language code, a model this account is not entitled to, '
                   'or a per-tenant rate limit'),
            1011: 'ASR engine unavailable, timed out, or not configured for this language',
            1013: 'Server at capacity - back off and retry',
        }
        print(f"\nConnection closed by server: code {code}"
              f"{' - ' + detail if detail else ''}")
        if code in explanations:
            print(f"  {explanations[code]}")

    async def receive_messages(self, websocket):
        """Consume server messages until the connection closes."""
        async for message in websocket:
            self.handle_message(message)

    async def run(self):
        """Run the WebSocket client. Returns a process exit status."""
        print(f"Environment: {'Staging' if self.is_staging else 'Production'}")
        print(f"Connecting to: {self.base_url}/ws?api_key=***&lang={self.lang}&sample_rate={self.sample_rate}")
        print(f"Audio file: {self.wav_file_path}")
        print(f"Language: {self.lang}")
        print(f"Punctuation mode: {self.punctuation_mode or 'Generated (default)'}")
        print(f"Sample rate: {self.sample_rate} Hz")
        print(f"Chunk size: {self.CHUNK_SIZE} bytes")
        print('')

        exit_code = 0
        send_task = None
        recv_task = None

        try:
            async with websockets.connect(self.url) as websocket:
                print('Connected to WebSocket')

                # Receive concurrently with sending, so a close that arrives
                # mid-stream is observed immediately rather than after the last
                # chunk, and so the sender's own failures are not masked.
                recv_task = asyncio.create_task(self.receive_messages(websocket))
                send_task = asyncio.create_task(self.send_audio_chunks(websocket))

                await send_task

                # `Done` has been sent; the server closes once the engine has
                # drained. Bounded, because a dropped flush never closes.
                try:
                    await asyncio.wait_for(recv_task, timeout=DRAIN_TIMEOUT_S)
                except asyncio.TimeoutError:
                    print(f"\nNo response from server {DRAIN_TIMEOUT_S} s after Done - closing.")
                    print('The final segment may be missing.')
                    exit_code = 1

        except websockets.exceptions.ConnectionClosedOK:
            pass
        except websockets.exceptions.ConnectionClosed as e:
            # 1008 / 1011 / 1013 land here. Surfacing the code matters: without
            # it a capacity rejection is indistinguishable from a clean run.
            code = getattr(e, 'code', None)
            if code in CLEAN_CLOSE_CODES:
                pass
            elif code in (1008, 1011, 1013) or not self.received_final:
                self.report_close(e)
                exit_code = 1
            else:
                # Relayed engine code, but the transcript did arrive.
                self.report_close(e)
        except OSError as e:
            print(f"Connection error: {e}")
            exit_code = 1
        except Exception as e:
            print(f"WebSocket error: {e}")
            exit_code = 1
        finally:
            for task in (send_task, recv_task):
                if task is not None and not task.done():
                    task.cancel()
                    with contextlib.suppress(asyncio.CancelledError, Exception):
                        await task
            elapsed = int((time.time() - self.start_time) * 1000) if self.start_time else 0
            print(f'\nFinished: {elapsed} ms')

        return exit_code


def main():
    # Parse command line arguments
    args = sys.argv[1:]
    is_staging = '--staging' in args

    # Remove --staging from args if present
    if is_staging:
        args.remove('--staging')

    # Optional --punctuation-mode=Generated|Dictated
    punctuation_mode = None
    for i, arg in enumerate(list(args)):
        if arg.startswith('--punctuation-mode'):
            if '=' in arg:
                punctuation_mode = arg.split('=', 1)[1]
                args.pop(i)
            else:
                punctuation_mode = args[i + 1] if i + 1 < len(args) else None
                del args[i:i + 2]
            if punctuation_mode not in ('Generated', 'Dictated'):
                print(f"Error: --punctuation-mode must be Generated or Dictated (got '{punctuation_mode}')")
                sys.exit(1)
            break

    if len(args) < 2:
        print("Usage: python asr-file-ws.py <API_KEY> <WAV_FILE> [LANG] [--punctuation-mode=MODE] [--staging]")
        print("Example: python asr-file-ws.py your-api-key audio.wav fr")
        print("Example: python asr-file-ws.py your-staging-api-key audio.wav fr-medical --staging")
        print("")
        print("Parameters:")
        print("  API_KEY: Your Voxist API key")
        print("  WAV_FILE: Path to the WAV audio file (16 kHz mono 16-bit PCM)")
        print("  LANG: Language code (optional, default: 'fr')")
        print("  --punctuation-mode: Generated (default) or Dictated, for spoken punctuation")
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

    client = ASRWebSocketClient(wav_file, api_key, lang, is_staging, punctuation_mode)

    try:
        client.validate_audio()
    except FileNotFoundError:
        print(f"Error: Could not find audio file at {wav_file}")
        sys.exit(1)
    except (WavError, OSError) as e:
        print(f"Error: {e}")
        sys.exit(1)

    sys.exit(asyncio.run(client.run()))


if __name__ == "__main__":
    main()
