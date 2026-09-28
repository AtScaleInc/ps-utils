import { useQuery } from '@tanstack/react-query'
import { api } from './api'
import { BuildView } from './build/BuildView'
import { AskDialog, LinkModelDialog, Toast } from './components/Dialogs'
import { ManageView } from './components/ManageView'
import { PromoteView } from './components/PromoteView'
import { SettingsView } from './components/SettingsView'
import { ENVS, envOf, plural, useHosts } from './components/ui'
import { resolveHost, useUi, type BuildSection, type Section, type View } from './store'

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
          {view === 'build' && <BuildView />}
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

const TABS: { id: Exclude<View, 'settings'>; label: string; note: string }[] = [
  { id: 'build', label: 'Build', note: 'Model SML, deploy to hosts' },
  { id: 'manage', label: 'Manage', note: 'Objects on one host' },
  { id: 'promote', label: 'Promote', note: 'Move objects between hosts' },
]

function Header() {
  const { view, setView } = useUi()
  const hosts = useHosts().data?.hosts ?? []
  return (
    <header className="header">
      <div className="header-brand">
        <span className="brand">AtScale · Env Manager</span>
        <nav className="tabs">
          {TABS.map((t) => (
            <button key={t.id} type="button" title={t.note} className={`tab ${view === t.id ? 'on' : ''}`} onClick={() => setView(t.id)}>
              {t.label}
            </button>
          ))}
        </nav>
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

/** Left rail: the current tab's sections, styled like the top tabs. */
function Sidebar() {
  const { view, section, setSection, buildSection, setBuildSection, manage, src, tgt, build } = useUi()
  const hosts = useHosts().data?.hosts ?? []
  const ctxHost = resolveHost(hosts, view === 'promote' ? src : view === 'build' ? build : manage)
  const th = resolveHost(hosts, tgt)
  const objects = view === 'manage' || view === 'promote'
  const models = useQuery({ queryKey: ['models', ctxHost?.id], queryFn: () => api.models(ctxHost!.id), enabled: !!ctxHost && objects })
  const aggModels = useQuery({ queryKey: ['aggModels', ctxHost?.id], queryFn: () => api.aggModels(ctxHost!.id), enabled: !!ctxHost && objects })

  const counts: Record<Section, string> = {
    models: models.data ? String(models.data.models.length) : '—',
    aggs: aggModels.data ? String(aggModels.data.models.length) : '—',
  }
  const context = view === 'promote' ? `${ctxHost?.label ?? '—'} → ${th?.label ?? '—'}`
    : view === 'settings' ? `${plural(hosts.length, 'host')} across 3 groups`
    : `${envOf((view === 'build' ? build : manage).env).label} · ${ctxHost?.label ?? 'no host'}`
  const hint = view === 'promote' ? 'Drag source → target' : view === 'settings' ? 'Credentials per host'
    : view === 'build' ? 'Deploy to one or many hosts' : 'Pick a group, then a host'

  return (
    <aside className="sidebar">
      <nav className="side-nav">
        {view === 'build' && ([
          { id: 'model', label: 'Model', note: 'Sources, canvas, SML' },
          { id: 'preview', label: 'Preview', note: 'Query a deployed cube' },
        ] as { id: BuildSection; label: string; note: string }[]).map((s) => (
          <button key={s.id} type="button" className={`side-btn ${buildSection === s.id ? 'on' : ''}`} onClick={() => setBuildSection(s.id)}>
            <span className="t">{s.label}</span><span className="n">{s.note}</span>
          </button>
        ))}
        {objects && ([
          { id: 'models', label: 'Models', note: view === 'promote' ? 'Repo attach + deploy' : 'Link, deploy, unlink' },
          { id: 'aggs', label: 'Aggregates', note: view === 'promote' ? 'System aggregates only' : 'Activate, build' },
        ] as const).map((s) => (
          <button key={s.id} type="button" className={`side-btn ${section === s.id ? 'on' : ''}`} onClick={() => setSection(s.id)}>
            <span className="t">{s.label}<span className="c">{counts[s.id]}</span></span><span className="n">{s.note}</span>
          </button>
        ))}
        {view === 'settings' && (
          <div className="side-btn on" style={{ cursor: 'default' }}>
            <span className="t">Hosts &amp; Git</span><span className="n">Connections, profile, cache</span>
          </div>
        )}
      </nav>

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
