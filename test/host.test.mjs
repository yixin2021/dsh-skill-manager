/**
 * Host behaviour: the frontmatter grammar, root discovery and every mutation,
 * exercised against a real temporary directory tree.
 *
 * Run with `node --test test/`.
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { after, before, describe, test } from 'node:test'

import {
  composeSkillFile,
  describeSkill,
  isSkillName,
  listRoots,
  parseFrontmatter,
  readFlag,
  resolveWithin,
  scanRoot,
} from '../lib/skills-core.js'
import { dispatch, internals } from '../index.js'

/** A Host context whose only service is the workspace registry. */
function fakeContext(workspaces) {
  return {
    get(name) {
      if (name !== 'workspaceRegistry') return undefined
      return { list: () => workspaces.map((path) => ({ path, title: path.split('/').pop() })) }
    },
  }
}

const SKILL = `---
name: alpha
description: Does the alpha thing.
whenToUse: When alpha is needed.
---

# Alpha

Body text.
`

describe('frontmatter', () => {
  test('parses the keys DSH reads', () => {
    const parsed = parseFrontmatter(SKILL)
    assert.equal(parsed.present, true)
    assert.equal(parsed.data.name, 'alpha')
    assert.equal(parsed.data.description, 'Does the alpha thing.')
    assert.equal(parsed.data.whenToUse, 'When alpha is needed.')
    assert.match(parsed.body, /# Alpha/)
  })

  test('reports a file with no frontmatter', () => {
    const parsed = parseFrontmatter('# Just a heading\n')
    assert.equal(parsed.present, false)
    assert.equal(parsed.data.name, undefined)
  })

  test('handles quoted scalars, comments and block scalars', () => {
    const parsed = parseFrontmatter(
      ['---', 'name: "quoted-name"', "description: 'has: colon'", 'whenToUse: plain # note', 'note: |', '  line one', '  line two', '---', ''].join('\n'),
    )
    assert.equal(parsed.data.name, 'quoted-name')
    assert.equal(parsed.data.description, 'has: colon')
    assert.equal(parsed.data.whenToUse, 'plain')
    assert.equal(parsed.data.note, 'line one\nline two')
  })

  test('reads DSH boolean spellings and rejects the rest', () => {
    assert.equal(readFlag('TRUE'), true)
    assert.equal(readFlag('no'), false)
    assert.equal(readFlag(undefined), undefined)
    assert.equal(readFlag('sometimes'), 'invalid')
  })

  test('describeSkill reports the invocation policy and discovery issues', () => {
    const skill = describeSkill({ text: SKILL, entryName: 'alpha', entryKind: 'directory' })
    assert.equal(skill.name, 'alpha')
    assert.equal(skill.modelInvocable, true)
    assert.equal(skill.userInvocable, true)
    assert.deepEqual(skill.issues, [])

    const bare = describeSkill({ text: 'no frontmatter', entryName: 'bare', entryKind: 'file' })
    assert.deepEqual(bare.issues, ['missing-frontmatter', 'missing-name', 'missing-description'])

    const hidden = describeSkill({
      text: '---\nname: x\ndescription: y\ndisable-model-invocation: true\nuser-invocable: false\n---\n',
      entryName: 'x',
      entryKind: 'directory',
    })
    assert.equal(hidden.modelInvocable, false)
    assert.equal(hidden.userInvocable, false)
  })

  test('composeSkillFile round-trips through the parser', () => {
    const text = composeSkillFile({ name: 'made', description: 'Made: by a test # ok', body: '# Made\n' })
    const parsed = parseFrontmatter(text)
    assert.equal(parsed.data.name, 'made')
    assert.equal(parsed.data.description, 'Made: by a test # ok')
  })
})

describe('paths and names', () => {
  test('resolveWithin refuses escapes', () => {
    const base = '/tmp/root'
    assert.equal(resolveWithin(base, 'a/SKILL.md'), '/tmp/root/a/SKILL.md')
    assert.equal(resolveWithin(base, '../escape'), undefined)
    assert.equal(resolveWithin(base, '/etc/passwd'), undefined)
    assert.equal(resolveWithin(base, 'a\\b'), undefined)
    assert.equal(resolveWithin(base, ''), undefined)
    assert.equal(resolveWithin(base, 'a/../../b'), undefined)
  })

  test('isSkillName accepts DSH names and rejects the rest', () => {
    assert.equal(isSkillName('my-skill'), true)
    assert.equal(isSkillName('a.b_c-1'), true)
    for (const bad of ['.hidden', 'has space', '../x', '', '-lead']) assert.equal(isSkillName(bad), false)
  })
})

describe('roots and scanning', () => {
  let base
  let project

  before(async () => {
    base = await mkdtemp(join(tmpdir(), 'dsh-skill-manager-'))
    project = join(base, 'project')
    await mkdir(join(project, '.dsh', 'skills', 'alpha'), { recursive: true })
    await writeFile(join(project, '.dsh', 'skills', 'alpha', 'SKILL.md'), SKILL, 'utf8')
    await writeFile(join(project, '.dsh', 'skills', 'flat.md'), SKILL.replace('alpha', 'flat'), 'utf8')
    await mkdir(join(project, '.dsh', 'skills', 'nested', 'inner'), { recursive: true })
    await writeFile(join(project, '.dsh', 'skills', 'nested', 'inner', 'SKILL.md'), SKILL, 'utf8')
  })

  after(async () => {
    await rm(base, { recursive: true, force: true })
  })

  test('lists the user roots and the project roots that exist', async () => {
    const roots = await listRoots({ dshHome: base, agentsHome: join(base, 'agents-home'), workspaces: [{ path: project, title: 'project' }] })
    const keys = roots.map((root) => root.key)
    assert.deepEqual(keys.slice(0, 2), ['user-dsh', 'user-agents'])
    assert.ok(keys.includes(`project-dsh:${project}`))
    assert.ok(!keys.includes(`project-agents:${project}`), 'a project root appears only when its directory exists')
  })

  test('scans direct children only, and both skill shapes', async () => {
    const roots = await listRoots({ dshHome: base, agentsHome: join(base, 'agents-home'), workspaces: [{ path: project, title: 'project' }] })
    const root = roots.find((entry) => entry.key === `project-dsh:${project}`)
    const scanned = await scanRoot(root)
    assert.equal(scanned.exists, true)
    assert.deepEqual(scanned.skills.map((skill) => skill.name).sort(), ['alpha', 'flat'])
    assert.ok(!scanned.skills.some((skill) => skill.name === 'inner'), 'nested SKILL.md files are not discovered')
  })

  test('a missing root is reported, not thrown', async () => {
    const scanned = await scanRoot({ key: 'user-dsh', path: join(base, 'absent') })
    assert.equal(scanned.exists, false)
    assert.deepEqual(scanned.skills, [])
  })
})

describe('mutations', () => {
  let base
  let project
  let ctx

  before(async () => {
    base = await mkdtemp(join(tmpdir(), 'dsh-skill-manager-mut-'))
    project = join(base, 'project')
    await mkdir(join(project, '.dsh', 'skills', 'alpha'), { recursive: true })
    await writeFile(join(project, '.dsh', 'skills', 'alpha', 'SKILL.md'), SKILL, 'utf8')
    process.env.DSH_HOME = base
    process.env.DSH_AGENTS_HOME = join(base, '.agents')
    ctx = fakeContext([project])
  })

  after(async () => {
    delete process.env.DSH_HOME
    delete process.env.DSH_AGENTS_HOME
    await rm(base, { recursive: true, force: true })
  })

  const rootKey = () => `project-dsh:${project}`

  test('list returns the roots, the skills and the trash', async () => {
    const answer = await dispatch(ctx, { action: 'list' })
    assert.equal(answer.ok, true)
    const root = answer.roots.find((entry) => entry.key === rootKey())
    assert.deepEqual(root.skills.map((skill) => skill.name), ['alpha'])
    assert.deepEqual(root.trash, [])
  })

  test('disable moves the bundle to .disabled and enable moves it back', async () => {
    const disabled = await dispatch(ctx, { action: 'set-disabled', rootKey: rootKey(), entryName: 'alpha', disabled: true })
    assert.equal(disabled.ok, true)
    const listed = await dispatch(ctx, { action: 'list' })
    const root = listed.roots.find((entry) => entry.key === rootKey())
    assert.equal(root.skills.find((skill) => skill.entryName === 'alpha').disabled, true)
    const onDisk = await readdir(join(project, '.dsh', 'skills', '.disabled'))
    assert.deepEqual(onDisk, ['alpha'])

    const enabled = await dispatch(ctx, { action: 'set-disabled', rootKey: rootKey(), entryName: 'alpha', disabled: false })
    assert.equal(enabled.ok, true)
    assert.deepEqual(await readdir(join(project, '.dsh', 'skills', '.disabled')), [])
  })

  test('disable refuses an entry that is not where it claims', async () => {
    const answer = await dispatch(ctx, { action: 'set-disabled', rootKey: rootKey(), entryName: 'ghost', disabled: true })
    assert.equal(answer.ok, false)
    assert.equal(answer.code, 'missing')
  })

  test('disable refuses a name that is not a skill name', async () => {
    const answer = await dispatch(ctx, { action: 'set-disabled', rootKey: rootKey(), entryName: '../etc', disabled: true })
    assert.equal(answer.ok, false)
    assert.equal(answer.code, 'bad-name')
  })

  test('an unknown root key is refused', async () => {
    const answer = await dispatch(ctx, { action: 'set-disabled', rootKey: '/etc', entryName: 'alpha', disabled: true })
    assert.equal(answer.code, 'unknown-root')
  })

  test('a DSH_HOME that already names .dsh is not nested again', async () => {
    const answer = await dispatch(ctx, { action: 'list' })
    const dsh = answer.roots.find((entry) => entry.key === 'user-dsh')
    const agents = answer.roots.find((entry) => entry.key === 'user-agents')
    // DSH_HOME is `/…/.dsh` itself; the root is `<that>/skills`.
    assert.equal(dsh.path, join(base, 'skills'))
    assert.ok(!dsh.path.includes(`${sep}.dsh${sep}.dsh${sep}`), dsh.path)
    // The agents root comes from the agents home, not from the DSH home.
    assert.equal(agents.path, join(base, '.agents', 'skills'))
  })

  test('the user root is addressable even before it exists', async () => {
    const answer = await dispatch(ctx, { action: 'list' })
    const userRoot = answer.roots.find((entry) => entry.key === 'user-dsh')
    assert.equal(userRoot.exists, false)
    assert.equal(userRoot.path, join(base, 'skills'))
  })

  test('read returns the body, and refuses an oversized file', async () => {
    const answer = await dispatch(ctx, { action: 'read', rootKey: rootKey(), entryName: 'alpha', disabled: false })
    assert.equal(answer.ok, true)
    assert.match(answer.skill.body, /Body text/)
    assert.equal(answer.rootPath, join(project, '.dsh', 'skills'))
  })

  test('uninstall, restore and purge round-trip', async () => {
    const trashed = await dispatch(ctx, { action: 'trash', rootKey: rootKey(), entryName: 'alpha' })
    assert.equal(trashed.ok, true)
    let listed = await dispatch(ctx, { action: 'list' })
    let root = listed.roots.find((entry) => entry.key === rootKey())
    assert.deepEqual(root.skills, [])
    assert.equal(root.trash.length, 1)

    const restored = await dispatch(ctx, { action: 'restore', rootKey: rootKey(), entryName: 'alpha' })
    assert.equal(restored.ok, true)
    listed = await dispatch(ctx, { action: 'list' })
    root = listed.roots.find((entry) => entry.key === rootKey())
    assert.deepEqual(root.skills.map((skill) => skill.name), ['alpha'])

    await dispatch(ctx, { action: 'trash', rootKey: rootKey(), entryName: 'alpha' })
    const purged = await dispatch(ctx, { action: 'purge', rootKey: rootKey(), entryName: 'alpha' })
    assert.equal(purged.ok, true)
    listed = await dispatch(ctx, { action: 'list' })
    root = listed.roots.find((entry) => entry.key === rootKey())
    assert.deepEqual(root.trash, [])
  })

  test('create writes a bundle that scans back', async () => {
    const created = await dispatch(ctx, {
      action: 'create',
      rootKey: rootKey(),
      name: 'beta',
      description: 'Does beta.',
      whenToUse: 'When beta is needed.',
      body: '# Beta\n',
    })
    assert.equal(created.ok, true)
    const text = await readFile(join(project, '.dsh', 'skills', 'beta', 'SKILL.md'), 'utf8')
    const skill = describeSkill({ text, entryName: 'beta', entryKind: 'directory' })
    assert.equal(skill.name, 'beta')
    assert.deepEqual(skill.issues, [])
  })

  test('create refuses a duplicate and an unusable name', async () => {
    const duplicate = await dispatch(ctx, { action: 'create', rootKey: rootKey(), name: 'beta', description: 'x' })
    assert.equal(duplicate.code, 'conflict')
    const bad = await dispatch(ctx, { action: 'create', rootKey: rootKey(), name: '../escape', description: 'x' })
    assert.equal(bad.code, 'bad-name')
    const noDescription = await dispatch(ctx, { action: 'create', rootKey: rootKey(), name: 'gamma', description: '' })
    assert.equal(noDescription.code, 'bad-description')
  })

  test('install copies a folder and refuses traversal', async () => {
    const source = join(base, 'source-skill')
    await mkdir(source, { recursive: true })
    await writeFile(join(source, 'SKILL.md'), SKILL.replace(/alpha/g, 'copied'), 'utf8')

    const installed = await dispatch(ctx, { action: 'import-directory', rootKey: rootKey(), sourcePath: source })
    assert.equal(installed.ok, true)
    assert.equal(installed.entryName, 'copied')
    assert.ok(await readFile(join(project, '.dsh', 'skills', 'copied', 'SKILL.md'), 'utf8'))
    assert.ok(await readFile(join(source, 'SKILL.md'), 'utf8'), 'the source is copied, never moved')

    const escaped = await dispatch(ctx, {
      action: 'import-files',
      rootKey: rootKey(),
      name: 'sneaky',
      files: [{ path: '../escape/SKILL.md', content: 'x' }],
    })
    assert.equal(escaped.code, 'bad-path')
  })

  test('import-files needs a SKILL.md and writes nested paths', async () => {
    const noSkill = await dispatch(ctx, { action: 'import-files', rootKey: rootKey(), name: 'noskill', files: [{ path: 'README.md', content: 'x' }] })
    assert.equal(noSkill.code, 'not-a-skill')

    const ok = await dispatch(ctx, {
      action: 'import-files',
      rootKey: rootKey(),
      name: 'nested-assets',
      files: [
        { path: 'SKILL.md', content: '---\nname: nested-assets\ndescription: Has a reference.\n---\n' },
        { path: 'references/usage.md', content: '# Usage\n' },
      ],
    })
    assert.equal(ok.ok, true)
    assert.ok(await readFile(join(project, '.dsh', 'skills', 'nested-assets', 'references', 'usage.md'), 'utf8'))
  })

  test('empty-trash removes every entry of one root', async () => {
    await dispatch(ctx, { action: 'trash', rootKey: rootKey(), entryName: 'beta' })
    const emptied = await dispatch(ctx, { action: 'empty-trash', rootKey: rootKey() })
    assert.equal(emptied.ok, true)
    assert.equal(emptied.removed >= 1, true)
    const listed = await dispatch(ctx, { action: 'list' })
    assert.deepEqual(listed.roots.find((entry) => entry.key === rootKey()).trash, [])
  })

  test('an unknown action is a typed failure', async () => {
    const answer = await dispatch(ctx, { action: 'nope' })
    assert.equal(answer.code, 'unknown-action')
    assert.equal((await dispatch(ctx, null)).code, 'bad-request')
  })
})

test('the market reads the bundled catalogue and refuses a foreign source', async () => {
  // The catalogue ships inside the package, so the Host reads it without the
  // network. A malformed entry is dropped, and a source on a host the installer
  // does not read is rejected outright rather than becoming a request the Host
  // would make on the person's behalf.
  const { readMarket } = internals
  const answer = await readMarket()
  assert.equal(answer.ok, true)
  assert.ok(Array.isArray(answer.entries))
  for (const entry of answer.entries) {
    assert.match(entry.source, /^https:\/\/(github|gitlab|gitee|gitcode|atomgit)\.com\//)
  }
})

test('the market expands a repository index into one entry per skill', async () => {
  // readMarket merges the bundled file with the published indexes. Tests run
  // offline, so they drive the index expansion directly with a stubbed fetch:
  // one repository tree becomes one card per SKILL.md, and a non-GitHub source
  // is refused before it ever becomes a request.
  const { expandIndex } = await import('../lib/market.js')
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(url)
    assert.match(url, /api\.github\.com\/repos\/o\/r\/git\/trees\/HEAD/)
    return {
      ok: true,
      json: async () => ({
        tree: [
          { type: 'blob', path: 'skills/alpha/SKILL.md' },
          { type: 'blob', path: 'skills/beta/SKILL.md' },
          { type: 'blob', path: 'skills/beta/README.md' },
          { type: 'blob', path: 'SKILL.md' },
        ],
      }),
    }
  }
  const result = await expandIndex(
    { repositories: ['https://github.com/o/r', 'https://gitlab.com/x/y', 'not a url'] },
    { fetchImpl, token: 't' },
  )
  assert.equal(calls.length, 1, 'only the GitHub repository is fetched')
  assert.deepEqual(result.entries.map((entry) => entry.name).sort(), ['alpha', 'beta'])
  for (const entry of result.entries) {
    assert.equal(entry.source, 'https://github.com/o/r', 'the source stays the repository; the path pins the skill')
    assert.match(entry.path, /^skills\/(alpha|beta)$/)
  }
  assert.equal(result.warnings.length, 2, 'the two non-GitHub entries are reported, not silently dropped')
})

test('the market reads bundled skills without the network', async () => {
  const { readMarket } = internals
  const answer = await readMarket({ includeIndexes: false })
  assert.equal(answer.ok, true)
  assert.ok(answer.entries.some((entry) => entry.id === 'skill-creator'), 'the bundled catalogue is present offline')
  assert.ok(answer.entries.every((entry) => entry.view === undefined || entry.view.length > 0), 'a bundled entry may carry its own view link')
  for (const entry of answer.entries) {
    assert.equal(entry.origin, 'bundled')
  }
})

test('the market index is fetched over the API, not raw.githubusercontent', async () => {
  // Some networks reset raw.githubusercontent.com while api.github.com answers,
  // so the index must read through the contents API first. This drives
  // readIndexSource through a stubbed fetch and proves the URL chosen is the
  // API one, and that a base64 body is decoded.
  const { MARKET_INDEX_SOURCES } = internals
  assert.ok(Array.isArray(MARKET_INDEX_SOURCES) && MARKET_INDEX_SOURCES.length > 0)
  for (const source of MARKET_INDEX_SOURCES) {
    assert.equal(typeof source.repo, 'string', 'a source names a repository')
    assert.equal(typeof source.path, 'string', 'a source names a path inside it')
  }
})

test('every expanded index entry carries a per-skill view link', async () => {
  // "View source" must open the skill's own folder, not the repository root that
  // install reads from — otherwise every row on a multi-skill repo links the same.
  const { expandIndex } = await import('../lib/market.js')
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({
      tree: [
        { type: 'blob', path: 'skills/alpha/SKILL.md' },
        { type: 'blob', path: 'skills/beta/SKILL.md' },
      ],
    }),
  })
  const result = await expandIndex({ repositories: ['https://github.com/o/r'] }, { fetchImpl })
  for (const entry of result.entries) {
    assert.equal(entry.source, 'https://github.com/o/r')
    assert.match(entry.view, /^https:\/\/github\.com\/o\/r\/tree\/HEAD\/skills\/(alpha|beta)$/)
  }
  assert.notEqual(result.entries[0].view, result.entries[1].view, 'two skills in one repo link to different folders')
})

describe('market index sources', () => {
  let base
  let ctx

  before(async () => {
    base = await mkdtemp(join(tmpdir(), 'dsh-skill-manager-sources-'))
    process.env.DSH_HOME = base
    process.env.DSH_AGENTS_HOME = join(base, '.agents')
    ctx = fakeContext([])
    await dispatch(ctx, { action: 'reset-market-sources' })
  })

  after(async () => {
    delete process.env.DSH_HOME
    delete process.env.DSH_AGENTS_HOME
    await rm(base, { recursive: true, force: true })
  })

  const added = (answer) => (answer.sources ?? []).filter((row) => row.builtin !== true)

  test('the built-in index is listed, and cannot be removed', async () => {
    const listed = await dispatch(ctx, { action: 'market-sources' })
    assert.equal(listed.ok, true)
    const builtin = listed.sources.filter((row) => row.builtin === true)
    assert.equal(builtin.length, internals.MARKET_INDEX_SOURCES.length)
    assert.match(builtin[0].label, /dsh-skill-manager/)
    assert.match(builtin[0].page, /^https:\/\/github\.com\//)
    assert.deepEqual(added(listed), [])

    const refused = await dispatch(ctx, { action: 'remove-market-source', key: builtin[0].key })
    assert.equal(refused.ok, false)
    assert.equal(refused.code, 'builtin')
    assert.deepEqual(added(await dispatch(ctx, { action: 'market-sources' })), [])
  })

  test('a pasted repository link is stored and handed back to the market', async () => {
    const response = await dispatch(ctx, { action: 'add-market-source', value: 'https://github.com/owner/repo' })
    assert.equal(response.ok, true)
    const rows = added(response)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].label, 'owner/repo', 'a bare repository is stored as a whole-repository source')
    assert.equal(rows[0].page, 'https://github.com/owner/repo')
    assert.equal(rows[0].builtin, false)

    // The list is a fact about this machine: it survives the next request.
    const listed = await dispatch(ctx, { action: 'market-sources' })
    assert.deepEqual(added(listed).map((row) => row.key), ['owner/repo'])

    // readMarket carries the rows even when it does not read the network,
    // which is what the manager dialog paints from.
    const market = await internals.readMarket({ includeIndexes: false })
    assert.equal(market.ok, true)
    assert.deepEqual(added({ sources: market.sources }).map((row) => row.key), ['owner/repo'])
  })

  test('a JSON index link becomes a direct source', async () => {
    const response = await dispatch(ctx, { action: 'add-market-source', value: 'https://skills.example.com/index.json' })
    assert.equal(response.ok, true)
    const keys = added(response).map((row) => row.key)
    assert.ok(keys.includes('https://skills.example.com/index.json'))
    assert.ok(keys.includes('owner/repo'))
  })

  test('duplicates, private hosts and non-JSON links are typed refusals', async () => {
    const duplicate = await dispatch(ctx, { action: 'add-market-source', value: 'https://github.com/owner/repo' })
    assert.equal(duplicate.ok, false)
    assert.equal(duplicate.code, 'duplicate')

    const privateHost = await dispatch(ctx, { action: 'add-market-source', value: 'http://127.0.0.1/index.json' })
    assert.equal(privateHost.ok, false)
    assert.equal(privateHost.code, 'bad-source')
    assert.equal(privateHost.reason, 'private-host')

    const notJson = await dispatch(ctx, { action: 'add-market-source', value: 'https://example.com/skills' })
    assert.equal(notJson.ok, false)
    assert.equal(notJson.code, 'bad-source')
    assert.equal(notJson.reason, 'json-file')

    const empty = await dispatch(ctx, { action: 'add-market-source', value: '' })
    assert.equal(empty.reason, 'empty')
  })

  test('the list is capped', async () => {
    const listed = await dispatch(ctx, { action: 'market-sources' })
    assert.ok(added(listed).length < internals.MAX_MARKET_SOURCES)
  })

  test('removing an added source leaves the built-in one, and reset forgets the rest', async () => {
    const removed = await dispatch(ctx, { action: 'remove-market-source', key: 'https://skills.example.com/index.json' })
    assert.equal(removed.ok, true)
    assert.deepEqual(added(removed).map((row) => row.key), ['owner/repo'])

    const reset = await dispatch(ctx, { action: 'reset-market-sources' })
    assert.equal(reset.ok, true)
    assert.deepEqual(added(reset), [])
    assert.equal(reset.sources.filter((row) => row.builtin === true).length, internals.MARKET_INDEX_SOURCES.length)

    const unknown = await dispatch(ctx, { action: 'remove-market-source', key: 'owner/repo' })
    assert.equal(unknown.ok, false)
    assert.equal(unknown.code, 'unknown-source')
  })

  test('a bare repository source expands over the GitHub API', async () => {
    // A person pasting a repository link stores `{ repo, path: '' }`; reading it
    // hands the index expander a one-repository list, so the tree walk and the
    // per-skill view links are the same code the bundled index uses.
    const realFetch = globalThis.fetch
    const calls = []
    globalThis.fetch = async (url) => {
      calls.push(String(url))
      assert.match(String(url), /api\.github\.com\/repos\/stub\/repo\/git\/trees\/HEAD/, 'the tree is read over the API')
      return {
        ok: true,
        json: async () => ({ tree: [{ type: 'blob', path: 'skills/alpha/SKILL.md' }] }),
      }
    }
    try {
      const result = await internals.readIndexSource({ repo: 'stub/repo', path: '' })
      assert.equal(result.warnings.length, 0)
      assert.equal(result.entries.length, 1)
      assert.equal(result.entries[0].source, 'https://github.com/stub/repo')
      assert.equal(result.entries[0].view, 'https://github.com/stub/repo/tree/HEAD/skills/alpha')
    } finally {
      globalThis.fetch = realFetch
    }
  })

  test('a token in the environment raises the GitHub API limit', async () => {
    // Anonymous tree reads share one sixty-requests-per-hour budget per IP, and
    // a market read costs one per repository. A token in the environment
    // (GITHUB_TOKEN or GH_TOKEN) is sent to api.github.com only.
    const realEnv = process.env.GITHUB_TOKEN
    const realFetch = globalThis.fetch
    process.env.GITHUB_TOKEN = 'test-token'
    globalThis.fetch = async (url, init) => {
      if (String(url).startsWith('https://api.github.com/')) {
        assert.equal(init?.headers?.authorization, 'Bearer test-token')
      }
      return { ok: true, json: async () => ({ tree: [{ type: 'blob', path: 'skills/token/SKILL.md' }] }) }
    }
    try {
      const result = await internals.readIndexSource({ repo: 'stub/token', path: '' })
      assert.equal(result.entries.length, 1)
    } finally {
      globalThis.fetch = realFetch
      if (realEnv === undefined) delete process.env.GITHUB_TOKEN
      else process.env.GITHUB_TOKEN = realEnv
    }
  })

  test('a direct JSON source is fetched by its own URL', async () => {
    const realFetch = globalThis.fetch
    const calls = []
    globalThis.fetch = async (url) => {
      calls.push(String(url))
      if (calls.length === 1) {
        assert.equal(String(url), 'https://skills.example.com/index.json')
        return { ok: true, json: async () => ({ repositories: ['https://github.com/stub/repo'] }) }
      }
      return { ok: true, json: async () => ({ tree: [{ type: 'blob', path: 'skills/beta/SKILL.md' }] }) }
    }
    try {
      const result = await internals.readIndexSource({ url: 'https://skills.example.com/index.json' })
      assert.equal(result.warnings.length, 0)
      assert.equal(result.entries.length, 1)
      assert.equal(result.entries[0].name, 'beta')
    } finally {
      globalThis.fetch = realFetch
    }
  })

  test('a failed refresh keeps the last successful read', async () => {
    // The anonymous GitHub API limit resets hourly. A 403 on the refresh must
    // not throw away cards that were read a moment ago: the market keeps the
    // last copy and adds a warning instead of going empty.
    const realFetch = globalThis.fetch
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ tree: [{ type: 'blob', path: 'skills/stale/SKILL.md' }] }) })
    try {
      const first = await internals.readIndexSource({ repo: 'stub/stale', path: '' })
      assert.equal(first.entries.length, 1)
      const cached = internals.marketIndexCache.get('stub/stale')
      assert.ok(cached, 'the successful read is cached')
      cached.at = 0 // force the next read to refetch

      globalThis.fetch = async () => ({ ok: false, status: 403, json: async () => ({}) })
      const second = await internals.readIndexSource({ repo: 'stub/stale', path: '' })
      assert.equal(second.entries.length, 1, 'the last read is still shown')
      assert.equal(second.entries[0].view, 'https://github.com/stub/stale/tree/HEAD/skills/stale')
      assert.ok(second.warnings.some((warning) => /showing the last read/i.test(warning)))
    } finally {
      globalThis.fetch = realFetch
      internals.marketIndexCache.delete('stub/stale')
    }
  })

  test('a damaged bookkeeping file reads as no added sources', async () => {
    await writeFile(join(base, 'skills-market-sources.json'), '{ not json', 'utf8')
    const listed = await dispatch(ctx, { action: 'market-sources' })
    assert.equal(listed.ok, true)
    assert.deepEqual(listed.sources.filter((row) => row.builtin !== true), [])
  })
})
