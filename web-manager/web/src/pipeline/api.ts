// Pipeline tab API (api/routes/pipeline.py): the business unit's stages, the
// board, runs, CI setup. The step calls are the same ones the envmgr CLI makes.

import { req, type EnvId } from '../api'

export type Verdict = 'pass' | 'fail' | 'running' | 'none' | 'error'
export type GateK = 'blank' | 'merge' | 'sync' | 'na' | 'wait' | 'block' | 'open'
export type Orchestrator = 'gha' | 'jenkins' | 'builtin'

export interface Stage { env: EnvId; label: string; trigger: string; role: 'pr' | 'main' | 'promote' | 'release'; hosts: { id: string; label: string }[] }

export interface Score {
  verdict: Verdict
  queries?: number
  matched?: number
  failed?: number
  overLimit?: number
  maxVariance?: number | null
  unbounded?: boolean
  limit?: number
  intended?: number
  unintended?: number
  unclassified?: boolean
  error?: string
  runRef?: string | null
  at?: string | null
  runId?: string
  validateRunId?: string | null
  baseline?: { kind: 'stage' | 'previous' | 'none' | null; label: string | null; version: string | null; env: EnvId | null }
}

export interface Cell {
  env: EnvId
  hostId: string
  hostLabel: string
  hosts: string[]
  commit: string | null
  version: string
  branch: string | null
  repoUrl: string | null
  catalog: string | null
  updated: string | null
  status: string
  error: string | null
  drift: string[]
  /** Every host of the stage and what it runs of this model (null: not deployed there). */
  perHost: { id: string; label: string; version: string | null; commit: string | null; status: string | null }[]
  test: Score
}

/** `why`: a gate held by other models of the same repo (a deploy takes the whole catalog). */
export interface Gate { k: GateK; label: string; sub: string; approval?: boolean; why?: string[] }

export interface BoardModel { name: string; catalog: string | null; repoUrl: string | null; cells: (Cell | null)[]; gates: Gate[] }

export interface Policy { requireTest: boolean; approval: boolean; intendedOnly: boolean; variance: number }

export interface Board {
  stages: Stage[]
  gates: { from: EnvId; to: EnvId; kind: 'merge' | 'promote'; final: boolean }[]
  models: BoardModel[]
  hostErrors: Record<string, string>
  policy: Policy
  orchestrator: Orchestrator
}

export interface PipelineRun {
  id: string
  kind: 'validate' | 'deploy' | 'test' | 'promote-aggs' | 'rollback' | 'promote' | 'report'
  stage: string | null
  model: string | null
  commit: string | null
  version: string | null
  env: EnvId | null
  orchestrator: string | null
  runRef: string | null
  url: string | null
  status: 'running' | 'done' | 'failed'
  verdict: Verdict | null
  error: string | null
  startedAt: string
  finishedAt: string | null
  durationS: number | null
  score?: Score
  validateRunId?: string | null
}

export interface Identity { hostId: string; label: string; env: EnvId; username: string; hasPassword: boolean; serviceAccount: boolean }

export interface Setup {
  orchestrator: Orchestrator
  policy: Policy
  serviceAccountPattern: string
  stages: Stage[]
  identities: Identity[]
  templates: { gha: string; jenkins: string }
  cli: string[]
  url: string
}

export interface ApiToken { id: string; name: string; scope: string[]; prefix: string; created: string; lastUsed: string | null }

export type ActionKind = 'promote' | 'test' | 'rollback'
export interface ScriptRequest { action: ActionKind; env: EnvId; model: string; hosts?: string[]; branch?: string; commit?: string }
export interface ActionScript { filename: string; title: string; sh: string; gha: string; jenkins: string }

export interface JobState { id: string; status: 'running' | 'done'; verdict?: Verdict; summary?: string; result?: unknown }

export const pipelineApi = {
  board: (refresh?: boolean) => req<Board>('GET', `/pipeline/board${refresh ? '?refresh=1' : ''}`),
  runs: () => req<{ runs: PipelineRun[] }>('GET', '/pipeline/runs'),
  setup: () => req<Setup>('GET', `/pipeline/setup?origin=${encodeURIComponent(window.location.origin)}`),
  putPolicy: (patch: { orchestrator?: Orchestrator; policy?: Partial<Policy>; serviceAccountPattern?: string }) =>
    req<{ orchestrator: Orchestrator; policy: Policy }>('PUT', '/pipeline/policy', patch),
  tokens: () => req<{ tokens: ApiToken[]; scopes: string[] }>('GET', '/pipeline/tokens'),
  createToken: (name: string, scope: string[]) => req<ApiToken & { token: string }>('POST', '/pipeline/tokens', { name, scope }),
  revokeToken: (id: string) => req<{ ok: boolean }>('DELETE', `/pipeline/tokens/${encodeURIComponent(id)}`),
  test: (env: EnvId, model: string, host?: string) => req<{ jobId: string }>('POST', '/pipeline/test', { env, model, host }),
  promote: (env: EnvId, model: string, hosts?: string[], branch?: string) =>
    req<{ jobId: string }>('POST', '/pipeline/promote', { env, model, hosts, branch }),
  rollback: (env: EnvId, model: string, hosts?: string[]) => req<{ jobId: string }>('POST', '/pipeline/rollback', { env, model, hosts }),
  /** One Board action as a shell script, a GitHub Actions job and a Jenkins stage. */
  script: (body: ScriptRequest) =>
    req<ActionScript>('POST', '/pipeline/script', { ...body, origin: window.location.origin }),
  promoteAggs: (from: EnvId, to: EnvId, model: string) => req<{ jobId: string }>('POST', '/pipeline/promote-aggs', { from, to, model }),
  job: (id: string) => req<JobState>('GET', `/pipeline/jobs/${encodeURIComponent(id)}`),
}

/** Poll a pipeline job until it's done. */
export async function waitPipelineJob(jobId: string, onTick?: () => void): Promise<JobState> {
  for (;;) {
    const j = await pipelineApi.job(jobId)
    if (j.status !== 'running') return j
    onTick?.()
    await new Promise((r) => setTimeout(r, 1500))
  }
}
