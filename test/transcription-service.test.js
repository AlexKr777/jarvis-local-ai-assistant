import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { spawn as spawnProcess } from 'node:child_process';

import { TranscriptionService } from '../src/transcription-service.js';

const VALID_RESULT = { text: 'Привет, мир', durationMs: 1250, language: 'ru' };

function createSpawn({
  stdout = `${JSON.stringify(VALID_RESULT)}\n`,
  stdoutChunks = null,
  stderr = '',
  exitCode = 0,
  hang = false,
  emitError = null,
} = {}) {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdinText = '';
    child.stdin.on('data', (chunk) => {
      child.stdinText += chunk.toString('utf8');
    });
    child.killSignals = [];
    child.kill = (signal) => {
      child.killSignals.push(signal);
      queueMicrotask(() => child.emit('close', null, signal));
      return true;
    };
    calls.push({ command, args, options, child });

    queueMicrotask(() => {
      if (emitError) {
        child.emit('error', emitError);
        return;
      }
      if (hang) return;
      if (stdoutChunks) {
        for (const chunk of stdoutChunks) child.stdout.write(chunk);
      } else if (stdout) {
        child.stdout.write(stdout);
      }
      if (stderr) child.stderr.write(stderr);
      child.stdout.end();
      child.stderr.end();
      child.emit('close', exitCode, null);
    });
    return child;
  };
  spawnImpl.calls = calls;
  return spawnImpl;
}

function createPersistentSpawn({ crashFirstRequest = false } = {}) {
  const calls = [];
  let requestCount = 0;
  const spawnImpl = (command, args, options) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killSignals = [];
    child.kill = (signal) => {
      child.killSignals.push(signal);
      queueMicrotask(() => child.emit('close', 0, signal));
      return true;
    };
    let input = '';
    child.stdin.on('data', (chunk) => {
      input += chunk.toString('utf8');
      while (input.includes('\n')) {
        const newline = input.indexOf('\n');
        const line = input.slice(0, newline);
        input = input.slice(newline + 1);
        if (!line) continue;
        const request = JSON.parse(line);
        requestCount += 1;
        if (crashFirstRequest && requestCount === 1) {
          queueMicrotask(() => child.emit('close', 1, null));
          continue;
        }
        queueMicrotask(() => child.stdout.write(`${JSON.stringify({ id: request.id, ...VALID_RESULT })}\n`));
      }
    });
    calls.push({ command, args, options, child });
    return child;
  };
  spawnImpl.calls = calls;
  return spawnImpl;
}

async function withService(spawnImpl, run, options = {}) {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'jarvis-transcription-'));
  try {
    const service = new TranscriptionService({ projectRoot, spawnImpl, ...options });
    await run(service, projectRoot);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
}

function audioBase64(bytes = 'fake webm audio') {
  return Buffer.from(bytes).toString('base64');
}

async function assertAudioDirectoryEmpty(projectRoot) {
  assert.deepEqual(await readdir(path.join(projectRoot, 'data', 'audio')), []);
}

test('keeps one warm worker for consecutive transcriptions and stops it explicitly', async () => {
  const spawnImpl = createPersistentSpawn();
  await withService(spawnImpl, async (service, projectRoot) => {
    assert.deepEqual(await service.transcribe({ mime: 'audio/wav', base64: audioBase64('first') }), VALID_RESULT);
    assert.deepEqual(await service.transcribe({ mime: 'audio/wav', base64: audioBase64('second') }), VALID_RESULT);

    assert.equal(spawnImpl.calls.length, 1);
    assert.equal(spawnImpl.calls[0].child.killSignals.length, 0);
    await assertAudioDirectoryEmpty(projectRoot);
    await service.stop();
    assert.deepEqual(spawnImpl.calls[0].child.killSignals, ['SIGTERM']);
  }, { timeoutMs: 50 });
});

test('restarts a crashed warm worker once without losing the transcription request', async () => {
  const spawnImpl = createPersistentSpawn({ crashFirstRequest: true });
  await withService(spawnImpl, async (service) => {
    assert.deepEqual(await service.transcribe({ mime: 'audio/wav', base64: audioBase64('retry') }), VALID_RESULT);
    assert.equal(spawnImpl.calls.length, 2);
    await service.stop();
  }, { timeoutMs: 50 });
});

test('real Python worker handles a cold request followed by a warm request with timing marks', async () => {
  const fakeModuleRoot = await mkdtemp(path.join(os.tmpdir(), 'jarvis-fake-whisper-'));
  const audioPath = path.join(fakeModuleRoot, 'sample.wav');
  const modelPath = path.join(fakeModuleRoot, 'models');
  const pythonPath = path.join(process.cwd(), '.venv', 'Scripts', 'python.exe');
  try {
    await writeFile(path.join(fakeModuleRoot, 'faster_whisper.py'), [
      'class Segment:',
      '    text = "тест"',
      'class Info:',
      '    duration = 1.0',
      '    language = "ru"',
      'class WhisperModel:',
      '    def __init__(self, *args, **kwargs): pass',
      '    def transcribe(self, *args, **kwargs): return ([Segment()], Info())',
      '',
    ].join('\n'), 'utf8');
    await writeFile(audioPath, 'not-real-audio', 'utf8');
    const child = spawnProcess(pythonPath, [path.join(process.cwd(), 'speech', 'transcribe.py')], {
      env: { ...process.env, PYTHONPATH: fakeModuleRoot },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    const request = (id) => JSON.stringify({ id, audioPath, modelPath, model: 'small', device: 'cpu', computeType: 'int8' });
    child.stdin.end(`${request('cold')}\n${request('warm')}\n`);
    const exitCode = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    assert.equal(exitCode, 0, stderr);
    const results = stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line));
    assert.equal(results.length, 2);
    assert.equal(results[0].text, 'тест');
    assert.equal(results[0].timings.warm, false);
    assert.equal(results[1].text, 'тест');
    assert.equal(results[1].timings.warm, true);
    assert.equal(Number.isFinite(results[1].timings.asrStartedAtUnixMs), true);
  } finally {
    await rm(fakeModuleRoot, { recursive: true, force: true });
  }
});

test('spawns the project Python worker directly and exchanges one JSON line', async () => {
  const spawnImpl = createSpawn();
  await withService(spawnImpl, async (service, projectRoot) => {
    const result = await service.transcribe({ mime: 'audio/webm;codecs=opus', base64: audioBase64() });

    assert.deepEqual(result, VALID_RESULT);
    assert.equal(spawnImpl.calls.length, 1);
    const call = spawnImpl.calls[0];
    assert.equal(call.command, path.join(projectRoot, '.venv', 'Scripts', 'python.exe'));
    assert.deepEqual(call.args, [path.join(projectRoot, 'speech', 'transcribe.py')]);
    assert.deepEqual(call.options, {
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    assert.match(call.child.stdinText, /^\{[^\r\n]+\}\n$/);

    const request = JSON.parse(call.child.stdinText);
    assert.equal(request.modelPath, path.join(projectRoot, 'data', 'models'));
    assert.equal(path.dirname(request.audioPath), path.join(projectRoot, 'data', 'audio'));
    assert.match(path.basename(request.audioPath), /^[0-9a-f]{8}-[0-9a-f-]{27}\.webm$/i);
    assert.equal(await readFile(request.audioPath).catch((error) => error.code), 'ENOENT');
    await assertAudioDirectoryEmpty(projectRoot);
  });
});

test('preserves UTF-8 JSON when a Russian character is split across stdout chunks', async () => {
  const encoded = Buffer.from(`${JSON.stringify(VALID_RESULT)}\n`, 'utf8');
  const splitAt = encoded.indexOf(Buffer.from('П', 'utf8')) + 1;
  const spawnImpl = createSpawn({ stdoutChunks: [encoded.subarray(0, splitAt), encoded.subarray(splitAt)] });

  await withService(spawnImpl, async (service) => {
    assert.deepEqual(
      await service.transcribe({ mime: 'audio/webm', base64: audioBase64() }),
      VALID_RESULT,
    );
  });
});

test('uses MIME-selected extensions for supported browser audio formats', async () => {
  const cases = [
    ['audio/webm', '.webm'],
    ['audio/ogg;codecs=opus', '.ogg'],
    ['audio/mp4', '.m4a'],
    ['audio/wav', '.wav'],
    ['audio/mpeg', '.mp3'],
  ];

  for (const [mime, extension] of cases) {
    const spawnImpl = createSpawn();
    await withService(spawnImpl, async (service) => {
      await service.transcribe({ mime, base64: audioBase64() });
      const request = JSON.parse(spawnImpl.calls[0].child.stdinText);
      assert.equal(path.extname(request.audioPath), extension);
    });
  }
});

test('rejects unsupported MIME and malformed base64 before writing or spawning', async () => {
  const spawnImpl = createSpawn();
  await withService(spawnImpl, async (service, projectRoot) => {
    await assert.rejects(
      service.transcribe({ mime: 'text/plain', base64: audioBase64() }),
      { message: 'Unsupported audio MIME type.' },
    );
    await assert.rejects(
      service.transcribe({ mime: 'audio/webm', base64: 'not base64!' }),
      { message: 'Audio data must be strict base64.' },
    );
    await assert.rejects(
      service.transcribe({ mime: 'audio/webm', base64: '' }),
      { message: 'Audio data must be strict base64.' },
    );

    assert.equal(spawnImpl.calls.length, 0);
    await assert.rejects(stat(path.join(projectRoot, 'data', 'audio')), /ENOENT/);
  });
});

test('accepts exactly 25 MiB and rejects one decoded byte more before spawning', async () => {
  const spawnImpl = createSpawn();
  await withService(spawnImpl, async (service, projectRoot) => {
    await service.transcribe({
      mime: 'audio/webm',
      base64: Buffer.alloc(25 * 1024 * 1024).toString('base64'),
    });
    assert.equal(spawnImpl.calls.length, 1);
    await assertAudioDirectoryEmpty(projectRoot);

    await assert.rejects(
      service.transcribe({
        mime: 'audio/webm',
        base64: Buffer.alloc(25 * 1024 * 1024 + 1).toString('base64'),
      }),
      { message: 'Audio size exceeds 25 MiB.' },
    );
    assert.equal(spawnImpl.calls.length, 1);
  });
});

test('rejects an oversized valid base64 payload before decoding it', async () => {
  const spawnImpl = createSpawn();
  const oversized = Buffer.alloc(25 * 1024 * 1024 + 1).toString('base64');
  await withService(spawnImpl, async (service) => {
    const originalFrom = Buffer.from;
    let decodedOversizedPayload = false;
    Buffer.from = function guardedFrom(value, encoding, ...rest) {
      if (value === oversized && encoding === 'base64') {
        decodedOversizedPayload = true;
        throw new Error('Oversized payload reached Buffer.from.');
      }
      return originalFrom.call(Buffer, value, encoding, ...rest);
    };

    try {
      await assert.rejects(
        service.transcribe({ mime: 'audio/webm', base64: oversized }),
        { message: 'Audio size exceeds 25 MiB.' },
      );
    } finally {
      Buffer.from = originalFrom;
    }

    assert.equal(decodedOversizedPayload, false);
    assert.equal(spawnImpl.calls.length, 0);
  });
});

test('removes temporary audio after a non-zero worker exit', async () => {
  const spawnImpl = createSpawn({ stderr: 'private worker details', exitCode: 1 });
  await withService(spawnImpl, async (service, projectRoot) => {
    await assert.rejects(service.transcribe({ mime: 'audio/webm', base64: audioBase64() }), {
      message: 'Local speech transcription failed.',
    });
    await assertAudioDirectoryEmpty(projectRoot);
  });
});

test('removes temporary audio after malformed or multiple JSON responses', async () => {
  for (const stdout of ['not-json\n', `${JSON.stringify(VALID_RESULT)}\n${JSON.stringify(VALID_RESULT)}\n`]) {
    const spawnImpl = createSpawn({ stdout });
    await withService(spawnImpl, async (service, projectRoot) => {
      await assert.rejects(service.transcribe({ mime: 'audio/webm', base64: audioBase64() }), {
        message: 'Local speech transcription failed.',
      });
      await assertAudioDirectoryEmpty(projectRoot);
    });
  }
});

test('times out, terminates the worker, and removes temporary audio', async () => {
  const spawnImpl = createSpawn({ hang: true });
  await withService(spawnImpl, async (service, projectRoot) => {
    await assert.rejects(service.transcribe({ mime: 'audio/webm', base64: audioBase64() }), {
      message: 'Local speech transcription timed out.',
    });
    assert.deepEqual(spawnImpl.calls[0].child.killSignals, ['SIGKILL']);
    await assertAudioDirectoryEmpty(projectRoot);
  }, { timeoutMs: 10 });
});

test('caps worker stdout and stderr and still cleans up', async () => {
  for (const output of [
    { stdout: 'x'.repeat(65 * 1024) },
    { stdout: '', stderr: 'x'.repeat(65 * 1024), exitCode: 1 },
  ]) {
    const spawnImpl = createSpawn(output);
    await withService(spawnImpl, async (service, projectRoot) => {
      await assert.rejects(service.transcribe({ mime: 'audio/webm', base64: audioBase64() }), {
        message: 'Local speech transcription failed.',
      });
      assert.deepEqual(spawnImpl.calls[0].child.killSignals, ['SIGKILL']);
      await assertAudioDirectoryEmpty(projectRoot);
    });
  }
});

test('maps a spawn failure to a stable setup error and removes temporary audio', async () => {
  const spawnImpl = createSpawn({ emitError: Object.assign(new Error('private path'), { code: 'ENOENT' }) });
  await withService(spawnImpl, async (service, projectRoot) => {
    await assert.rejects(service.transcribe({ mime: 'audio/webm', base64: audioBase64() }), {
      message: 'Local speech transcription is not set up.',
    });
    await assertAudioDirectoryEmpty(projectRoot);
  });
});

test('does not expose internal paths when temporary storage is unavailable', async () => {
  const spawnImpl = createSpawn();
  await withService(spawnImpl, async (service, projectRoot) => {
    await writeFile(path.join(projectRoot, 'data'), 'not a directory', 'utf8');

    await assert.rejects(service.transcribe({ mime: 'audio/webm', base64: audioBase64() }), {
      message: 'Local speech transcription failed.',
    });
    assert.equal(spawnImpl.calls.length, 0);
  });
});

test('rejects a data directory junction without creating anything outside the project', async () => {
  const spawnImpl = createSpawn();
  const outside = await mkdtemp(path.join(os.tmpdir(), 'jarvis-transcription-outside-'));
  try {
    await withService(spawnImpl, async (service, projectRoot) => {
      await symlink(outside, path.join(projectRoot, 'data'), 'junction');

      await assert.rejects(
        service.transcribe({ mime: 'audio/webm', base64: audioBase64() }),
        { message: 'Local speech transcription failed.' },
      );

      assert.equal(spawnImpl.calls.length, 0);
      assert.deepEqual(await readdir(outside), []);
      await assert.rejects(stat(path.join(outside, 'audio')), /ENOENT/);
    });
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});
