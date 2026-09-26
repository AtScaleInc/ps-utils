import { useQuery } from '@tanstack/react-query'
import { api } from './api'
import { AskDialog, LinkModelDialog, Toast } from './components/Dialogs'
import { ManageView } from './components/ManageView'
import { PromoteView } from './components/PromoteView'
import { SettingsView } from './components/SettingsView'
import { ENVS, envOf, plural, useHosts } from './components/ui'
import { resolveHost, useUi, type Section } from './store'

export default function App() {
  const { view, linkOpen, manage } = useUi()
  const hosts = useHosts().data?.hosts ?? []
  const mh = resolveHost(hosts, manage)
  return (
    <div className="app">
      <Header />
      <div className="body">
        <Sidebar />
        <main className="main">
          {view === 'manage' && <ManageView />}
          {view === 'promote' && <PromoteView />}
          {view === 'settings' && <SettingsView />}
        </main>
      </div>
      <AskDialog />
      {linkOpen && mh && <LinkModelDialog host={mh} />}
      <Toast />
    </div>
  )
}

function Header() {
  const { view, setView } = useUi()
  const hosts = useHosts().data?.hosts ?? []
  return (
    <header className="header">
      <div className="header-brand">
        <span className="brand">AtScale · Env Manager</span>
        <span className="display">One semantic layer, <em>every</em> environment</span>
      </div>
      <div className="header-right">
        <div className="env-counts">
          {ENVS.map((e) => (
            <span key={e.id} className="env-count">
              <span className="sq" style={{ background: e.color }} />{e.label} · {plural(hosts.filter((h) => h.env === e.id).length, 'host')}
            </span>
          ))}
        </div>
        <button type="button" className={`settings-tab ${view === 'settings' ? 'on' : ''}`} onClick={() => setView('settings')}>
          <span className="mono muted" style={{ fontSize: 10 }}>⚙</span>Settings
        </button>
      </div>
    </header>
  )
}

function Sidebar() {
  const { view, section, setView, setSection, manage, src, tgt } = useUi()
  const hosts = useHosts().data?.hosts ?? []
  const ctxHost = resolveHost(hosts, view === 'promote' ? src : manage)
  const th = resolveHost(hosts, tgt)
  const models = useQuery({ queryKey: ['models', ctxHost?.id], queryFn: () => api.models(ctxHost!.id), enabled: !!ctxHost && view !== 'settings' })
  const aggModels = useQuery({ queryKey: ['aggModels', ctxHost?.id], queryFn: () => api.aggModels(ctxHost!.id), enabled: !!ctxHost && view !== 'settings' })

  const counts: Record<Section, string> = {
    models: models.data ? String(models.data.models.length) : '—',
    aggs: aggModels.data ? `${aggModels.data.models.length} models` : '—',
  }
  const context = view === 'promote' ? `${ctxHost?.label ?? '—'} → ${th?.label ?? '—'}`
    : view === 'settings' ? `${plural(hosts.length, 'host')} across 3 groups`
    : `${envOf(manage.env).label} · ${ctxHost?.label ?? 'no host'}`
  const hint = view === 'promote' ? 'Drag source → target' : view === 'settings' ? 'Credentials per host' : 'Pick a group, then a host'

  return (
    <aside className="sidebar">
      <div className="side-head eyebrow">01 — Mode</div>
      {([
        { id: 'manage', label: 'Manage', note: 'Browse objects on one host' },
        { id: 'promote', label: 'Promote', note: 'Move objects between hosts' },
      ] as const).map((m) => (
        <button key={m.id} type="button" className={`side-btn mode ${view === m.id ? 'on' : ''}`} onClick={() => setView(m.id)}>
          <span className="t">{m.label}</span><span className="n">{m.note}</span>
        </button>
      ))}

      <div className="side-sep eyebrow">02 — Objects</div>
      <div style={{ opacity: view === 'settings' ? 0.5 : 1 }}>
        {([
          { id: 'models', label: 'Models', dot: '#2AA5C7' },
          { id: 'aggs', label: 'Aggregates', dot: '#12A594' },
        ] as const).map((s) => (
          <button key={s.id} type="button" className={`side-btn sec ${section === s.id && view !== 'settings' ? 'on' : ''}`} onClick={() => setSection(s.id)}>
            <span className="sq" style={{ background: s.dot }} />
            <span className="t">{s.label}</span>
            <span className="c">{counts[s.id]}</span>
          </button>
        ))}
      </div>

      <div className="side-ctx">
        <span className="eyebrow">Context</span>
        <span className="v">{context}</span>
      </div>
      <div className="side-foot">
        <span className="palette">{ENVS.map((e) => <span key={e.id} style={{ background: e.color }} />)}<span style={{ background: '#FF3B35' }} /></span>
        <span className="hint">{hint}</span>
      </div>
    </aside>
  )
}
