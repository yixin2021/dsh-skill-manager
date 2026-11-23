/**
 * DSH Skills — the skill market catalogue.
 *
 * The panel can browse a small, curated list of skills and install one with a
 * click. The list is a plain JSON document shipped inside this package
 * (`docs/skills.json`), so browsing needs no network and no backend: the Host
 * reads the file, validates every entry, and hands the page a clean list.
 *
 * Installing is not this module's job — a chosen entry becomes an ordinary
 * `install-from-remote` request and travels the same code path as a link a
 * person typed. That keeps one installer, one set of size limits, and one
 * refusal vocabulary.
 *
 * Everything a catalogue entry contributes is untrusted input: it comes from a
 * file a contributor can edit, and its `source` becomes a request the Host
 * makes on the person's behalf. This module therefore refuses any entry whose
 * source is not one of the hosts the remote-install path already supports, so
 * the market can never widen where the panel will fetch from.
 *
 * @module dsh-skill-manager/market
 */

import { MAX_ARCHIVE_BYTES, downloadArchive, readArchive, stripArchiveRoot } from './github-source.js'

/** The hosts the remote installer reads. Kept in step with remote-source.js. */
const MARKET_HOSTS = new Set([
  'github.com',
  'gitlab.com',
  'gitee.com',
  'gitcode.com',
  'atomgit.com',
])

/** The largest catalogue this module will read, so a bad file cannot freeze the page. */
const MAX_ENTRIES = 200

/** The longest text a single field may carry. */
const MAX_TEXT = 600

/**
 * Turn a source URL into the host it points at.
 *
 * @param value - the raw source string.
 * @returns the lower-case host, or undefined when the string is not an http(s) URL.
 */
function hostOf(value) {
  if (typeof value !== 'string') return undefined
  try {
    const url = new URL(value.trim())
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined
    return url.hostname.toLowerCase()
  } catch {
    return undefined
  }
}

/**
 * Read one list of strings that a person should see verbatim.
 *
 * @param value - the raw field.
 * @returns the strings, capped in count and length.
 */
function stringList(value) {
  if (!Array.isArray(value)) return []
  return value
    .filter((item) => typeof item === 'string' && item.trim().length > 0)
    .slice(0, 20)
    .map((item) => item.trim().slice(0, MAX_TEXT))
}

/**
 * Validate and normalize one catalogue entry.
 *
 * A malformed entry is dropped rather than failing the whole catalogue: one bad
 * row should not hide every good one.
 *
 * @param raw - the entry as written.
 * @param index - its position, used to build a stable key.
 * @returns the cleaned entry, or undefined when it cannot be used.
 */
function normalizeEntry(raw, index) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  if (name.length === 0 || name.length > 120) return undefined
  const host = hostOf(raw.source)
  if (host === undefined || !MARKET_HOSTS.has(host)) return undefined
  const description = typeof raw.description === 'string' ? raw.description.trim().slice(0, MAX_TEXT) : ''
  const tags = stringList(raw.tags)
  const key = typeof raw.id === 'string' && raw.id.trim().length > 0 ? raw.id.trim() : `${name.toLowerCase().replace(/\s+/g, '-')}-${index}`
  // `view` is the page a person opens from a card. It is display-only: the
  // install still goes to `source`, so an entry may point its card at the
  // skill's own folder while the installer reads the repository root. Only
  // http(s) pages are accepted, so a catalogue cannot inject `javascript:`.
  const viewHost = hostOf(raw.view)
  const view = viewHost === undefined ? '' : String(raw.view).trim().slice(0, 300)
  return {
    id: key,
    name,
    description,
    source: String(raw.source).trim(),
    author: typeof raw.author === 'string' ? raw.author.trim().slice(0, 120) : '',
    tags,
    /* A directory inside the repository, when the source is a whole repo. */
    path: typeof raw.path === 'string' && raw.path.trim().length > 0 ? raw.path.trim().slice(0, 300) : '',
    /* The page the card's "view source" link opens; empty means fall back to `source`. */
    view,
  }
}

/**
 * Read a catalogue document and return its usable entries.
 *
 * @param text - the JSON text of `docs/skills.json`.
 * @returns the entry list plus any entries that were skipped, for diagnostics.
 */
export function parseCatalogue(text) {
  let decoded
  try {
    decoded = JSON.parse(text)
  } catch {
    return { entries: [], skipped: 0, error: 'The marketplace catalogue is not valid JSON.' }
  }
  const list = Array.isArray(decoded) ? decoded : Array.isArray(decoded?.skills) ? decoded.skills : undefined
  if (list === undefined) {
    return { entries: [], skipped: 0, error: 'The marketplace catalogue has no "skills" list.' }
  }
  const entries = []
  let skipped = 0
  for (let index = 0; index < list.length && entries.length < MAX_ENTRIES; index += 1) {
    const entry = normalizeEntry(list[index], index)
    if (entry === undefined) skipped += 1
    else entries.push(entry)
  }
  return { entries, skipped }
}

/** The hosts this module will accept a catalogue source from. */
export const MARKET_SOURCE_HOSTS = [...MARKET_HOSTS]

/** The GitHub API root the tree reader calls. */
const GITHUB_API = 'https://api.github.com'
/** The raw host used to fetch a single file's bytes. */
const GITHUB_RAW = 'https://raw.githubusercontent.com'
/** The most SKILL.md files one repository may contribute, so one huge repo cannot flood the list. */
const MAX_REPO_SKILLS = 200

/**
 * Split a source string of the form `https://github.com/<owner>/<repo>` (or
 * `.git`, or a tree link) into owner and repo.
 *
 * @param value - the source string.
 * @returns `{ owner, repo }` or undefined.
 */
export function parseGitHubRepo(value) {
  const host = hostOf(value)
  if (host !== 'github.com') return undefined
  try {
    const url = new URL(value.trim())
    const parts = url.pathname.split('/').filter(Boolean)
    if (parts.length < 2) return undefined
    const owner = parts[0]
    const repo = parts[1].replace(/\.git$/, '')
    if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) return undefined
    return { owner, repo }
  } catch {
    return undefined
  }
}

/**
 * Turn a `SKILL.md` path into a skill candidate: its directory, a display name
 * taken from the directory, and the tags implied by the folder it sits under.
 *
 * @param path - repository-relative path ending in `/SKILL.md`.
 * @returns the candidate, or undefined when the folder name is unusable.
 */
function candidateFromSkillPath(path) {
  const dir = path.slice(0, -'SKILL.md'.length).replace(/\/+$/, '')
  if (dir.length === 0) return undefined
  const segments = dir.split('/').filter(Boolean)
  if (segments.some((segment) => segment === '..' || segment === '.')) return undefined
  const leaf = segments[segments.length - 1]
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(leaf)) return undefined
  return { dir, name: leaf }
}

/**
 * Read a published index that points at GitHub repositories and expand each
 * repository into the skills it holds.
 *
 * Two shapes are accepted, because both are cheap to publish:
 *
 *   - the same object shape as `docs/skills.json`, where an entry may name a
 *     whole repository (expanded into its skills) or one skill directory;
 *   - a bare array of `https://github.com/<owner>/<repo>` strings.
 *
 * Expansion is one tree request per repository. A repository that fails is
 * skipped with a warning rather than failing the whole source, so one dead
 * link does not empty the market.
 *
 * @param raw - the parsed JSON of the index.
 * @param options - `fetchImpl` (defaults to global fetch), `token`, `seen` (a
 *   set of already-listed source keys, to de-duplicate across sources).
 * @returns `{ entries, warnings }`.
 */
export async function expandIndex(raw, options = {}) {
  const fetchImpl = options.fetchImpl ?? (typeof fetch === 'function' ? fetch : undefined)
  const seen = options.seen ?? new Set()
  const warnings = []
  const entries = []
  if (fetchImpl === undefined) return { entries, warnings: ['No fetch available to read the index.'] }

  // Normalize both shapes into a list of { repo, path?, name?, description?, author?, tags? }.
  const wanted = []
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.repositories) ? raw.repositories : Array.isArray(raw?.skills) ? raw.skills : []
  for (const item of list) {
    const source = typeof item === 'string' ? item : typeof item?.source === 'string' ? item.source : ''
    const repo = parseGitHubRepo(source)
    if (repo === undefined) {
      warnings.push(`Skipped an index entry that is not a github.com repository: ${String(source).slice(0, 80)}`)
      continue
    }
    wanted.push({
      repo,
      source: `https://github.com/${repo.owner}/${repo.repo}`,
      path: typeof item?.path === 'string' ? item.path.trim() : '',
      name: typeof item?.name === 'string' ? item.name.trim() : '',
      description: typeof item?.description === 'string' ? item.description.trim() : '',
      author: typeof item?.author === 'string' ? item.author.trim() : '',
      tags: stringList(item?.tags),
    })
  }

  for (const want of wanted) {
    const key = `${want.repo.owner}/${want.repo.repo}`
    let tree
    try {
      tree = await fetchRepoTrees(fetchImpl, want.repo, options.token)
    } catch (error) {
      warnings.push(`Could not read ${key}: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    const skillPaths = tree.filter((path) => path === 'SKILL.md' || path.endsWith('/SKILL.md'))
    if (skillPaths.length === 0) {
      warnings.push(`${key} has no SKILL.md files.`)
      continue
    }
    const candidates = []
    for (const skillPath of skillPaths) {
      const candidate = candidateFromSkillPath(skillPath)
      if (candidate === undefined) continue
      if (want.path.length > 0 && candidate.dir !== want.path && !candidate.dir.startsWith(`${want.path}/`)) continue
      candidates.push(candidate)
      if (candidates.length >= MAX_REPO_SKILLS) break
    }
    if (candidates.length === 0) {
      warnings.push(want.path.length > 0 ? `${key} has no skill at "${want.path}".` : `${key} yielded no usable skills.`)
      continue
    }
    // One entry per skill: the source stays the repo, the path pins the skill.
    for (const candidate of candidates) {
      const id = `${want.repo.owner}-${want.repo.repo}-${candidate.dir}`.toLowerCase().replace(/[^a-z0-9._-]+/g, '-')
      const sourceKey = `${key}#${candidate.dir}`
      if (seen.has(sourceKey)) continue
      seen.add(sourceKey)
      entries.push({
        id,
        name: want.name && candidates.length === 1 ? want.name : candidate.name,
        description: want.description,
        source: want.source,
        author: want.author || want.repo.owner,
        tags: want.tags,
        path: candidate.dir,
        // Where a person opens to read the skill itself: the folder inside the
        // repository, not the repository root the install reads from.
        view: `https://github.com/${want.repo.owner}/${want.repo.repo}/tree/HEAD/${candidate.dir}`,
      })
    }
  }
  return { entries, warnings }
}

/**
 * Read the blob paths of a GitHub repository's default branch.
 *
 * @param fetchImpl - the fetch to use.
 * @param repo - `{ owner, repo }`.
 * @param token - optional token for a higher rate limit.
 * @returns the repository-relative paths of every blob.
 */
async function fetchRepoTrees(fetchImpl, repo, token) {
  const url = `${GITHUB_API}/repos/${repo.owner}/${repo.repo}/git/trees/HEAD?recursive=1`
  const headers = { accept: 'application/vnd.github+json', 'user-agent': 'dsh-skill-manager' }
  if (typeof token === 'string' && token.length > 0) headers.authorization = `Bearer ${token}`
  const response = await fetchImpl(url, { headers })
  if (!response.ok) {
    // The anonymous tree API allows sixty requests per hour per IP, and one
    // market read costs one per repository. A 403/429 therefore means "try the
    // route that has no API limit": the public archive on codeload, which the
    // installer already knows how to unpack. A private repository has no
    // archive without a token, so that attempt simply fails with a warning.
    if (response.status === 403 || response.status === 429) return fetchRepoTreesFromArchive(fetchImpl, repo)
    throw new Error(`HTTP ${response.status}`)
  }
  const body = await response.json()
  if (!Array.isArray(body?.tree)) throw new Error('the repository tree is missing')
  if (body.truncated === true) {
    // A truncated tree still lists what GitHub got to; that is fine, the
    // candidate cap bounds what we keep.
  }
  return body.tree.filter((item) => item?.type === 'blob').map((item) => String(item.path))
}

/**
 * List a repository's paths from its public archive, for a rate-limited API.
 *
 * `codeload.github.com` serves the whole tree in one request and is not bound
 * by the REST API's hourly budget. The archive is bounded by the same size
 * limit the installer uses: a repository too large to download is skipped with
 * a warning rather than silently consuming memory.
 *
 * @param fetchImpl - the fetch to use.
 * @param repo - `{ owner, repo }`.
 * @returns the repository-relative blob paths.
 */
async function fetchRepoTreesFromArchive(fetchImpl, repo) {
  const bytes = await downloadArchive(
    { owner: repo.owner, repo: repo.repo, ref: 'HEAD' },
    { fetchImpl, maxBytes: MAX_ARCHIVE_BYTES },
  )
  const files = stripArchiveRoot(readArchive(bytes))
  return [...files.keys()]
}

/** Rewrite a repo+path into the raw file link a person can open. */
export function rawSkillLink(repo, dir) {
  return `${GITHUB_RAW}/${repo.owner}/${repo.repo}/HEAD/${dir}/SKILL.md`
}
