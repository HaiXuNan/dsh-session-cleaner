/**
 * Offline harness for the session-cleaner host half: mounts the plugin into a
 * fake cordis context, then drives the real HTTP handler against a throwaway
 * DSH_HOME so route parsing, guards, registry calls, and file removal are all
 * exercised before the desktop app restarts.
 *
 * Run: node test-host.mjs
 */

import { mkdir, mkdtemp, rm, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const SESSION_ID = 'session-11111111-2222-3333-4444-555555555555'
const plainId = 'session-99999999-8888-7777-6666-555555555555'

const home = await mkdtemp(join(tmpdir(), 'dsh-cleaner-'))
process.env.DSH_HOME = home

const sessionDir = join(home, 'sessions', '--C-Users-Administrator-Desktop--', SESSION_ID)
await mkdir(sessionDir, { recursive: true })
await writeFile(join(sessionDir, 'session.v4.jsonl.zstd'), 'log')
const cacheDir = join(home, 'storages', 'session_projcache', 'sessions')
await mkdir(cacheDir, { recursive: true })
await writeFile(join(cacheDir, `${SESSION_ID}.json`), '{}')

const detached = []
const registry = {
  archivedSessionIds: [SESSION_ID, plainId],
  list: () => [{ detachSession: async (id) => { detached.push(id) } }],
  unarchiveSession: async (id) => {
    registry.archivedSessionIds = registry.archivedSessionIds.filter((entry) => entry !== id)
  },
  unpinSession: async () => {},
}

let route
const ctx = {
  get: (name) => (name === 'workspaceRegistry' ? registry : undefined),
  effect: (factory) => { factory() },
  logger: { warn: () => {} },
  webServer: { register: (value) => { route = value; return () => {} } },
}

async function call(method, path, body) {
  const payload = body === undefined ? '' : JSON.stringify(body)
  const req = {
    method,
    url: path,
    async *[Symbol.asyncIterator]() {
      if (payload !== '') yield Buffer.from(payload)
    },
  }
  let status
  let text = ''
  const res = {
    writeHead: (code) => { status = code },
    end: (value) => { text = String(value ?? '') },
  }
  await route.handler(req, res)
  return { status, body: JSON.parse(text) }
}

const { apply } = await import(pathToFileURL(join(process.cwd(), 'lib', 'index.js')).href)
apply(ctx)

const checks = []
const check = (name, ok, detail) => checks.push({ name, ok, detail })

const listed = await call('GET', '/session-cleaner/archived')
check('list archived', listed.status === 200 && listed.body.value.archivedSessionIds.length === 2, listed.body)

const guarded = await call('POST', '/session-cleaner/delete', { sessionId: plainId })
check('refuses non-archived? (it is archived here)', guarded.status === 200, guarded.body)

const rejected = await call('POST', '/session-cleaner/delete', { sessionId: '../../etc' })
check('rejects traversal id', rejected.status === 400 && rejected.body.error.code === 'invalid-session-id', rejected.body)

const removed = await call('POST', '/session-cleaner/delete', { sessionId: SESSION_ID })
check('delete ok', removed.status === 200 && removed.body.value.removed.length === 1, removed.body)
check('detached from workspaces', detached.includes(SESSION_ID), detached)
check('dropped from archive set', !registry.archivedSessionIds.includes(SESSION_ID), registry.archivedSessionIds)

const dirGone = await stat(sessionDir).then(() => false, () => true)
const cacheGone = await stat(join(cacheDir, `${SESSION_ID}.json`)).then(() => false, () => true)
check('session dir removed', dirGone)
check('projection cache removed', cacheGone)

const again = await call('POST', '/session-cleaner/delete', { sessionId: SESSION_ID })
check('second delete refuses (no longer archived)', again.status === 409 && again.body.error.code === 'not-archived', again.body)

const unknown = await call('POST', '/session-cleaner/unknown', {})
check('unknown route 404', unknown.status === 404, unknown.body)

for (const entry of checks) console.log(`${entry.ok ? 'PASS' : 'FAIL'}  ${entry.name}`, entry.ok ? '' : JSON.stringify(entry.detail))
await rm(home, { recursive: true, force: true })
process.exit(checks.every((entry) => entry.ok) ? 0 : 1)
