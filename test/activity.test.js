import test from 'node:test';
import assert from 'node:assert/strict';

import { activityFromItem, approvalActivity } from '../src/activity.js';

function assertNoMojibake(event) {
  assert.doesNotMatch(JSON.stringify(event), /Р |Рџ|РЎ|Рќ|Р¤|Рљ|Р С|РЎР/);
}

test('uses one id for start and completion of a web search', () => {
  const item = { id: 'web-1', type: 'webSearch', query: 'погода Кагул', results: [{ title: 'A' }] };

  assert.deepEqual(activityFromItem(item, 'started'), {
    id: 'web-1',
    category: 'web',
    title: 'Поиск в интернете',
    detail: 'погода Кагул',
    state: 'working',
  });
  assert.equal(activityFromItem(item, 'completed').detail, '1 результат');
  assertNoMojibake(activityFromItem(item, 'started'));
});

test('never returns reasoning or aggregated command output', () => {
  assert.equal(activityFromItem({ id: 'r1', type: 'reasoning', content: ['hidden'] }, 'started'), null);

  const event = activityFromItem(
    {
      id: 'c1',
      type: 'commandExecution',
      command: 'npm.cmd test',
      cwd: 'C:\\work',
      status: 'completed',
      exitCode: 0,
      aggregatedOutput: 'secret',
      stdout: 'also-secret',
      stderr: 'error-secret',
    },
    'completed',
  );

  assert.equal(event.detail.includes('secret'), false);
  assert.equal(event.state, 'complete');
  assert.deepEqual(Object.keys(event), ['id', 'category', 'title', 'detail', 'state']);
});

test('projects commands as human activity without cwd or exit-code noise', () => {
  const event = activityFromItem(
    {
      id: 'cmd-1',
      type: 'commandExecution',
      command: 'powershell -NoProfile -Command "Get-ChildItem C:\\Users\\user\\Desktop"',
      cwd: 'C:\\Users\\user\\Desktop\\project',
      status: 'failed',
      exitCode: 2,
    },
    'completed',
  );

  assert.equal(event.id, 'cmd-1');
  assert.equal(event.category, 'command');
  assert.equal(event.state, 'error');
  assert.doesNotMatch(event.detail, /project|exit 2|powershell|-NoProfile/i);
  assert.equal(event.title, 'Действие не выполнено');
  assert.ok(event.title.length <= 64);
  assert.ok(event.detail.length <= 180);
});

test('redacts authorization material inside command text', () => {
  const event = activityFromItem(
    {
      id: 'cmd-secret',
      type: 'commandExecution',
      command: 'curl -H "Authorization: Bearer abc123" https://example.test',
      cwd: 'C:\\work',
      status: 'completed',
      exitCode: 0,
    },
    'completed',
  );

  assert.doesNotMatch(event.detail, /Bearer|abc123/);
});

test('redacts token flags, env assignments, and header secret forms', () => {
  const cases = [
    'curl --token abc123 https://example.test',
    'tool --api-key abc123 run',
    'PASSWORD abc123 tool run',
    'TOKEN=abc123 tool run',
    'curl -H "X-API-Key: abc123" https://example.test',
    'curl --header "Authorization: Bearer abc123" https://example.test',
  ];

  for (const [index, command] of cases.entries()) {
    const event = activityFromItem(
      { id: `cmd-${index}`, type: 'commandExecution', command, cwd: 'C:\\work', status: 'completed' },
      'completed',
    );

    assert.doesNotMatch(event.detail, /abc123|Bearer/);
  }
});

test('prefers safe command action metadata over suspicious raw command text', () => {
  const event = activityFromItem(
    {
      id: 'cmd-action',
      type: 'commandExecution',
      command: 'curl --token abc123 https://example.test',
      commandActions: [{ type: 'read', path: 'src/activity.js' }],
      cwd: 'C:\\work',
      status: 'completed',
    },
    'completed',
  );

  assert.match(event.detail, /read src\/activity\.js/);
  assert.doesNotMatch(event.detail, /curl|abc123|token/);
});

test('ignores unknown command action metadata and falls back to a human command label', () => {
  const event = activityFromItem(
    {
      id: 'cmd-unknown-action',
      type: 'commandExecution',
      command: 'powershell -Command "Remove-Item -LiteralPath .\\test-workspace\\readme.txt"',
      commandActions: [{ type: 'unknown' }],
    },
    'started',
  );

  assert.equal(event.detail, 'Работаю с выбранным объектом');
  assert.doesNotMatch(event.detail, /unknown|powershell|remove-item/i);
});

test('projects concrete file changes from changes only', () => {
  const event = activityFromItem(
    {
      id: 'file-1',
      type: 'fileChange',
      changes: [
        { type: 'create', path: 'src/activity.js' },
        { action: 'update', path: 'test/activity.test.js' },
        { action: 'delete', path: 'logs/debug.txt' },
      ],
      aggregatedOutput: 'secret',
    },
    'completed',
  );

  assert.deepEqual(event, {
    id: 'file-1',
    category: 'file',
    title: 'Файлы изменены',
    detail: 'создан src/activity.js; обновлен test/activity.test.js; удален logs/debug.txt',
    state: 'complete',
  });
  assertNoMojibake(event);
});

test('projects App Server object-shaped file change kinds', () => {
  const event = activityFromItem(
    {
      id: 'file-kind',
      type: 'fileChange',
      changes: [
        { kind: { type: 'add' }, path: 'src/new.js' },
        { kind: { type: 'update' }, path: 'src/existing.js' },
        { kind: { type: 'delete' }, path: 'src/old.js' },
      ],
    },
    'completed',
  );

  assert.equal(event.detail, 'создан src/new.js; обновлен src/existing.js; удален src/old.js');
  assert.doesNotMatch(event.detail, /\[object Object\]/);
});

test('projects approvals without authorization material', () => {
  const event = approvalActivity(
    {
      id: 'approval-1',
      kind: 'network',
      command: 'curl https://example.test',
      target: 'example.test',
      token: 'secret-token',
      authorization: 'Bearer secret-token',
    },
    'started',
  );

  assert.deepEqual(event, {
    id: 'approval-1',
    category: 'approval',
    title: 'Нужно подтверждение',
    detail: 'Сетевой доступ к example.test ожидает разрешения',
    state: 'waiting',
  });
  assert.doesNotMatch(JSON.stringify(event), /secret-token|Bearer/);
  assertNoMojibake(event);
});

test('projects approval activity as a human action without raw shell syntax', () => {
  const event = approvalActivity(
    {
      id: 'approval-delete',
      kind: 'command',
      safetyLevel: 'approval',
      command: 'powershell.exe -Command "Remove-Item -LiteralPath C:\\work\\test-workspace\\readme.txt -Force"',
      target: 'C:\\work\\test-workspace\\readme.txt',
      reason: 'Подтвердите удаление файла readme.txt.',
    },
    'started',
  );

  assert.equal(event.detail, 'Удаление readme.txt ожидает разрешения');
  assert.doesNotMatch(event.detail, /powershell|remove-item|-literalpath|c:\\work/i);
});

test('approval decline and cancellation are normal resolved states, not system errors', () => {
  for (const phase of ['declined', 'cancelled']) {
    const event = approvalActivity({ id: `approval-${phase}`, reason: 'Удаление файла' }, phase);
    assert.equal(event.state, 'complete');
    assert.equal(event.title, phase === 'declined' ? 'Действие отклонено' : 'Подтверждение отменено');
  }
});

test('flattens control characters and caps visible text', () => {
  const event = activityFromItem(
    {
      id: 'web-long',
      type: 'webSearch',
      query: `line one\n${'x'.repeat(220)}`,
      results: [],
    },
    'started',
  );

  assert.equal(event.detail.includes('\n'), false);
  assert.ok(event.title.length <= 64);
  assert.ok(event.detail.length <= 180);
});

test('returns null for unknown unobservable items', () => {
  assert.equal(activityFromItem({ id: 'unknown-1', type: 'unmodeled' }, 'started'), null);
});

test('preserves long App Server item ids exactly across phases', () => {
  const id = `item-${'x'.repeat(240)}`;
  const item = { id, type: 'webSearch', query: 'test', results: [] };

  assert.equal(activityFromItem(item, 'started').id, id);
  assert.equal(activityFromItem(item, 'completed').id, id);
});

test('returns null when an observable item has no non-empty string id', () => {
  assert.equal(activityFromItem({ type: 'webSearch', query: 'test' }, 'started'), null);
  assert.equal(activityFromItem({ id: '', type: 'commandExecution', command: 'npm test' }, 'started'), null);
});
