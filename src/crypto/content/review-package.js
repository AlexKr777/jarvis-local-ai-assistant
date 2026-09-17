import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildStoryBrief } from './story-brief.js';

function safeId(value) {
  return String(value || 'review').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80) || 'review';
}

function publicCandidate(candidate = {}) {
  return {
    id: candidate.id || null,
    symbol: candidate.symbol || null,
    cashtag: candidate.cashtag || null,
    top10Rank: Number.isInteger(candidate.top10Rank) ? candidate.top10Rank : null,
    occurredAt: candidate.occurredAt || null,
  };
}

export async function writeReviewPackage({ directory, candidate, factPack, editorial, validation, chart, publication }) {
  if (typeof directory !== 'string' || !directory) throw new TypeError('A review package directory is required.');
  const packageData = {
    schemaVersion: 3,
    generatedAt: new Date().toISOString(),
    candidate: publicCandidate(candidate),
    factPack,
    research: factPack?.research || { status: 'none_found', sources: [], claims: [] },
    editorial: editorial?.audit || null,
    // Skips need the same explainability as previews: the deterministic brief
    // is still meaningful even if Writer, Critic, or diversity rejected copy.
    storyBrief: editorial?.audit?.storyBrief || editorial?.finalStory?.spine?.storyBrief || buildStoryBrief(factPack),
    formatting: editorial?.audit?.selected?.validation?.formatting || null,
    writerFailure: editorial?.audit?.writerFailure || null,
    validation,
    chart: chart ? { path: chart.path, sha256: chart.sha256, labels: chart.labels, annotation: chart.annotation || null } : null,
    publication: publication ? { status: publication.status, published: publication.published === true } : null,
  };
  await mkdir(directory, { recursive: true });
  const filename = `${safeId(candidate?.id)}-${Date.now()}.json`;
  const target = path.join(directory, filename);
  await writeFile(target, `${JSON.stringify(packageData, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return { id: filename.slice(0, -5), path: target, package: packageData };
}
