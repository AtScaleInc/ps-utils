import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { Fragment, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { api, waitForJob, type CatalogDeployment, type CatalogModel, type CatalogRepo, type EnvId, type Host } from '../api'
import { useUi, type CatalogPick } from '../store'
import { RunBuilder } from '../test/TestView'
import { testApi, type CubeRef } from '../test/api'
import { TEST_FRESH_MS } from '../test/shared'
import { BranchSelect, ENVS, RefreshButton, StatusPill, envOf, errMsg, fmtDate, plural, useGit, useHosts, usedEnvs } from './ui'

/** Catalog: the business unit's AtScale models from the repo side (api/routes/catalog.py).
 * Manage / Test / Promote start from a host; this starts from a model and shows,
 * deploys, undeploys and validates it on every host of every group. */
export function CatalogView() {
  const { catalogSection } = useUi()
  return catalogSection === 'validate' ? <CatalogValidate /> : <CatalogModels />
}

const norm = (u: string) => u.trim().replace(/\/+$/, '').replace(/\.git$/, '').toLowerCase()
const pickKey = (p: CatalogPick) => `${norm(p.repoUrl)}|${p.model}`
const isPick = (p: CatalogPick | null, r: CatalogRepo, m: CatalogModel) => !!p && pickKey(p) === pickKey({ repoUrl: r.url, model: m.name })

export function useCatalog() {
  return useQuery({ queryKey: ['catalog'], queryFn: () => api.catalog() })
}

type Tone = 'ok' | 'warn' | 'err' | 'info'
const TONE: Record<Tone, string> = { ok: 'var(--qa)', warn: 'var(--warn)', err: 'var(--danger)', info: 'var(--muted)' }

/** How a copy reads at a glance: deployed at head / behind / linked only / failed. */
function copyTone(d: CatalogDeployment): Tone {
  if (d.status === 'Error') return 'err'
  if (d.status === 'Linked') return 'info'
  return d.atHead === false ? 'warn' : 'ok'
}

/** What a BU wants to know about a model before acting on it, worst first. */
function findings(m: CatalogModel, hosts: Host[]): Finding[] {
  const out: Finding[] = []
  const deployed = m.deployments.filter((d) => d.status === 'Deployed')
  const failed = m.deployments.filter((d) => d.status === 'Error')
  if (failed.length) out.push({ tone: 'err', text: `Error on ${failed.map((d) => d.label).join(', ')}` })
  const behind = deployed.filter((d) => d.atHead === false)
  if (behind.length) out.push({ tone: 'warn', text: `${behind.length} ${behind.length === 1 ? 'copy' : 'copies'} behind branch head` })
  const versions = new Set(deployed.map((d) => d.commit).filter(Boolean))
  if (versions.size > 1) out.push({ tone: 'warn', text: `${versions.size} versions across hosts` })
  const missing = usedEnvs(hosts).filter((e) => !deployed.some((d) => d.env === e.id))
  if (!deployed.length) out.push({ tone: 'info', text: m.deployments.length ? 'Linked, not deployed' : 'Not on any host' })
  else if (missing.length) out.push({ tone: 'info', text: `Not deployed in ${missing.map((e) => e.label).join(', ')}` })
  if (!m.inGit) out.push({ tone: 'info', text: 'Repo not in the Git profile' })
  if (!out.length) out.push({ tone: 'ok', text: `In sync${deployed[0]?.version ? ` at ${deployed[0].version}` : ''}` })
  return out
}

function Chip({ d }: { d: CatalogDeployment }) {
  const tone = copyTone(d)
  const title = `${d.label}: ${d.status}${d.branch ? ` · ${d.branch}` : ''}${d.version ? ` @ ${d.version}` : ''}${d.atHead === false ? ' · behind head' : d.atHead ? ' · at head' : ''}`
  return (
    <span className={`cat-chip ${tone}`} title={title}>
      <span className="dot" style={{ background: TONE[tone] }} />
      <span className="ellipsis">{d.label}</span>
      {d.version && <span className="v">{d.version}</span>}
    </span>
  )
}

type Finding = { tone: Tone; text: string }

/** Repo -> model rows with one column per group; a row opens `detail` under it.
 * Models and Validate are both this table - they differ in which models and
 * copies they show, what Status says and what opening a model offers. */
function ModelTable({ keep, chips, status, detail, segment, empty }: {
  keep: (m: CatalogModel, f: Finding[]) => boolean
  chips: (m: CatalogModel) => CatalogDeployment[]
  status: (m: CatalogModel) => Finding[]
  detail: (r: CatalogRepo, m: CatalogModel) => ReactNode
  segment?: ReactNode
  empty: string
}) {
  const { catalogPick, setCatalogPick } = useUi()
  const hosts = useHosts().data?.hosts ?? []
  const envs = usedEnvs(hosts)
  const q = useCatalog()
  const qc = useQueryClient()
  const [search, setSearch] = useState('')

  const repos = useMemo(() => {
    const s = search.trim().toLowerCase()
    return (q.data?.repos ?? []).map((r) => ({
      ...r,
      models: r.models.filter((m) => (!s || m.name.toLowerCase().includes(s) || r.fullName.toLowerCase().includes(s)) && keep(m, status(m))),
    })).filter((r) => r.models.length)
  }, [q.data, search, keep, status])
  const nModels = repos.reduce((n, r) => n + r.models.length, 0)
  const grid = { gridTemplateColumns: `minmax(0, 1.6fr) ${envs.map(() => 'minmax(0, 1fr)').join(' ')} minmax(0, 1.3fr) 72px` }

  return (
    <div className="col">
      <div className="bar">
        <div className="row">
          <input className="input search" placeholder="Search models or repos" value={search} onChange={(e) => setSearch(e.target.value)} />
          {segment}
        </div>
        <div className="row">
          <span className="hint">{q.data ? `${plural(nModels, 'model')} · ${plural(repos.length, 'repo')} · ${plural(hosts.length, 'host')}` : ''}</span>
          <RefreshButton cachedAt={q.dataUpdatedAt ? q.dataUpdatedAt / 1000 : null}
            onRefresh={async () => { qc.setQueryData(['catalog'], await api.catalog(true)) }} />
        </div>
      </div>

      {q.isError && <div className="notice err" style={{ marginTop: 12 }}><span className="eyebrow" style={{ color: 'var(--danger)' }}>Error</span>{errMsg(q.error)}</div>}
      {q.data?.gitError && <div className="notice" style={{ marginTop: 12 }}><span className="eyebrow">Git</span>{q.data.gitError} - showing only what the hosts report.</div>}
      {q.data?.hosts.filter((h) => h.error).map((h) => (
        <div key={h.id} className="notice err" style={{ marginTop: 12 }}><span className="eyebrow" style={{ color: 'var(--danger)' }}>{h.label}</span>{h.error}</div>
      ))}

      <div className="scroll" style={{ paddingTop: 14 }}>
        <div className="table">
          <div className="tr th" style={grid}>
            <span>Model</span>
            {envs.map((e) => <span key={e.id} style={{ color: e.color }}>{e.label}</span>)}
            <span>Status</span><span />
          </div>
          {repos.map((r) => (
            <Fragment key={r.url}>
              <div className="cat-repo">
                <span className="mono">{r.fullName}</span>
                <span className="hint">{r.defaultBranch} · {plural(r.models.length, 'model')}{r.source === 'host' ? ' · attached on a host, not in Git profile' : ''}</span>
              </div>
              {r.models.map((m) => {
                const open = isPick(catalogPick, r, m)
                const f = status(m)
                const cs = chips(m)
                return (
                  <Fragment key={m.name}>
                    <div className={`tr ${open ? 'sel' : ''}`} style={grid} onClick={() => setCatalogPick(open ? null : { repoUrl: r.url, model: m.name })}>
                      <span className="name ellipsis">{m.name}</span>
                      {envs.map((e) => {
                        const ds = cs.filter((d) => d.env === e.id)
                        return (
                          <span key={e.id} className="cat-cell">
                            {ds.length ? ds.map((d) => <Chip key={d.hostId} d={d} />) : <span className="hint">—</span>}
                          </span>
                        )
                      })}
                      <span className="cat-find" title={f.map((x) => x.text).join('\n')}>
                        <span className="dot" style={{ background: TONE[f[0].tone] }} />
                        <span className="ellipsis">{f[0].text}</span>
                        {f.length > 1 && <span className="hint">+{f.length - 1}</span>}
                      </span>
                      <span className="hint" style={{ justifySelf: 'end' }}>{open ? 'Hide' : 'Open'}</span>
                    </div>
                    {open && detail(r, m)}
                  </Fragment>
                )
              })}
            </Fragment>
          ))}
          {!repos.length && <div className="empty">{q.isLoading ? 'Reading repos and hosts…' : search ? 'No models match' : empty}</div>}
        </div>
      </div>
    </div>
  )
}

function CatalogModels() {
  const hosts = useHosts().data?.hosts ?? []
  const [only, setOnly] = useState<'all' | 'attention'>('all')
  const status = useCallback((m: CatalogModel) => findings(m, hosts), [hosts])
  const keep = useCallback((_m: CatalogModel, f: Finding[]) => only === 'all' || f[0].tone !== 'ok', [only])
  return (
    <ModelTable keep={keep} status={status} chips={allCopies}
      detail={(r, m) => <ModelDetail repo={r} model={m} hosts={hosts} />}
      empty={only === 'all' ? 'No models in this business unit yet' : 'Nothing needs attention'}
      segment={(
        <div className="seg">
          {([['all', 'All models'], ['attention', 'Needs attention']] as const).map(([k, label]) => (
            <button key={k} type="button" className={only === k ? 'on' : ''} style={{ background: only === k ? 'var(--dev)' : 'transparent' }}
              onClick={() => setOnly(k)}>{label}</button>
          ))}
        </div>
      )} />
  )
}

const allCopies = (m: CatalogModel) => m.deployments
const deployedCopies = (m: CatalogModel) => m.deployments.filter((d) => d.status === 'Deployed')

/** One model on every host of the BU: what's there, and deploy / undeploy / validate / analyze from here. */
function ModelDetail({ repo, model, hosts }: { repo: CatalogRepo; model: CatalogModel; hosts: Host[] }) {
  const { setCatalogSection, setView, setManage, setManageAnalyze, setSrc } = useUi()
  const f = findings(model, hosts)
  const deployed = model.deployments.filter((d) => d.status === 'Deployed')
  return (
    <div className="cat-detail">
      <div className="cat-detail-head">
        <div className="cat-finds">
          {f.map((x) => <span key={x.text} className="cat-find"><span className="dot" style={{ background: TONE[x.tone] }} />{x.text}</span>)}
        </div>
        <div className="row">
          <button type="button" className="btn info xs" disabled={!deployed.length} onClick={() => setCatalogSection('validate')}
            title={deployed.length ? 'Run the same queries on the hosts it is deployed on' : 'Deploy it somewhere first'}>
            Validate on {plural(deployed.length, 'host')}
          </button>
        </div>
      </div>
      <div className="cat-hosts">
        <div className="cat-hrow th">
          <span>Group</span><span>Host</span><span>Status</span><span>Branch · version</span><span>Deployed</span><span />
        </div>
        {ENVS.map((e) => hosts.filter((h) => h.env === e.id).map((h) => {
          const d = model.deployments.find((x) => x.hostId === h.id) ?? null
          return (
            <HostRow key={h.id} env={e.id} host={h} repo={repo} model={model} d={d}
              otherModels={d?.catalog ? repo.models.filter((o) => o.deployments.some((x) => x.hostId === h.id && x.catalog === d.catalog && x.status !== 'Linked')).map((o) => o.name) : []}
              onAnalyze={d && d.status !== 'Linked' ? () => {
                setManage({ env: h.env, hostId: h.id, analyzeKey: d.key, sel: [], q: '' })
                setManageAnalyze(true)
                setView('manage')
              } : undefined}
              onPromote={d && d.status === 'Deployed' ? () => { setSrc({ env: h.env, hostId: h.id }); setView('promote') } : undefined} />
          )
        }))}
      </div>
    </div>
  )
}

function HostRow({ env, host, repo, model, d, otherModels, onAnalyze, onPromote }: {
  env: EnvId; host: Host; repo: CatalogRepo; model: CatalogModel; d: CatalogDeployment | null
  /** Other models deployed in the same catalog on this host (an undeploy takes them too). */
  otherModels?: string[]
  onAnalyze?: () => void; onPromote?: () => void
}) {
  const { flash, setAsk } = useUi()
  const qc = useQueryClient()
  const git = useGit()
  const e = envOf(env)
  const [branch, setBranch] = useState(d?.branch || repo.defaultBranch)
  useEffect(() => setBranch(d?.branch || repo.defaultBranch), [d?.branch, repo.defaultBranch])

  const deploy = useMutation({
    mutationFn: async () => {
      let key = d?.key
      if (!key) {
        // Not on this host yet: attach the repo + link the model, then deploy it.
        await api.link(host.id, { repoUrl: repo.url, branch, model: model.name })
        const rows = (await api.models(host.id, true)).models
        key = rows.find((r) => r.name === model.name && norm(r.repoUrl || '') === norm(repo.url))?.key
        if (!key) throw new Error(`Linked ${model.name} on ${host.label}, but it isn't listed there yet - refresh and deploy again`)
      }
      return waitForJob(await api.deploy(host.id, [{ key, branch }]))
    },
    onSuccess: (res) => {
      const r = res.results[0]
      if (r && !r.ok) flash(`${host.label}: ${r.error}`, 'err')
      else flash(`${model.name} deployed to ${host.label} · ${r?.branch ?? branch}${r?.commit ? ` ${r.commit.slice(0, 7)}` : ''}`)
    },
    onError: (err) => flash(errMsg(err), 'err'),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['catalog'] })
      qc.invalidateQueries({ queryKey: ['models', host.id] })
      qc.invalidateQueries({ queryKey: ['testCubes', host.id] })
    },
  })

  const undeploy = useMutation({
    mutationFn: () => api.undeploy(host.id, [d!.key]),
    onSuccess: (res) => flash(`Undeployed ${res.catalogs.join(', ') || model.name} on ${host.label}${res.warnings.length ? ` · ${res.warnings.join(' · ')}` : ''}`,
      res.warnings.length ? 'warn' : 'ok'),
    onError: (err) => flash(errMsg(err), 'err'),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['catalog'] })
      qc.invalidateQueries({ queryKey: ['models', host.id] })
      qc.invalidateQueries({ queryKey: ['aggModels', host.id] })
      qc.invalidateQueries({ queryKey: ['testCubes', host.id] })
    },
  })
  // AtScale has no per-model undeploy: the whole catalog goes, every model in it.
  const others = d?.catalog ? (otherModels ?? []).filter((n) => n !== model.name) : []
  const goUndeploy = () => setAsk({
    eyebrow: `${e.label} · ${host.label}`,
    title: `Undeploy ${model.name}?`,
    note: `Undeploys catalog ${d?.catalog ?? ''} on ${host.label} - every model in it${others.length ? ` (also ${others.join(', ')})` : ''} - and drops its aggregates. The repo link stays, so it can be deployed again.${env === 'prod' ? ' This is a production host.' : ''}`,
    label: 'Undeploy',
    tone: 'danger',
    go: () => undeploy.mutate(),
  })

  const label = !d ? 'Link + deploy' : d.status === 'Linked' ? 'Deploy' : d.atHead && branch === d.branch ? 'Redeploy' : 'Deploy head'
  const go = () => setAsk({
    eyebrow: `${e.label} · ${host.label}`,
    title: `${label} ${model.name}?`,
    note: `${!d ? `Attaches ${repo.fullName} to ${host.label}, links the model and deploys` : 'Deploys'} the head of ${branch}.${env === 'prod' ? ' This is a production host.' : ''}`,
    label,
    tone: env === 'prod' ? 'prod' : undefined,
    go: () => deploy.mutate(),
  })

  return (
    <div className="cat-hrow">
      <span className="mono" style={{ color: e.color }}>{e.label}</span>
      <span className="ellipsis" title={host.hostname}>{host.label}</span>
      <span>{d ? <StatusPill status={d.status} /> : <span className="hint">Not on host</span>}</span>
      <span className="row" style={{ gap: 8, flexWrap: 'nowrap', minWidth: 0 }}>
        <BranchSelect compact hostId={host.id} repoUrl={repo.url} value={branch} onChange={setBranch} />
        {d?.version && (
          <span className="mono" title={d.versionInferred ? 'Inferred from the publish time' : undefined} style={{ color: d.atHead === false ? 'var(--warn)' : undefined }}>
            {d.version}{d.versionInferred ? '*' : ''}{d.atHead === false ? ' · behind' : d.atHead ? ' · head' : ''}
          </span>
        )}
      </span>
      <span className="mono">{fmtDate(d?.updated)}</span>
      <span className="row" style={{ gap: 6, justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
        {onAnalyze && <button type="button" className="btn ghost xs" onClick={onAnalyze}>Analyze</button>}
        {onPromote && <button type="button" className="btn ghost xs" onClick={onPromote} title="Open Promote with this host as the source">Promote…</button>}
        {d && d.status !== 'Linked' && (
          <button type="button" className="btn danger xs" disabled={undeploy.isPending || deploy.isPending} onClick={goUndeploy}>
            {undeploy.isPending ? 'Undeploying…' : 'Undeploy'}
          </button>
        )}
        <button type="button" className={`btn xs ${env === 'prod' ? 'solid' : 'primary'}`} style={env === 'prod' ? { background: 'var(--prod)' } : undefined}
          disabled={!git.ready || deploy.isPending || undeploy.isPending} title={git.ready ? undefined : 'Set a working Git profile in Settings first'} onClick={go}>
          {deploy.isPending ? 'Deploying…' : label}
        </button>
      </span>
    </div>
  )
}

/** The model's cube on a host: AtScale names a branch deployment's catalog
 * `<catalog>_<branch>`, so match the cube by name and prefer the recorded catalog. */
function cubeOn(list: CubeRef[] | undefined, model: string, catalog: string | null): CubeRef | null {
  const named = (list ?? []).filter((c) => c.cube === model)
  return named.find((c) => c.catalog === catalog) ?? (named.length === 1 ? named[0] : named.find((c) => !!catalog && c.catalog.startsWith(catalog)) ?? null)
}

/** Status in Validate: what a run across the deployed copies would compare. */
function versionStatus(m: CatalogModel): Finding[] {
  const ds = deployedCopies(m)
  const versions = new Set(ds.map((d) => d.commit).filter(Boolean))
  const out: Finding[] = versions.size > 1
    ? [{ tone: 'warn', text: `${versions.size} versions across ${plural(ds.length, 'host')}` }]
    : [{ tone: 'ok', text: `${versions.size ? 'Same version' : 'Deployed'} on ${plural(ds.length, 'host')}` }]
  const behind = ds.filter((d) => d.atHead === false).length
  if (behind) out.push({ tone: 'warn', text: `${behind} behind branch head` })
  return out
}

/** Validate: the same table as Models, deployed models only; open one, tick the
 * groups / hosts to run on, and run the Validate tab's queries there. */
function CatalogValidate() {
  const keep = useCallback((m: CatalogModel) => deployedCopies(m).length > 0, [])
  return (
    <ModelTable keep={keep} status={versionStatus} chips={deployedCopies}
      detail={(r, m) => <ValidateDetail key={`${r.url}|${m.name}`} repo={r} model={m} />}
      empty="No model is deployed on any host of this business unit yet" />
  )
}

function ValidateDetail({ repo, model }: { repo: CatalogRepo; model: CatalogModel }) {
  const deployed = useMemo(() => deployedCopies(model), [model])
  const cubes = useQueries({
    queries: deployed.map((d) => ({ queryKey: ['testCubes', d.hostId], queryFn: () => testApi.cubes(d.hostId), staleTime: TEST_FRESH_MS })),
  })
  /** undefined = still listing; null = no cube for the model there. */
  const refOn = (i: number): CubeRef | null | undefined =>
    cubes[i]?.isLoading ? undefined : cubeOn(cubes[i]?.data?.cubes, model.name, deployed[i].catalog)

  const [picked, setPicked] = useState<string[]>(() => deployed.map((d) => d.hostId))
  const on = (id: string) => picked.includes(id)
  const toggle = (ids: string[], value: boolean) =>
    setPicked((p) => (value ? [...new Set([...p, ...ids])] : p.filter((x) => !ids.includes(x))))

  const targets = deployed.flatMap((d, i) => {
    const ref = refOn(i)
    return on(d.hostId) && ref ? [{ hostId: d.hostId, ...ref }] : []
  })
  // Queries are generated from the first (lowest-group) host in the run.
  const gen = targets[0] ?? null
  const genDep = deployed.find((d) => d.hostId === gen?.hostId)
  const versions = new Set(deployed.filter((d) => on(d.hostId)).map((d) => d.commit).filter(Boolean))
  const failed = deployed.map((d, i) => ({ d, e: cubes[i]?.error })).filter((x) => x.e)
  const cubeErr = failed.length ? `Couldn't list cubes on ${failed.map((x) => x.d.label).join(', ')}: ${errMsg(failed[0].e)}` : null

  return (
    <div className="cat-detail cat-validate">
      <RunBuilder
        genHostId={gen?.hostId ?? null}
        model={gen ? { catalog: gen.catalog, cube: gen.cube } : null}
        targets={targets}
        error={cubeErr}
        barLeft={(
          <span className="row" style={{ gap: 10 }}>
            <span className="name">{model.name}</span>
            <span className="hint">{repo.fullName}</span>
          </span>
        )}
        barRight={(
          <span className="hint">
            {genDep ? `Queries from ${envOf(genDep.env).label} · ${genDep.label}` : 'Tick where to run'}
            {versions.size > 1 ? ` · ${versions.size} versions - a promotion check` : ''}
          </span>
        )}
        runOn={(
          <div className="cat-hosts">
            {ENVS.map((e) => {
              const inEnv = deployed.map((d, i) => ({ d, i })).filter((x) => x.d.env === e.id)
              if (!inEnv.length) return null
              const usable = inEnv.filter((x) => refOn(x.i) !== null).map((x) => x.d.hostId)
              const allOn = usable.length > 0 && usable.every(on)
              return (
                <Fragment key={e.id}>
                  <label className="cat-vrow env">
                    <input type="checkbox" checked={allOn} disabled={!usable.length} onChange={() => toggle(usable, !allOn)} />
                    <span className="mono" style={{ color: e.color }}>{e.label}</span>
                    <span className="hint">{plural(inEnv.length, 'host')}</span>
                  </label>
                  {inEnv.map(({ d, i }) => {
                    const ref = refOn(i)
                    const off = ref === null
                    const why = cubes[i]?.isError ? errMsg(cubes[i].error) : `No cube named ${model.name} on ${d.label}`
                    return (
                      <label key={d.hostId} className={`cat-vrow ${off ? 'off' : ''}`} title={off ? why : `${ref?.catalog ?? d.catalog ?? ''}${d.branch ? ` · ${d.branch}` : ''}`}>
                        <input type="checkbox" disabled={off} checked={on(d.hostId) && !off} onChange={() => toggle([d.hostId], !on(d.hostId))} />
                        <span className="ellipsis">{d.label}</span>
                        <span className="mono" style={{ color: d.atHead === false ? 'var(--warn)' : undefined }}>
                          {d.branch ?? ''}{d.version ? ` @ ${d.version}` : ''}{d.atHead === false ? ' · behind' : ''}
                        </span>
                        <span className="hint">{ref === undefined ? '…' : cubes[i]?.isError ? "can't read" : off ? 'no cube' : ref.catalog}</span>
                      </label>
                    )
                  })}
                </Fragment>
              )
            })}
          </div>
        )}
      />
    </div>
  )
}
