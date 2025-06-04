#!/usr/bin/env python3
"""
Python WebSocket client for Voxist ASR streaming
"""

import asyncio
import json
import sys
import time
import websockets
from pathlib import Path


class ASRWebSocketClient:
    def __init__(self, wav_file_path, api_key, lang="fr-medical", sample_rate=16000, is_staging=False):
        self.wav_file_path = Path(wav_file_path)
        self.api_key = api_key
        self.lang = lang
        self.sample_rate = sample_rate
        self.is_staging = is_staging
        
        # Select the appropriate domain based on staging flag
        domain = 'asr-staging-dev.voxist.com' if is_staging else 'api-asr.voxist.com'
        self.url = f"wss://{domain}/ws?api_key={api_key}&lang={lang}&sample_rate={sample_rate}"
        
        # Constants for chunking
        self.BYTES_PER_SAMPLE = 2
        self.CHUNK_DURATION_MS = 100
        self.CHUNK_SIZE = int(sample_rate * self.BYTES_PER_SAMPLE * (self.CHUNK_DURATION_MS / 1000))
        
        # State tracking
        self.start_time = None
        self.first_word_received = False
        self.last_segment = None

    def clear_line(self):
        """Clear current line and move cursor to beginning"""
        print('\r' + ' ' * 80 + '\r', end='', flush=True)

    async def send_audio_chunks(self, websocket):
        """Read and send audio file in chunks"""
        self.start_time = time.time()
        
        try:
            with open(self.wav_file_path, 'rb') as f:
                while True:
                    chunk = f.read(self.CHUNK_SIZE)
                    if not chunk:
                        break
                    
                    await websocket.send(chunk)
                    await asyncio.sleep(self.CHUNK_DURATION_MS / 1000)
                
                # Send EOF signal
                await websocket.send('{"eof": 1}')
                
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
        print(f"Connecting to: {self.url}")
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
                    
        except websockets.exceptions.ConnectionClosed:
            elapsed = int((time.time() - self.start_time) * 1000) if self.start_time else 0
            print(f'\nFinished: {elapsed} ms')
        except Exception as e:
            print(f"WebSocket error: {e}")


def main():
    # Parse command line arguments
    args = sys.argv[1:]
    is_staging = '--staging' in args
    
    # Remove --staging from args if present
    if is_staging:
        args.remove('--staging')
    
    if len(args) < 2:
        print("Usage: python asr-file-ws.py <API_KEY> <WAV_FILE> [LANG] [SAMPLE_RATE] [--staging]")
        print("Example: python asr-file-ws.py your-api-key audio.wav fr-medical 16000")
        print("Example: python asr-file-ws.py your-staging-api-key audio.wav fr-medical 16000 --staging")
        print("")
        print("Parameters:")
        print("  API_KEY: Your Voxist API key")
        print("  WAV_FILE: Path to the WAV audio file")
        print("  LANG: Language code (optional, default: 'fr-medical')")
        print("  SAMPLE_RATE: Sample rate in Hz (optional, default: 16000)")
        print("  --staging: Use staging environment (optional)")
        print("")
        print("Supported Languages:")
        print("  fr: French")
        print("  fr-medical: French Medical")
        print("  en: English")
        print("  en-medical: English Medical")
        print("")
        print("Environments:")
        print("  Production: api-asr.voxist.com (default)")
        print("  Staging: asr-staging-dev.voxist.com (with --staging flag)")
        print("")
        print("Note: Staging and production use different API keys")
        sys.exit(1)
    
    api_key = args[0]
    wav_file = args[1]
    lang = args[2] if len(args) > 2 else "fr-medical"
    sample_rate = int(args[3]) if len(args) > 3 else 16000
    
    client = ASRWebSocketClient(wav_file, api_key, lang, sample_rate, is_staging)
    asyncio.run(client.run())


if __name__ == "__main__":
    main() 