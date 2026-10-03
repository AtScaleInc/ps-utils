import { useQuery } from '@tanstack/react-query'
import { api } from './api'
import { BuildView } from './build/BuildView'
import { PipelineView } from './pipeline/PipelineView'
import { AskDialog, LinkModelDialog, Toast } from './components/Dialogs'
import { ManageView } from './components/ManageView'
import { PromoteView } from './components/PromoteView'
import { SettingsView } from './components/SettingsView'
import { TestView } from './test/TestView'
import { MonitorView } from './monitor/MonitorView'
import { ErrorBoundary } from './components/ErrorBoundary'
import { BuPicker } from './components/BusinessUnits'
import { ENVS, envOf, plural, useHosts, usedEnvs } from './components/ui'
import { resolveHost, targetPick, useUi, type BuildSection, type PipelineSection, type MonitorSection, type Section, type SettingsSection, type TestSection, type View } from './store'

export default function App() {
  const { view, linkOpen, manage, section, manageAnalyze, buildSection, testSection, pipelineSection, monitorSection, settingsSection } = useUi()
  const hosts = useHosts().data?.hosts ?? []
  const mh = resolveHost(hosts, manage)
  return (
    <div className="app">
      <Header />
      <div className="body">
        <Sidebar />
        <main className="main">
          <ErrorBoundary resetKey={`${view}|${section}|${manageAnalyze}|${buildSection}|${testSection}|${pipelineSection}|${monitorSection}|${settingsSection}`}>
            {view === 'build' && <BuildView />}
            {view === 'manage' && <ManageView />}
            {view === 'promote' && <PromoteView />}
            {view === 'test' && <TestView />}
            {view === 'pipeline' && <PipelineView />}
            {view === 'monitor' && <MonitorView />}
            {view === 'settings' && <SettingsView />}
          </ErrorBoundary>
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
  { id: 'test', label: 'Validate', note: 'Generate + run model queries on hosts, compare before promoting' },
  { id: 'promote', label: 'Promote', note: 'Move objects between hosts' },
  { id: 'manage', label: 'Manage', note: 'Objects on one host' },
  { id: 'pipeline', label: 'Pipeline', note: 'Commits across this business unit\'s stages - gates, tests, CI' },
  { id: 'monitor', label: 'Monitor', note: 'Query history, cache / aggregate use, latency' },
]

function Header() {
  const { view, setView } = useUi()
  const hosts = useHosts().data?.hosts ?? []
  return (
    <header className="header">
      <div className="header-brand">
        <div className="brand-stack">
          <span className="brand">AtScale · Env Manager</span>
          <BuPicker />
        </div>
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
          {!hosts.length && <span className="env-count">No hosts yet</span>}
          {usedEnvs(hosts).map((e) => (
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
  const { view, section, setSection, manageAnalyze, setManageAnalyze, buildSection, setBuildSection, testSection, setTestSection, pipelineSection, setPipelineSection, monitorSection, setMonitorSection, settingsSection, setSettingsSection, manage, src, tgt, build, test, monitor } = useUi()
  const hosts = useHosts().data?.hosts ?? []
  const pick = view === 'promote' ? src : view === 'build' ? build : view === 'test' ? test : view === 'monitor' ? monitor : manage
  const ctxHost = resolveHost(hosts, pick)
  const th = resolveHost(hosts, targetPick(hosts, src, tgt))
  const objects = view === 'manage' || view === 'promote'
  const models = useQuery({ queryKey: ['models', ctxHost?.id], queryFn: () => api.models(ctxHost!.id), enabled: !!ctxHost && objects })
  const aggModels = useQuery({ queryKey: ['aggModels', ctxHost?.id], queryFn: () => api.aggModels(ctxHost!.id), enabled: !!ctxHost && objects })

  const counts: Record<Section, string> = {
    models: models.data ? String(models.data.models.length) : '—',
    aggs: aggModels.data ? String(aggModels.data.models.length) : '—',
  }
  const context = view === 'promote' ? `${ctxHost?.label ?? '—'} → ${th?.label ?? '—'}`
    : view === 'settings' ? `${plural(hosts.length, 'host')} across ${ENVS.length} groups`
    : view === 'pipeline' ? `${usedEnvs(hosts).map((e) => e.label).join(' → ') || 'no groups'}`
    : `${envOf(ctxHost?.env ?? pick.env).label} · ${ctxHost?.label ?? 'no host'}`
  const hint = view === 'promote' ? 'Drag source → target' : view === 'settings' ? 'Credentials per host'
    : view === 'build' ? 'Deploy to one or many hosts' : view === 'test' ? 'Same queries, every env'
    : view === 'monitor' ? 'Poll on demand or every 5 min'
    : view === 'pipeline' ? 'CI runs the steps'
    : view === 'manage' && manageAnalyze ? 'Pick a group, host, then a model' : 'Pick a group, then a host'

  return (
    <aside className="sidebar">
      <nav className="side-nav">
        {view === 'build' && ([
          { id: 'discover', label: 'Discovery', note: 'Profile a warehouse table' },
          { id: 'model', label: 'Develop', note: 'Sources, canvas, SML' },
          { id: 'preview', label: 'Preview', note: 'Query a deployed cube' },
        ] as { id: BuildSection; label: string; note: string }[]).map((s) => (
          <button key={s.id} type="button" className={`side-btn ${buildSection === s.id ? 'on' : ''}`} onClick={() => setBuildSection(s.id)}>
            <span className="t">{s.label}</span><span className="n">{s.note}</span>
          </button>
        ))}
        {view === 'test' && ([
          { id: 'run', label: 'Run', note: 'Pick model, hosts, queries' },
          { id: 'results', label: 'Results', note: 'Runs by model · promotion check' },
          { id: 'compare', label: 'Compare results', note: 'Baseline vs candidate values' },
          { id: 'model', label: 'Compare model', note: 'DMV metrics + levels diff' },
        ] as { id: TestSection; label: string; note: string }[]).map((s) => (
          <button key={s.id} type="button" className={`side-btn ${testSection === s.id ? 'on' : ''}`} onClick={() => setTestSection(s.id)}>
            <span className="t">{s.label}</span><span className="n">{s.note}</span>
          </button>
        ))}
        {view === 'pipeline' && ([
          { id: 'board', label: 'Board', note: 'Each model\'s commit per stage · gates' },
          { id: 'runs', label: 'Runs', note: 'Steps CI ran here, newest first' },
          { id: 'setup', label: 'CI setup', note: 'Orchestrator, gate policy, tokens' },
        ] as { id: PipelineSection; label: string; note: string }[]).map((s) => (
          <button key={s.id} type="button" className={`side-btn ${pipelineSection === s.id ? 'on' : ''}`} onClick={() => setPipelineSection(s.id)}>
            <span className="t">{s.label}</span><span className="n">{s.note}</span>
          </button>
        ))}
        {view === 'monitor' && ([
          { id: 'overview', label: 'Overview', note: 'Cache / aggregate mix, volume, latency' },
          { id: 'history', label: 'History', note: 'Every query, filter + detail' },
          { id: 'hotspots', label: 'Hotspots', note: 'Slow, warehouse-heavy, failing' },
        ] as { id: MonitorSection; label: string; note: string }[]).map((s) => (
          <button key={s.id} type="button" className={`side-btn ${monitorSection === s.id ? 'on' : ''}`} onClick={() => setMonitorSection(s.id)}>
            <span className="t">{s.label}</span><span className="n">{s.note}</span>
          </button>
        ))}
        {objects && ([
          { id: 'models', label: 'Models', note: view === 'promote' ? 'Repo attach + deploy' : 'Link, deploy, unlink' },
          { id: 'aggs', label: 'Aggregates', note: view === 'promote' ? 'System aggregates only' : 'Activate, build' },
        ] as const).map((s) => (
          <button key={s.id} type="button" className={`side-btn ${section === s.id && !(view === 'manage' && manageAnalyze) ? 'on' : ''}`} onClick={() => setSection(s.id)}>
            <span className="t">{s.label}<span className="c">{counts[s.id]}</span></span><span className="n">{s.note}</span>
          </button>
        ))}
        {view === 'manage' && (
          <button type="button" className={`side-btn ${manageAnalyze ? 'on' : ''}`} onClick={() => setManageAnalyze(true)}>
            <span className="t">Analyze</span><span className="n">Audit a model: objects, joins, comments</span>
          </button>
        )}
        {view === 'settings' && ([
          { id: 'hosts', label: 'Hosts & Git', note: "This business unit's hosts + Git profile" },
          { id: 'bus', label: 'Business units', note: 'Add, rename, remove realms' },
          { id: 'storage', label: 'Cache & Database', note: 'List cache, test + query history clean-up' },
        ] as { id: SettingsSection; label: string; note: string }[]).map((s) => (
          <button key={s.id} type="button" className={`side-btn ${settingsSection === s.id ? 'on' : ''}`} onClick={() => setSettingsSection(s.id)}>
            <span className="t">{s.label}</span><span className="n">{s.note}</span>
          </button>
        ))}
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
