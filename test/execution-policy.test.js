import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EXECUTION_POLICY,
  classifyExecutionRequest,
} from '../src/execution-policy.js';

const commandApproval = (command, overrides = {}) => ({
  method: 'item/commandExecution/requestApproval',
  command,
  cwd: 'C:\\Users\\user',
  explicitUserRequest: true,
  ...overrides,
});

test('auto-allows explicit read, search, browser, safe create, copy, move, and test commands', () => {
  const commands = [
    'Get-ChildItem -LiteralPath "C:\\Users\\user\\Desktop"',
    'rg --files "C:\\Users\\user\\Downloads"',
    'Start-Process "https://example.com"',
    'New-Item -ItemType Directory -Path "C:\\Users\\user\\Desktop\\New folder"',
    'Copy-Item -LiteralPath "C:\\Users\\user\\a.txt" -Destination "C:\\Users\\user\\b.txt"',
    'Move-Item -LiteralPath "C:\\Users\\user\\old.txt" -Destination "C:\\Users\\user\\new.txt"',
    'npm.cmd test',
  ];

  for (const command of commands) {
    assert.equal(classifyExecutionRequest(commandApproval(command)).policy, EXECUTION_POLICY.AUTO_ALLOW, command);
  }
});

test('auto-allows a safe browser launch inside the real PowerShell command wrapper', () => {
  const wrapped = '"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "Start-Process \'https://www.google.com\'"';
  assert.equal(classifyExecutionRequest(commandApproval(wrapped)).policy, EXECUTION_POLICY.AUTO_ALLOW);
});

test('auto-allows structured read-only command actions and managed network access', () => {
  assert.equal(classifyExecutionRequest(commandApproval('custom-reader', {
    commandActions: [{ type: 'read', command: 'custom-reader', path: 'C:\\Users\\user\\notes.txt', name: 'notes.txt' }],
  })).policy, EXECUTION_POLICY.AUTO_ALLOW);
  assert.equal(classifyExecutionRequest(commandApproval('curl https://example.com', {
    networkApprovalContext: { host: 'example.com' },
  })).policy, EXECUTION_POLICY.AUTO_ALLOW);
});

test('requires confirmation for deletion, overwrite, settings, elevation, installs, and unknown commands', () => {
  const commands = [
    'Remove-Item -LiteralPath "C:\\Users\\user\\old.txt"',
    'Set-Content -LiteralPath "C:\\Users\\user\\report.txt" -Value changed',
    'Copy-Item a.txt b.txt -Force',
    'reg.exe delete HKCU\\Software\\Example /f',
    'Start-Process powershell -Verb RunAs',
    'winget install Example.App',
    'mystery-tool --mutate machine',
  ];

  for (const command of commands) {
    assert.equal(classifyExecutionRequest(commandApproval(command)).policy, EXECUTION_POLICY.CONFIRM_REQUIRED, command);
  }
  assert.equal(classifyExecutionRequest({
    method: 'item/fileChange/requestApproval',
    grantRoot: 'C:\\Users\\user\\Documents',
    explicitUserRequest: true,
  }).policy, EXECUTION_POLICY.CONFIRM_REQUIRED);
});

test('hard-blocks core disk and Windows destruction even when explicitly requested', () => {
  const commands = [
    'format C: /q',
    'diskpart /s clean-disk.txt',
    'Remove-Item -Recurse -Force C:\\Windows\\System32',
    'bcdedit /delete {current}',
  ];

  for (const command of commands) {
    const decision = classifyExecutionRequest(commandApproval(command));
    assert.equal(decision.policy, EXECUTION_POLICY.HARD_BLOCK, command);
    assert.equal(decision.overrideAllowed, false, command);
  }
});

test('never auto-allows an action that is not attached to an explicit user turn', () => {
  const result = classifyExecutionRequest(commandApproval('npm.cmd test', { explicitUserRequest: false }));
  assert.equal(result.policy, EXECUTION_POLICY.CONFIRM_REQUIRED);
});
