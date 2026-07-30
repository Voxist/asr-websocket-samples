import fs from 'fs';

/**
 * Minimal RIFF/WAVE parser.
 *
 * The gateway treats every binary frame as raw PCM, so the 44-byte WAV header
 * must never reach it — streaming the file verbatim feeds the header to the
 * decoder as if it were audio. This locates the `data` chunk and validates the
 * format up front, because the gateway does no resampling and no channel
 * downmixing: whatever you send is interpreted as 16 kHz mono signed 16-bit.
 */
export function readWavInfo(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
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

    while (fs.readSync(fd, chunkHeader, 0, 8, offset) === 8) {
      const chunkId = chunkHeader.toString('ascii', 0, 4);
      const chunkSize = chunkHeader.readUInt32LE(4);
      const bodyOffset = offset + 8;

      if (chunkId === 'fmt ') {
        const body = Buffer.alloc(Math.min(chunkSize, 16));
        fs.readSync(fd, body, 0, body.length, bodyOffset);
        fmt = {
          audioFormat: body.readUInt16LE(0),
          channels: body.readUInt16LE(2),
          sampleRate: body.readUInt32LE(4),
          bitsPerSample: body.readUInt16LE(14),
        };
      } else if (chunkId === 'data') {
        if (!fmt) {
          throw new Error('data chunk found before fmt chunk');
        }
        return { ...fmt, dataOffset: bodyOffset, dataSize: chunkSize };
      }

      // Chunks are word-aligned: an odd size is followed by a pad byte.
      offset = bodyOffset + chunkSize + (chunkSize % 2);
    }

    throw new Error('no data chunk found');
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
  if (info.audioFormat !== 1) problems.push(`not uncompressed PCM (format ${info.audioFormat})`);
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
