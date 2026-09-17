const TRACKING_PARAMETER = /^(?:utm_|ref$|source$|campaign$|fbclid$|gclid$)/i;

function canonicalUrl(value) {
  try {
    const url = new URL(value);
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING_PARAMETER.test(key)) url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return null;
  }
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function asTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function identityTerms(identity = {}) {
  return [identity.projectName, identity.baseAsset, identity.symbol]
    .map((value) => text(value).toLocaleLowerCase())
    .filter((value) => value.length >= 2);
}

function matchesIdentity(source, identity) {
  const haystack = `${text(source.title)} ${text(source.evidenceText)}`.toLocaleLowerCase();
  return identityTerms(identity).some((term) => haystack.includes(term));
}

function emptyResearch() {
  return { status: 'none_found', sources: [], claims: [], cleanCatalystFound: false };
}

/**
 * Collects optional editorial background. It intentionally does not infer that
 * a source caused a move: causality needs a separate corroboration policy.
 */
export class ResearchContextCollector {
  constructor({ providers = [], maxSources = 5, cacheTtlMs = 15 * 60_000, now = () => Date.now() } = {}) {
    this.providers = providers;
    this.maxSources = maxSources;
    this.cacheTtlMs = cacheTtlMs;
    this.now = now;
    this.cache = new Map();
  }

  async collect({ identity, occurredAt }) {
    if (!this.providers.length) return emptyResearch();
    const cacheKey = `${identity?.symbol || ''}:${Number(occurredAt) || 0}`;
    const cached = this.cache.get(cacheKey);
    if (cached && this.now() - cached.savedAt < this.cacheTtlMs) return cached.value;

    const results = await Promise.allSettled(this.providers.map(async (provider) => {
      const records = await provider.search({ identity, occurredAt });
      return { provider: provider.name ?? 'unknown', records: Array.isArray(records) ? records : [] };
    }));

    const seen = new Set();
    const sources = [];
    for (const result of results) {
      if (result.status !== 'fulfilled') continue;
      for (const record of result.value.records) {
        const url = canonicalUrl(record?.url);
        const title = text(record?.title);
        const publishedAt = asTimestamp(record?.publishedAt);
        if (!url || !title || !publishedAt || !matchesIdentity(record, identity)) continue;
        if (seen.has(url)) continue;
        seen.add(url);
        sources.push(Object.freeze({
          id: `research:${sources.length + 1}`,
          provider: result.value.provider,
          url,
          title,
          publishedAt,
          evidenceText: text(record.evidenceText),
        }));
        if (sources.length >= this.maxSources) break;
      }
      if (sources.length >= this.maxSources) break;
    }

    if (!sources.length) {
      const value = emptyResearch();
      this.cache.set(cacheKey, { savedAt: this.now(), value });
      return value;
    }
    const claims = sources.map((source) => Object.freeze({
      id: `research-claim:${source.id}`,
      sourceId: source.id,
      text: source.evidenceText || source.title,
      relationToMove: source.publishedAt > occurredAt ? 'background' : 'preceding_context',
      causalLanguageAllowed: false,
    }));
    const value = Object.freeze({
      status: 'context_found',
      sources: Object.freeze(sources),
      claims: Object.freeze(claims),
      cleanCatalystFound: false,
    });
    this.cache.set(cacheKey, { savedAt: this.now(), value });
    return value;
  }
}
