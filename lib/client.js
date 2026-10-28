/**
 * dsh-session-cleaner — browser half.
 *
 * Adds one row to the sidebar session menu: 「删除会话」. The row only exists
 * for archived sessions, so a live conversation can never be offered a delete
 * action; the host route repeats that check and refuses non-archived ids.
 *
 * The bundle is the plain `window.__ModuleLoader__` format every DSH client
 * plugin uses: executing it registers a factory, and the factory runs when the
 * shell materializes the module.
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-cleaner',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const react = require('react')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')

    /** Locale namespace owned by this plugin. */
    const NS = 'sessionCleaner'
    /** Simplified Chinese dictionary (key-set source of truth). */
    const zh = {
      'menu.delete': '删除会话',
      'confirm.message': '永久删除这个已归档会话？会话记录和缓存都会被移除，无法恢复。',
      'error.prefix': '删除失败：',
    }
    /** English dictionary, kept complete against the zh key set. */
    const en = {
      'menu.delete': 'Delete session',
      'confirm.message': 'Permanently delete this archived session? Its log and cache will be removed. This cannot be undone.',
      'error.prefix': 'Delete failed: ',
    }

    /**
     * Project one observable into another, recomputing only when the source
     * snapshot changes identity (the same shape the workspace plugin's own
     * `hooks` seats consume).
     * @param source - observable with getSnapshot/subscribe.
     * @param project - pure projection of one snapshot.
     * @returns the projected observable.
     */
    function derive(source, project) {
      let seen
      let value
      return {
        getSnapshot: () => {
          const snapshot = source.getSnapshot()
          if (value === undefined || snapshot !== seen) {
            seen = snapshot
            value = project(snapshot)
          }
          return value
        },
        subscribe: (listener) => source.subscribe(listener),
      }
    }

    /**
     * Ask the host to delete one archived session.
     * @param sessionId - the row's session id.
     * @param t - locale lookup.
     * @returns whether the session was deleted.
     */
    async function deleteSession(sessionId, t) {
      if (typeof sessionId !== 'string' || sessionId === '') return false
      if (!window.confirm(t('confirm.message'))) return false
      try {
        const response = await fetch('/session-cleaner/delete', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId }),
        })
        const payload = await response.json().catch(() => null)
        if (!response.ok || payload === null || payload.ok !== true) {
          throw new Error(payload?.error?.message ?? `HTTP ${response.status}`)
        }
        return true
      } catch (error) {
        window.alert(t('error.prefix') + (error instanceof Error ? error.message : String(error)))
        return false
      }
    }

    /**
     * One `sidebar.workspaces.session.menu.item` row (order 500): present only
     * on an archived session.
     * @param props - session id, menu open state, archived hook, locale lookup.
     * @returns the menu row, or null for a session that is not archived.
     */
    function DeleteSessionMenuItem(props) {
      const { sessionId, useMenuOpenState, useArchived } = props
      const t = typeof props.t === 'function' ? props.t : (key) => zh[key] ?? key
      // Hooks run unconditionally, before the archived check below.
      const [, setMenuOpen] = useMenuOpenState()
      const archived = useArchived((set) => (set === null || set === undefined ? true : set.has(sessionId)))
      if (!archived) return null
      // Other rows all lead with a glyph; the trash icon keeps this one
      // consistent. Looked up lazily and omitted (rather than crashing) if a
      // build does not export it.
      const DeleteIcon = primitives.IconTrashOutlineRegular ?? primitives.IconTrashOutlineMedium
      return react.createElement(
        primitives.MenuItemButton,
        {
          ...(DeleteIcon === undefined ? {} : { icon: react.createElement(DeleteIcon, {}) }),
          // Same destructive treatment as 「删除工作区」: MenuItemButton's
          // danger flag paints the icon+label with the error color and the
          // hover background with the danger surface.
          danger: true,
          onSelect: () => {
            setMenuOpen(false)
            void deleteSession(sessionId, t).then((deleted) => {
              // Refresh only the session list: the host no longer has this
              // session, so the next list read drops the row in place. A full
              // page reload would do the same far more disruptively.
              if (deleted && typeof props.refreshSessions === 'function') props.refreshSessions()
            })
          },
        },
        t('menu.delete'),
      )
    }

    /** Services this client plugin needs before it applies. */
    const inject = ['slots', 'workspaces', 'sessions', 'locale']

    /**
     * Register the dictionary and the session-menu row.
     * @param ctx - client plugin context.
     */
    function apply(ctx) {
      const locale = ctx.get('locale')
      if (locale !== undefined) {
        ctx.effect(() => locale.register(NS, { zh, en }), 'session-cleaner: dictionaries')
      }

      // The archive set is registry-global and already streamed to the client
      // as `workspaces.list`; the same projection the sidebar uses gives this
      // row its "archived only" visibility.
      const workspaces = ctx.get('workspaces')
      const archivedSet = workspaces === undefined
        ? { getSnapshot: () => null, subscribe: () => () => {} }
        : derive(workspaces.list, (snapshot) => new Set(snapshot.archivedSessionIds ?? []))

      // `sessions.refresh()` re-pulls the Session baseline from the Host; the
      // row for a deleted session disappears because the Host no longer lists
      // it. This is the in-place alternative to reloading the whole shell.
      const sessions = ctx.get('sessions')
      const refreshSessions = () => {
        try {
          const pending = sessions?.refresh?.()
          if (pending !== undefined && typeof pending.catch === 'function') pending.catch(() => {})
        } catch {
          // A refresh racing a reconnect is harmless; the next baseline wins.
        }
      }

      ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
        name: 'sidebar.workspaces.session.menu.item',
        id: 'delete-session',
        order: 500,
        locale: NS,
        inject: () => ({ hooks: { archived: archivedSet }, refreshSessions }),
      }, DeleteSessionMenuItem))
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
