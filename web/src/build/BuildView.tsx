import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { EnvSegment, HostSelect, useHosts } from '../components/ui'
import { resolveHost, useUi } from '../store'
import { deployModel, generateSml, setBuildHost, SmlValidationFailure, type GenerateSmlPayload, type SmlFile } from './client'
import { MODEL_NAME_HINT, slugifyModelName } from './lib/naming'
import { counters, useModelStore } from './modelStore'
import { CalculationsModal } from './panels/CalculationsModal'
import { Canvas } from './panels/Canvas'
import { DiscoveryTab } from './panels/DiscoveryTab'
import { Inspector } from './panels/Inspector'
import { ManageModelModal } from './panels/ManageModelModal'
import { PreviewTab } from './panels/PreviewTab'
import { SmlViewerModal } from './panels/SmlViewerModal'
import { SourcePanel } from './panels/SourcePanel'
import { WizardModal } from './panels/WizardModal'
import './tokens.css'
import './build.css'

/** Build: sml-wizard's App (web/src/App.tsx) minus its login screen - the
 * host comes from the Build bar, and Deploy can target several hosts. */
export function BuildView() {
  const { build, setBuild, buildSection, setBuildSection, setView } = useUi()
  const hosts = useHosts().data?.hosts ?? []
  const host = resolveHost(hosts, build)
  // Set before the panels render so their fetches hit this host.
  setBuildHost(host?.id ?? null)

  const state = useModelStore()
  const c = counters(state)
  const qc = useQueryClient()
  const [files, setFiles] = useState<SmlFile[] | null>(null)
  const [generating, setGenerating] = useState(false)
  const [genError, setGenError] = useState<string | null>(null)
  const [showManage, setShowManage] = useState(false)
  const [showCalculations, setShowCalculations] = useState(false)
  const [showWizard, setShowWizard] = useState(false)

  // Reads the store fresh via getState(): the Wizard's "Build & Deploy" writes
  // to the store and calls generate in the same handler (sml-wizard App.tsx).
  function buildPayload(modelName: string): GenerateSmlPayload | null {
    const s = useModelStore.getState()
    if (!s.sourceMeta) {
      setGenError('Select a data source before generating SML.')
      return null
    }
    const schema = s.nodes[0]?.schema
    if (!schema) {
      setGenError('Add at least one table to the canvas before generating SML.')
      return null
    }
    return {
      modelName,
      connectionName: `con_${s.sourceMeta.database}_${schema}`,
      asConnection: s.sourceMeta.connectionId,
      database: s.sourceMeta.database,
      schema,
      dialect: s.sourceMeta.dialect,
      nodes: s.nodes,
      joins: s.joins,
      cfg: s.cfg,
      calculations: s.calculations,
      // A model loaded from an attached repo pushes back to that repo/branch.
      gitRepoUrl: s.sourceRepo?.url,
      gitBranch: s.sourceRepo?.branch,
    }
  }

  async function handleGenerate() {
    const modelName = useModelStore.getState().modelName
    if (!modelName.trim()) {
      setGenError('Enter a model name before generating SML.')
      return
    }
    const payload = buildPayload(modelName)
    if (!payload) return
    setGenerating(true)
    setGenError(null)
    try {
      setFiles((await generateSml(payload)).files)
    } catch (err) {
      setGenError(err instanceof SmlValidationFailure ? err.errors.join('\n') : err instanceof Error ? err.message : String(err))
    } finally {
      setGenerating(false)
    }
  }

  // Rebuilds the payload from current state, so edits made since the preview
  // opened are what gets deployed.
  async function handleDeploy(hostIds: string[]) {
    const payload = buildPayload(useModelStore.getState().modelName)
    if (!payload) throw new Error(genError ?? 'Cannot deploy - fix the error above first')
    const result = await deployModel(payload, hostIds)
    for (const r of result.results) {
      qc.invalidateQueries({ queryKey: ['models', r.hostId] })
      qc.invalidateQueries({ queryKey: ['aggModels', r.hostId] })
    }
    qc.invalidateQueries({ queryKey: ['diff'] })
    return result
  }

  return (
    <div className="col">
      <div className="bar">
        <div className="row">
          <EnvSegment value={build.env} onPick={(e) => setBuild({ env: e, hostId: null })} />
          <HostSelect hosts={hosts} env={build.env} value={host?.id ?? null} onChange={(id) => setBuild({ env: build.env, hostId: id })} />
          {buildSection === 'model' && (
            <input
              className="input model-name"
              placeholder="Model name"
              title={MODEL_NAME_HINT}
              value={state.modelName}
              onChange={(e) => state.setModelName(slugifyModelName(e.target.value))}
            />
          )}
        </div>
        {buildSection === 'model' && host && (
          <div className="row">
            <span className="counter">{c.datasets} datasets</span>
            <span className="counter">{c.joins} joins</span>
            <span className="counter">{c.metrics} metrics</span>
            <span className="counter">{c.levels} levels</span>
            <span className="counter">{c.calculations} calcs</span>
            <button type="button" className="btn ghost" onClick={() => setShowCalculations(true)}>Calculations</button>
            <button type="button" className="btn ghost" onClick={() => setShowManage(true)}>Save / Load</button>
            <button type="button" className="btn ghost" onClick={() => { state.reset(); setGenError(null) }}>Reset</button>
            <button type="button" className="btn ghost" onClick={() => setShowWizard(true)}>Wizard</button>
            <button type="button" className="btn primary" onClick={handleGenerate} disabled={generating}>
              {generating ? 'Generating…' : 'Deploy'}
            </button>
          </div>
        )}
      </div>

      <div className="wiz">
      {!host ? (
        <div className="nohost">
          <span className="flag" />
          <span className="display" style={{ fontSize: 34 }}>No hosts in this <em>group</em> yet.</span>
          <span style={{ fontSize: 13.5, lineHeight: 1.4 }} className="muted">
            Build browses a host's data warehouses and deploys to it. Add one in Settings first.
          </span>
          <button type="button" className="btn primary lg" style={{ alignSelf: 'flex-start' }} onClick={() => setView('settings')}>Open settings</button>
        </div>
      ) : buildSection === 'preview' ? (
        <PreviewTab key={host.id} />
      ) : buildSection === 'discover' ? (
        <DiscoveryTab key={host.id} hostId={host.id} />
      ) : (
        <>
          {genError && <div className="login-error build-error">{genError}</div>}
          <div className="app-body" key={host.id}>
            <SourcePanel />
            <Canvas />
            <Inspector />
          </div>
        </>
      )}

      {files && (
        <SmlViewerModal
          files={files}
          connectionId={useModelStore.getState().sourceMeta?.connectionId ?? null}
          defaultHostId={host?.id ?? null}
          onClose={() => setFiles(null)}
          onDeploy={handleDeploy}
        />
      )}
      {showManage && <ManageModelModal onClose={() => setShowManage(false)} />}
      {showCalculations && <CalculationsModal onClose={() => setShowCalculations(false)} />}
      {showWizard && <WizardModal onClose={() => setShowWizard(false)} onGenerate={handleGenerate} onDone={() => setBuildSection('model')} />}
      </div>
    </div>
  )
}
