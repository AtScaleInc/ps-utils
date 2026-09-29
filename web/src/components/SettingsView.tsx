import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api, type EnvId, type Host } from '../api'
import { useUi } from '../store'
import { CONN, ConnDot, ENVS, errMsg, fmtTime, plural, useGit, useHosts } from './ui'
import { DatabaseCard } from '../test/DatabaseCard'
import { DiscoveryStoreCard } from '../build/DiscoveryStoreCard'

function useInvalidateHosts() {
  const qc = useQueryClient()
  return () => {
    qc.invalidateQueries({ queryKey: ['hosts'] })
    qc.invalidateQueries({ queryKey: ['diff'] })
  }
}

function Secret({ value, onChange, onBlur, placeholder }: {
  value: string; onChange: (v: string) => void; onBlur: () => void; placeholder: string
}) {
  const [show, setShow] = useState(false)
  // Show/Hide only reveals what's typed and unsaved - saved secrets never come back from the API.
  return (
    <div className="secret">
      <input className="input" type={show ? 'text' : 'password'} value={value} placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)} onBlur={onBlur} autoComplete="new-password" />
      <button type="button" onClick={() => setShow(!show)}>{show ? 'Hide' : 'Show'}</button>
    </div>
  )
}

export function SettingsView() {
  const { settingsSection } = useUi()
  return settingsSection === 'storage' ? <StorageView /> : <HostsView />
}

/** Cache & Database: the 2 h list cache and the Test history database. */
function StorageView() {
  return (
    <div className="settings">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 640 }}>
        <span className="eyebrow" style={{ color: 'var(--dev)' }}>Settings — Cache &amp; database</span>
        <span className="display" style={{ fontSize: 34 }}>Keep the working folder <em>tidy</em>.</span>
        <span className="muted" style={{ fontSize: 13.5, lineHeight: 1.4 }}>
          The list cache reloads itself from AtScale; test history and discovery profiles are kept until they're cleaned up here or aged out.
        </span>
      </div>
      <CacheCard />
      <DatabaseCard />
      <DiscoveryStoreCard />
    </div>
  )
}

function HostsView() {
  const { flash, setAsk } = useUi()
  const hostsQ = useHosts()
  const hosts = hostsQ.data?.hosts ?? []
  const invalidate = useInvalidateHosts()
  const qc = useQueryClient()

  const add = useMutation({ mutationFn: (env: EnvId) => api.addHost(env), onSettled: invalidate, onError: (e) => flash(errMsg(e), 'err') })
  const reset = useMutation({
    mutationFn: api.demoReset,
    onSuccess: () => { qc.invalidateQueries(); flash('Demo data reset') },
  })

  return (
    <div className="settings">
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 24, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 640 }}>
          <span className="eyebrow" style={{ color: 'var(--dev)' }}>Settings — Environments &amp; credentials</span>
          <span className="display" style={{ fontSize: 34 }}>Group the hosts, <em>then</em> promote.</span>
          <span className="muted" style={{ fontSize: 13.5, lineHeight: 1.4 }}>
            Each host carries its own credentials and token. Assign it to Dev, Test-QA or Prod — the group decides where it appears in Manage and Promote.
          </span>
        </div>
        {hostsQ.data?.fake && (
          <button type="button" className="btn lg ghost" onClick={() => setAsk({
            eyebrow: 'Demo data', title: 'Reset demo data.', note: 'Every host and object goes back to the seeded demo state.',
            label: 'Reset', tone: 'danger', go: () => reset.mutate(),
          })}>Reset demo data</button>
        )}
      </div>

      <GitCard />

      <div className="cols">
        {ENVS.map((e) => {
          const hs = hosts.filter((h) => h.env === e.id)
          return (
            <div key={e.id} style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
              <div className="col-head" style={{ background: e.color }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span className="k">Group</span><span className="v">{e.label}</span>
                </div>
                <span className="mono" style={{ fontSize: 10.5, letterSpacing: '.08em', textTransform: 'uppercase' }}>{plural(hs.length, 'host')}</span>
              </div>
              {hs.map((h) => <HostCard key={h.id} host={h} />)}
              <button type="button" className="btn dashed" disabled={add.isPending} onClick={() => add.mutate(e.id)}>+ Add host to {e.label}</button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function GitCard() {
  const { flash } = useUi()
  const git = useGit()
  const qc = useQueryClient()
  const g = git.data
  const [user, setUser] = useState<string | null>(null)
  const [email, setEmail] = useState<string | null>(null)
  const [token, setToken] = useState('')
  const [testing, setTesting] = useState(false)

  const save = useMutation({
    mutationFn: api.putGit,
    onSuccess: (d) => qc.setQueryData(['git'], d),
    onError: (e) => flash(errMsg(e), 'err'),
  })
  const test = async () => {
    setTesting(true)
    try {
      if (token) { await save.mutateAsync({ token }); setToken('') }
      const res = await api.testGit()
      qc.setQueryData(['git'], res)
      if (res.error) flash(`Git test failed: ${res.error}`, 'err')
    } catch (e) {
      flash(errMsg(e), 'err')
    } finally {
      setTesting(false)
    }
  }
  const status = testing ? 'testing' : g?.status ?? 'missing'

  return (
    <div className="card git">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span className="eyebrow" style={{ color: 'var(--prod)' }}>Git · shared by all hosts</span>
          <span className="muted" style={{ fontSize: 12.5 }}>Used to link, deploy and promote SML repositories. Personal access token needs repo scope.</span>
        </div>
        <ConnDot status={status} />
      </div>
      <div className="git-grid">
        <label className="field">
          <span className="label">Git username</span>
          <input className="input" value={user ?? g?.username ?? ''} placeholder="github username"
            onChange={(e) => setUser(e.target.value)}
            onBlur={() => { if (user !== null && user !== g?.username) save.mutate({ username: user }); setUser(null) }} />
        </label>
        <label className="field">
          <span className="label">Email</span>
          <input className="input" value={email ?? g?.email ?? ''} placeholder="you@company.com"
            onChange={(e) => setEmail(e.target.value)}
            onBlur={() => { if (email !== null && email !== g?.email) save.mutate({ email }); setEmail(null) }} />
        </label>
        <label className="field">
          <span className="label">Git token (PAT)</span>
          <Secret value={token} onChange={setToken} placeholder={g?.hasToken ? '•••••• saved' : 'ghp_…'}
            onBlur={() => { if (token) { save.mutate({ token }); setToken('') } }} />
        </label>
        <button type="button" className="btn primary" style={{ height: 32 }} disabled={testing} onClick={test}>
          {testing ? 'Testing…' : 'Test Git'}
        </button>
      </div>
    </div>
  )
}

function HostCard({ host }: { host: Host }) {
  const { flash, setAsk } = useUi()
  const invalidate = useInvalidateHosts()
  const qc = useQueryClient()
  const [draft, setDraft] = useState<Partial<Record<'label' | 'hostname' | 'username', string>>>({})
  const [pass, setPass] = useState('')
  const [token, setToken] = useState('')
  const [testing, setTesting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const patch = useMutation({
    mutationFn: (p: Parameters<typeof api.patchHost>[1]) => api.patchHost(host.id, p),
    onSettled: invalidate,
    onError: (e) => flash(errMsg(e), 'err'),
  })
  const remove = useMutation({ mutationFn: () => api.deleteHost(host.id), onSettled: invalidate })

  const text = (field: 'label' | 'hostname' | 'username') => ({
    value: draft[field] ?? host[field],
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, [field]: e.target.value }),
    onBlur: () => {
      const v = draft[field]
      if (v !== undefined && v !== host[field]) patch.mutate({ [field]: v })
      setDraft((d) => { const next = { ...d }; delete next[field]; return next })
    },
  })

  const test = async () => {
    setTesting(true)
    setError(null)
    try {
      const pending: Record<string, string> = {}
      if (pass) pending.password = pass
      if (token) pending.apiToken = token
      if (Object.keys(pending).length) { await api.patchHost(host.id, pending); setPass(''); setToken('') }
      const res = await api.testHost(host.id)
      setError(res.error ?? null)
      qc.invalidateQueries({ queryKey: ['models', host.id] })
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setTesting(false)
      invalidate()
    }
  }

  const status = testing ? 'testing' : host.status
  const checked = host.lastChecked ? `${host.status === 'failed' ? 'Failed' : 'Checked'} ${fmtTime(host.lastChecked)}` : ''

  return (
    <div className="card">
      <div className="row" style={{ gap: 10 }}>
        <input className="input title" placeholder="Host label" {...text('label')} style={{ flex: 1, minWidth: 0 }} />
        <ConnDot status={status} label={CONN[status][0]} />
      </div>
      <label className="field">
        <span className="label">Host</span>
        <input className="input" placeholder="atscale-dev.corp.local" {...text('hostname')} />
      </label>
      <div className="pair">
        <label className="field">
          <span className="label">ID</span>
          <input className="input" placeholder="service account" {...text('username')} />
        </label>
        <label className="field">
          <span className="label">Password</span>
          <Secret value={pass} onChange={setPass} placeholder={host.hasPassword ? '•••••• saved' : '••••••'}
            onBlur={() => { if (pass) { patch.mutate({ password: pass }); setPass('') } }} />
        </label>
      </div>
      <label className="field">
        <span className="label">API token</span>
        <Secret value={token} onChange={setToken} placeholder={host.hasToken ? '•••••• saved' : 'Bearer token (optional)'}
          onBlur={() => { if (token) { patch.mutate({ apiToken: token }); setToken('') } }} />
      </label>
      <label className="field">
        <span className="label">Group</span>
        <select className="select" value={host.env} onChange={(e) => patch.mutate({ env: e.target.value as EnvId })}>
          {ENVS.map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}
        </select>
      </label>
      {error && <span className="err-text">{error}</span>}
      <div className="row" style={{ gap: 8, paddingTop: 4 }}>
        <button type="button" className="btn primary" style={{ fontSize: 12 }} disabled={testing} onClick={test}>
          {testing ? 'Testing…' : 'Test connection'}
        </button>
        <button type="button" className="btn danger" style={{ fontSize: 12 }} onClick={() => setAsk({
          eyebrow: `Remove · ${host.label}`, title: 'Remove this host.',
          note: `${host.label} and its saved credentials are removed from connections.yaml. Nothing on the AtScale host changes.`,
          label: 'Remove', tone: 'danger', go: () => remove.mutate(),
        })}>Remove</button>
        <span className="hint" style={{ marginLeft: 'auto', letterSpacing: '.08em' }}>{checked}</span>
      </div>
    </div>
  )
}

/** The on-disk mirror of the 2 h cache (workspace/cache/), so it's visible
 * what the app is serving instead of it living only in memory. */
function CacheCard() {
  const { flash } = useUi()
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const q = useQuery({ queryKey: ['cache'], queryFn: api.cache, staleTime: 0, refetchInterval: open ? 10_000 : false })
  const clear = useMutation({
    mutationFn: api.clearCache,
    onSuccess: () => { qc.invalidateQueries(); flash('Cache cleared — lists reload from AtScale on next view') },
  })
  const entries = q.data?.entries ?? []
  const fresh = entries.filter((e) => e.fresh).length
  const kb = Math.round(entries.reduce((n, e) => n + e.bytes, 0) / 1024)
  return (
    <div className="card" style={{ gap: 12, padding: '16px 20px' }}>
      <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span className="eyebrow" style={{ color: 'var(--qa)' }}>Cache · working folder</span>
          <span className="muted" style={{ fontSize: 12.5 }}>
            AtScale and GitHub lists are kept {Math.round((q.data?.ttlSeconds ?? 7200) / 3600)} h and mirrored as JSON in{' '}
            <span className="mono" style={{ color: 'var(--ink)' }}>{q.data?.dir ?? 'workspace/cache'}</span>
          </span>
        </div>
        <div className="row" style={{ gap: 10 }}>
          <span className="hint">{entries.length} lists · {fresh} fresh · {kb} KB</span>
          <button type="button" className="btn ghost" onClick={() => setOpen(!open)}>{open ? 'Hide' : 'Show'} contents</button>
          <button type="button" className="btn danger" disabled={clear.isPending || !entries.length} onClick={() => clear.mutate()}>Clear cache</button>
        </div>
      </div>
      {open && (
        <div className="table" style={{ maxHeight: 280, overflow: 'auto' }}>
          <div className="tr th" style={{ gridTemplateColumns: 'minmax(0,3fr) 70px 150px 150px 70px' }}>
            <span>File</span><span>Items</span><span>Loaded</span><span>Expires</span><span>State</span>
          </div>
          {entries.map((e) => (
            <div key={e.path} className="tr" style={{ gridTemplateColumns: 'minmax(0,3fr) 70px 150px 150px 70px', height: 32, cursor: 'default' }}>
              <span className="mono ellipsis" title={e.path}>{e.path}</span>
              <span className="mono muted">{e.items ?? '—'}</span>
              <span className="mono muted">{new Date(e.loadedAt).toLocaleString()}</span>
              <span className="mono muted">{new Date(e.expiresAt).toLocaleString()}</span>
              <span className="hint" style={{ color: e.fresh ? 'var(--qa)' : 'var(--warn)' }}>{e.fresh ? 'Fresh' : 'Expired'}</span>
            </div>
          ))}
          {!entries.length && <div className="empty">Nothing cached yet</div>}
        </div>
      )}
    </div>
  )
}
