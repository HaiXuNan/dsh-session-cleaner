/**
 * Offline harness for the session-cleaner host half, v2: covers the new
 * order (files first, registry last), the 410 guard for a missing log, and
 * the startup reconciliation that heals stale archive entries.
 *
 * Run: node test-host-v2.mjs
 */

import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const SESSION_ID = 'session-11111111-2222-3333-4444-555555555555'
const STALE_ID = 'session-99999999-8888-7777-6666-555555555555'
const GHOST_ID = 'session-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

const home = await mkdtemp(join(tmpdir(), 'dsh-cleaner-'))
process.env.DSH_HOME = home

const sessionDir = join(home, 'sessions', '--C-Users-Administrator-Desktop--', SESSION_ID)
await mkdir(sessionDir, { recursive: true })
await writeFile(join(sessionDir, 'session.v4.jsonl.zstd'), 'log')
const cacheDir = join(home, 'storages', 'session_projcache', 'sessions')
await mkdir(cacheDir, { recursive: true })
await writeFile(join(cacheDir, `${SESSION_ID}.json`), '{}')
// A stale entry: archived, no log on disk (healed at mount).
await writeFile(join(cacheDir, `${STALE_ID}.json`), '{}')

const detached = []
const registry = {
  archivedSessionIds: [SESSION_ID, STALE_ID],
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
  logger: { warn: () => {}, info: () => {} },
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
await new Promise((resolve) => setTimeout(resolve, 100))

const checks = []
const check = (name, ok, detail) => checks.push({ name, ok, detail })

check('mount heals stale archive entry', !registry.archivedSessionIds.includes(STALE_ID), registry.archivedSessionIds)
check('mount removes stale cache file', await stat(join(cacheDir, `${STALE_ID}.json`)).then(() => false, () => true))

const listed = await call('GET', '/session-cleaner/archived')
check('list archived', listed.status === 200 && listed.body.value.archivedSessionIds.length === 1, listed.body)

const traversal = await call('POST', '/session-cleaner/delete', { sessionId: '../../etc' })
check('rejects traversal id', traversal.status === 400 && traversal.body.error.code === 'invalid-session-id', traversal.body)

const notArchived = await call('POST', '/session-cleaner/delete', { sessionId: 'session-bbbbbbbb-1111-2222-3333-444444444444' })
check('refuses non-archived id', notArchived.status === 409 && notArchived.body.error.code === 'not-archived', notArchived.body)

// An archived id with no log: reconciliation skipped it only if it existed at
// mount, so add one now and expect the 410 guard.
registry.archivedSessionIds.push(GHOST_ID)
const missingLog = await call('POST', '/session-cleaner/delete', { sessionId: GHOST_ID })
check('refuses archived id with no log', missingLog.status === 410 && missingLog.body.error.code === 'log-missing', missingLog.body)

const removed = await call('POST', '/session-cleaner/delete', { sessionId: SESSION_ID })
check('delete ok', removed.status === 200 && removed.body.value.removed.length === 1, removed.body)
check('detached from workspaces', detached.includes(SESSION_ID), detached)
check('dropped from archive set', !registry.archivedSessionIds.includes(SESSION_ID), registry.archivedSessionIds)
check('session dir removed', await stat(sessionDir).then(() => false, () => true))
check('projection cache removed', await stat(join(cacheDir, `${SESSION_ID}.json`)).then(() => false, () => true))

const again = await call('POST', '/session-cleaner/delete', { sessionId: SESSION_ID })
check('second delete refuses (not archived)', again.status === 409 && again.body.error.code === 'not-archived', again.body)

const unknown = await call('POST', '/session-cleaner/unknown', {})
check('unknown route 404', unknown.status === 404, unknown.body)

for (const entry of checks) console.log(`${entry.ok ? 'PASS' : 'FAIL'}  ${entry.name}`, entry.ok ? '' : JSON.stringify(entry.detail))
await rm(home, { recursive: true, force: true })
process.exit(checks.every((entry) => entry.ok) ? 0 : 1)
