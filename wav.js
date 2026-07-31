import fs from 'fs';

/**
 * Minimal RIFF/WAVE parser.
 *
 * The gateway treats every binary frame as raw PCM, so the WAV header must never
 * reach it — streaming the file verbatim feeds the header to the decoder as if it
 * were audio. The header is NOT a fixed 44 bytes: a `LIST`/`INFO` chunk (what
 * ffmpeg writes by default, and what most DAW exports carry) pushes `data` well
 * past that offset, so the chunk list has to be walked.
 *
 * `wav.py` is the line-by-line equivalent of this file. Keep the two in sync —
 * the samples must agree on which files are valid.
 */

const FORMAT_PCM = 0x0001;
const FORMAT_EXTENSIBLE = 0xfffe;

// A `data` length of 0 or 0xFFFFFFFF means "unknown": a writer streaming to a
// pipe cannot seek back to patch the field. Trust the file size in both cases.
const SIZE_UNKNOWN = 0xffffffff;

export function readWavInfo(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const fileSize = fs.fstatSync(fd).size;

    const header = Buffer.alloc(12);
    if (fs.readSync(fd, header, 0, 12, 0) < 12) {
      throw new Error('file is too short to be a WAV file');
    }
    if (header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE') {
      throw new Error('not a RIFF/WAVE file');
    }

    let offset = 12;
    let fmt = null;
    const chunkHeader = Buffer.alloc(8);

    while (offset + 8 <= fileSize && fs.readSync(fd, chunkHeader, 0, 8, offset) === 8) {
      const chunkId = chunkHeader.toString('ascii', 0, 4);
      const chunkSize = chunkHeader.readUInt32LE(4);
      const bodyOffset = offset + 8;

      if (chunkId === 'fmt ') {
        if (chunkSize < 16) {
          throw new Error(`fmt chunk is truncated (${chunkSize} bytes, expected at least 16)`);
        }
        // 16 bytes covers plain PCM; 40 covers WAVE_FORMAT_EXTENSIBLE.
        const want = Math.min(chunkSize, 40);
        const body = Buffer.alloc(want);
        const read = fs.readSync(fd, body, 0, want, bodyOffset);
        if (read < 16) {
          throw new Error('fmt chunk is truncated (file ends mid-header)');
        }
        fmt = {
          audioFormat: body.readUInt16LE(0),
          channels: body.readUInt16LE(2),
          sampleRate: body.readUInt32LE(4),
          bitsPerSample: body.readUInt16LE(14),
          // WAVE_FORMAT_EXTENSIBLE keeps the real codec in the SubFormat GUID,
          // whose first two bytes are the format tag it stands in for.
          subFormat: read >= 26 ? body.readUInt16LE(24) : null,
        };
      } else if (chunkId === 'data') {
        if (!fmt) {
          throw new Error('data chunk found before fmt chunk');
        }
        const remaining = Math.max(0, fileSize - bodyOffset);
        const dataSize =
          chunkSize === 0 || chunkSize === SIZE_UNKNOWN || chunkSize > remaining ? remaining : chunkSize;
        if (dataSize === 0) {
          throw new Error('file contains no audio data');
        }
        return { ...fmt, dataOffset: bodyOffset, dataSize };
      }

      // Chunks are word-aligned: an odd size is followed by a pad byte.
      offset = bodyOffset + chunkSize + (chunkSize % 2);
    }

    throw new Error(fmt ? 'no data chunk found' : 'no fmt chunk found');
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Reject anything the gateway would silently mis-transcribe.
 *
 * `sample_rate` in the connection URL is only used for duration accounting on
 * the server — it does NOT trigger resampling — so 8 kHz audio sent to a 16 kHz
 * engine comes back as garbage rather than as an error.
 */
export function assertStreamable(info, expectedSampleRate) {
  const problems = [];

  // WAVE_FORMAT_EXTENSIBLE is a container, not a codec: Windows recorders emit
  // it for ordinary PCM, so judge it by its SubFormat rather than rejecting it.
  const effectiveFormat = info.audioFormat === FORMAT_EXTENSIBLE ? info.subFormat : info.audioFormat;
  if (effectiveFormat !== FORMAT_PCM) {
    if (info.audioFormat !== FORMAT_EXTENSIBLE) {
      problems.push(`not uncompressed PCM (format ${info.audioFormat})`);
    } else if (info.subFormat === null) {
      problems.push('extensible WAV whose fmt chunk is too short to declare a SubFormat');
    } else {
      problems.push(`extensible WAV carrying a non-PCM codec (SubFormat ${info.subFormat})`);
    }
  }
  if (info.channels !== 1) problems.push(`${info.channels} channels, expected mono`);
  if (info.bitsPerSample !== 16) problems.push(`${info.bitsPerSample}-bit, expected 16-bit`);
  if (info.sampleRate !== expectedSampleRate) {
    problems.push(`${info.sampleRate} Hz, expected ${expectedSampleRate} Hz`);
  }

  if (problems.length > 0) {
    throw new Error(
      `Unsupported audio: ${problems.join(', ')}.\n` +
        `Convert it first:\n` +
        `  ffmpeg -i input.wav -ac 1 -ar ${expectedSampleRate} -sample_fmt s16 output.wav`,
    );
  }
}
