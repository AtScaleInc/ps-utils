import { useQuery } from '@tanstack/react-query'
import { Fragment, useState, type ReactNode } from 'react'
import {
  api, type AuditAttr, type AuditDataset, type AuditDimension, type AuditFinding, type AuditJoin, type AuditMetric, type AuditNotes,
  type BusCell, type CalcGroup, type Host, type ModelAudit, type Spec,
} from '../api'
import { useUi } from '../store'
import { HostHero } from './ManageView'
import { StatusPill, errMsg, fmtDate, plural } from './ui'
import './analyze.css'

type Tab = 'overview' | 'relationships' | 'time' | 'metrics' | 'dimensions' | 'datasets' | 'joins' | 'other' | 'properties'

/** Manage › Analyze: an audit of one model - everything its SML defines (read
 * from Git at the deployed commit) with every documented property, descriptions
 * and YAML comments, plus what the host actually serves (DMV + aggregates). */
export function ManageAnalyze({ host }: { host: Host }) {
  const { manage, setManage } = useUi()
  const [tab, setTab] = useState<Tab>('overview')
  const [file, setFile] = useState<string | null>(null)
  const models = useQuery({ queryKey: ['models', host.id], queryFn: () => api.models(host.id) })
  const list = (models.data?.models ?? []).filter((m) => m.repoUrl)
    .sort((a, b) => Number(a.status === 'Linked') - Number(b.status === 'Linked') || a.name.localeCompare(b.name))
  const model = list.find((m) => m.key === manage.analyzeKey) ?? list[0] ?? null
  const audit = useQuery({
    queryKey: ['analyze', host.id, model?.key], queryFn: () => api.analyze(host.id, model!.key), enabled: !!model, retry: false,
  })
  const a = audit.data
  const q = manage.q.trim().toLowerCase()

  const exportJson = () => {
    if (!a) return
    const blob = new Blob([JSON.stringify(a, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `${a.model.label.replace(/[^\w.-]+/g, '_')}-audit-${a.source.ref.slice(0, 12)}.json`
    link.click()
    URL.revokeObjectURL(url)
  }

  const c = a?.counts
  const tabs: { id: Tab; label: string; n?: number }[] = a && c ? [
    { id: 'overview', label: 'Overview' },
    { id: 'relationships', label: 'Relationships', n: a.busMatrix.facts.length },
    { id: 'time', label: 'Time & calcs', n: c.timeDimensions + c.calculationGroups + c.timeCalculations },
    { id: 'metrics', label: 'Metrics', n: a.metrics.length },
    { id: 'dimensions', label: 'Dimensions', n: a.dimensions.length },
    { id: 'datasets', label: 'Datasets', n: a.datasets.length },
    { id: 'joins', label: 'Joins', n: a.joins.length },
    { id: 'other', label: 'Other', n: a.connections.length + a.rowSecurity.length + a.perspectives.length + a.drillthroughs.length + a.aggregates.length + a.partitions.length + a.overrides.length + a.unused.length },
    { id: 'properties', label: 'SML Properties', n: a.propertyUsage.filter((u) => u.count).length },
  ] : []

  return (
    <div className="col an">
      <HostHero host={host} count={a ? plural(a.metrics.length + a.dimensions.length + a.datasets.length, 'object') : plural(list.length, 'model')} />
      <div className="toolbar">
        <span className="label">Model</span>
        <select className="select sm an-model" value={model?.key ?? ''} disabled={!list.length}
          onChange={(e) => setManage({ analyzeKey: e.target.value })}>
          {!list.length && <option value="">No models on this host</option>}
          {list.map((m) => <option key={m.key} value={m.key}>{m.name}{m.status === 'Linked' ? ' · linked only' : ''}</option>)}
        </select>
        {model && <StatusPill status={model.status} />}
        {a && (
          <span className="mono muted ellipsis" style={{ minWidth: 0 }} title={a.source.repoUrl}>
            {a.source.repoUrl.replace(/^https?:\/\/(www\.)?github\.com\//, '')} @ {a.source.atCommit ? (a.source.commit ?? '').slice(0, 7) : a.source.ref}
            {a.source.atCommit && a.source.branch ? ` · ${a.source.branch}` : ''}
            {!a.source.atCommit && ' · branch head (no deployed commit known)'}
          </span>
        )}
        <span style={{ marginLeft: 'auto' }} />
        <button type="button" className="btn info" disabled={!a} onClick={exportJson} title="The whole audit as JSON">Export JSON</button>
      </div>

      {a && (
        <div className="an-tabs">
          {tabs.map((t) => (
            <button key={t.id} type="button" className={`an-tab ${tab === t.id ? 'on' : ''}`} onClick={() => setTab(t.id)}>
              {t.label}{t.n !== undefined && <span className="c">{t.n}</span>}
            </button>
          ))}
        </div>
      )}

      <div className="scroll">
        {models.isError || audit.isError ? (
          <div className="notice err" style={{ margin: 0 }}><span className="eyebrow" style={{ color: 'var(--danger)' }}>Error</span>{errMsg(models.error ?? audit.error)}</div>
        ) : !model ? (
          models.isLoading ? <div className="empty">Loading…</div> : <div className="empty">No model with a Git repo on this host — link or deploy one first</div>
        ) : !a ? (
          <div className="empty">Reading {model.name}'s SML from Git…</div>
        ) : (
          <>
            {tab === 'overview' && <Overview a={a} onFile={setFile} />}
            {tab === 'relationships' && <Relationships a={a} q={q} />}
            {tab === 'time' && <TimeCalcs a={a} q={q} />}
            {tab === 'metrics' && <Metrics a={a} q={q} onFile={setFile} />}
            {tab === 'dimensions' && <Dimensions a={a} q={q} onFile={setFile} />}
            {tab === 'datasets' && <Datasets a={a} q={q} onFile={setFile} />}
            {tab === 'joins' && <Joins a={a} q={q} />}
            {tab === 'other' && <Other a={a} q={q} onFile={setFile} />}
            {tab === 'properties' && <Properties a={a} q={q} />}
          </>
        )}
      </div>
      {file && model && <FileDrawer hostId={host.id} modelKey={model.key} path={file} onClose={() => setFile(null)} />}
    </div>
  )
}

// -- helpers ----------------------------------------------------------------------------------

const hit = (q: string, ...parts: unknown[]) => !q || JSON.stringify(parts).toLowerCase().includes(q)
const fmtBool = (b: boolean | null | undefined) => (b === true ? 'on' : b === false ? 'off' : 'default')

function Notes({ n }: { n: AuditNotes }) {
  if (!n.description && !n.comments?.length) return null
  return (
    <div className="an-notes">
      {n.description && <div><span className="label">Description</span> {n.description}</div>}
      {n.comments?.map((c, i) => <div key={i} className="an-comment"># {c}</div>)}
    </div>
  )
}

function NoteMark({ n }: { n: AuditNotes }) {
  const k = (n.description ? 1 : 0) + (n.comments?.length ?? 0)
  return k ? <span className="an-mark" title={[n.description, ...(n.comments ?? []).map((c) => `# ${c}`)].filter(Boolean).join('\n')}>✎{k > 1 ? k : ''}</span> : null
}

function val(v: unknown): ReactNode {
  if (v === null || v === undefined) return <span className="muted">—</span>
  if (typeof v === 'boolean') return String(v)
  if (typeof v === 'string' || typeof v === 'number') return String(v)
  if (Array.isArray(v) && v.every((x) => typeof x !== 'object' || x === null)) return v.join(', ')
  return <code className="an-json">{JSON.stringify(v, null, 1).replace(/\n\s*/g, ' ')}</code>
}

/** Every documented SML property the object sets, plus undocumented keys. */
function Props({ o, title = 'SML properties' }: { o: Spec; title?: string }) {
  const p = Object.entries(o.props ?? {})
  const x = Object.entries(o.extra ?? {})
  if (!p.length && !x.length) return null
  return (
    <div className="an-props">
      <span className="label">{title}</span>
      <dl className="an-dl">
        {p.map(([k, v]) => <Fragment key={k}><dt>{k}</dt><dd className="mono">{val(v)}</dd></Fragment>)}
        {x.map(([k, v]) => <Fragment key={k}><dt title="Not in the SML reference">{k} <span className="an-tag warn">undoc</span></dt><dd className="mono">{val(v)}</dd></Fragment>)}
      </dl>
    </div>
  )
}

function FileBtn({ path, onFile }: { path: string | null | undefined; onFile: (p: string) => void }) {
  if (!path) return null
  return <button type="button" className="an-file" title="View YAML" onClick={(e) => { e.stopPropagation(); onFile(path) }}>{path}</button>
}

function Tag({ children, tone, title }: { children: ReactNode; tone?: 'warn' | 'dev' | 'prod' | 'qa' | 'muted'; title?: string }) {
  return <span className={`an-tag ${tone ?? ''}`} title={title}>{children}</span>
}

function Section({ title, note, children }: { title: string; note?: ReactNode; children: ReactNode }) {
  return (
    <section className="an-sec">
      <div className="an-sec-h"><span className="eyebrow">{title}</span>{note && <span className="hint">{note}</span>}</div>
      {children}
    </section>
  )
}

interface Sub<T extends string> { id: T; label: string; n?: ReactNode }

/** The switch every Analyze tab opens with: one view at a time, "label · count". */
function SubTabs<T extends string>({ items, value, onChange, right }: {
  items: Sub<T>[]; value: T; onChange: (v: T) => void; right?: ReactNode
}) {
  return (
    <div className="an-subtabs">
      <div className="an-subtabs-l">
      {items.map((s) => (
        <button key={s.id} type="button" className={`an-chip sm ${value === s.id ? 'on' : ''} ${s.n === 0 ? 'zero' : ''}`} onClick={() => onChange(s.id)}>
          {s.label}{s.n !== undefined && <span className="n"> · {s.n}</span>}
        </button>
      ))}
      </div>
      {right && <span className="an-subtabs-r">{right}</span>}
    </div>
  )
}

function useExpand() {
  const [open, setOpen] = useState<Set<string>>(new Set())
  const toggle = (k: string) => setOpen((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n })
  return { open, toggle }
}

const role = (t: string | null | undefined) => (t ? t.replace('{0}', '…') : '')

// -- overview ---------------------------------------------------------------------------------

function Overview({ a, onFile }: { a: ModelAudit; onFile: (p: string) => void }) {
  const c = a.counts
  const tiles: { v: number; l: string; s?: string; tone?: string }[] = [
    { v: c.metrics, l: 'Metrics', s: `${c.semiAdditive} semi · ${c.nonAdditive} non-additive`, tone: 'var(--prod)' },
    { v: c.calculations, l: 'Calculations', s: `${c.timeCalculations} time-relative`, tone: 'var(--prod)' },
    { v: c.dimensions, l: 'Dimensions', s: `${c.degenerateDimensions} degenerate · ${c.timeDimensions} time`, tone: 'var(--dev)' },
    { v: c.hierarchies, l: 'Hierarchies', s: `${plural(c.levels, 'level')} · ${c.defaultMembers} default members`, tone: 'var(--dev)' },
    { v: c.levelAttributes + c.secondaryAttributes + c.aliases + c.metricalAttributes, l: 'Attributes', s: `${c.levelAttributes} level · ${c.secondaryAttributes} secondary · ${c.aliases} alias · ${c.metricalAttributes} metrical`, tone: 'var(--dev)' },
    { v: c.rolePlays, l: 'Role plays', s: `${c.rolePlayRelationships} relationships · ${plural(c.rolePlayedDimensions, 'dim')}`, tone: 'var(--dev)' },
    { v: c.calculationGroups, l: 'Calc groups', s: plural(c.calculatedMembers, 'member'), tone: 'var(--dev)' },
    { v: c.parallelPeriods, l: 'Parallel periods', tone: 'var(--dev)' },
    { v: c.datasets, l: 'Datasets', s: `${c.factDatasets} fact · ${c.queryDatasets} SQL · ${c.incrementalDatasets} incremental`, tone: 'var(--qa)' },
    { v: c.connections, l: 'Connections', tone: 'var(--qa)' },
    { v: c.joins, l: 'Joins', s: `${c.factJoins} fact · ${c.snowflakeJoins} snowflake · ${c.embeddedJoins} embedded`, tone: 'var(--qa)' },
    { v: c.m2m, l: 'Many-to-many', tone: c.m2m ? 'var(--warn)' : undefined },
    { v: c.calculatedColumns, l: 'Calc columns', s: `${c.mapColumns} map`, tone: 'var(--qa)' },
    { v: c.constraintTranslations, l: 'Constraint transl.' },
    { v: c.perspectives, l: 'Perspectives' },
    { v: c.drillthroughs, l: 'Drill-throughs' },
    { v: c.userAggregates, l: 'User aggs (SML)', s: `${c.partitions} partition hints` },
    { v: c.rowSecurity, l: 'Row security' },
    { v: c.overrides, l: 'Overrides' },
    { v: c.undocumentedKeys, l: 'Undocumented keys', tone: c.undocumentedKeys ? 'var(--warn)' : undefined },
  ]
  const groups = ['references', 'rules', 'design', 'documentation']
  const lv = (l: string) => a.findings.filter((f) => f.level === l).length
  const [view, setView] = useState<'summary' | 'host' | 'shape' | 'findings'>('summary')
  return (
    <div className="an-grid">
      <SubTabs value={view} onChange={setView} items={[
        { id: 'summary', label: 'Summary' },
        { id: 'host', label: 'Deployed on host', n: a.deployed ? (a.deployed.dmv ? 'live' : 'DMV error') : 'linked only' },
        { id: 'shape', label: 'Shape', n: plural(Object.keys(a.calculationMethods).length, 'method') },
        { id: 'findings', label: 'Findings', n: `${lv('error')} error · ${lv('warn')} warn · ${lv('info')} info` },
      ]} />
      {view === 'summary' && <>
      <div className="an-card an-head">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
          <span className="eyebrow">{a.model.composite ? 'Composite model' : 'Model'} · {a.catalog?.label ?? a.source.catalog}</span>
          <span className="display" style={{ fontSize: 26 }}>{a.model.label}</span>
          <span className="mono muted">unique_name: {a.model.name}{a.model.composite && ` · models: ${a.model.members.join(', ')}`}</span>
          <Notes n={a.model} />
          <Props o={a.model} title="Model properties" />
        </div>
        <dl className="an-dl">
          <dt>Deployed</dt><dd>{fmtDate(a.source.updated, true)}</dd>
          <dt>Commit</dt><dd className="mono">{a.source.commit ? `${a.source.commit.slice(0, 10)}${a.source.versionInferred ? ' (inferred)' : ''}` : '—'} {a.source.commitDate && <span className="muted">{fmtDate(a.source.commitDate, true)}</span>}</dd>
          <dt>Branch</dt><dd className="mono">{a.source.branch ?? '—'}</dd>
          <dt>Catalog</dt><dd className="mono">{a.catalog ? `${a.catalog.name} · SML v${a.catalog.version ?? '?'}` : '—'}</dd>
          <dt>Agg settings</dt><dd className="mono">{a.catalog ? `aggressive promotion ${fmtBool(a.catalog.aggressiveAggPromotion)} · speculative ${fmtBool(a.catalog.buildSpeculativeAggs)}` : '—'}</dd>
          {a.catalog && a.catalog.hiddenModels.length > 0 && <><dt>Hidden models</dt><dd>{a.catalog.hiddenModels.join(', ')}</dd></>}
          {a.model.degenerateDimensions.length > 0 && <><dt>Degenerate dims</dt><dd>{a.model.degenerateDimensions.join(', ')}</dd></>}
          <dt>Files</dt><dd className="mono">{c.files} YAML <FileBtn path={a.model.file} onFile={onFile} /> <FileBtn path={a.catalog?.file} onFile={onFile} /></dd>
          {a.package && <><dt>Packages</dt><dd className="mono">{a.package.packages.map((p) => `${p.name}@${p.branch}`).join(', ')}</dd></>}
          {a.otherModels.length > 0 && <><dt>Same repo</dt><dd>{a.otherModels.join(', ')}</dd></>}
        </dl>
      </div>

      <div className="an-tiles">
        {tiles.map((t) => (
          <div key={t.l} className="an-tile" style={{ borderTopColor: t.tone ?? 'var(--off)' }}>
            <span className="label">{t.l}</span>
            <span className="an-v">{t.v}</span>
            {t.s && <span className="hint" style={{ textTransform: 'none', letterSpacing: 0 }}>{t.s}</span>}
          </div>
        ))}
      </div>
      </>}

      {view === 'host' && <Section title="Deployed on host" note={a.deployed ? 'DMV + aggregates, live' : undefined}>
          {!a.deployed ? <div className="muted an-pad">Linked only — nothing deployed, so only the SML is analysed.</div> : (
            <div className="an-pad" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {a.deployed.dmv ? (
                <>
                  <div className="an-mini">
                    <span><b>{a.deployed.dmv.measures}</b> measures</span><span><b>{a.deployed.dmv.dimensions}</b> dimensions</span>
                    <span><b>{a.deployed.dmv.hierarchies}</b> hierarchies</span><span><b>{a.deployed.dmv.levels}</b> levels</span>
                  </div>
                  <div className="muted" style={{ fontSize: 12 }}>
                    XMLA <span className="mono">{a.deployed.dmv.catalog} › {a.deployed.dmv.cube}</span>. SML lists {a.metrics.filter((m) => !m.hidden).length} visible metrics + calculations. Role-plays expand dimensions and levels on the host.
                  </div>
                  {a.deployed.dmv.missingFromHost.length > 0 && <Finding level="warn" group="" text={`${a.deployed.dmv.missingFromHost.length} SML metric(s) not served by the host`} items={a.deployed.dmv.missingFromHost} />}
                  {a.deployed.dmv.notInSml.length > 0 && <Finding level="warn" group="" text={`${a.deployed.dmv.notInSml.length} host measure(s) not in this SML`} items={a.deployed.dmv.notInSml} />}
                  {!a.deployed.dmv.missingFromHost.length && !a.deployed.dmv.notInSml.length && <Finding level="info" group="" text="Host measures match the SML" items={[]} />}
                </>
              ) : <div className="muted" style={{ fontSize: 12 }}>DMV not read: {a.deployed.dmvError}</div>}
              {a.deployed.aggregates ? (
                <div className="an-mini">
                  <span><b>{a.deployed.aggregates.total}</b> aggregates</span><span><b>{a.deployed.aggregates.system}</b> system</span>
                  <span><b>{a.deployed.aggregates.user}</b> user</span><span><b>{a.deployed.aggregates.active}</b> active</span>
                  {Object.entries(a.deployed.aggregates.byStatus).map(([s, n]) => <span key={s}><b>{n}</b> {s.toLowerCase()}</span>)}
                </div>
              ) : <div className="muted" style={{ fontSize: 12 }}>Aggregates not read: {a.deployed.aggregatesError}</div>}
            </div>
          )}
        </Section>}
      {view === 'shape' && <Section title="Shape" note="calculation methods, formats, folders, role plays, connections">
          <div className="an-pad" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <Chips label="Calculation methods" m={a.calculationMethods} />
            <Chips label="Formats" m={a.formats} />
            <Chips label="Folders" m={a.folders} />
            <div>
              <span className="label">Role plays</span>
              {a.rolePlays.length ? a.rolePlays.map((r) => (
                <div key={r.dimension} style={{ fontSize: 12.5, marginTop: 4 }}>
                  {r.dimension} <span className="muted">as</span> {r.roles.map((x) => <Tag key={x.template} tone="dev">{role(x.template)} ×{x.relationships}</Tag>)}
                </div>
              )) : <div className="muted" style={{ fontSize: 12 }}>None</div>}
            </div>
            <div>
              <span className="label">Connections</span>
              {a.connections.map((cn) => <div key={cn.name} className="mono" style={{ marginTop: 4 }}>{cn.label} <span className="muted">→ {cn.asConnection} · {[cn.database, cn.schema].filter(Boolean).join('.')}</span></div>)}
            </div>
          </div>
        </Section>}

      {view === 'findings' && <Section title="Findings" note={`${lv('error')} error · ${lv('warn')} warning · ${lv('info')} info`}>
        <div className="an-pad" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {!a.findings.length && <span className="muted">Nothing to flag.</span>}
          {groups.map((g) => {
            const fs = a.findings.filter((f) => f.group === g)
            return fs.length ? (
              <div key={g} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span className="label">{g === 'rules' ? 'SML reference rules' : g}</span>
                {fs.map((f, i) => <Finding key={i} {...f} />)}
              </div>
            ) : null
          })}
        </div>
      </Section>}
    </div>
  )
}

function Chips({ label, m }: { label: string; m: Record<string, number> }) {
  return (
    <div>
      <span className="label">{label}</span>
      <div className="an-chips">{Object.entries(m).map(([k, n]) => <Tag key={k}>{k} · {n}</Tag>)}</div>
    </div>
  )
}

function Finding({ level, text, items }: AuditFinding) {
  const [open, setOpen] = useState(false)
  return (
    <div className={`an-find ${level}`}>
      <button type="button" className="an-find-h" onClick={() => setOpen(!open)} disabled={!items.length}>
        <span className="an-lvl">{level}</span><span style={{ flex: 1 }}>{text}</span>
        {items.length > 0 && <span className="hint">{open ? 'Hide' : `Show ${items.length}`}</span>}
      </button>
      {open && <div className="an-find-items">{items.map((x, i) => <span key={i}>{x}</span>)}</div>}
    </div>
  )
}

// -- relationships: fact × dimension matrix, diagram, metric reach ------------------------------

/** "Order {0}" applied to a hierarchy / level label, as the deployed cube names it. */
const played = (t: string | null | undefined, s: string) => (t && t.includes('{0}') ? t.replace('{0}', s) : s)

interface RelRef { mdx: string; key: string; role: string | null; m2m: boolean }

/** The [Hierarchy].[Level] references one fact → dimension cell resolves to: every
 * hierarchy holding the joined level, role-played; degenerate dims list each
 * hierarchy's leaf. `key` is fact (or parent dimension) columns → level key. */
function relRefs(d: AuditDimension | undefined, cells: BusCell[]): RelRef[] {
  const out: RelRef[] = []
  const seen = new Set<string>()
  const push = (r: RelRef) => { if (!seen.has(r.mdx + r.key)) { seen.add(r.mdx + r.key); out.push(r) } }
  for (const c of cells) {
    if (!d) { push({ mdx: `${c.level ?? '?'}`, key: c.columns.join(', '), role: c.rolePlay, m2m: !!c.m2m }); continue }
    if (c.how === 'degenerate') {
      for (const h of d.hierarchies) {
        const leaf = h.levels[h.levels.length - 1]
        const la = d.levelAttributes.find((x) => x.name === leaf?.name)
        push({ mdx: `[${h.label}].[${leaf?.label ?? '?'}]`, key: la ? `${(la.keyColumns.length ? la.keyColumns : [la.nameColumn ?? '']).join(', ')} (fact column)` : '', role: null, m2m: false })
      }
      continue
    }
    const la = d.levelAttributes.find((x) => x.name === c.level)
    const label = la?.label ?? c.level ?? '?'
    const key = `${c.columns.join(', ')} → ${la?.keyColumns.join(', ') || c.level}`
    const hs = d.hierarchies.filter((h) => h.levels.some((l) => l.name === c.level))
    if (!hs.length) push({ mdx: `[${played(c.rolePlay, d.label)}].[${played(c.rolePlay, label)}]`, key, role: c.rolePlay, m2m: !!c.m2m })
    for (const h of hs) push({ mdx: `[${played(c.rolePlay, h.label)}].[${played(c.rolePlay, label)}]`, key, role: c.rolePlay, m2m: !!c.m2m })
  }
  return out
}

function DimIcon({ d }: { d: AuditDimension | undefined }) {
  const kind = !d ? 'dim' : d.type === 'time' ? 'time' : d.degenerate ? 'degen' : 'dim'
  const t = kind === 'time' ? 'Time dimension' : kind === 'degen' ? 'Degenerate dimension (fact columns)' : 'Dimension'
  return (
    <svg className={`an-dimicon ${kind}`} width="14" height="14" viewBox="0 0 14 14" aria-label={t}><title>{t}</title>
      {kind === 'time' ? <><circle cx="7" cy="7" r="6" /><path d="M7 3.5V7l2.5 1.5" className="hand" /></>
        : kind === 'degen' ? <><rect x="1" y="2" width="12" height="10" rx="1" className="o" /><path d="M1 5.5h12M1 9h12M5 2v10" className="o" /></>
          : <><rect x="1" y="2" width="12" height="2.6" rx=".6" /><rect x="1" y="5.7" width="12" height="2.6" rx=".6" /><rect x="1" y="9.4" width="12" height="2.6" rx=".6" /></>}
    </svg>
  )
}

function Relationships({ a, q }: { a: ModelAudit; q: string }) {
  const b = a.busMatrix
  const byName = Object.fromEntries(a.dimensions.map((d) => [d.name, d]))
  const [view, setView] = useState<'matrix' | 'diagram' | 'reach'>('matrix')
  // Rows: dimensions a fact reaches directly (joins + degenerate), then the ones reached through them.
  const direct = b.dimensions.filter((d) => b.facts.some((f) => f.cells[d]?.some((c) => c.how !== 'embedded')))
  const via = (d: string) => {
    for (const f of b.facts) for (const c of f.cells[d] ?? []) if (c.how === 'embedded' && c.path) return c.path.slice(0, -1)
    return []
  }
  const embedded = b.dimensions.filter((d) => !direct.includes(d) && b.facts.some((f) => f.cells[d]))
  const unreached = b.dimensions.filter((d) => !b.facts.some((f) => f.cells[d]))
  const ordered: { name: string; depth: number; parent: string | null }[] = []
  const place = (d: string, depth: number) => {
    if (ordered.some((o) => o.name === d)) return
    ordered.push({ name: d, depth, parent: depth ? via(d).slice(-1)[0] ?? null : null })
    for (const e of embedded) if (via(e).slice(-1)[0] === d) place(e, depth + 1)
  }
  direct.forEach((d) => place(d, 0))
  embedded.forEach((d) => place(d, 1))
  const rows = ordered.filter((r) => hit(q, r.name, byName[r.name]?.label) || b.facts.some((f) => hit(q, f.cells[r.name])))
  return (
    <div className="an-grid">
      <SubTabs value={view} onChange={setView} items={[
        { id: 'matrix', label: 'Matrix', n: plural(rows.length, 'dimension') },
        { id: 'diagram', label: 'Diagram', n: plural(b.facts.length, 'fact dataset') },
        { id: 'reach', label: 'Metric reach', n: plural(b.metricReach.length, 'metric') },
      ]} />
      {view === 'matrix' && <Section title="Dimensions × fact datasets" note={`${plural(b.facts.length, 'fact dataset')} · ${plural(direct.length, 'joined dimension')} · ${embedded.length} through another dimension${b.conformed.length ? ` · ${b.conformed.length} conformed` : ''}`}>
        <div style={{ overflowX: 'auto' }}>
          <table className="an-rel">
            <thead>
              <tr>
                <th className="an-rel-dim">Dimensions</th>
                {b.facts.map((f) => (
                  <th key={f.dataset}>
                    <div className="an-rel-fact">{f.dataset}</div>
                    <div className="hint" style={{ textTransform: 'none', letterSpacing: 0 }}>{plural(f.metrics.length, 'metric')}</div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const d = byName[r.name]
                return (
                  <tr key={r.name} className={r.depth ? 'emb' : ''}>
                    <td className="an-rel-dim">
                      <div className="an-rel-dname" style={{ paddingLeft: r.depth * 18 }}>
                        {r.depth > 0 && <span className="muted">↳</span>}
                        <DimIcon d={d} />
                        <span className="name">{d?.label ?? r.name}</span>
                        {b.conformed.includes(r.name) && <Tag tone="prod" title="Shared by several fact datasets">conformed</Tag>}
                      </div>
                      <div className="an-rel-sub" style={{ paddingLeft: r.depth * 18 + 22 }}>
                        {r.depth > 0 && r.parent ? `via ${byName[r.parent]?.label ?? r.parent} · ` : ''}{d?.datasets.join(', ')}
                      </div>
                    </td>
                    {b.facts.map((f) => {
                      const cs = f.cells[r.name]
                      if (!cs) return <td key={f.dataset} className="an-rel-none" title="Not related: unrelated_dimensions_handling applies">—</td>
                      const refs = relRefs(d, cs)
                      return (
                        <td key={f.dataset}>
                          {refs.map((x, i) => (
                            <div key={i} className="an-rel-ref">
                              <span className="an-rel-mdx">{x.mdx}{x.m2m && <Tag tone="warn">m2m</Tag>}</span>
                              <span className="an-rel-key">{x.key}</span>
                            </div>
                          ))}
                        </td>
                      )
                    })}
                  </tr>
                )
              })}
              {unreached.length > 0 && (
                <tr><td colSpan={b.facts.length + 1} className="an-rel-sub" style={{ padding: '10px 14px' }}>Not reached by any fact: {unreached.join(', ')}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Section>}

      {view === 'diagram' && <Section title="Relationship diagram" note="fact → dimension → embedded / snowflake">
        <Diagram a={a} />
      </Section>}

      {view === 'reach' && <Section title="Metric reach" note="which dimensions each metric can be sliced by">
          <div className="table flat">
            <div className="tr th grid-an-r"><span>Metric</span><span>Dataset</span><span>Sliceable by</span><span>Not related</span><span>Unrelated handling</span></div>
            {b.metricReach.filter((m) => hit(q, m)).map((m) => (
              <div key={m.metric} className="tr grid-an-r" style={{ cursor: 'default', height: 'auto', minHeight: 36, padding: '6px 18px' }}>
                <span className="name ellipsis">{m.metric}</span>
                <span className="mono muted ellipsis">{m.dataset}</span>
                <span style={{ fontSize: 12 }} title={m.dimensions.join(', ')}>
                  {!m.unrelated.length ? <span className="muted">All {plural(m.dimensions.length, 'dimension')}</span> : m.dimensions.join(', ')}
                </span>
                <span style={{ fontSize: 12, color: m.unrelated.length ? 'var(--warn)' : undefined }}>{m.unrelated.join(', ') || '—'}</span>
                <span className="mono">{m.handling ?? <span className="muted">default</span>}</span>
              </div>
            ))}
            {!b.metricReach.length && <div className="empty">No metric with a dataset</div>}
          </div>
      </Section>}
    </div>
  )
}

/** Layered SVG: fact datasets → dimensions they join → dimensions those embed / snowflake. */
function Diagram({ a }: { a: ModelAudit }) {
  const layer = new Map<string, number>()
  const facts = a.busMatrix.facts.map((f) => f.dataset)
  facts.forEach((f) => layer.set(`f:${f}`, 0))
  const edges: { from: string; to: string; label: string; kind: string }[] = []
  for (const j of a.joins) {
    if (j.kind === 'fact' && j.fromDataset && j.toDimension) {
      layer.set(`d:${j.toDimension}`, Math.min(layer.get(`d:${j.toDimension}`) ?? 1, 1))
      edges.push({ from: `f:${j.fromDataset}`, to: `d:${j.toDimension}`, label: role(j.rolePlay), kind: 'fact' })
    }
  }
  for (const d of a.dimensions) if (d.degenerate) {
    for (const ds of d.datasets) if (facts.includes(ds)) {
      layer.set(`d:${d.name}`, 1)
      edges.push({ from: `f:${ds}`, to: `d:${d.name}`, label: '', kind: 'degenerate' })
    }
  }
  let changed = true
  while (changed) {
    changed = false
    for (const j of a.joins) {
      if (j.kind !== 'embedded' || !j.toDimension) continue
      const from = layer.get(`d:${j.owner}`)
      if (from === undefined) continue
      const want = from + 1
      if ((layer.get(`d:${j.toDimension}`) ?? Infinity) > want) { layer.set(`d:${j.toDimension}`, want); changed = true }
    }
  }
  for (const j of a.joins) if (j.kind === 'embedded' && j.toDimension) {
    edges.push({ from: `d:${j.owner}`, to: `d:${j.toDimension}`, label: [role(j.rolePlay), j.m2m ? 'm2m' : ''].filter(Boolean).join(' · '), kind: 'embedded' })
  }
  const snow = new Map<string, number>()
  for (const j of a.joins) if (j.kind === 'snowflake') snow.set(j.owner, (snow.get(j.owner) ?? 0) + 1)
  const cols: string[][] = []
  for (const [k, l] of layer) (cols[l] ??= []).push(k)
  cols.forEach((c) => c.sort())
  const W = 230, BW = 190, BH = 34, GAP = 14, PAD = 16
  const rows = Math.max(1, ...cols.map((c) => c.length))
  const height = PAD * 2 + rows * (BH + GAP)
  const pos = new Map<string, { x: number; y: number }>()
  cols.forEach((c, i) => c.forEach((k, j) => {
    const off = (rows - c.length) * (BH + GAP) / 2
    pos.set(k, { x: PAD + i * W, y: PAD + off + j * (BH + GAP) })
  }))
  // One edge per pair; role plays (Order / Ship ...) become one combined label.
  const merged = new Map<string, { from: string; to: string; labels: Set<string>; kind: string }>()
  for (const e of edges) {
    const k = `${e.from}|${e.to}`
    const m = merged.get(k) ?? { from: e.from, to: e.to, labels: new Set<string>(), kind: e.kind }
    if (e.label) m.labels.add(e.label)
    merged.set(k, m)
  }
  const uniq = [...merged.values()].map((m) => ({ ...m, label: [...m.labels].join(' · ') }))
  const width = PAD * 2 + Math.max(1, cols.length) * W - (W - BW)
  return (
    <div className="an-pad" style={{ overflowX: 'auto' }}>
      <svg width={width} height={height} className="an-diagram" role="img" aria-label="Relationship diagram">
        {uniq.map((e, i) => {
          const s = pos.get(e.from), t = pos.get(e.to)
          if (!s || !t) return null
          const x1 = s.x + BW, y1 = s.y + BH / 2, x2 = t.x, y2 = t.y + BH / 2
          const mx = (x1 + x2) / 2
          return (
            <g key={i}>
              <path d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`} className={`an-edge ${e.kind}`} />
              {e.label && <text x={mx} y={(y1 + y2) / 2 - 3} className="an-edge-l" textAnchor="middle">{e.label}</text>}
            </g>
          )
        })}
        {[...pos].map(([k, p]) => {
          const fact = k.startsWith('f:')
          const name = k.slice(2)
          const d = a.dimensions.find((x) => x.name === name)
          const n = snow.get(name)
          return (
            <g key={k} transform={`translate(${p.x},${p.y})`}>
              <rect width={BW} height={BH} rx={3} className={`an-node ${fact ? 'fact' : d?.type === 'time' ? 'time' : d?.degenerate ? 'degen' : 'dim'}`} />
              <text x={10} y={BH / 2 + 4} className="an-node-t">{name.length > 24 ? `${name.slice(0, 23)}…` : name}<title>{name}</title></text>
              {n ? <text x={BW - 8} y={BH / 2 + 4} textAnchor="end" className="an-node-s">❄{n}</text> : null}
            </g>
          )
        })}
      </svg>
      <div className="hint" style={{ textTransform: 'none', letterSpacing: 0 }}>Orange: fact dataset · teal: time dimension · blue: dimension · grey: degenerate · ❄n: snowflake joins inside the dimension · dashed: embedded.</div>
    </div>
  )
}

// -- time & calculation groups ---------------------------------------------------------------------

function TimeCalcs({ a, q }: { a: ModelAudit; q: string }) {
  const ti = a.timeIntelligence
  const [view, setView] = useState<'dims' | 'groups' | 'calcs' | 'semi'>('dims')
  const members = ti.calculationGroups.reduce((n, g) => n + g.members.length, 0)
  return (
    <div className="an-grid">
      <SubTabs value={view} onChange={setView} items={[
        { id: 'dims', label: 'Time dimensions', n: plural(ti.dimensions.length, 'dimension') },
        { id: 'groups', label: 'Calculation groups', n: `${plural(ti.calculationGroups.length, 'group')} · ${plural(members, 'member')}` },
        { id: 'calcs', label: 'Time calculations', n: plural(ti.calculations.length, 'calculation') },
        { id: 'semi', label: 'Semi-additive', n: plural(ti.semiAdditive.length, 'metric') },
      ]} />
      {view === 'dims' && <Section title="Time dimensions" note={plural(ti.dimensions.length, 'dimension')}>
        <div className="an-pad" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {!ti.dimensions.length && <span className="muted">No time dimension.</span>}
          {ti.dimensions.filter((d) => hit(q, d)).map((d) => (
            <div key={d.name} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div><span className="name">{d.label}</span> <Tag tone="qa">{d.type}</Tag>{d.roles.map((r) => <Tag key={r} tone="dev">{role(r)}</Tag>)}</div>
              <div className="an-hiers">
                {d.hierarchies.map((h) => (
                  <div key={h.name} className="an-hier">
                    <span className="label">{h.label}</span>
                    <div className="an-levels">
                      {h.levels.map((l, i) => <Fragment key={l.name}>{i > 0 && <span className="muted">›</span>}<span>{l.label} {l.timeUnit ? <Tag tone="qa">{l.timeUnit}</Tag> : <Tag tone="warn" title="No time_unit">?</Tag>}</span></Fragment>)}
                    </div>
                  </div>
                ))}
              </div>
              {d.parallelPeriods.length > 0 && (
                <div>
                  <span className="label">Parallel periods</span>
                  {d.parallelPeriods.map((p, i) => <div key={i} className="mono" style={{ marginTop: 3 }}>{p.hierarchy} › {p.level} <span className="muted">→ {p.toLevel} on {p.keyColumns.join(', ')}</span></div>)}
                </div>
              )}
            </div>
          ))}
        </div>
      </Section>}

      {view === 'groups' && <Section title="Calculation groups" note={`${ti.calculationGroups.length} groups · ${plural(members, 'member')}`}>
        <div className="an-pad" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {!ti.calculationGroups.length && <span className="muted">None.</span>}
          {ti.calculationGroups.filter((g) => hit(q, g)).map((g) => <CalcGroupView key={`${g.dimension}:${g.name}`} g={g} dim={g.dimension} />)}
        </div>
      </Section>}

      {view === 'calcs' && <Section title="Time-relative calculations" note={`${ti.calculations.length} use MDX time functions`}>
        {ti.calculations.length ? (
          <div className="table flat">
            <div className="tr th grid-an-t"><span>Calculation</span><span>Functions</span><span>Expression</span></div>
            {ti.calculations.filter((c) => hit(q, c)).map((c) => (
              <div key={c.name} className="tr grid-an-t" style={{ cursor: 'default', height: 'auto', minHeight: 36, padding: '6px 18px', alignItems: 'start' }}>
                <span className="name">{c.label}</span>
                <span className="an-flags">{c.functions.map((f) => <Tag key={f} tone="qa">{f}</Tag>)}</span>
                <code className="an-json" style={{ whiteSpace: 'pre-wrap' }}>{c.expression}</code>
              </div>
            ))}
          </div>
        ) : <div className="muted an-pad">None.</div>}
      </Section>}

      {view === 'semi' && <Section title="Semi-additive metrics" note="not summed across the listed relationships">
        <div className="an-pad" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {!ti.semiAdditive.length && <span className="muted">None.</span>}
          {ti.semiAdditive.map((m) => (
            <div key={m.name} style={{ fontSize: 12.5 }}>
              <b>{m.label}</b> <Tag tone="warn">{m.position}</Tag>
              <span className="mono muted"> over {[...m.relationships, ...m.degenerate].join(' · ') || '—'}</span>
            </div>
          ))}
        </div>
      </Section>}
    </div>
  )
}

function CalcGroupView({ g, dim }: { g: CalcGroup; dim: string }) {
  return (
    <div className="an-hier">
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <b style={{ fontSize: 12.5 }}>{g.label ?? g.name}</b> <NoteMark n={g} />
        <span className="muted" style={{ fontSize: 12 }}>{dim}</span>
        {g.folder && <Tag>{g.folder}</Tag>}
        {g.precedence !== null && g.precedence !== undefined && <Tag tone="dev">precedence {g.precedence}</Tag>}
        {g.hidden && <Tag>hidden</Tag>}
      </div>
      <Notes n={g} />
      <div className="an-cm">
        {g.members.map((m) => (
          <div key={m.name} className="an-cm-row">
            <span className="mono">{m.name}{m.default && <Tag tone="qa">default</Tag>}{m.hidden && <Tag>hidden</Tag>}</span>
            <span>{m.template ? <Tag tone="dev">{m.template}</Tag> : <code className="an-json">{m.expression}</code>}</span>
            <span className="mono muted">{m.useInputMetricFormat ? 'input metric format' : m.format ?? ''}</span>
            {(m.description || m.comments.length > 0) && <div style={{ gridColumn: '1 / -1' }}><Notes n={m} /></div>}
          </div>
        ))}
      </div>
    </div>
  )
}

// -- metrics ------------------------------------------------------------------------------------

function Metrics({ a, q, onFile }: { a: ModelAudit; q: string; onFile: (p: string) => void }) {
  const { open, toggle } = useExpand()
  const [kind, setKind] = useState<'all' | 'metric' | 'calculation'>('all')
  const rows = a.metrics.filter((m) => (kind === 'all' || m.kind === kind) && hit(q, m))
  return (
    <div className="an-grid">
      <SubTabs value={kind} onChange={setKind} right={<span className="hint">Click a row for every property</span>} items={[
        { id: 'all', label: 'All', n: a.metrics.length },
        { id: 'metric', label: 'Metrics', n: a.counts.metrics },
        { id: 'calculation', label: 'Calculations', n: a.counts.calculations },
      ]} />
      <Section title={kind === 'all' ? 'Metrics & calculations' : kind === 'metric' ? 'Metrics' : 'Calculations'} note={plural(rows.length, 'object')}>
      <div className="table flat">
        <div className="tr th grid-an-m"><span>Metric</span><span>Kind</span><span>Method / expression</span><span>Source</span><span>Folder</span><span>Flags</span></div>
        {rows.map((m) => (
          <Fragment key={m.name}>
            <div className="tr grid-an-m" onClick={() => toggle(m.name)}>
              <span className="ellipsis"><span className="name">{m.label}</span> <NoteMark n={m} />{m.label !== m.name && <span className="mono muted"> {m.name}</span>}</span>
              <Tag tone={m.kind === 'metric' ? 'prod' : 'muted'}>{m.kind === 'metric' ? 'metric' : 'calc'}</Tag>
              <span className="mono ellipsis" title={m.expression ?? undefined}>{m.kind === 'metric' ? m.calculationMethod : m.expression}</span>
              <span className="mono muted ellipsis">{m.dataset ? `${m.dataset}.${m.column}` : '—'}</span>
              <span className="muted ellipsis">{m.folder ?? '—'}</span>
              <span className="an-flags">
                {m.semiAdditive && <Tag tone="warn">semi · {m.semiAdditive.position}</Tag>}
                {m.additivity === 'non-additive' && <Tag tone="warn">non-additive</Tag>}
                {(m.timeFunctions?.length ?? 0) > 0 && <Tag tone="qa">time</Tag>}
                {m.hidden && <Tag>hidden</Tag>}
                {m.quantiles && <Tag>quantile</Tag>}
                {m.queryName && <Tag tone="dev" title={`query name: ${m.queryName}`}>override</Tag>}
                {Object.keys(m.extra ?? {}).length > 0 && <Tag tone="warn">undoc</Tag>}
              </span>
            </div>
            {open.has(m.name) && <MetricDetail m={m} onFile={onFile} />}
          </Fragment>
        ))}
        {!rows.length && <div className="empty">Nothing matches</div>}
      </div>
      </Section>
    </div>
  )
}

function MetricDetail({ m, onFile }: { m: AuditMetric; onFile: (p: string) => void }) {
  return (
    <div className="an-detail">
      <Notes n={m} />
      {m.expression && <pre className="an-code">{m.expression}</pre>}
      <dl className="an-dl">
        {m.additivity && <><dt>Additivity</dt><dd className="mono">{m.additivity}</dd></>}
        {m.semiAdditive && <><dt>Semi-additive</dt><dd className="mono">{m.semiAdditive.position} over {[...m.semiAdditive.relationships, ...m.semiAdditive.degenerate].join(' · ') || '—'}</dd></>}
        {m.timeFunctions && m.timeFunctions.length > 0 && <><dt>Time functions</dt><dd className="mono">{m.timeFunctions.join(', ')}</dd></>}
        {m.queryName && <><dt>Query name (override)</dt><dd className="mono">{m.queryName}</dd></>}
        <dt>File</dt><dd><FileBtn path={m.file} onFile={onFile} /></dd>
      </dl>
      <Props o={m} />
    </div>
  )
}

// -- dimensions ---------------------------------------------------------------------------------

function Dimensions({ a, q, onFile }: { a: ModelAudit; q: string; onFile: (p: string) => void }) {
  const [kind, setKind] = useState<'all' | 'standard' | 'time' | 'degenerate' | 'calcgroups'>('all')
  const is = (d: AuditDimension) => kind === 'all' || (kind === 'time' ? d.type === 'time' : kind === 'degenerate' ? d.degenerate
    : kind === 'calcgroups' ? d.calculationGroups.length > 0 : d.type !== 'time' && !d.degenerate)
  const rows = a.dimensions.filter((d) => is(d) && hit(q, d))
  const roles = Object.fromEntries(a.rolePlays.map((r) => [r.dimension, r.roles]))
  const n = (k: typeof kind) => a.dimensions.filter((d) => k === 'all' || (k === 'time' ? d.type === 'time' : k === 'degenerate' ? d.degenerate
    : k === 'calcgroups' ? d.calculationGroups.length > 0 : d.type !== 'time' && !d.degenerate)).length
  return (
    <div className="an-grid">
      <SubTabs value={kind} onChange={setKind} right={<span className="hint">Click a dimension to open it</span>} items={[
        { id: 'all', label: 'All', n: n('all') }, { id: 'standard', label: 'Standard', n: n('standard') },
        { id: 'time', label: 'Time', n: n('time') }, { id: 'degenerate', label: 'Degenerate', n: n('degenerate') },
        { id: 'calcgroups', label: 'With calc groups', n: n('calcgroups') },
      ]} />
      <Section title="Dimensions" note={plural(rows.length, 'dimension')}>
        <div className="an-pad an-dims">
          {rows.map((d) => <DimensionCard key={d.name} d={d} q={q} roles={roles[d.name]} onFile={onFile} />)}
          {!rows.length && <div className="empty">Nothing matches</div>}
        </div>
      </Section>
    </div>
  )
}

function DimensionCard({ d, q, roles, onFile }: { d: AuditDimension; q: string; roles?: { template: string; relationships: number }[]; onFile: (p: string) => void }) {
  const [open, setOpen] = useState(false)
  const { open: ex, toggle } = useExpand()
  const attrs: AuditAttr[] = [...d.levelAttributes, ...d.secondaryAttributes, ...d.aliases, ...d.metricalAttributes]
  const shown = q ? attrs.filter((x) => hit(q, x)) : attrs
  return (
    <div className="an-card an-dim">
      <button type="button" className="an-dim-h" onClick={() => setOpen(!open)}>
        <span className="an-caret">{open ? '▾' : '▸'}</span>
        <span className="name">{d.label}</span> <NoteMark n={d} />
        <Tag tone={d.type === 'time' ? 'qa' : 'dev'}>{d.type}</Tag>
        {d.degenerate && <Tag>degenerate</Tag>}
        {d.sharedDegenerate && <Tag>shared degenerate</Tag>}
        {d.calculationGroups.length > 0 && <Tag tone="prod">{plural(d.calculationGroups.length, 'calc group')}</Tag>}
        {roles?.map((r) => <Tag key={r.template} tone="dev">{role(r.template)}</Tag>)}
        <span className="hint" style={{ marginLeft: 'auto' }}>
          {d.hierarchies.length} {d.hierarchies.length === 1 ? 'hierarchy' : 'hierarchies'} · {plural(attrs.length, 'attribute')} · {d.datasets.join(', ')}
        </span>
      </button>
      {(open || !!q) && (
        <div className="an-dim-b">
          <Notes n={d} />
          <div className="an-hiers">
            {d.hierarchies.map((h) => (
              <div key={h.name} className="an-hier">
                <span className="label">{h.label}{h.folder ? ` · ${h.folder}` : ''}</span> <NoteMark n={h} />
                <div className="an-levels">
                  {h.levels.map((l, i) => <Fragment key={l.name}>{i > 0 && <span className="muted">›</span>}<span className={l.hidden ? 'muted' : ''}>{l.label}{l.timeUnit && <Tag tone="qa">{l.timeUnit}</Tag>}</span></Fragment>)}
                </div>
                {h.filterEmpty && <div className="mono muted">filter_empty: {h.filterEmpty}</div>}
                {h.defaultMember && <div className="mono muted">default member: {h.defaultMember}{h.defaultMemberOnlyInQuery ? ' (only when in query)' : ''}</div>}
              </div>
            ))}
          </div>
          <div className="table flat">
            <div className="tr th grid-an-a"><span>Attribute</span><span>Kind</span><span>Dataset</span><span>Key → name · sort</span><span>Notes</span></div>
            {shown.map((x) => {
              const k = `${x.kind}:${x.name}:${x.level ?? ''}`
              return (
                <Fragment key={k}>
                  <div className="tr grid-an-a" style={{ height: 'auto', minHeight: 38, padding: '7px 18px' }} onClick={() => toggle(k)}>
                    <span className="ellipsis"><span className={x.hidden ? 'muted' : ''}>{x.label}</span>{x.label !== x.name && <span className="mono muted"> {x.name}</span>}</span>
                    <span className="an-flags">
                      <Tag tone={x.kind === 'level' ? 'dev' : 'muted'}>{x.kind}</Tag>{x.uniqueKey && <Tag>key</Tag>}{x.timeUnit && <Tag tone="qa">{x.timeUnit}</Tag>}{x.hidden && <Tag>hidden</Tag>}
                      {x.constraintTranslationRank !== null && x.constraintTranslationRank !== undefined && <Tag tone="dev">ct rank {x.constraintTranslationRank}</Tag>}
                      {Object.keys(x.extra ?? {}).length > 0 && <Tag tone="warn">undoc</Tag>}
                    </span>
                    <span className="mono muted ellipsis">{x.dataset ?? (x.sharedDegenerateColumns.map((s) => s.dataset).join(', ') || '—')}</span>
                    <span className="mono ellipsis" title={`key: ${x.keyColumns.join(', ')} · name: ${x.nameColumn ?? x.column ?? ''} · sort: ${x.sortColumn ?? ''}`}>
                      {x.keyColumns.join(', ') || x.column}{x.nameColumn && x.nameColumn !== x.keyColumns.join(', ') ? ` → ${x.nameColumn}` : ''}{x.sortColumn ? <span className="muted"> · {x.sortColumn}</span> : ''}
                    </span>
                    <span style={{ fontSize: 12 }}>{x.description}{x.comments.map((c, i) => <span key={i} className="an-comment"> # {c}</span>)}</span>
                  </div>
                  {ex.has(k) && <div className="an-detail"><Props o={x} /></div>}
                </Fragment>
              )
            })}
          </div>
          {d.parallelPeriods.length > 0 && (
            <div>
              <span className="label">Parallel periods</span>
              {d.parallelPeriods.map((p, i) => <div key={i} className="mono" style={{ marginTop: 3 }}>{p.hierarchy} › {p.level} <span className="muted">→ {p.toLevel} on {p.keyColumns.join(', ')}</span></div>)}
            </div>
          )}
          {d.calculationGroups.map((g) => <CalcGroupView key={g.name} g={g} dim={d.label} />)}
          <Props o={d} title="Dimension properties" />
          <div className="hint">File <FileBtn path={d.file} onFile={onFile} /></div>
        </div>
      )}
    </div>
  )
}

// -- datasets -------------------------------------------------------------------------------------

function Datasets({ a, q, onFile }: { a: ModelAudit; q: string; onFile: (p: string) => void }) {
  const { open, toggle } = useExpand()
  const [kind, setKind] = useState<'all' | 'fact' | 'dimension' | 'sql'>('all')
  const is = (d: AuditDataset, k: typeof kind) => k === 'all' || (k === 'sql' ? !!d.sql : d.role.includes(k))
  const rows = a.datasets.filter((d) => is(d, kind) && hit(q, d))
  return (
    <div className="an-grid">
      <SubTabs value={kind} onChange={setKind} right={<span className="hint">Click a row for columns + every property</span>} items={[
        { id: 'all', label: 'All', n: a.datasets.length }, { id: 'fact', label: 'Fact', n: a.datasets.filter((d) => is(d, 'fact')).length },
        { id: 'dimension', label: 'Dimension', n: a.datasets.filter((d) => is(d, 'dimension')).length },
        { id: 'sql', label: 'SQL query', n: a.datasets.filter((d) => is(d, 'sql')).length },
      ]} />
      <Section title="Datasets" note={plural(rows.length, 'dataset')}>
    <div className="table flat">
      <div className="tr th grid-an-d"><span>Dataset</span><span>Role</span><span>Source</span><span>Connection</span><span>Columns</span><span>Flags</span></div>
      {rows.map((d) => (
        <Fragment key={d.name}>
          <div className="tr grid-an-d" onClick={() => toggle(d.name)}>
            <span className="ellipsis"><span className="name">{d.label}</span> <NoteMark n={d} /></span>
            <Tag tone={d.role.startsWith('fact') ? 'prod' : 'dev'}>{d.role}</Tag>
            <span className="mono ellipsis">{d.sql ? 'SQL query' : d.table}</span>
            <span className="mono muted ellipsis">{d.connection}</span>
            <span className="mono">{d.columns.length}{d.calculatedColumns ? <span className="muted"> · {d.calculatedColumns} calc</span> : ''}{d.mapColumns ? <span className="muted"> · {d.mapColumns} map</span> : ''}</span>
            <span className="an-flags">
              {d.incremental && <Tag tone="qa">incremental</Tag>}{d.immutable && <Tag>immutable</Tag>}
              {d.qdsMaterialization && <Tag tone="dev">QDS</Tag>}{d.alternate && <Tag>alternate</Tag>}
              {d.dialects.length > 0 && <Tag>{d.dialects.length} dialects</Tag>}
              {Object.keys(d.datasetProperties.effective).length > 0 && <Tag tone="dev">agg props</Tag>}
            </span>
          </div>
          {open.has(d.name) && <DatasetDetail d={d} onFile={onFile} />}
        </Fragment>
      ))}
      {!rows.length && <div className="empty">Nothing matches</div>}
    </div>
      </Section>
    </div>
  )
}

function DatasetDetail({ d, onFile }: { d: AuditDataset; onFile: (p: string) => void }) {
  const dp = d.datasetProperties
  return (
    <div className="an-detail">
      <Notes n={d} />
      {d.sql && <pre className="an-code">{d.sql}</pre>}
      {d.dialects.map((x) => <div key={x.dialect}><span className="label">{x.dialect}</span><pre className="an-code">{x.sql}</pre></div>)}
      <dl className="an-dl">
        {d.incremental && <><dt>Incremental</dt><dd className="mono">{d.incremental.column} · grace {d.incremental.gracePeriod}</dd></>}
        {d.alternate && <><dt>Alternate</dt><dd className="mono">{d.alternate.type} · {d.alternate.connection} · {d.alternate.table ?? d.alternate.sql}</dd></>}
        {Object.keys(dp.effective).length > 0 && <><dt>Dataset properties</dt><dd className="mono">
          {Object.entries(dp.effective).map(([k, v]) => `${k}: ${String(v)}${dp.model && k in dp.model ? ' (model)' : ' (catalog)'}`).join(' · ')}
        </dd></>}
      </dl>
      <div className="an-cols">
        {d.columns.map((c) => (
          <div key={c.name} className="an-colrow">
            <span className="mono">{c.name}</span>
            <span className="mono muted">{c.dataType ?? '—'}{c.map ? ' · map' : ''}{c.parentColumn ? ` · from ${c.parentColumn}` : ''}</span>
            <span style={{ fontSize: 12 }}>
              {c.sql && <code className="an-inline">{c.sql}</code>}
              {c.map && <code className="an-inline">{JSON.stringify(c.map)}</code>}
              {c.dialects.length > 0 && <Tag>{c.dialects.join(', ')}</Tag>}
              {c.description}
              {c.comments.map((x, i) => <span key={i} className="an-comment"> # {x}</span>)}
              {Object.keys(c.extra ?? {}).length > 0 && <Tag tone="warn" title={JSON.stringify(c.extra)}>undoc</Tag>}
            </span>
          </div>
        ))}
      </div>
      <Props o={d} title="Dataset properties (SML)" />
      <div className="hint">File <FileBtn path={d.file} onFile={onFile} /></div>
    </div>
  )
}

// -- joins ------------------------------------------------------------------------------------------

function Joins({ a, q }: { a: ModelAudit; q: string }) {
  const [kind, setKind] = useState<'all' | AuditJoin['kind']>('all')
  const rows = a.joins.filter((j) => (kind === 'all' || j.kind === kind) && hit(q, j))
  const n = (k: AuditJoin['kind']) => a.joins.filter((j) => j.kind === k).length
  return (
    <div className="an-grid">
      <SubTabs value={kind} onChange={setKind} items={[
        { id: 'all', label: 'All', n: a.joins.length }, { id: 'fact', label: 'Fact → dimension', n: n('fact') },
        { id: 'snowflake', label: 'Snowflake', n: n('snowflake') }, { id: 'embedded', label: 'Embedded', n: n('embedded') },
        { id: 'security', label: 'Row security', n: n('security') },
      ]} />
      <Section title="Joins" note={plural(rows.length, 'relationship')}>
    <div className="table flat">
      <div className="tr th grid-an-j"><span>Kind</span><span>From dataset · columns</span><span>To dimension · level</span><span>Role play</span><span>Defined in</span></div>
      {rows.map((j, i) => (
        <div key={i} className="tr grid-an-j" style={{ cursor: 'default', height: 'auto', minHeight: 40, padding: '6px 18px' }}>
          <span className="an-flags"><Tag tone={j.kind === 'fact' ? 'prod' : j.kind === 'snowflake' ? 'qa' : j.kind === 'security' ? 'warn' : 'dev'}>{j.kind}</Tag>{j.m2m && <Tag tone="warn">m2m</Tag>}</span>
          <span className="mono ellipsis" title={j.columns.join(', ')}>
            {j.fromDataset} <span className="muted">({j.columns.join(', ')})</span>{j.columns.length > 1 && <Tag>composite</Tag>}
            {(j.fromHierarchy || j.fromLevel) && <div className="muted">from {[j.fromHierarchy, j.fromLevel].filter(Boolean).join(' › ')}</div>}
            {j.constraintTranslation && <div className="muted">constraint translation → {j.constraintTranslation.level} on {j.constraintTranslation.fromColumns.join(', ')}</div>}
          </span>
          <span className="ellipsis">{j.toDimension} <span className="mono muted">· {j.toLevel ?? '—'}</span></span>
          <span className="mono">{j.rolePlay ?? <span className="muted">—</span>}</span>
          <span className="muted ellipsis">{j.owner}{j.name ? <span className="mono"> · {j.name}</span> : ''}</span>
        </div>
      ))}
      {!rows.length && <div className="empty">Nothing matches</div>}
    </div>
      </Section>
    </div>
  )
}

// -- other ------------------------------------------------------------------------------------------

function Other({ a, q, onFile }: { a: ModelAudit; q: string; onFile: (p: string) => void }) {
  const f = <T,>(xs: T[]) => xs.filter((x) => hit(q, x))
  type O = 'catalog' | 'packages' | 'connections' | 'rls' | 'perspectives' | 'drill' | 'udas' | 'partitions' | 'overrides' | 'dsprops' | 'unused' | 'undoc'
  const [view, setView] = useState<O>('catalog')
  const items: Sub<O>[] = [
    { id: 'catalog', label: 'Catalog', n: a.catalog ? 1 : 0 },
    { id: 'connections', label: 'Connections', n: a.connections.length },
    { id: 'rls', label: 'Row security', n: a.rowSecurity.length },
    { id: 'perspectives', label: 'Perspectives', n: a.perspectives.length },
    { id: 'drill', label: 'Drill-throughs', n: a.drillthroughs.length },
    { id: 'udas', label: 'User aggs', n: a.aggregates.length },
    { id: 'partitions', label: 'Partitions', n: a.partitions.length },
    { id: 'overrides', label: 'Overrides', n: a.overrides.length },
    { id: 'dsprops', label: 'Dataset props', n: Object.keys(a.datasetProperties.model).length },
    { id: 'packages', label: 'Packages', n: a.package?.packages.length ?? 0 },
    { id: 'unused', label: 'Unused', n: a.unused.length },
    { id: 'undoc', label: 'Undocumented', n: a.undocumented.length },
  ]
  return (
    <div className="an-grid">
      <SubTabs value={view} onChange={setView} items={items} />
      {view === 'catalog' && !a.catalog && <Section title="Catalog"><div className="muted an-pad">No catalog.yml in the repo</div></Section>}
      {view === 'catalog' && a.catalog && (
        <Section title="Catalog" note={a.catalog.file ?? undefined}>
          <div className="an-pad" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <Notes n={a.catalog} />
            <Props o={a.catalog} title="Catalog properties" />
            {Object.keys(a.catalog.datasetProperties).length > 0 && (
              <div><span className="label">dataset_properties</span>
                {Object.entries(a.catalog.datasetProperties).map(([ds, v]) => <div key={ds} className="mono" style={{ marginTop: 3 }}>{ds} <span className="muted">{JSON.stringify(v)}</span></div>)}
              </div>
            )}
            <FileBtn path={a.catalog.file} onFile={onFile} />
          </div>
        </Section>
      )}
      {view === 'packages' && (
        <Section title="Packages" note={a.package?.file ?? 'no package.yml'}>
          <SimpleRows rows={(a.package?.packages ?? []).map((p) => ({ k: p.name, a: p.name, b: `${p.url} @ ${p.branch}`, c: p.version, file: a.package!.file }))} onFile={onFile} />
        </Section>
      )}
      {view === 'connections' && <Section title="Connections">
        <SimpleRows rows={f(a.connections).map((c) => ({
          k: c.name, a: <>{c.label} <NoteMark n={c} /></>, b: `${c.asConnection ?? '—'} · ${[c.database, c.schema].filter(Boolean).join('.')}`,
          c: `${plural(c.datasets.length, 'dataset')}`, file: c.file, notes: c,
        }))} onFile={onFile} />
      </Section>}
      {view === 'rls' && <Section title="Row security">
        <SimpleRows rows={f(a.rowSecurity).map((r) => ({
          k: r.name, a: r.label, b: `${r.dataset ?? '—'} · filter ${r.filterKey ?? '—'} · ids ${r.idsColumn ?? '—'} (${r.idType ?? '?'})`,
          c: `scope ${r.scope ?? '—'} · filter key ${fmtBool(r.useFilterKey)} · secure totals ${fmtBool(r.secureTotals)}`, file: r.file, notes: r, spec: r,
        }))} onFile={onFile} />
      </Section>}
      {view === 'perspectives' && <Section title="Perspectives" note="objects hidden in each perspective">
        <SimpleRows rows={f(a.perspectives).map((p) => ({
          k: p.name, a: p.name, c: p.model,
          b: [p.hiddenMetrics.length ? `metrics: ${p.hiddenMetrics.join(', ')}` : '',
            ...p.hiddenDimensions.map((d) => `${d.name}${d.relationshipsPath.length ? ` [${d.relationshipsPath.join(' → ')}]` : ''}${d.hierarchies.length ? `: ${d.hierarchies.map((h) => `${h.name}${h.level ? ` from ${h.level}` : ''}${h.levels.length ? ` (${h.levels.join(', ')}, deprecated)` : ''}`).join(', ')}` : ' (whole dimension)'}${d.secondaryAttributes.length ? ` · ${d.secondaryAttributes.join(', ')}` : ''}`),
          ].filter(Boolean).join(' · ') || 'nothing hidden',
        }))} onFile={onFile} />
      </Section>}
      {view === 'drill' && <Section title="Drill-throughs">
        <SimpleRows rows={f(a.drillthroughs).map((d) => ({
          k: d.name, a: d.name, c: d.notes ?? d.model,
          b: `${d.metrics.join(', ')} · by ${d.attributes.map((x) => `${x.dimension ? `${x.dimension}.` : ''}${x.name}${x.relationshipsPath.length ? ` [${x.relationshipsPath.join(' → ')}]` : ''}`).join(', ') || '—'}`,
        }))} onFile={onFile} />
        {a.model.includeDefaultDrillthrough !== null && a.model.includeDefaultDrillthrough !== undefined && <div className="hint an-pad">include_default_drillthrough: {String(a.model.includeDefaultDrillthrough)}</div>}
      </Section>}
      {view === 'udas' && <Section title="User-defined aggregates (SML)">
        <SimpleRows rows={f(a.aggregates).map((g) => ({
          k: g.name, a: g.label ?? g.name, c: g.caching ?? '',
          b: `${g.metrics.join(', ')} by ${g.attributes.map((x) => `${x.rowSecurity ? `RLS ${x.rowSecurity}` : `${x.dimension}.${x.name}`}${x.partition ? ` [partition ${x.partition}${x.partitionRank ? ` #${x.partitionRank}` : ''}]` : ''}${x.distribution ? ` [distribution ${x.distribution}${x.distributionRank ? ` #${x.distributionRank}` : ''}]` : ''}${x.relationshipsPath.length ? ` via ${x.relationshipsPath.join(' → ')}` : ''}`).join(', ') || '—'}`,
        }))} onFile={onFile} />
      </Section>}
      {view === 'partitions' && <Section title="Partition hints">
        <SimpleRows rows={f(a.partitions).map((p) => ({ k: p.name, a: p.name, b: `${p.dimension}.${p.attribute}`, c: p.type }))} onFile={onFile} />
      </Section>}
      {view === 'overrides' && <Section title="Query name overrides">
        <SimpleRows rows={f(a.overrides).map((o) => ({ k: o.name, a: o.name, b: `→ ${o.queryName ?? '—'}`, c: '' }))} onFile={onFile} />
      </Section>}
      {view === 'dsprops' && <Section title="Model dataset_properties">
        <SimpleRows rows={Object.entries(a.datasetProperties.model).map(([ds, v]) => ({ k: ds, a: ds, b: JSON.stringify(v), c: '' }))} onFile={onFile} />
      </Section>}
      {view === 'unused' && <Section title="In the repo, not used by this model" note={a.otherModels.length ? `other models: ${a.otherModels.join(', ')}` : undefined}>
        <SimpleRows rows={f(a.unused).map((u) => ({ k: `${u.type}:${u.name}`, a: u.name, b: u.type.replace('_', ' '), c: '', file: u.file }))} onFile={onFile} />
      </Section>}
      {view === 'undoc' && <Section title="Undocumented keys" note="set in the YAML, not in the SML reference">
        <SimpleRows rows={f(a.undocumented).map((u, i) => ({ k: `${i}`, a: u.split(': ').slice(-1)[0], b: u.split(': ').slice(0, -1).join(': '), c: '' }))} onFile={onFile} />
      </Section>}
    </div>
  )
}

function SimpleRows({ rows, onFile }: {
  rows: { k: string; a: ReactNode; b: string; c: string; file?: string | null; notes?: AuditNotes; spec?: Spec }[]; onFile: (p: string) => void
}) {
  if (!rows.length) return <div className="muted an-pad" style={{ fontSize: 12 }}>None</div>
  return (
    <div className="an-simple">
      {rows.map((r) => (
        <div key={r.k} className="an-srow">
          <span className="name ellipsis">{r.a}</span>
          <span className="mono muted" style={{ overflowWrap: 'anywhere' }} title={r.b}>{r.b}</span>
          <span className="muted ellipsis" title={r.c}>{r.c}</span>
          <FileBtn path={r.file} onFile={onFile} />
          {r.notes && <div style={{ gridColumn: '1 / -1' }}><Notes n={r.notes} /></div>}
          {r.spec && <div style={{ gridColumn: '1 / -1' }}><Props o={r.spec} /></div>}
        </div>
      ))}
    </div>
  )
}

// -- property usage -------------------------------------------------------------------------------

/** SML reference page → tab label, in reading order (the model first, then what it's built from). */
const SPEC_FILES: [string, string][] = [
  ['model.md', 'Model'], ['dimension.md', 'Dimension'], ['metric.md', 'Metric'], ['calculation.md', 'Calculation'],
  ['dataset.md', 'Dataset'], ['connection.md', 'Connection'], ['catalog.md', 'Catalog'], ['row-security.md', 'Row security'],
  ['composite-model.md', 'Composite model'], ['package.md', 'Package'],
]
const kindLabel = (k: string) => k.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase())

function Properties({ a, q }: { a: ModelAudit; q: string }) {
  const [usedOnly, setUsedOnly] = useState(false)
  const [file, setFile] = useState('model.md')
  const { open: openKinds, toggle: toggleKind } = useExpand()
  const home = (u: { file: string }) => u.file.split(',')[0].trim()
  const groups = SPEC_FILES.map(([f, label]) => {
    const all = a.propertyUsage.filter((u) => home(u) === f)
    return { f, label, total: all.length, used: all.filter((u) => u.count).length }
  }).filter((g) => g.total)
  const rows = a.propertyUsage.filter((u) => home(u) === file && (!usedOnly || u.count > 0) && hit(q, u.kind, u.property))
  const kinds = [...new Set(rows.map((u) => u.kind))]
  const used = a.propertyUsage.filter((u) => u.count).length
  return (
    <div className="an-grid">
      <SubTabs value={file} onChange={setFile} items={groups.map((g) => ({ id: g.f, label: g.label, n: `${g.used}/${g.total}` }))} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span className="hint" style={{ textTransform: 'none', letterSpacing: 0, flex: 1 }}>
          {used} of {a.propertyUsage.length} SML properties are set by this model · SML reference v1.8 ({file}) · count = objects that set it / objects of that kind
        </span>
        <button type="button" className={`an-chip sm ${usedOnly ? 'on' : ''}`} onClick={() => setUsedOnly(!usedOnly)}>{usedOnly ? '✓ ' : ''}Used only</button>
      </div>
      {kinds.map((k) => {
        const us = rows.filter((u) => u.kind === k)
        const set = a.propertyUsage.filter((u) => u.kind === k && u.count).length
        const total = a.propertyUsage.filter((u) => u.kind === k).length
        const none = !us[0].objects
        const shown = !none || openKinds.has(k) || !!q
        return (
          <section key={k} className={`an-sec ${none ? 'an-sec-none' : ''}`}>
            <button type="button" className="an-sec-h an-sec-btn" disabled={!none} onClick={() => toggleKind(k)}>
              <span className="eyebrow">{none && <span className="an-caret">{shown ? '▾' : '▸'}</span>}{kindLabel(k)}</span>
              <span className="hint">{none ? `not used in this model · ${total} ${total === 1 ? 'property' : 'properties'}` : `${plural(us[0].objects, 'object')} · ${set}/${total} properties set`}</span>
            </button>
            {shown && <div className="an-pgrid">
              {us.map((u) => (
                <div key={u.property} className={`an-prow ${u.count ? '' : 'zero'}`}>
                  <span className="mono" title={u.property}>{u.property}</span>
                  <span className="an-pbar"><span style={{ width: `${u.objects ? Math.min(100, (u.count / u.objects) * 100) : 0}%` }} /></span>
                  <span className="mono">{u.count}<span className="muted">/{u.objects}</span></span>
                </div>
              ))}
            </div>}
          </section>
        )
      })}
      {!kinds.length && <div className="empty">{usedOnly ? 'This model sets none of these properties' : 'Nothing matches'}</div>}
    </div>
  )
}

// -- YAML viewer ------------------------------------------------------------------------------------

function FileDrawer({ hostId, modelKey, path, onClose }: { hostId: string; modelKey: string; path: string; onClose: () => void }) {
  const f = useQuery({ queryKey: ['analyzeFile', hostId, modelKey, path], queryFn: () => api.analyzeFile(hostId, modelKey, path) })
  return (
    <div className="an-drawer-bg" onClick={onClose}>
      <aside className="an-drawer" onClick={(e) => e.stopPropagation()}>
        <div className="an-drawer-h">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
            <span className="eyebrow">SML · {f.data?.ref.slice(0, 10) ?? '…'}</span>
            <span className="mono ellipsis" style={{ fontSize: 13 }}>{path}</span>
          </div>
          <button type="button" className="btn" onClick={onClose}>Close</button>
        </div>
        {f.isError ? <div className="notice err" style={{ margin: 16 }}>{errMsg(f.error)}</div>
          : <pre className="an-yaml">{f.data ? f.data.content.split('\n').map((l, i) => (
            <div key={i} className={/^\s*#/.test(l) ? 'an-yc' : undefined}><span className="an-ln">{i + 1}</span>{l || ' '}</div>
          )) : 'Loading…'}</pre>}
      </aside>
    </div>
  )
}
