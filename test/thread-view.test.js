import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  compactThreadTitle,
  isJarvisThread,
  threadDetail,
  threadSummary,
} from '../src/thread-view.js';

test('keeps only positively identified JARVIS threads in the exact project', () => {
  const root = path.resolve('C:\\work');
  const valid = {
    id: 'a',
    cwd: root,
    threadSource: 'jarvis-local',
    preview: 'Привет',
    name: null,
    turns: [],
  };

  assert.equal(isJarvisThread(valid, root, 'win32'), true);
  assert.equal(isJarvisThread({ ...valid, threadSource: null }, root, 'win32'), false);
  assert.equal(isJarvisThread({ ...valid, cwd: path.dirname(root) }, root, 'win32'), false);
});

test('matches Windows project cwd case-insensitively', () => {
  const root = path.resolve('C:\\Work\\Jarvis');
  const thread = { id: 'a', cwd: root.toUpperCase(), threadSource: 'jarvis-local' };

  assert.equal(isJarvisThread(thread, root.toLowerCase(), 'win32'), true);
  assert.equal(isJarvisThread(thread, root.toLowerCase(), 'linux'), false);
});

test('omits a new empty thread from Recent Chats', () => {
  const root = path.resolve('C:\\work');

  assert.equal(
    threadSummary({
      id: 'a',
      cwd: root,
      threadSource: 'jarvis-local',
      name: null,
      preview: '',
      turns: [],
    }),
    null,
  );
});

test('returns no summary when JARVIS metadata is missing', () => {
  assert.equal(
    threadSummary({
      id: 'a',
      cwd: path.resolve('C:\\work'),
      threadSource: null,
      name: 'Проверка',
      preview: 'Проверь',
      turns: [],
    }),
    null,
  );
});

test('projects messages and excludes reasoning and raw tool output', () => {
  const root = path.resolve('C:\\work');
  const detail = threadDetail({
    id: 'a',
    cwd: root,
    threadSource: 'jarvis-local',
    name: 'Проверка',
    preview: 'Проверь',
    turns: [
      {
        id: 'turn-1',
        status: 'completed',
        items: [
          { id: 'u1', type: 'userMessage', content: [{ type: 'text', text: 'Проверь' }] },
          { id: 'r1', type: 'reasoning', summary: ['secret'] },
          {
            id: 'c1',
            type: 'commandExecution',
            command: 'dir',
            aggregatedOutput: 'private output',
            cwd: root,
            status: 'completed',
            commandActions: [],
          },
          { id: 'a1', type: 'agentMessage', text: 'Готово' },
        ],
      },
    ],
  });

  assert.deepEqual(
    detail.messages.map(({ role, text }) => ({ role, text })),
    [
      { role: 'user', text: 'Проверь' },
      { role: 'assistant', text: 'Готово' },
    ],
  );
  assert.doesNotMatch(JSON.stringify(detail), /secret|private output/);
});

test('projects local images with safe attachment names only', () => {
  const detail = threadDetail({
    id: 'a',
    cwd: path.resolve('C:\\work'),
    threadSource: 'jarvis-local',
    name: 'Image check',
    preview: 'See file',
    turns: [
      {
        id: 'turn-1',
        status: 'completed',
        items: [
          {
            id: 'u1',
            type: 'userMessage',
            content: [
              { type: 'text', text: 'Что на картинке?' },
              { type: 'localImage', path: 'C:\\Users\\user\\Pictures\\private\\secret.png' },
            ],
          },
        ],
      },
    ],
  });

  assert.deepEqual(detail.messages, [
    {
      id: 'u1',
      turnId: 'turn-1',
      role: 'user',
      text: 'Что на картинке?',
      attachments: [{ type: 'localImage', name: 'secret.png' }],
    },
  ]);
  assert.doesNotMatch(JSON.stringify(detail), /Users|Pictures|private/);
});

test('compacts long whitespace-heavy titles to a short browser label', () => {
  assert.equal(
    compactThreadTitle('  one   two three four five six seven eight nine  '),
    'one two three four five six',
  );
  assert.equal(compactThreadTitle(''), '');
  assert.equal(compactThreadTitle('a'.repeat(80)), `${'a'.repeat(47)}…`);
});
