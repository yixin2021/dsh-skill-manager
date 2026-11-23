/**
 * DSH Skills — the index sources the market reads.
 *
 * The market ships with one built-in index (this repository's
 * `docs/market-index.json`). People can add their own: another GitHub
 * repository that keeps a JSON list of skills, or a plain JSON file reachable
 * over http(s).
 *
 * A source is stored in one of two shapes:
 *
 *   { repo: 'owner/repo', path: 'docs/market-index.json' }  // read over the GitHub API
 *   { repo: 'owner/repo', path: '' }                        // every SKILL.md in the repository
 *   { url: 'https://example.com/index.json' }               // read directly
 *
 * The repository shape exists because raw.githubusercontent.com is reset on
 * some networks while the GitHub API is reachable, so a GitHub-hosted index is
 * fetched through `/contents` and never through the raw host. Only GitHub
 * repositories use that shape: the tree reader that expands an index knows
 * `api.github.com` alone, so a link to another code host is accepted only as a
 * direct link to the JSON file itself.
 *
 * Everything here is validation only — no network, no file system — so the
 * rules can be tested directly and the Host keeps a single place to refuse a
 * source it will not read.
 *
 * @module dsh-skill-manager/market-sources
 */

/** The most index sources a person may keep, so the market cannot crawl forever. */
export const MAX_MARKET_SOURCES = 20

/** The longest source string accepted. */
const MAX_SOURCE_TEXT = 500

/** The raw host that serves the same bytes as `github.com/.../blob/...`. */
const GITHUB_RAW_HOST = 'raw.githubusercontent.com'

/** A path segment that can be an owner or a repository name. */
const REPO_SEGMENT = /^[\w.-]+$/

/** The hosts whose `blob` page can be rewritten into a raw link. */
const BLOB_HOSTS = new Set(['gitlab.com', 'gitee.com', 'gitcode.com', 'atomgit.com'])

/**
 * Whether a hostname points at the machine itself or a private network.
 *
 * The Host makes the request, so a source naming `169.254.169.254` or
 * `127.0.0.1` would turn "add an index" into a request against the local
 * network. Those names are refused; a public host is the person's own choice.
 *
 * @param hostname - the lower-case host.
 * @returns whether the host is local or private.
 */
function isPrivateHost(hostname) {
  if (hostname === 'localhost' || hostname === '0.0.0.0' || hostname === '[::1]') return true
  if (hostname.endsWith('.local') || hostname.endsWith('.internal') || hostname.endsWith('.localhost')) return true
  if (/^127\./.test(hostname) || /^10\./.test(hostname) || /^192\.168\./.test(hostname)) return true
  if (/^169\.254\./.test(hostname)) return true
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) return true
  return false
}

/**
 * Split `owner/repo` out of URL path segments.
 * @param segments - the decoded path segments.
 * @returns the `owner/repo` string, or undefined when it is not one.
 */
function repoFrom(segments) {
  if (segments.length < 2) return undefined
  const owner = segments[0]
  const repo = segments[1].replace(/\.git$/, '')
  if (!REPO_SEGMENT.test(owner) || !REPO_SEGMENT.test(repo)) return undefined
  return `${owner}/${repo}`
}

/**
 * Rewrite a "blob" page link on a GitLab/Gitee-style host into its raw link.
 *
 * Those hosts serve the file bytes at `/raw/` where the human page is `/blob/`,
 * and a person pasting a browser URL pastes the page. GitLab keeps the project
 * at `owner/repo` and marks the page with a `/-/` infix; Gitee has no infix.
 *
 * @param url - the parsed URL.
 * @param flavored - whether the host uses the `/-/` infix.
 * @returns the raw URL, or undefined when the link is not a blob page.
 */
function blobToRaw(url, flavored) {
  const segments = url.pathname.split('/').filter((part) => part.length > 0)
  const at = segments.indexOf('blob')
  if (at < 2) return undefined
  const head = segments.slice(0, flavored ? at - 1 : at)
  if (head.length < 2) return undefined
  const rest = segments.slice(at + 1)
  if (rest.length < 2) return undefined
  // The raw route keeps the ref and the path and gains `raw` where the page
  // had `blob`: GitLab reads `/-/raw/<ref>/<path>`, Gitee `/raw/<ref>/<path>`.
  const infix = flavored ? '/-/' : '/'
  return `${url.protocol}//${url.host}/${head.join('/')}${infix}raw/${rest.join('/')}`
}

/**
 * Turn one typed value into a source the Host can read.
 *
 * The `reason` is a stable code the page maps to its own language; `error` is
 * the English sentence the Host would show on its own (tests and the CLI read
 * it, and it is the fallback when the page has not learned the code yet).
 *
 * @param value - what the person typed, or what was stored.
 * @returns `{ source }` on success, `{ error, reason }` with a sentence to show otherwise.
 */
export function parseMarketSource(value) {
  if (typeof value !== 'string') return { error: 'An index source must be a link.', reason: 'not-string' }
  const text = value.trim()
  if (text.length === 0) return { error: 'An index source cannot be empty.', reason: 'empty' }
  if (text.length > MAX_SOURCE_TEXT) return { error: 'That link is too long to be an index source.', reason: 'too-long' }
  if (text.includes('\0')) return { error: 'That link contains a character that is not allowed.', reason: 'nul' }

  let url
  try {
    url = new URL(text)
  } catch {
    return { error: 'That is not a full link. Paste one that starts with https://', reason: 'not-a-link' }
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { error: 'An index source must be an http:// or https:// link.', reason: 'scheme' }
  }
  if (url.username.length > 0 || url.password.length > 0) {
    return { error: 'An index source cannot carry a username or password.', reason: 'credentials' }
  }
  const hostname = url.hostname.toLowerCase()
  const segments = url.pathname.split('/').filter((part) => part.length > 0)

  // A GitHub link becomes a repository read, which works on networks that
  // reset raw.githubusercontent.com.
  if (hostname === 'github.com') {
    const repo = repoFrom(segments)
    if (repo === undefined) return { error: 'That GitHub link does not name a repository.', reason: 'github-repo' }
    const rest = segments.slice(2)
    if (rest.length === 0) return { source: { repo, path: '' } }
    const kind = rest[0]
    // `tree`/`blob`/`raw` are followed by the ref, then the path. A link with
    // no path names the whole repository; anything else must be the JSON index
    // itself, because a directory listing is not a catalogue.
    if (kind === 'tree' || kind === 'blob' || kind === 'raw') {
      const path = rest.slice(2).join('/')
      if (path.length === 0) return { source: { repo, path: '' } }
      if (!/\.json$/i.test(path)) return { error: 'An index link must point at a .json file.', reason: 'json-file' }
      return { source: { repo, path } }
    }
    return { error: 'Link a repository, or a JSON file inside it.', reason: 'github-kind' }
  }

  // A raw link is the same read with the ref dropped.
  if (hostname === GITHUB_RAW_HOST) {
    const repo = repoFrom(segments)
    if (repo === undefined) return { error: 'That GitHub link does not name a repository.', reason: 'github-repo' }
    const path = segments.slice(3).join('/')
    if (!/\.json$/i.test(path)) return { error: 'An index link must point at a .json file.', reason: 'json-file' }
    return { source: { repo, path } }
  }

  if (isPrivateHost(hostname)) {
    return { error: 'That host is on this machine or a private network, so the market will not read it.', reason: 'private-host' }
  }

  // Another code host serves the JSON at its raw route. Only a link to the file
  // is usable, because the tree reader that expands an index knows the GitHub
  // API alone — a repository page elsewhere could not be expanded at all.
  if (BLOB_HOSTS.has(hostname)) {
    const raw = blobToRaw(url, hostname === 'gitlab.com')
    if (raw !== undefined) {
      if (!/\.json$/i.test(new URL(raw).pathname)) {
        return { error: 'An index link must point at a .json file.', reason: 'json-file' }
      }
      return { source: { url: raw } }
    }
    return { error: 'Link the JSON file itself on that host, not the repository page.', reason: 'blob-file' }
  }

  if (!/\.json$/i.test(url.pathname)) {
    return { error: 'An index link must point at a .json file.', reason: 'json-file' }
  }
  return { source: { url: url.toString() } }
}

/**
 * The stable key a source is cached and compared by.
 * @param source - a stored source.
 * @returns the key.
 */
export function marketSourceKey(source) {
  if (typeof source === 'string') return source
  if (typeof source?.url === 'string') return source.url
  const repo = typeof source?.repo === 'string' ? source.repo : ''
  const path = typeof source?.path === 'string' ? source.path : ''
  return path.length === 0 ? repo : `${repo}/${path}`
}

/**
 * The text a person sees for a source.
 * @param source - a stored source.
 * @returns the label.
 */
export function marketSourceLabel(source) {
  if (typeof source === 'string') return source
  if (typeof source?.url === 'string') return source.url
  const repo = typeof source?.repo === 'string' ? source.repo : ''
  const path = typeof source?.path === 'string' ? source.path : ''
  return path.length === 0 ? repo : `${repo}/${path}`
}

/**
 * The page a person opens to see a source for themselves.
 * @param source - a stored source.
 * @returns the link.
 */
export function marketSourcePage(source) {
  if (typeof source !== 'object' || source === null) return undefined
  if (typeof source.url === 'string') return source.url
  const repo = typeof source?.repo === 'string' ? source.repo : ''
  if (repo.length === 0) return undefined
  const path = typeof source?.path === 'string' ? source.path : ''
  return path.length === 0 ? `https://github.com/${repo}` : `https://github.com/${repo}/blob/HEAD/${path}`
}

/**
 * Turn a stored row back into the link a person would have typed.
 *
 * The file keeps objects rather than links so a source stays readable, but
 * re-parsing it as a link is what keeps one validator in charge of what the
 * Host will read.
 *
 * @param item - a stored row.
 * @returns the link text, or a value the parser will refuse.
 */
function sourceText(item) {
  if (typeof item === 'string') return item
  if (typeof item !== 'object' || item === null) return ''
  if (typeof item.url === 'string') return item.url
  if (typeof item.repo !== 'string') return ''
  const repo = item.repo.trim().replace(/^\/+|\/+$/g, '')
  if (repo.length === 0) return ''
  const path = typeof item.path === 'string' ? item.path.trim().replace(/^\/+/, '') : ''
  const base = `https://github.com/${repo}`
  return path.length === 0 ? base : `${base}/blob/HEAD/${path}`
}

/**
 * Clean a stored or submitted list of sources.
 *
 * A malformed row is dropped rather than failing the whole list: one bad link
 * should not hide every good one, and a damaged file must still open the page.
 *
 * @param value - the raw list.
 * @returns the sources, de-duplicated, in the order given, capped in count.
 */
export function normalizeMarketSources(value) {
  if (!Array.isArray(value)) return []
  const sources = []
  const seen = new Set()
  for (const item of value) {
    const parsed = parseMarketSource(sourceText(item))
    if (parsed.error !== undefined) continue
    const key = marketSourceKey(parsed.source)
    if (seen.has(key)) continue
    seen.add(key)
    sources.push(parsed.source)
    if (sources.length >= MAX_MARKET_SOURCES) break
  }
  return sources
}
