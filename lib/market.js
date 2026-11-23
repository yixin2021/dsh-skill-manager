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
  return {
    id: key,
    name,
    description,
    source: String(raw.source).trim(),
    author: typeof raw.author === 'string' ? raw.author.trim().slice(0, 120) : '',
    tags,
    /* A directory inside the repository, when the source is a whole repo. */
    path: typeof raw.path === 'string' && raw.path.trim().length > 0 ? raw.path.trim().slice(0, 300) : '',
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
