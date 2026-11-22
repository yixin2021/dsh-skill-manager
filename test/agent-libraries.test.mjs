/**
 * Agent libraries: the skill directories Codex, CodeBuddy, Claude Code and Pi
 * keep are found on their own, so a person does not have to paste a path the
 * app could have discovered.
 *
 * These tests run against a temporary home with the environment variables each
 * agent honours, so the result does not depend on what is installed on the
 * machine running them.
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { apply, dispatch, internals } from '../index.js'

const SKILL = '---\nname: %NAME%\ndescription: A test skill.\n---\n\n# Body\n'

/** A Host context with no workspaces. */
const ctx = { get: () => undefined }

describe('agent libraries', () => {
  let base

  before(async () => {
    base = await mkdtemp(join(tmpdir(), 'dsh-skills-agents-'))
    process.env.DSH_HOME = join(base, 'home')
    process.env.DSH_AGENTS_HOME = join(base, 'agents')
    process.env.CODEX_HOME = join(base, 'codex')
    process.env.CODEBUDDY_HOME = join(base, 'codebuddy')
    process.env.CLAUDE_CONFIG_DIR = join(base, 'claude')
    // Pi's library is not directly inside its home: it is `<agent dir>/skills`,
    // and the agent dir itself is what PI_CODING_AGENT_DIR moves.
    process.env.PI_CODING_AGENT_DIR = join(base, 'pi', 'agent')
    process.env.WORKBUDDY_HOME = join(base, 'workbuddy')
    for (const [kind, name] of [
      [process.env.CODEX_HOME, 'codex-skill'],
      [process.env.CODEBUDDY_HOME, 'buddy-skill'],
      [process.env.CLAUDE_CONFIG_DIR, 'claude-skill'],
      [process.env.PI_CODING_AGENT_DIR, 'pi-skill'],
      [process.env.WORKBUDDY_HOME, 'wb-skill'],
    ]) {
      await mkdir(join(kind, 'skills', name), { recursive: true })
      await writeFile(join(kind, 'skills', name, 'SKILL.md'), SKILL.replace('%NAME%', name), 'utf8')
    }
  })

  after(async () => {
    delete process.env.DSH_HOME
    delete process.env.DSH_AGENTS_HOME
    delete process.env.CODEX_HOME
    delete process.env.CODEBUDDY_HOME
    delete process.env.CLAUDE_CONFIG_DIR
    delete process.env.PI_CODING_AGENT_DIR
    delete process.env.WORKBUDDY_HOME
    await rm(base, { recursive: true, force: true })
  })

  test('finds each agent library that exists, and skips the ones that do not', async () => {
    const listed = await dispatch(ctx, { action: 'list' })
    const agents = listed.roots.filter((root) => root.kind === 'agent')
    // Listed in the order the page shows them: codex, claude, pi, workbuddy, codebuddy.
    assert.deepEqual(agents.map((root) => root.agent), ['codex', 'claude', 'pi', 'workbuddy', 'codebuddy'])
    assert.deepEqual(agents.map((root) => root.skills.map((skill) => skill.name)), [
      ['codex-skill'],
      ['claude-skill'],
      ['pi-skill'],
      ['wb-skill'],
      ['buddy-skill'],
    ])
    for (const root of agents) {
      assert.equal(root.readOnly, undefined, 'a discovered library is managed like any other root')
      assert.equal(root.exists, true)
      assert.match(root.key, /^agent:/)
    }

    // DSH's own roots carry the DSH mark.
    const own = listed.roots.find((root) => root.key === 'user-dsh')
    assert.equal(own.agent, 'dsh')
  })

  test('honours the environment variable each agent uses for its home', () => {
    const candidates = internals.agentLibraryCandidates()
    assert.deepEqual(
      candidates.map((entry) => entry.path),
      [
        join(process.env.CODEX_HOME, 'skills'),
        join(process.env.CLAUDE_CONFIG_DIR, 'skills'),
        // Pi keeps skills one level deeper than the other agents.
        join(process.env.PI_CODING_AGENT_DIR, 'skills'),
        join(process.env.WORKBUDDY_HOME, 'skills'),
        join(process.env.CODEBUDDY_HOME, 'skills'),
      ],
    )
  })

  test('an agent library stays listed until the agent itself is gone', async () => {
    const before = await internals.discoverAgentLibraries()
    assert.equal(before.length, 5)
    // Only the library directory is removed: the agent is still installed, so
    // its home remains the evidence that this root deserves a row.
    await rm(join(process.env.CODEBUDDY_HOME, 'skills'), { recursive: true, force: true })
    const libraryGone = await internals.discoverAgentLibraries()
    assert.deepEqual(libraryGone.map((entry) => entry.agent), ['codex', 'claude', 'pi', 'workbuddy', 'codebuddy'])
    const listed = await dispatch(ctx, { action: 'list' })
    const buddy = listed.roots.find((root) => root.key === 'agent:codebuddy')
    assert.equal(buddy.exists, false, 'the row says the library is not there yet')
    assert.deepEqual(buddy.skills, [])

    // Uninstalling the agent removes the row again.
    await rm(process.env.CODEBUDDY_HOME, { recursive: true, force: true })
    const agentGone = await internals.discoverAgentLibraries()
    assert.deepEqual(agentGone.map((entry) => entry.agent), ['codex', 'claude', 'pi', 'workbuddy'])

    // Put it back for the tests that follow.
    await mkdir(join(process.env.CODEBUDDY_HOME, 'skills', 'buddy-skill'), { recursive: true })
    await writeFile(join(process.env.CODEBUDDY_HOME, 'skills', 'buddy-skill', 'SKILL.md'), SKILL.replace('%NAME%', 'buddy-skill'), 'utf8')
  })

  test('a Claude library that has never been created takes the first skill', async () => {
    // Claude Code is installed and configured (~/.claude/settings.json) but has
    // never kept a skill, so ~/.claude/skills does not exist. That is the state
    // a person is in the moment they want to manage Claude's skills for the
    // first time, and it must not be the one state the panel cannot address.
    const original = process.env.CLAUDE_CONFIG_DIR
    const fresh = join(base, 'claude-installed')
    await mkdir(fresh, { recursive: true })
    await writeFile(join(fresh, 'settings.json'), '{}\n', 'utf8')
    process.env.CLAUDE_CONFIG_DIR = fresh
    try {
      const listed = await dispatch(ctx, { action: 'list' })
      const claude = listed.roots.find((root) => root.key === 'agent:claude')
      assert.ok(claude, 'Claude Code is listed as soon as the agent itself is installed')
      assert.equal(claude.path, join(fresh, 'skills'))
      assert.equal(claude.exists, false)
      assert.deepEqual(claude.skills, [])

      const installed = await dispatch(ctx, {
        action: 'import-files',
        rootKey: 'agent:claude',
        name: 'claude-first',
        files: [{ path: 'SKILL.md', content: SKILL.replace('%NAME%', 'claude-first') }],
      })
      assert.equal(installed.ok, true, 'installing is the way the library gets created')
      assert.equal(installed.entryName, 'claude-first')

      const again = (await dispatch(ctx, { action: 'list' })).roots.find((root) => root.key === 'agent:claude')
      assert.equal(again.exists, true)
      assert.deepEqual(again.skills.map((skill) => skill.name), ['claude-first'])
    } finally {
      process.env.CLAUDE_CONFIG_DIR = original
    }
  })

  test('a skill in an agent library is switched in place, not copied', async () => {
    const listed = await dispatch(ctx, { action: 'list' })
    const codex = listed.roots.find((root) => root.key === 'agent:codex')
    const library = join(process.env.CODEX_HOME, 'skills')

    const disabled = await dispatch(ctx, { action: 'set-disabled', rootKey: codex.key, entryName: 'codex-skill', disabled: true })
    assert.equal(disabled.ok, true)
    assert.deepEqual(await readdir(library), ['.disabled'])
    assert.deepEqual(await readdir(join(library, '.disabled')), ['codex-skill'])

    const enabled = await dispatch(ctx, { action: 'set-disabled', rootKey: codex.key, entryName: 'codex-skill', disabled: false })
    assert.equal(enabled.ok, true)
    // `.disabled` stays behind so the next disable is a rename, not a create.
    assert.deepEqual((await readdir(library)).sort(), ['.disabled', 'codex-skill'])
  })

  test('adding a discovered directory by hand is refused instead of doubled', async () => {
    const added = await dispatch(ctx, { action: 'add-root', path: join(process.env.CODEX_HOME, 'skills') })
    assert.equal(added.ok, false)
    assert.equal(added.code, 'duplicate')
  })

  test('the model sees the agent libraries through the plugin provider', async () => {
    let factory
    const ctxWithSkills = {
      get: (name) => (name === 'skills' ? { registerProvider: (create) => ((factory = create), () => {}) } : undefined),
      effect: (fn) => (fn(), () => {}),
      connection: { fetch: { register: () => () => {} } },
    }
    apply(ctxWithSkills)
    const provider = factory({ signal: new AbortController().signal, invalidate: () => {} })
    const listed = await provider.list()
    assert.deepEqual(listed.candidates.map((candidate) => candidate.name).sort(), ['buddy-skill', 'claude-skill', 'codex-skill', 'pi-skill', 'wb-skill'])
    for (const candidate of listed.candidates) assert.equal(candidate.source, 'custom')

    const skill = await provider.get(listed.candidates.find((candidate) => candidate.name === 'codex-skill'))
    assert.match(skill.content, /# Body/)
  })

  test('a repository\'s own Claude skills are a project root, and the model can load them', async () => {
    // Claude Code keeps per-repository skills in `<repo>/.claude/skills`. They
    // are neither DSH's nor a separate agent library, and DSH does not scan the
    // path, so this plugin has to: a switch that renames the bundle only means
    // something if the catalog it feeds is the one this plugin serves.
    const repo = join(base, 'repo-with-claude-skills')
    await mkdir(join(repo, '.claude', 'skills', 'repo-skill'), { recursive: true })
    await writeFile(join(repo, '.claude', 'skills', 'repo-skill', 'SKILL.md'), SKILL.replace('%NAME%', 'repo-skill'), 'utf8')
    await mkdir(join(repo, '.dsh', 'skills'), { recursive: true })

    const repoCtx = { get: (name) => (name === 'workspaceRegistry' ? { list: () => [{ path: repo, title: 'repo' }] } : undefined) }
    const listed = await dispatch(repoCtx, { action: 'list' })
    const claude = listed.roots.find((root) => root.key === `project-claude:${repo}`)
    assert.ok(claude, 'the repository\'s Claude library is listed')
    assert.equal(claude.kind, 'project')
    assert.equal(claude.agent, 'claude')
    assert.deepEqual(claude.skills.map((skill) => skill.name), ['repo-skill'])
    // A workspace without that directory gains no root.
    assert.equal(listed.roots.some((root) => root.key === 'project-claude:/nope'), false)

    let factory
    const providerCtx = {
      get: (name) => {
        if (name === 'skills') return { registerProvider: (create) => ((factory = create), () => {}) }
        if (name === 'workspaceRegistry') return { list: () => [{ path: repo, title: 'repo' }] }
        return undefined
      },
      effect: (fn) => (fn(), () => {}),
      connection: { fetch: { register: () => () => {} } },
    }
    apply(providerCtx)
    const provider = factory({ signal: new AbortController().signal, invalidate: () => {} })
    const candidates = (await provider.list()).candidates
    const found = candidates.find((candidate) => candidate.name === 'repo-skill')
    assert.ok(found, 'the model catalog carries the repository Claude skill')
    assert.match((await provider.get(found)).content, /# Body/)

    // The switch works in place, and the entry leaves the catalog with it.
    const off = await dispatch(repoCtx, { action: 'set-disabled', rootKey: `project-claude:${repo}`, entryName: 'repo-skill', disabled: true })
    assert.equal(off.ok, true)
    const after = (await provider.list()).candidates.map((candidate) => candidate.name)
    assert.ok(!after.includes('repo-skill'), 'a disabled Claude skill is gone from the model catalog')
  })
  test('Pi keeps its library one level deeper than the other agents', async () => {
    // Pi's config dir is `~/.pi/agent`, not `~/.pi`: the parent also holds the
    // package cache and the shared session store, so treating `~/.pi` as the
    // agent home would list a library for a machine that has only ever used a
    // pi package manager and never the agent.
    const original = process.env.PI_CODING_AGENT_DIR
    const home = join(base, 'pi-only-cache')
    await mkdir(join(home, '.pi', 'packages'), { recursive: true })
    process.env.PI_CODING_AGENT_DIR = join(home, '.pi', 'agent')
    try {
      const listed = await dispatch(ctx, { action: 'list' })
      assert.equal(
        listed.roots.some((root) => root.key === 'agent:pi'),
        false,
        'a `~/.pi` without `agent/` is not evidence that pi is installed',
      )

      // Once the agent has written its own config dir, the row appears and the
      // skills directory is created by the first install, not by hand.
      await mkdir(join(home, '.pi', 'agent'), { recursive: true })
      const installed = await dispatch(ctx, {
        action: 'import-files',
        rootKey: 'agent:pi',
        name: 'pi-first',
        files: [{ path: 'SKILL.md', content: SKILL.replace('%NAME%', 'pi-first') }],
      })
      assert.equal(installed.ok, true)
      assert.equal(installed.entryName, 'pi-first')
      const pi = (await dispatch(ctx, { action: 'list' })).roots.find((root) => root.key === 'agent:pi')
      assert.equal(pi.path, join(home, '.pi', 'agent', 'skills'))
      assert.deepEqual(pi.skills.map((skill) => skill.name), ['pi-first'])
    } finally {
      process.env.PI_CODING_AGENT_DIR = original
    }
  })

  test('a home-relative agent dir is expanded and a relative one is ignored', () => {
    const original = process.env.PI_CODING_AGENT_DIR
    try {
      process.env.PI_CODING_AGENT_DIR = '~/custom-pi/agent'
      const expanded = internals.agentLibraryCandidates().find((entry) => entry.agent === 'pi')
      assert.equal(expanded.home, join(homedir(), 'custom-pi', 'agent'))
      assert.equal(expanded.path, join(homedir(), 'custom-pi', 'agent', 'skills'))

      // A relative value would resolve against pi's cwd, which this process
      // does not share; the default is the honest fallback.
      process.env.PI_CODING_AGENT_DIR = 'relative/agent'
      const fallback = internals.agentLibraryCandidates().find((entry) => entry.agent === 'pi')
      assert.equal(fallback.home, join(homedir(), '.pi', 'agent'))
    } finally {
      if (original === undefined) delete process.env.PI_CODING_AGENT_DIR
      else process.env.PI_CODING_AGENT_DIR = original
    }
  })

  test('a repository can carry a Pi library and a Claude library side by side', async () => {
    // Pi reads `<repo>/.pi/skills`; Claude reads `<repo>/.claude/skills`. Both
    // are per-repository, neither is scanned by DSH, and a repo may have both.
    const repo = join(base, 'repo-both-agents')
    for (const [dir, name] of [
      ['.pi', 'pi-repo-skill'],
      ['.claude', 'claude-repo-skill'],
    ]) {
      await mkdir(join(repo, dir, 'skills', name), { recursive: true })
      await writeFile(join(repo, dir, 'skills', name, 'SKILL.md'), SKILL.replace('%NAME%', name), 'utf8')
    }

    const repoCtx = { get: (name) => (name === 'workspaceRegistry' ? { list: () => [{ path: repo, title: 'repo' }] } : undefined) }
    const listed = await dispatch(repoCtx, { action: 'list' })
    const pi = listed.roots.find((root) => root.key === `project-pi:${repo}`)
    assert.ok(pi, 'the repository\'s Pi library is a project root')
    assert.equal(pi.kind, 'project')
    assert.equal(pi.path, join(repo, '.pi', 'skills'))
    assert.deepEqual(pi.skills.map((skill) => skill.name), ['pi-repo-skill'])
    assert.ok(listed.roots.some((root) => root.key === `project-claude:${repo}`), 'and so is Claude\'s')

    let factory
    const providerCtx = {
      get: (name) => {
        if (name === 'skills') return { registerProvider: (create) => ((factory = create), () => {}) }
        if (name === 'workspaceRegistry') return { list: () => [{ path: repo, title: 'repo' }] }
        return undefined
      },
      effect: (fn) => (fn(), () => {}),
      connection: { fetch: { register: () => () => {} } },
    }
    apply(providerCtx)
    const provider = factory({ signal: new AbortController().signal, invalidate: () => {} })
    const names = (await provider.list()).candidates.map((candidate) => candidate.name)
    assert.ok(names.includes('pi-repo-skill'), 'the model catalog carries the repository Pi skill')
    assert.ok(names.includes('claude-repo-skill'), 'and the repository Claude skill')

    // Disabling is a rename inside the repo-scoped Pi library, and the model
    // catalog loses it on the next read.
    const off = await dispatch(repoCtx, { action: 'set-disabled', rootKey: `project-pi:${repo}`, entryName: 'pi-repo-skill', disabled: true })
    assert.equal(off.ok, true)
    const after = (await provider.list()).candidates.map((candidate) => candidate.name)
    assert.ok(!after.includes('pi-repo-skill'), 'a disabled Pi skill is gone from the model catalog')
    assert.ok(after.includes('claude-repo-skill'), 'and the Claude one is untouched')
  })
})
