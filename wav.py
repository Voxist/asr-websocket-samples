"""Minimal RIFF/WAVE parser.

The gateway treats every binary frame as raw PCM, so the WAV header must never
reach it - streaming the file verbatim feeds the header to the decoder as if it
were audio. The header is NOT a fixed 44 bytes: a `LIST`/`INFO` chunk (what
ffmpeg writes by default, and what most DAW exports carry) pushes `data` well
past that offset, so the chunk list has to be walked.

`wav.js` is the line-by-line equivalent of this file. Keep the two in sync - the
samples must agree on which files are valid. This is deliberately hand-rolled
rather than delegating to the stdlib `wave` module, which reports 0 frames for a
pipe-written file instead of recovering the audio, and whose format support
varies by Python version.
"""

import os
import struct

FORMAT_PCM = 0x0001
FORMAT_EXTENSIBLE = 0xFFFE

# A `data` length of 0 or 0xFFFFFFFF means "unknown": a writer streaming to a
# pipe cannot seek back to patch the field. Trust the file size in both cases.
SIZE_UNKNOWN = 0xFFFFFFFF


class WavError(Exception):
    """Raised when a file cannot be parsed or streamed as-is."""


class WavInfo:
    def __init__(self, audio_format, channels, sample_rate, bits_per_sample, sub_format,
                 data_offset, data_size):
        self.audio_format = audio_format
        self.channels = channels
        self.sample_rate = sample_rate
        self.bits_per_sample = bits_per_sample
        self.sub_format = sub_format
        self.data_offset = data_offset
        self.data_size = data_size


def read_wav_info(file_path):
    file_size = os.path.getsize(file_path)

    with open(file_path, 'rb') as f:
        header = f.read(12)
        if len(header) < 12:
            raise WavError('file is too short to be a WAV file')
        if header[0:4] != b'RIFF' or header[8:12] != b'WAVE':
            raise WavError('not a RIFF/WAVE file')

        offset = 12
        fmt = None

        while offset + 8 <= file_size:
            f.seek(offset)
            chunk_header = f.read(8)
            if len(chunk_header) < 8:
                break
            chunk_id = chunk_header[0:4]
            chunk_size = struct.unpack('<I', chunk_header[4:8])[0]
            body_offset = offset + 8

            if chunk_id == b'fmt ':
                if chunk_size < 16:
                    raise WavError(
                        f'fmt chunk is truncated ({chunk_size} bytes, expected at least 16)'
                    )
                # 16 bytes covers plain PCM; 40 covers WAVE_FORMAT_EXTENSIBLE.
                want = min(chunk_size, 40)
                body = f.read(want)
                if len(body) < 16:
                    raise WavError('fmt chunk is truncated (file ends mid-header)')
                fmt = {
                    'audio_format': struct.unpack('<H', body[0:2])[0],
                    'channels': struct.unpack('<H', body[2:4])[0],
                    'sample_rate': struct.unpack('<I', body[4:8])[0],
                    'bits_per_sample': struct.unpack('<H', body[14:16])[0],
                    # WAVE_FORMAT_EXTENSIBLE keeps the real codec in the SubFormat
                    # GUID, whose first two bytes are the tag it stands in for.
                    'sub_format': struct.unpack('<H', body[24:26])[0] if len(body) >= 26 else None,
                }
            elif chunk_id == b'data':
                if fmt is None:
                    raise WavError('data chunk found before fmt chunk')
                remaining = max(0, file_size - body_offset)
                if chunk_size in (0, SIZE_UNKNOWN) or chunk_size > remaining:
                    data_size = remaining
                else:
                    data_size = chunk_size
                if data_size == 0:
                    raise WavError('file contains no audio data')
                return WavInfo(data_offset=body_offset, data_size=data_size, **fmt)

            # Chunks are word-aligned: an odd size is followed by a pad byte.
            offset = body_offset + chunk_size + (chunk_size % 2)

    raise WavError('no data chunk found' if fmt else 'no fmt chunk found')


def assert_streamable(info, expected_sample_rate):
    """Reject anything the gateway would silently mis-transcribe.

    `sample_rate` in the connection URL is only used for duration accounting on
    the server - it does NOT trigger resampling - so 8 kHz audio sent to a 16 kHz
    engine comes back as garbage rather than as an error.
    """
    problems = []

    # WAVE_FORMAT_EXTENSIBLE is a container, not a codec: Windows recorders emit
    # it for ordinary PCM, so judge it by its SubFormat rather than rejecting it.
    effective_format = info.sub_format if info.audio_format == FORMAT_EXTENSIBLE else info.audio_format
    if effective_format != FORMAT_PCM:
        if info.audio_format != FORMAT_EXTENSIBLE:
            problems.append(f'not uncompressed PCM (format {info.audio_format})')
        elif info.sub_format is None:
            problems.append('extensible WAV whose fmt chunk is too short to declare a SubFormat')
        else:
            problems.append(f'extensible WAV carrying a non-PCM codec (SubFormat {info.sub_format})')
    if info.channels != 1:
        problems.append(f'{info.channels} channels, expected mono')
    if info.bits_per_sample != 16:
        problems.append(f'{info.bits_per_sample}-bit, expected 16-bit')
    if info.sample_rate != expected_sample_rate:
        problems.append(f'{info.sample_rate} Hz, expected {expected_sample_rate} Hz')

    if problems:
        raise WavError(
            'Unsupported audio: ' + ', '.join(problems) + '.\n'
            'Convert it first:\n'
            f'  ffmpeg -i input.wav -ac 1 -ar {expected_sample_rate} -sample_fmt s16 output.wav'
        )
