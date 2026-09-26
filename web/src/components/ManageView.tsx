import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { api, type Host } from '../api'
import { resolveHost, useUi } from '../store'
import { ManageAggregates } from './ManageAggregates'
import { ManageModels } from './ManageModels'
import { CONN, EnvSegment, HostSelect, RefreshButton, envOf, useHosts } from './ui'

export function ManageView() {
  const { section, manage, setManage, setView } = useUi()
  const hosts = useHosts().data?.hosts ?? []
  const host = resolveHost(hosts, manage)
  const env = envOf(manage.env)
  const qc = useQueryClient()
  // Same keys as the section views, so these read the shared cache (no extra fetch).
  const models = useQuery({ queryKey: ['models', host?.id], queryFn: () => api.models(host!.id), enabled: !!host })
  const aggModels = useQuery({ queryKey: ['aggModels', host?.id], queryFn: () => api.aggModels(host!.id), enabled: !!host && section === 'aggs' })
  const cachedAt = section === 'models' ? models.data?.cachedAt : aggModels.data?.cachedAt

  return (
    <div className="col">
      <div className="bar">
        <span className="eyebrow">03 — Manage · {section === 'models' ? 'Models' : 'Aggregates'}</span>
        <div className="row">
          <EnvSegment value={manage.env} onPick={(e) => setManage({ env: e, hostId: null, sel: [], modelKey: null })} />
          <HostSelect hosts={hosts} env={manage.env} value={host?.id ?? null} onChange={(id) => setManage({ hostId: id, sel: [], modelKey: null })} />
          <input className="input search" value={manage.q} onChange={(e) => setManage({ q: e.target.value })}
            placeholder={section === 'models' ? 'Search models' : 'Search aggregates'} />
          {host && <RefreshButton cachedAt={cachedAt} onRefresh={() => refreshHost(qc, host.id)} />}
        </div>
      </div>
      {host ? (
        section === 'models' ? <ManageModels key={host.id} host={host} /> : <ManageAggregates key={host.id} host={host} />
      ) : (
        <div className="nohost">
          <span className="flag" />
          <span className="display" style={{ fontSize: 34 }}>No hosts in this <em>group</em> yet.</span>
          <span style={{ fontSize: 13.5, lineHeight: 1.4 }} className="muted">
            Add a host and its credentials in Settings, assign it to {env.label}, and its objects list here.
          </span>
          <button type="button" className="btn primary lg" style={{ alignSelf: 'flex-start' }} onClick={() => setView('settings')}>Open settings</button>
        </div>
      )}
    </div>
  )
}

export function HostHero({ host, count, children }: { host: Host; count: string; children?: ReactNode }) {
  const env = envOf(host.env)
  const [conn, color] = CONN[host.status] ?? CONN.untested
  return (
    <div className="hero">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <span className="eyebrow" style={{ color: env.color }}>{env.label} · Host</span>
        <span className="display">{host.label}</span>
        <span className="mono muted" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="dot" style={{ background: color }} />
          {host.hostname || 'no host set'} · {host.username || 'no id'} · {conn}
        </span>
      </div>
      <div className="row" style={{ gap: 16 }}>
        <span className="mono muted" style={{ letterSpacing: '.09em', textTransform: 'uppercase' }}>{count}</span>
        {children}
      </div>
    </div>
  )
}

/** Reload a host's lists from AtScale (bypassing the API cache): models, the
 * aggregate model picker, and every aggregate list already opened for it. */
export async function refreshHost(qc: QueryClient, hostId: string) {
  const jobs: Promise<unknown>[] = [
    qc.fetchQuery({ queryKey: ['models', hostId], queryFn: () => api.models(hostId, true), staleTime: 0 }),
    qc.fetchQuery({ queryKey: ['aggModels', hostId], queryFn: () => api.aggModels(hostId, true), staleTime: 0 }),
  ]
  for (const q of qc.getQueryCache().findAll({ queryKey: ['aggs', hostId] })) {
    const key = q.queryKey[2]
    if (typeof key !== 'string') continue
    const [catalogId, modelId] = key.split('|')
    jobs.push(qc.fetchQuery({
      queryKey: q.queryKey, staleTime: 0,
      queryFn: () => api.aggs(hostId, { catalogId, modelId, name: '', catalog: '' }, true),
    }))
  }
  await Promise.all(jobs)
  qc.invalidateQueries({ queryKey: ['diff'] })
}
