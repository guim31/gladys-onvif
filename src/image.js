// -----------------------------------------------------------------------------
// Camera images for Gladys: a JPEG of at most 150 KB once written as
// `image/jpg;base64,...` (the core bound, src/camera.setImage), so about
// 112 KB of JPEG. A 1080p snapshot weighs 200 to 600 KB, a 4K one more: it is
// scaled down and compressed with ffmpeg, step by step until it fits, the way
// the core's RTSP camera service does (1280 px wide).
//
// ffmpeg also grabs a frame from the RTSP stream of the cameras without a
// snapshot address. Its address carries the credentials: it is given to the
// process only, and never written in an error or a log line.
//
// One ffmpeg at a time: decoding a 4K frame takes tens of megabytes, and the
// container has 256.
// -----------------------------------------------------------------------------

import { spawn as nodeSpawn } from 'node:child_process';

export const IMAGE_PREFIX = 'image/jpg;base64,';
export const MAX_IMAGE_CHARS = 150 * 1024;
export const MAX_JPEG_BYTES = Math.floor((MAX_IMAGE_CHARS - IMAGE_PREFIX.length) / 4) * 3;
export const FFMPEG_TIMEOUT_MS = 12000;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

// Width (never enlarged) and JPEG quality (2 best … 31 worst), tried in order.
export const STEPS = [
  { width: 1280, quality: 5 },
  { width: 1280, quality: 9 },
  { width: 960, quality: 12 },
  { width: 640, quality: 15 },
  { width: 480, quality: 24 },
];

export class ImageError extends Error {
  constructor(message, { code } = {}) {
    super(message);
    this.name = 'ImageError';
    this.code = code;
  }
}

export const isJpeg = (buffer) =>
  Buffer.isBuffer(buffer) && buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8;

/** The string Gladys stores and shows. */
export function toDataUri(jpeg) {
  return `${IMAGE_PREFIX}${jpeg.toString('base64')}`;
}

/** Remove the credentials an ffmpeg message may repeat (`rtsp://user:pass@`). */
export function redactCredentials(text) {
  return String(text ?? '').replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s@]*@/gi, '$1***@');
}

export class ImageProcessor {
  /**
   * @param {object} [options]
   * @param {string} [options.ffmpegPath]
   * @param {Function} [options.spawn] child_process.spawn (tests replace it)
   * @param {number} [options.timeoutMs] one ffmpeg run
   */
  constructor({ ffmpegPath = 'ffmpeg', spawn = nodeSpawn, timeoutMs = FFMPEG_TIMEOUT_MS } = {}) {
    this.ffmpegPath = ffmpegPath;
    this.spawn = spawn;
    this.timeoutMs = timeoutMs;
    this.queue = Promise.resolve();
  }

  /** Run one ffmpeg after the ones already queued. */
  run(args, input) {
    const job = this.queue.then(() => this.exec(args, input));
    this.queue = job.catch(() => {});
    return job;
  }

  exec(args, input) {
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = this.spawn(this.ffmpegPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (err) {
        reject(new ImageError(`Cannot start ffmpeg: ${err.message}`, { code: 'ENOFFMPEG' }));
        return;
      }
      const chunks = [];
      let size = 0;
      let stderr = '';
      let settled = false;
      const finish = (fn, value) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          fn(value);
        }
      };
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish(reject, new ImageError('ffmpeg took too long', { code: 'ETIMEDOUT' }));
      }, this.timeoutMs);
      child.on('error', (err) => {
        finish(
          reject,
          new ImageError(`Cannot run ffmpeg: ${err.message}`, {
            code: err.code === 'ENOENT' ? 'ENOFFMPEG' : err.code,
          }),
        );
      });
      child.stdout.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_OUTPUT_BYTES) {
          child.kill('SIGKILL');
          finish(reject, new ImageError('ffmpeg output too large', { code: 'ETOOBIG' }));
          return;
        }
        chunks.push(chunk);
      });
      child.stderr.on('data', (chunk) => {
        stderr = `${stderr}${chunk}`.slice(-2000);
      });
      child.on('close', (code) => {
        const output = Buffer.concat(chunks);
        if (code === 0 && isJpeg(output)) {
          finish(resolve, output);
        } else {
          const reason = redactCredentials(stderr.trim().split('\n').pop() || `exit code ${code}`);
          finish(reject, new ImageError(`ffmpeg failed: ${reason}`, { code: 'EFFMPEG' }));
        }
      });
      // A camera that closes the stream early is not an error of ours.
      child.stdin.on('error', () => {});
      if (input) {
        child.stdin.end(input);
      } else {
        child.stdin.end();
      }
    });
  }

  /**
   * A JPEG of at most MAX_JPEG_BYTES from any image a camera served: kept as
   * is when it already fits.
   */
  async fit(image) {
    if (isJpeg(image) && image.length <= MAX_JPEG_BYTES) {
      return image;
    }
    let last = null;
    for (const step of STEPS) {
      last = await this.run(
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-f',
          'image2pipe',
          '-i',
          'pipe:0',
          ...encodeArgs(step),
        ],
        image,
      );
      if (last.length <= MAX_JPEG_BYTES) {
        return last;
      }
    }
    throw new ImageError(`Image still too large (${last.length} bytes)`, { code: 'ETOOBIG' });
  }

  /** One frame of an RTSP stream (the address may hold credentials). */
  async grab(streamUrl) {
    const frame = await this.run([
      '-hide_banner',
      '-loglevel',
      'error',
      '-nostdin',
      '-rtsp_transport',
      'tcp',
      '-i',
      streamUrl,
      ...encodeArgs(STEPS[0]),
    ]);
    return this.fit(frame);
  }
}

function encodeArgs({ width, quality }) {
  return [
    '-frames:v',
    '1',
    '-vf',
    `scale='min(${width},iw)':-2`,
    '-q:v',
    String(quality),
    '-f',
    'image2pipe',
    '-c:v',
    'mjpeg',
    'pipe:1',
  ];
}
