const BINANCE_ANNOUNCEMENTS_URL = 'https://www.binance.com/bapi/composite/v1/public/cms/article/list/query?type=1&pageNo=1&pageSize=100';

function asMilliseconds(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return number < 1_000_000_000_000 ? number * 1_000 : number;
}

function articlesFrom(payload) {
  const catalogs = payload?.data?.catalogs;
  if (!Array.isArray(catalogs)) return [];
  return catalogs.flatMap((catalog) => Array.isArray(catalog?.articles) ? catalog.articles : []);
}

export class OfficialContextResearch {
  constructor({ fetchImpl = globalThis.fetch, announcementsUrl = BINANCE_ANNOUNCEMENTS_URL } = {}) {
    this.fetchImpl = fetchImpl;
    this.announcementsUrl = announcementsUrl;
  }

  async research({ candidate = {}, occurredAt, historical = false, question = '' } = {}) {
    const response = await this.fetchImpl(this.announcementsUrl, { headers: { accept: 'application/json' } });
    if (!response?.ok) return { status: 'none_found', facts: [], sources: [], causalityStrength: 'none', publicUseRecommendation: 'do_not_invent_catalyst', question };
    const token = String(candidate.cashtag || candidate.token || candidate.symbol || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
    const cutoff = Number(occurredAt);
    const sources = articlesFrom(await response.json())
      .map((article) => ({ title: String(article.title || ''), publishedAt: asMilliseconds(article.releaseDate ?? article.publishDate ?? article.date), code: article.code || article.id || '' }))
      .filter((article) => article.title.toLowerCase().includes(token))
      .filter((article) => !historical || (Number.isFinite(article.publishedAt) && article.publishedAt <= cutoff))
      .slice(0, 3)
      .map((article) => ({ source: 'Binance official announcement', title: article.title, publishedAt: article.publishedAt, url: article.code ? `https://www.binance.com/en/support/announcement/${article.code}` : this.announcementsUrl }));
    if (!sources.length) return { status: 'none_found', facts: [], sources: [], causalityStrength: 'none', publicUseRecommendation: 'do_not_invent_catalyst', question };
    return {
      status: 'possible_context',
      facts: sources.map((source) => `${source.title} was published before the event timestamp.`),
      sources,
      causalityStrength: 'not_inferred',
      publicUseRecommendation: 'may say the move followed an official announcement; do not claim it caused the move',
      question,
    };
  }
}
