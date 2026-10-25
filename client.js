window.__ModuleLoader__.load({
  id: 'dsh-peer-sync',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const zh = typeof navigator !== 'undefined' && /^zh/i.test(navigator.language || '')
    const L = (cn, en) => (zh ? cn : en)

    const S = {
      page: { display: 'flex', flexDirection: 'column', gap: 18, padding: '4px 0 24px' },
      section: { display: 'flex', flexDirection: 'column', gap: 8 },
      title: {
        fontSize: 13,
        fontWeight: 600,
        color: 'var(--dsw-alias-label-primary)',
        margin: 0,
      },
      hint: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', margin: 0, lineHeight: 1.6 },
      card: {
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 12,
        background: 'var(--dsw-alias-bg-layer-1)',
        padding: '12px 14px',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      },
      row: { display: 'flex', alignItems: 'center', gap: 10, fontSize: 13 },
      name: { fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
      mono: {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 12,
        color: 'var(--dsw-alias-label-secondary)',
      },
      dim: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12 },
      dot: (color) => ({
        width: 8,
        height: 8,
        borderRadius: 4,
        flex: '0 0 auto',
        background: color,
        marginTop: 1,
      }),
      list: { display: 'flex', flexDirection: 'column', gap: 8, margin: 0, padding: 0, listStyle: 'none' },
      code: {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 11,
        color: 'var(--dsw-alias-label-secondary)',
        wordBreak: 'break-all',
      },
      button: {
        alignSelf: 'flex-start',
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
        borderRadius: 8,
        padding: '5px 12px',
        fontSize: 12,
        cursor: 'pointer',
      },
      tag: {
        fontSize: 11,
        padding: '1px 6px',
        borderRadius: 6,
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-secondary)',
      },
    }

    function when(value) {
      if (!value) return '—'
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return '—'
      const pad = (n) => String(n).padStart(2, '0')
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    function size(bytes) {
      const value = Number(bytes) || 0
      if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`
      if (value >= 1024) return `${Math.round(value / 1024)} KB`
      return `${value} B`
    }

    function Section(props) {
      return h('section', { style: S.section }, h('h3', { style: S.title }, props.title), props.children)
    }

    function Peers(props) {
      if (!props.peers.length) {
        return h('p', { style: S.hint }, L('还没有对端。两台都装好后会自动发现并配对。', 'No peers yet. They pair automatically once both sides run.'))
      }
      return h(
        'ul',
        { style: S.list },
        props.peers.map((peer, index) =>
          h(
            'li',
            { key: `${peer.name}-${index}`, style: S.card },
            h(
              'div',
              { style: S.row },
              h('span', { style: S.dot(peer.reachable ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-idle-primary)') }),
              h('span', { style: S.name }, peer.name || peer.url),
              h('span', { style: S.dim }, peer.reachable ? L('在线', 'online') : L('离线', 'offline')),
              h('span', { style: S.code }, peer.url),
            ),
            h(
              'div',
              { style: S.dim },
              `${L('上次同步', 'last sync')} ${when(peer.lastSyncAt)}`,
              peer.lastError ? ` · ${peer.lastError}` : '',
            ),
          ),
        ),
      )
    }

    function Panel() {
      const data = typeof window === 'undefined' ? null : window.__DSH_PEER_SYNC__

      if (!data) {
        return h(
          'div',
          { style: S.page },
          h(
            'p',
            { style: S.hint },
            L(
              'Host 侧没有注入状态：插件可能刚刚重载，刷新一次页面即可；若仍为空，检查插件是否启用。',
              'No status injected by the host. Reload the page; if it stays empty, check that the plugin is enabled.',
            ),
          ),
          h('button', { type: 'button', style: S.button, onClick: () => location.reload() }, L('刷新', 'Refresh')),
        )
      }

      const peers = Array.isArray(data.peers) ? data.peers : []
      const bundles = data.bundles || {}
      const sessions = data.sessions || { items: [] }
      const units = data.units || { count: 0, ids: [] }

      return h(
        'div',
        { style: S.page },
        h(
          'div',
          { style: S.row },
          h('span', { style: S.name }, L('跨机同步', 'Peer Sync')),
          h('span', { style: S.tag }, data.pairing && data.pairing.mode ? `pairing: ${data.pairing.mode}` : 'pairing: —'),
          h('button', { type: 'button', style: S.button, onClick: () => location.reload() }, L('刷新', 'Refresh')),
        ),
        h(
          'p',
          { style: S.hint },
          `${L('本机', 'this machine')} ${data.self || '?'} · ${L('监听', 'listen')} ${data.listen || '?'} · ${L('发现', 'discovery')} udp:${(data.pairing && data.pairing.port) || '?'} · ${units.count} ${L('个同步单元', 'units')}`,
        ),

        h(Section, { title: `${L('对端', 'Peers')} (${peers.length})` }, h(Peers, { peers })),

        h(
          Section,
          { title: L('同步内容', 'Synced units') },
          h('p', { style: S.code }, units.ids.length ? units.ids.join('  ·  ') : '—'),
          data.pending && data.pending.length
            ? h('p', { style: S.hint }, `${L('待推送', 'pending')}: ${data.pending.join(', ')}`)
            : null,
        ),

        h(
          Section,
          { title: L('对端缺少的插件', 'Bundles the peer lacks') },
          bundles.toInstall && bundles.toInstall.length
            ? h(
                'ul',
                { style: S.list },
                bundles.toInstall.map((item, index) => h('li', { key: index, style: S.code }, `+ ${item}`)),
              )
            : h('p', { style: S.hint }, L('没有需要补装的。', 'Nothing to install.')),
          bundles.needsManualInstall && bundles.needsManualInstall.length
            ? h(
                'p',
                { style: S.hint },
                L('需要手动安装：', 'Install by hand: ') + bundles.needsManualInstall.join(', '),
              )
            : null,
          bundles.stateDiff && bundles.stateDiff.length
            ? h('p', { style: S.hint }, L('开关状态不同：', 'Enabled state differs: ') + bundles.stateDiff.join('; '))
            : null,
        ),

        h(
          Section,
          { title: L('对端会话镜像', 'Peer session mirror') },
          sessions.items && sessions.items.length
            ? h(
                'ul',
                { style: S.list },
                sessions.items.slice(0, 8).map((item) =>
                  h(
                    'li',
                    { key: item.id, style: S.card },
                    h(
                      'div',
                      { style: S.row },
                      h('span', { style: S.name }, item.title || L('(无标题)', '(untitled)')),
                      h('span', { style: S.dim }, `${when(item.updatedAt)} · ${size(item.size)}`),
                    ),
                    h('span', { style: S.code }, item.cwd || ''),
                  ),
                ),
              )
            : h('p', { style: S.hint }, L('还没有镜像到对端会话。', 'No peer sessions mirrored yet.')),
        ),

        h(
          'p',
          { style: S.hint },
          h('span', { style: S.code }, data.paths && data.paths.log ? data.paths.log : '~/.dsh/peer-sync/sync.log'),
        ),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.plugins.tab', () =>
          ctx.slots.register(
            {
              name: 'settings.plugins.tab',
              id: 'peer-sync',
              order: 60,
              label: L('跨机同步', 'Peer Sync'),
            },
            Panel,
          ),
        )
      },
    }
  },
})
