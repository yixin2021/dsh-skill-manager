/**
 * Index-source validation: what the Host will read, and what it refuses.
 *
 * Every source a person types passes through this module before the Host keeps
 * it. The rules are pure, so the tests assert them directly: a GitHub
 * repository (all its SKILL.md files), a JSON index inside one, a raw link, a
 * blob page on another host, and a plain JSON URL. Refusals carry a stable
 * `reason` so the page can say why in its own language.
 *
 * @module dsh-skill-manager/test/market-sources
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  MAX_MARKET_SOURCES,
  marketSourceKey,
  marketSourceLabel,
  marketSourcePage,
  normalizeMarketSources,
  parseMarketSource,
} from '../lib/market-sources.js'

test('a GitHub repository link reads every SKILL.md in it', () => {
  const parsed = parseMarketSource('https://github.com/owner/repo')
  assert.deepEqual(parsed, { source: { repo: 'owner/repo', path: '' } })
  const trailing = parseMarketSource('https://github.com/owner/repo/')
  assert.deepEqual(trailing, { source: { repo: 'owner/repo', path: '' } })
  const dotGit = parseMarketSource('https://github.com/owner/repo.git')
  assert.deepEqual(dotGit, { source: { repo: 'owner/repo', path: '' } })
})

test('a GitHub blob or tree link becomes a file inside the repository', () => {
  for (const kind of ['blob', 'tree', 'raw']) {
    const parsed = parseMarketSource(`https://github.com/owner/repo/${kind}/main/docs/market-index.json`)
    assert.deepEqual(parsed, { source: { repo: 'owner/repo', path: 'docs/market-index.json' } }, kind)
  }
  assert.equal(parseMarketSource('https://github.com/owner/repo/blob/main/index.json').source.path, 'index.json')
  assert.equal(parseMarketSource('https://github.com/owner/repo/tree/main').source.path, '', 'a ref alone is the whole repository')
  assert.equal(parseMarketSource('https://github.com/owner/repo/tree/main/skills').reason, 'json-file', 'a directory is not a catalogue')
})

test('a raw.githubusercontent link drops the ref and keeps the path', () => {
  const parsed = parseMarketSource('https://raw.githubusercontent.com/owner/repo/HEAD/docs/index.json')
  assert.deepEqual(parsed, { source: { repo: 'owner/repo', path: 'docs/index.json' } })
  assert.equal(parseMarketSource('https://raw.githubusercontent.com/owner/repo/HEAD/docs/SKILL.md').reason, 'json-file')
})

test('GitLab and Gitee blob pages become their raw routes', () => {
  const gitlab = parseMarketSource('https://gitlab.com/owner/repo/-/blob/main/docs/index.json')
  assert.deepEqual(gitlab, { source: { url: 'https://gitlab.com/owner/repo/-/raw/main/docs/index.json' } })
  const gitee = parseMarketSource('https://gitee.com/owner/repo/blob/main/docs/index.json')
  assert.deepEqual(gitee, { source: { url: 'https://gitee.com/owner/repo/raw/main/docs/index.json' } })
  // A project inside a GitLab subgroup keeps the whole namespace.
  const subgroup = parseMarketSource('https://gitlab.com/group/sub/project/-/blob/main/index.json')
  assert.deepEqual(subgroup, { source: { url: 'https://gitlab.com/group/sub/project/-/raw/main/index.json' } })
  assert.equal(parseMarketSource('https://gitee.com/owner/repo/blob/main/README.md').reason, 'json-file')
})

test('a plain JSON link is read directly', () => {
  const parsed = parseMarketSource('https://skills.example.com/index.json?ref=main')
  assert.deepEqual(parsed, { source: { url: 'https://skills.example.com/index.json?ref=main' } })
})

test('loopback and private hosts are refused before they become a request', () => {
  for (const link of [
    'http://127.0.0.1/index.json',
    'http://localhost/index.json',
    'http://169.254.169.254/index.json',
    'http://192.168.1.10/index.json',
    'http://10.0.0.5/index.json',
    'http://172.20.0.1/index.json',
    'http://box.internal/index.json',
  ]) {
    const parsed = parseMarketSource(link)
    assert.equal(parsed.error !== undefined, true, link)
    assert.equal(parsed.reason, 'private-host', link)
  }
})

test('schemes, credentials and non-JSON links are refused with a reason', () => {
  assert.equal(parseMarketSource('javascript:alert(1)').reason, 'scheme')
  assert.equal(parseMarketSource('ftp://example.com/index.json').reason, 'scheme')
  assert.equal(parseMarketSource('https://user:pass@example.com/index.json').reason, 'credentials')
  assert.equal(parseMarketSource('https://example.com/skills').reason, 'json-file')
  assert.equal(parseMarketSource('not a link').reason, 'not-a-link')
  assert.equal(parseMarketSource('   ').reason, 'empty')
  assert.equal(parseMarketSource(42).reason, 'not-string')
  assert.equal(parseMarketSource('https://github.com/owner').reason, 'github-repo')
  assert.equal(parseMarketSource('https://github.com/owner/repo/issues').reason, 'github-kind')
  assert.equal(parseMarketSource('https://gitee.com/owner/repo').reason, 'blob-file')
})

test('a malformed stored row is dropped without hiding the good ones', () => {
  const sources = normalizeMarketSources([
    { repo: 'owner/repo', path: '' },
    { repo: 'owner/repo', path: '' },
    { url: 'http://127.0.0.1/index.json' },
    { repo: 'owner/repo', path: 'docs/index.json' },
    'https://gitee.com/owner/other/blob/main/index.json',
    { nonsense: true },
    null,
  ])
  assert.deepEqual(sources, [
    { repo: 'owner/repo', path: '' },
    { repo: 'owner/repo', path: 'docs/index.json' },
    { url: 'https://gitee.com/owner/other/raw/main/index.json' },
  ])
})

test('the list is capped, so a hand-edited file cannot grow forever', () => {
  const rows = []
  for (let index = 0; index < MAX_MARKET_SOURCES + 5; index += 1) rows.push({ repo: `owner/repo${index}`, path: '' })
  const sources = normalizeMarketSources(rows)
  assert.equal(sources.length, MAX_MARKET_SOURCES)
  assert.equal(normalizeMarketSources('not a list').length, 0)
})

test('keys, labels and pages describe one source', () => {
  const repo = { repo: 'owner/repo', path: '' }
  assert.equal(marketSourceKey(repo), 'owner/repo')
  assert.equal(marketSourceLabel(repo), 'owner/repo')
  assert.equal(marketSourcePage(repo), 'https://github.com/owner/repo')

  const file = { repo: 'owner/repo', path: 'docs/market-index.json' }
  assert.equal(marketSourceKey(file), 'owner/repo/docs/market-index.json')
  assert.equal(marketSourceLabel(file), 'owner/repo/docs/market-index.json')
  assert.equal(marketSourcePage(file), 'https://github.com/owner/repo/blob/HEAD/docs/market-index.json')

  const direct = { url: 'https://skills.example.com/index.json' }
  assert.equal(marketSourceKey(direct), direct.url)
  assert.equal(marketSourceLabel(direct), direct.url)
  assert.equal(marketSourcePage(direct), direct.url)
})

test('every refusal carries both a sentence and a stable reason', () => {
  for (const value of [42, '', 'https://example.com/x', 'https://github.com/owner', 'javascript:x']) {
    const parsed = parseMarketSource(value)
    assert.equal(typeof parsed.error, 'string')
    assert.equal(typeof parsed.reason, 'string')
  }
})
