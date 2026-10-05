import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { saveBlob, type EnvId } from '../api'
import { BranchSelect, envOf, errMsg } from '../components/ui'
import { useUi } from '../store'
import { pipelineApi, type ActionKind, type Board, type BoardModel } from './api'

export interface ActionRun { hosts: string[]; branch?: string }

/** A Board action (deploy into the next stage, test, rollback) with its
 * options: which hosts of the stage, which branch (over a merge gate only - a
 * promotion deploys the tested commit), and the same action as a ps-utils
 * package - run.sh with the ps-utils CLI only - to download and run by hand,
 * or to commit and call from a pipeline (POST /pipeline/script[/zip]). */
export function ActionDialog({ kind, board, model, env, from, onRun, onClose }: {
  kind: ActionKind
  board: Board
  model: BoardModel
  /** The stage the action runs on (the target, for a deploy). */
  env: EnvId
  /** Deploys: the stage the commit comes from. */
  from?: EnvId
  onRun: (r: ActionRun) => void
  onClose: () => void
}) {
  const { flash } = useUi()
  const i = board.stages.findIndex((s) => s.env === env)
  const stage = board.stages[i]
  const cell = model.cells[i]
  const fi = from ? board.stages.findIndex((s) => s.env === from) : -1
  const src = fi >= 0 ? model.cells[fi] : null
  const gateKind = fi >= 0 ? board.gates[fi].kind : null
  const gate = fi >= 0 ? model.gates[fi] : null
  const final = i === board.stages.length - 1

  // What each host of the stage runs of this model now.
  const runs = Object.fromEntries((cell?.perHost ?? []).map((h) => [h.id, h.version]))
  const deployedOn = stage.hosts.filter((h) => runs[h.id])
  const pickable = kind === 'promote' ? stage.hosts : deployedOn
  const [hosts, setHosts] = useState<string[]>(kind === 'test' ? [cell?.hostId ?? pickable[0]?.id].filter(Boolean) as string[] : pickable.map((h) => h.id))
  const [branch, setBranch] = useState<string>(gateKind === 'merge' ? (cell?.branch ?? 'main') : (src?.branch ?? 'main'))
  const [tab, setTab] = useState<'sh' | 'gha' | 'jenkins'>(board.orchestrator === 'jenkins' ? 'jenkins' : board.orchestrator === 'gha' ? 'gha' : 'sh')

  const all = hosts.length === pickable.length
  const req = {
    action: kind, env, model: model.name,
    hosts: all && kind !== 'test' ? undefined : hosts,
    branch: kind === 'promote' ? branch : undefined,
  }
  const script = useQuery({ queryKey: ['pipeline', 'script', req], queryFn: () => pipelineApi.script(req), enabled: hosts.length > 0, retry: false })
  const text = script.data?.[tab] ?? ''
  const [zipping, setZipping] = useState(false)
  const download = async () => {
    setZipping(true)
    try {
      const { name, blob } = await pipelineApi.scriptZip(req)
      saveBlob(name, blob)
      flash(`${name} downloaded - fill in connections.yaml, then ./run.sh`)
    } catch (e) {
      flash(errMsg(e), 'err')
    } finally {
      setZipping(false)
    }
  }

  const verb = kind === 'promote' ? `Deploy to ${stage.label}` : kind === 'test' ? `Run test on ${stage.label}` : `Rollback ${stage.label}`
  const title = kind === 'promote'
    ? (gateKind === 'merge' ? `Deploy ${branch}'s head to ${stage.label}.` : `Deploy ${src?.version ?? ''} to ${stage.label}.`)
    : kind === 'test' ? `Test ${model.name} on ${stage.label}.` : `Redeploy ${model.name}'s previous commit.`
  const note = kind === 'promote'
    ? (gateKind === 'merge'
      ? `${stage.label} deploys the head of the branch you pick.`
      : `${model.name} ${src?.version ?? ''} passed on ${board.stages[fi].label}. That commit deploys - if ${src?.branch ?? 'its branch'} has moved since, the deploy is refused.`)
      + (final ? ' System aggregates are not in Git: the package moves them after the deploy; from the Board, use Move system aggregates.' : '')
    : kind === 'test'
      ? `Queries generated from the model run on the host you pick and on the baseline (${board.stages[board.stages.length - 1].env === env ? 'this stage\'s previous test' : board.stages[board.stages.length - 1].label}), then compare.`
      : 'Each picked host redeploys the commit it ran before, in place, as the same catalog - nothing is undeployed, nothing is rebuilt, and aggregates are left as they are.'
  const siblings = board.models.filter((x) => x !== model && x.repoUrl === model.repoUrl).map((x) => x.name)
  const catalogNote = kind !== 'test' && siblings.length
    ? `The repo's whole catalog goes with it: ${siblings.join(', ')} ${siblings.length === 1 ? 'moves' : 'move'} to the same commit on the picked hosts.` : ''

  const toggle = (id: string) => setHosts((cur) => kind === 'test' ? [id] : cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id])
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      flash(`${tab === 'sh' ? 'run.sh' : tab === 'gha' ? 'GitHub Actions job' : 'Jenkins stage'} copied`)
    } catch {
      flash('Copy failed - select the text instead', 'err')
    }
  }

  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal pl-modal" onClick={(e) => e.stopPropagation()}>
        <span className="eyebrow" style={{ color: envOf(env).color }}>{gate?.approval && kind === 'promote' ? 'Approve · ' : ''}{verb} · {model.name}</span>
        <span className="display">{title}</span>
        <span className="note">{note}</span>
        {catalogNote && <span className="note" style={{ color: 'var(--warn)' }}>{catalogNote}</span>}

        <div className="col" style={{ gap: 6, flex: '0 0 auto' }}>
          <span className="label">{kind === 'test' ? 'Host to test on' : `${stage.label} hosts`}</span>
          <div className="list">
            {pickable.map((h) => {
              const on = hosts.includes(h.id)
              return (
                <label key={h.id} className="pl-host">
                  <input type={kind === 'test' ? 'radio' : 'checkbox'} checked={on} onChange={() => toggle(h.id)} />
                  <span className="ellipsis" style={{ flex: 1 }}>{h.label}</span>
                  <span className="mono muted">{runs[h.id] ? `runs ${runs[h.id]}` : 'not deployed'}</span>
                </label>
              )
            })}
            {!pickable.length && <div className="hint">{model.name} isn't deployed on any {stage.label} host</div>}
          </div>
          {kind !== 'test' && !all && hosts.length > 0 && (
            <span className="hint" style={{ color: 'var(--warn)' }}>The other {stage.label} hosts keep what they run - the Board shows them as drift</span>
          )}
        </div>

        {kind === 'promote' && (
          <div className="col" style={{ gap: 6, flex: '0 0 auto' }}>
            <span className="label">Branch</span>
            {gateKind === 'merge' && model.repoUrl && stage.hosts[0]
              ? <BranchSelect hostId={stage.hosts[0].id} repoUrl={model.repoUrl} value={branch} onChange={setBranch} />
              : <span className="mono">{branch} · {src?.version ?? '—'} <span className="muted">- the commit {fi >= 0 ? board.stages[fi].label : ''} tested; another branch has to be tested there first</span></span>}
          </div>
        )}

        <div className="col" style={{ gap: 8, flex: '0 0 auto' }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span className="label">Or run it with ps-utils, by hand or from your pipeline</span>
            <div className="row" style={{ gap: 8 }}>
              <div className="seg">
                {([['sh', 'Shell'], ['gha', 'GitHub Actions'], ['jenkins', 'Jenkins']] as const).map(([k, l]) => (
                  <button key={k} type="button" className={tab === k ? 'on' : ''} style={{ background: tab === k ? 'var(--dev)' : undefined }} onClick={() => setTab(k)}>{l}</button>
                ))}
              </div>
              <button type="button" className="btn ghost" disabled={!text} onClick={copy}>Copy</button>
              <button type="button" className="btn ghost" disabled={!script.data || zipping} onClick={download}
                title={script.data ? `${script.data.filename}: run.sh, connections.yaml, README - the ps-utils package` : undefined}>
                {zipping ? 'Packing…' : 'Download .zip'}
              </button>
            </div>
          </div>
          {script.isError ? <div className="err-text">{errMsg(script.error)}</div> : <pre className="pl-pre pl-snippet">{text || ' '}</pre>}
          <span className="hint">
            {tab === 'sh' ? 'run.sh of the package · ps-utils CLI only, no call to Env Manager · fill in connections.yaml · exit 0 pass, 1 fail'
              : tab === 'gha' ? `Commit the package as atscale/${script.data?.folder ?? '…'}/ · secret ATSCALE_CONNECTIONS = the filled-in connections.yaml`
              : `Commit the package as atscale/${script.data?.folder ?? '…'}/ · secret file credential atscale-connections`}
          </span>
        </div>

        <div className="actions">
          <button type="button" className="btn lg ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="btn lg solid" disabled={!hosts.length || (kind !== 'test' && !pickable.length)}
            style={{ background: kind === 'rollback' ? 'var(--danger)' : envOf(env).color }}
            onClick={() => { onRun({ hosts: all && kind !== 'test' ? [] : hosts, branch: kind === 'promote' ? branch : undefined }); onClose() }}>
            {verb}{kind !== 'test' && !all ? ` (${hosts.length} of ${pickable.length})` : ''}
          </button>
        </div>
      </div>
    </div>
  )
}
