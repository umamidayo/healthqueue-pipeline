// Small GitHub REST client: pagination, retry on secondary rate limits, and a
// hard request budget so a scheduled job can never exhaust the repository's
// GITHUB_TOKEN quota (1,000 requests/hour) and starve other workflows.
export class RequestBudgetExceeded extends Error {}

export function createGitHubClient({
  token,
  baseUrl = 'https://api.github.com',
  fetchImpl = globalThis.fetch,
  maxRequests = 800,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  let used = 0;

  async function request(pathOrUrl, { accept = 'application/vnd.github+json' } = {}) {
    const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${baseUrl}${pathOrUrl}`;
    for (let attempt = 0; ; attempt += 1) {
      if (used >= maxRequests) throw new RequestBudgetExceeded(`request budget of ${maxRequests} exhausted`);
      used += 1;
      const res = await fetchImpl(url, {
        headers: {
          accept,
          'x-github-api-version': '2022-11-28',
          'user-agent': 'healthqueue-dora-collector',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      });
      if (res.status === 404) return { status: 404, data: null, headers: res.headers };
      const limited = res.status === 429 || (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0');
      if ((limited || res.status >= 500) && attempt < 3) {
        const retryAfter = Number(res.headers.get('retry-after'));
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2 ** attempt * 1000);
        continue;
      }
      if (!res.ok) throw new Error(`GitHub API ${res.status} for ${url}: ${(await res.text()).slice(0, 200)}`);
      return { status: res.status, data: await res.json(), headers: res.headers };
    }
  }

  function nextLink(headers) {
    const link = headers.get('link');
    const m = link && /<([^>]+)>;\s*rel="next"/.exec(link);
    return m ? m[1] : null;
  }

  /**
   * Yields items page by page. `pick` extracts the array from wrapped
   * responses (e.g. { workflow_runs: [...] }). Stop early by breaking out.
   */
  async function* paginate(path, { pick = (d) => d, maxPages = 20 } = {}) {
    let url = path;
    for (let page = 0; url && page < maxPages; page += 1) {
      const { data, headers } = await request(url);
      if (!data) return;
      for (const item of pick(data)) yield item;
      url = nextLink(headers);
    }
  }

  return { request, paginate, used: () => used, maxRequests };
}
