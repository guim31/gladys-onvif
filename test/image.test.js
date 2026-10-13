import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  IMAGE_PREFIX,
  ImageProcessor,
  MAX_IMAGE_CHARS,
  MAX_JPEG_BYTES,
  redactCredentials,
  toDataUri,
} from '../src/image.js';

const JPEG = (size) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(size - 3, 1)]);

/** A spawn that plays ffmpeg: answers `outputs` in turn, records the arguments. */
function fakeSpawn(outputs, calls) {
  return (command, args) => {
    calls.push(args);
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => setImmediate(() => child.emit('close', null));
    const output = outputs.shift();
    child.stdin.on('finish', () => {
      setImmediate(() => {
        if (output === 'hang') {
          return;
        }
        if (output instanceof Error) {
          child.stderr.write(output.message);
          child.emit('close', 1);
          return;
        }
        child.stdout.write(output);
        child.emit('close', 0);
      });
    });
    child.stdin.resume();
    return child;
  };
}

test('the data URI of the largest JPEG allowed fits the core bound', () => {
  assert.ok(toDataUri(JPEG(MAX_JPEG_BYTES)).length <= MAX_IMAGE_CHARS);
  assert.ok(toDataUri(JPEG(MAX_JPEG_BYTES + 3)).length > MAX_IMAGE_CHARS);
  assert.ok(toDataUri(JPEG(10)).startsWith(IMAGE_PREFIX));
});

test('a small JPEG is kept; a large one goes down the steps until it fits', async () => {
  const calls = [];
  const images = new ImageProcessor({
    spawn: fakeSpawn([JPEG(MAX_JPEG_BYTES + 10), JPEG(5000)], calls),
  });
  const small = JPEG(1000);
  assert.equal(await images.fit(small), small);
  assert.equal(calls.length, 0);
  const fitted = await images.fit(JPEG(400_000));
  assert.equal(fitted.length, 5000);
  assert.equal(calls.length, 2);
  assert.ok(calls[0].includes("scale='min(1280,iw)':-2"));
  assert.ok(calls[1].includes('9'));
});

test('ffmpeg errors never show the credentials of the stream address', async () => {
  const calls = [];
  const images = new ImageProcessor({
    spawn: fakeSpawn([new Error('rtsp://admin:s3cret@192.0.2.9:554/x: 401 Unauthorized')], calls),
  });
  await assert.rejects(images.grab('rtsp://admin:s3cret@192.0.2.9:554/x'), (err) => {
    assert.ok(!err.message.includes('s3cret'), err.message);
    assert.match(err.message, /rtsp:\/\/\*\*\*@192\.0\.2\.9/);
    return true;
  });
  assert.ok(calls[0].includes('-rtsp_transport'));
  assert.equal(redactCredentials('http://u:p@h/ and rtsp://x@y'), 'http://***@h/ and rtsp://***@y');
});

test('a stuck ffmpeg is killed; a missing one is reported', async () => {
  const images = new ImageProcessor({ spawn: fakeSpawn(['hang'], []), timeoutMs: 50 });
  await assert.rejects(images.fit(Buffer.from('not a jpeg')), { code: 'ETIMEDOUT' });
  const missing = new ImageProcessor({ ffmpegPath: '/nonexistent/ffmpeg' });
  await assert.rejects(missing.fit(Buffer.from('png?')), { code: 'ENOFFMPEG' });
});

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

test(
  'with the real ffmpeg: a 4K test image comes out under the bound',
  { skip: !hasFfmpeg },
  async () => {
    // A noisy 4K frame, the hardest to compress.
    const made = spawnSync(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=3840x2160,noise=alls=60:allf=t',
        '-frames:v',
        '1',
        '-q:v',
        '2',
        '-f',
        'image2pipe',
        '-c:v',
        'mjpeg',
        'pipe:1',
      ],
      { maxBuffer: 64 * 1024 * 1024 },
    );
    assert.equal(made.status, 0);
    assert.ok(made.stdout.length > MAX_JPEG_BYTES, `${made.stdout.length} bytes to begin with`);
    const fitted = await new ImageProcessor().fit(made.stdout);
    assert.ok(fitted.length <= MAX_JPEG_BYTES, `${fitted.length} bytes`);
    assert.ok(toDataUri(fitted).length <= MAX_IMAGE_CHARS);
  },
);
