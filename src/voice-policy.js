export { classifyConcreteAction, classifyVoiceIntent } from './execution-policy.js';

const ACCEPT = new Set([
  'да',
  'да подтверждаю',
  'ага',
  'подтверждаю',
  'подтвердить',
  'окей',
  'ок',
  'разрешаю',
  'давай',
  'делай',
  'выполняй',
  'yes',
  'confirm',
  'approve',
]);
const DECLINE = new Set([
  'нет',
  'отмена',
  'отменить',
  'отмени',
  'не надо',
  'не делай',
  'запрещаю',
  'no',
  'cancel',
  'decline',
]);

export function normalizeConfirmation(transcript) {
  if (typeof transcript !== 'string') return null;
  const normalized = transcript
    .trim()
    .toLowerCase()
    .replace(/[.!?,;:]+/g, ' ')
    .replace(/\s+/g, ' ');
  if (ACCEPT.has(normalized)) return 'accept';
  if (DECLINE.has(normalized)) return 'decline';
  return null;
}
