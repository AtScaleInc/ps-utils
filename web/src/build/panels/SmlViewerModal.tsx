import { useEffect, useState } from 'react'
import { SmlValidationFailure, deployPreflight, validateSml, type DeployResult, type SmlFile } from '../client'
import { ENVS, useHosts } from '../../components/ui'

interface Props {
  files: SmlFile[]
  /** The model's data warehouse connection id - a host without it can't deploy. */
  connectionId: string | null
  /** The Build bar's host, checked by default. */
  defaultHostId: string | null
  onClose: () => void
  onDeploy: (hostIds: string[]) => Promise<DeployResult>
}

export function SmlViewerModal({ files, connectionId, defaultHostId, onClose, onDeploy }: Props) {
  const [activeIdx, setActiveIdx] = useState(0)
  const [validating, setValidating] = useState(false)
  const [validation, setValidation] = useState<{ passed: boolean; output: string } | null>(null)

  const hosts = useHosts().data?.hosts ?? []
  const [picked, setPicked] = useState<string[]>(defaultHostId ? [defaultHostId] : [])
  const [missing, setMissing] = useState<Record<string, string>>({})
  const [deploying, setDeploying] = useState(false)
  const [deployResult, setDeployResult] = useState<DeployResult | null>(null)
  const [deployError, setDeployError] = useState<string | null>(null)

  const hostKey = hosts.map((h) => h.id).join(',')
  useEffect(() => {
    if (!connectionId || !hostKey) return
    deployPreflight(connectionId, hostKey.split(','))
      .then((rows) => setMissing(Object.fromEntries(rows.filter((r) => !r.ok).map((r) => [r.hostId, r.error ?? `No '${connectionId}' connection`]))))
      .catch(() => setMissing({}))
  }, [connectionId, hostKey])

  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]))
  const targets = picked.filter((id) => !missing[id] && hosts.some((h) => h.id === id))

  async function runValidate() {
    setValidating(true)
    setValidation(null)
    try {
      const result = await validateSml(files)
      setValidation(result)
    } catch (err) {
      setValidation({ passed: false, output: err instanceof Error ? err.message : String(err) })
    } finally {
      setValidating(false)
    }
  }

  async function runDeploy() {
    setDeploying(true)
    setDeployError(null)
    setDeployResult(null)
    try {
      setDeployResult(await onDeploy(targets))
    } catch (err) {
      if (err instanceof SmlValidationFailure) {
        setDeployError(err.errors.join('\n'))
      } else {
        setDeployError(err instanceof Error ? err.message : String(err))
      }
    } finally {
      setDeploying(false)
    }
  }

  const failed = deployResult?.results.filter((r) => !r.ok) ?? []

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="sml-modal" onClick={(e) => e.stopPropagation()}>
        <div className="sml-modal-header">
          <div>
            <div className="eyebrow" style={{ color: 'var(--as-join)' }}>
              GENERATED SML
            </div>
            <div className="identity-title">{files.length} files</div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-ghost" onClick={runValidate} disabled={validating}>
              {validating ? 'Validating…' : 'Validate with sml-cli'}
            </button>
            <button className="btn btn-primary" onClick={runDeploy} disabled={deploying || !targets.length}>
              {deploying ? 'Deploying…' : `Deploy to ${targets.length} host${targets.length === 1 ? '' : 's'}`}
            </button>
            <button className="btn btn-ghost" onClick={onClose}>
              Close
            </button>
          </div>
        </div>

        {validation && (
          <div className={`validation-banner ${validation.passed ? 'validation-pass' : 'validation-fail'}`}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>
              {validation.passed ? 'Validation passed' : 'Validation failed'}
            </div>
            <pre className="validation-output">{validation.output}</pre>
          </div>
        )}

        <div className="deploy-targets">
          <span className="eyebrow">Deploy to</span>
          {ENVS.map((e) => {
            const inEnv = hosts.filter((h) => h.env === e.id)
            if (!inEnv.length) return null
            return (
              <div key={e.id} className="deploy-env">
                <span className="deploy-env-label" style={{ color: e.color }}>{e.label}</span>
                {inEnv.map((h) => {
                  const why = missing[h.id]
                  return (
                    <label key={h.id} className={`deploy-host ${why ? 'deploy-host-off' : ''}`} title={why ?? h.hostname}>
                      <input type="checkbox" checked={picked.includes(h.id) && !why} disabled={!!why || deploying}
                        onChange={() => toggle(h.id)} />
                      {h.label}
                    </label>
                  )
                })}
              </div>
            )
          })}
        </div>

        {(deployResult || deployError) && (
          <div className={`validation-banner ${deployError || failed.length ? 'validation-fail' : 'validation-pass'}`}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>
              {deployError ? 'Deploy failed' : failed.length ? `Deployed to ${deployResult!.results.length - failed.length} of ${deployResult!.results.length} hosts` : 'Deployed'}
            </div>
            {deployResult && (
              <>
                <div className="field-note" style={{ marginBottom: 6 }}>
                  {deployResult.git.repoUrl} @ {deployResult.git.branch} ({deployResult.git.commit.slice(0, 7)})
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {deployResult.results.map((r) => (
                    <div key={r.hostId} style={{ display: 'flex', gap: 8, fontSize: 12 }}>
                      <span style={{ color: r.ok ? '#3bd44a' : '#ff3b35' }}>{r.ok ? '✓' : '✕'}</span>
                      <span>{r.label}</span>
                      {r.error && <span style={{ color: 'var(--as-muted)' }}>{r.error}</span>}
                      {r.warnings?.map((w) => <span key={w} style={{ color: '#f5a623' }}>{w}</span>)}
                    </div>
                  ))}
                </div>
              </>
            )}
            {deployError && <pre className="validation-output">{deployError}</pre>}
          </div>
        )}

        <div className="sml-modal-body">
          <div className="sml-file-tabs">
            {files.map((f, i) => (
              <div
                key={f.name}
                className={`sml-file-tab ${i === activeIdx ? 'sml-file-tab-active' : ''}`}
                onClick={() => setActiveIdx(i)}
              >
                {f.name}
              </div>
            ))}
          </div>
          <pre className="sml-file-content">{files[activeIdx]?.body}</pre>
        </div>
      </div>
    </div>
  )
}
