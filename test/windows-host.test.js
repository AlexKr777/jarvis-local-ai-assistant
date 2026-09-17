import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(import.meta.dirname, '..');
const buildScript = path.join(projectRoot, 'scripts', 'build-windows-host.ps1');
const executable = path.join(projectRoot, 'windows-host', 'bin', 'JarvisVoiceHost.exe');

test('Windows host builds with the installed framework compiler and passes its behavior self-test', async () => {
  const build = await execFileAsync('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', buildScript,
  ], { cwd: projectRoot, windowsHide: true, timeout: 60_000 });

  assert.match(build.stdout, /Windows host (built|up to date)/i);
  assert.equal((await stat(executable)).isFile(), true);

  const selfTest = await execFileAsync(executable, ['--self-test'], {
    cwd: projectRoot,
    windowsHide: true,
    timeout: 15_000,
  });
  const result = JSON.parse(selfTest.stdout.trim());
  assert.deepEqual(result, {
    quickTapIgnored: true,
    longPressRecords: true,
    chordCancels: true,
    escapeCancels: true,
    leftControlIgnored: true,
    injectedIgnored: true,
    maxDurationStops: true,
  });
});

test('Windows host opens the real default microphone only for a bounded in-memory diagnostic', async () => {
  await execFileAsync('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', buildScript,
  ], { cwd: projectRoot, windowsHide: true, timeout: 60_000 });
  const capture = await execFileAsync(executable, ['--audio-self-test'], {
    cwd: projectRoot,
    windowsHide: true,
    timeout: 15_000,
  });
  const result = JSON.parse(capture.stdout.trim());
  assert.equal(result.microphoneOpened, true);
  assert.ok(result.durationMs >= 500 && result.durationMs <= 1500);
  assert.ok(result.wavBytes > 44);
  assert.equal(result.rawAudioSaved, false);
});

test('native host contract uses physical Right Ctrl, non-idle local mic, tray, overlay, and owned backend supervision', async () => {
  const files = await Promise.all([
    readFile(path.join(projectRoot, 'windows-host', 'Input.cs'), 'utf8'),
    readFile(path.join(projectRoot, 'windows-host', 'Audio.cs'), 'utf8'),
    readFile(path.join(projectRoot, 'windows-host', 'Host.cs'), 'utf8'),
  ]);
  const source = files.join('\n');

  assert.match(source, /WH_KEYBOARD_LL/);
  assert.match(source, /VK_RCONTROL/);
  assert.match(source, /LLKHF_INJECTED/);
  assert.match(source, /waveInOpen/);
  assert.match(source, /waveInStart/);
  assert.match(source, /waveInReset/);
  assert.match(source, /NotifyIcon/);
  assert.match(source, /ShowWithoutActivation/);
  assert.match(source, /WH_MOUSE_LL/);
  assert.match(source, /WS_EX_TRANSPARENT/);
  assert.match(source, /GetForegroundWindow/);
  assert.match(source, /Screen\.FromHandle/);
  assert.match(source, /AnswerTimeoutMs\s*=\s*15000/);
  assert.match(source, /Полный ответ сохранён в JARVIS/);
  assert.match(source, /JARVIS_HOST_TOKEN/);
  assert.match(source, /JARVIS_NO_BROWSER/);
  assert.match(source, /StopOwnedAsync[\s\S]*owned\.Kill\(\)/);
  assert.match(source, /OpenJarvisAsync[\s\S]*backend\.EnsureRunningAsync\(\)[\s\S]*Process\.Start\(info\)/);
  assert.match(source, /openWait[\s\S]*Forget\(OpenJarvisAsync\(\)\)/);
  assert.doesNotMatch(source, /OPENAI_API_KEY|api\.openai\.com|gradient/i);
});

test('physical PTT path records privacy-safe T0 through T9 latency marks', async () => {
  const host = await readFile(path.join(projectRoot, 'windows-host', 'Host.cs'), 'utf8');
  assert.match(host, /PttLatencyTrace/);
  for (let index = 0; index <= 9; index += 1) {
    assert.match(host, new RegExp(`(?:Mark\\(${index}|T${index}=)`), `T${index}`);
  }
  assert.match(host, /ptt_latency/);
  assert.doesNotMatch(host, /ptt_latency[^\r\n]*(?:transcript|hostToken|audioBase64)/i);
});

test('launcher and autostart remain hidden, per-user, reversible, and idempotent', async () => {
  const [start, stop, host] = await Promise.all([
    readFile(path.join(projectRoot, 'START_JARVIS.bat'), 'utf8'),
    readFile(path.join(projectRoot, 'STOP_JARVIS.bat'), 'utf8'),
    readFile(path.join(projectRoot, 'windows-host', 'Host.cs'), 'utf8'),
  ]);

  assert.match(start, /build-windows-host\.ps1/i);
  assert.match(start, /JarvisVoiceHost\.exe/i);
  assert.doesNotMatch(start, /node\s+src[\\/]server\.js/i);
  assert.match(stop, /--stop/i);
  assert.match(host, /Registry\.CurrentUser/);
  assert.match(host, /Software\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Run/);
  assert.doesNotMatch(host, /Registry\.LocalMachine|schtasks|RunOnce/i);
});
