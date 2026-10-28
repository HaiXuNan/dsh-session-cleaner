/**
 * dsh-session-cleaner — host half.
 *
 * DSH 0.2.1-rc.3 has no way to delete a session: the workspace RPC surface
 * only archives. This plugin adds one local web route the client half calls
 * to permanently remove an *archived* session: its JSONL log directory, its
 * projection-cache file, and every registry reference (workspace accounting,
 * archive set, pin set).
 *
 * Design rules kept deliberately narrow:
 * - Only archived sessions are deletable. An active/live session is refused,
 *   so no running conversation can be destroyed by accident.
 * - Registry writes go through the public workspace registry service, never
 *   by rewriting workspace.json behind its back.
 * - Filesystem work is restricted to `<dsh home>/sessions` and the
 *   projection-cache directory; the session id must be a literal
 *   `session-<uuid>` (no separators, no traversal).
 * - Startup reconciles archive entries whose log is already gone, so a crash
 *   between a file removal and its registry write cannot leave a ghost row.
 */

import { readdir, rm, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'

/** Cordis plugin name. */
export const name = 'session-cleaner'

/** Services this plugin needs before it mounts. */
export const inject = ['webServer', 'workspaceRegistry']

/** Route prefix served to the browser half. */
const ROUTE_PREFIX = '/session-cleaner'

/** A session id we are willing to turn into a filesystem path. */
const SESSION_ID = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Largest JSON body accepted by the delete route. */
const BODY_LIMIT = 16 * 1024

/** A request failure carrying the HTTP status and machine code. */
class CleanerError extends Error {
  /**
   * @param status - HTTP status to answer with.
   * @param code - Stable machine-readable code for the client.
   * @param message - Human-readable (Chinese) explanation.
   */
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
    this.name = 'CleanerError'
  }
}

/**
 * The DeepSeek Harness home, mirroring `@deepseek-ai/dsh-home-paths`
 * precedence: `$DSH_HOME`, then `~/.dsh`.
 * @returns the absolute harness home.
 */
function dshHome() {
  const fromEnv = process.env.DSH_HOME
  return fromEnv !== undefined && fromEnv.trim() !== '' ? resolve(fromEnv) : join(homedir(), '.dsh')
}

/**
 * Whether a path is an existing directory.
 * @param path - Candidate path.
 * @returns true when `stat` reports a directory.
 */
async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/**
 * Every on-disk directory holding this session's log. Session logs live under
 * `<home>/sessions/<workspace-slug>/<session-id>/`; the slug is unknown to the
 * caller, so the session root is scanned instead of guessed.
 * @param sessionId - Validated session id.
 * @returns absolute session directory paths that exist.
 */
async function findSessionDirs(sessionId) {
  const root = join(dshHome(), 'sessions')
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const found = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const candidate = join(root, entry.name, sessionId)
    if (await isDirectory(candidate)) found.push(candidate)
  }
  return found
}

/**
 * Path of one session's projection-cache file.
 * @param sessionId - Validated session id.
 * @returns the absolute cache path (whether or not it exists).
 */
function projectionCacheFile(sessionId) {
  return join(dshHome(), 'storages', 'session_projcache', 'sessions', `${sessionId}.json`)
}

/**
 * Drop every registry reference to one session: workspace accounting, the
 * global archive set, and the global pin set.
 * @param registry - the workspace registry service.
 * @param sessionId - Session id to forget.
 */
async function forgetInRegistry(registry, sessionId) {
  for (const workspace of registry.list()) await workspace.detachSession(sessionId)
  await registry.unarchiveSession(sessionId)
  await registry.unpinSession(sessionId)
}

/**
 * Read and parse a JSON request body.
 * @param req - Node request stream.
 * @returns the parsed body object.
 * @throws {CleanerError} for oversized or malformed bodies.
 */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > BODY_LIMIT) throw new CleanerError(413, 'body-too-large', '请求体过大')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return {}
  try {
    const parsed = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new CleanerError(400, 'bad-body', '请求体必须是 JSON 对象')
    }
    return parsed
  } catch (error) {
    if (error instanceof CleanerError) throw error
    throw new CleanerError(400, 'bad-body', '请求体不是合法 JSON')
  }
}

/**
 * Write one JSON response.
 * @param res - Node response.
 * @param status - HTTP status.
 * @param payload - JSON-serializable body.
 */
function writeJson(res, status, payload) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(payload))
}

/**
 * The activity DSH reports for one session — its in-flight turn, subagent
 * descendants, owned background jobs and active schedules — read through the
 * same waterfall the archive path consults.
 *
 * A session merely being resident in memory is NOT activity: DSH keeps an
 * archived session loaded until the process exits, so a live-object check
 * would refuse every archive-then-delete flow.
 * @param ctx - Plugin context.
 * @param sessionId - Session to inspect.
 * @returns the activity entries, empty when nothing is running.
 */
async function sessionActivity(ctx, sessionId) {
  try {
    const activity = await ctx.waterfall('workspace/session-activity', { sessionId }, () => Promise.resolve([]))
    return Array.isArray(activity) ? activity : []
  } catch {
    return []
  }
}

/**
 * Delete one archived session's files, then its registry references.
 * @param ctx - Plugin context (workspace registry and live session store).
 * @param sessionId - Session id from the request.
 * @returns what was removed.
 * @throws {CleanerError} when the session still has running work, or is not archived.
 */
async function deleteSession(ctx, sessionId) {
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) {
    throw new CleanerError(400, 'invalid-session-id', '会话 ID 格式不正确')
  }
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined) {
    throw new CleanerError(503, 'registry-unavailable', '工作区注册表不可用，无法删除会话')
  }
  const activity = await sessionActivity(ctx, sessionId)
  if (activity.length > 0) {
    const kinds = [...new Set(activity.map((entry) => entry.kind))].join('、')
    throw new CleanerError(409, 'session-active', `该会话还有进行中的工作（${kinds}），请先停止后再删除`)
  }
  if (!registry.archivedSessionIds.includes(sessionId)) {
    throw new CleanerError(409, 'not-archived', '只能删除已归档的会话，请先归档')
  }

  // Files first: if a removal fails, the session keeps its archive entry and
  // stays visible, rather than becoming a registry-only ghost.
  const dirs = await findSessionDirs(sessionId)
  const removed = []
  for (const dir of dirs) {
    await rm(dir, { recursive: true, force: true })
    removed.push(dir)
  }
  await rm(projectionCacheFile(sessionId), { force: true })
  if (removed.length === 0) {
    throw new CleanerError(410, 'log-missing', '该会话的日志文件已不存在，可能已被删除')
  }

  await forgetInRegistry(registry, sessionId)
  return { sessionId, removed }
}

/**
 * Drop archive entries whose session log no longer exists and that are not
 * live. This heals the state a crash (or a lost workspace.json write) between
 * "files removed" and "registry updated" would otherwise leave behind.
 * @param ctx - Plugin context.
 * @returns how many entries were healed.
 */
async function reconcileStaleArchives(ctx) {
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined) return 0
  let healed = 0
  for (const sessionId of [...registry.archivedSessionIds]) {
    if (!SESSION_ID.test(sessionId)) continue
    if (ctx.get('sessions')?.get(sessionId) !== undefined) continue
    if ((await findSessionDirs(sessionId)).length > 0) continue
    await rm(projectionCacheFile(sessionId), { force: true })
    await forgetInRegistry(registry, sessionId)
    healed += 1
  }
  return healed
}

/**
 * Mount the local routes and the startup reconciliation.
 * @param ctx - Cordis plugin context.
 */
export function apply(ctx) {
  ctx.effect(() => {
    void reconcileStaleArchives(ctx).then((healed) => {
      if (healed > 0) ctx.logger?.info?.(`session-cleaner: dropped ${healed} archived entr${healed === 1 ? 'y' : 'ies'} whose log was gone`)
    }).catch((error) => {
      ctx.logger?.warn?.(`session-cleaner: reconcile failed: ${String(error)}`)
    })
  }, 'session-cleaner: reconcile stale archives')

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: async (req, res) => {
      try {
        const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
        const method = pathname.slice(ROUTE_PREFIX.length).replace(/^\/+/, '')

        if (method === 'archived' && req.method === 'GET') {
          const registry = ctx.get('workspaceRegistry')
          writeJson(res, 200, {
            ok: true,
            value: { archivedSessionIds: registry === undefined ? [] : [...registry.archivedSessionIds] },
          })
          return
        }

        if (method === 'delete') {
          if (req.method !== 'POST') {
            throw new CleanerError(405, 'method-error', '只接受 POST')
          }
          const body = await readJsonBody(req)
          writeJson(res, 200, { ok: true, value: await deleteSession(ctx, body.sessionId) })
          return
        }

        throw new CleanerError(404, 'not-found', '未知的接口')
      } catch (error) {
        const failure = error instanceof CleanerError
          ? error
          : new CleanerError(500, 'internal', error instanceof Error ? error.message : String(error))
        ctx.logger?.warn?.(`session-cleaner: ${failure.code}: ${failure.message}`)
        writeJson(res, failure.status, { ok: false, error: { code: failure.code, message: failure.message } })
      }
    },
  }), 'session-cleaner: routes')
}
