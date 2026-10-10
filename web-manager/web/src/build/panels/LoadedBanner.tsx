import { useState } from 'react'
import { readOnlyReason, useModelStore, type UnsupportedFeature } from '../modelStore'

/** Under the Build bar for a loaded model: whether Build made it (the marker
 *  comment in its catalog.yml), and - when it uses SML Build can't write back -
 *  why Save / Deploy are off, grouped by feature (api/smlgen/support.py). */
/** The features people ask about first (support.py names), shown in this order. */
const HEADLINE = [
  'Row security', 'Composite model', 'More than one model', 'Semi-additive metric', 'Calculation groups',
  'Perspectives', 'User-defined aggregates', 'Aggregate partitions', 'Drill-throughs',
  'Dimension over several datasets (snowflake)', 'More than one hierarchy', 'Composite key', 'Composite join',
  'SQL (query) dataset / calculated column', 'Many-to-many relationship', 'Parallel periods', 'Metrical attributes',
  'Quantile metric', 'Package (shared objects from another repo)',
]

export function LoadedBanner() {
  const loadedFrom = useModelStore((s) => s.loadedFrom)
  const reason = useModelStore(readOnlyReason)
  const [open, setOpen] = useState(false)
  if (!loadedFrom) return null

  const groups = new Map<string, UnsupportedFeature[]>()
  for (const f of loadedFrom.unsupported) groups.set(f.feature, [...(groups.get(f.feature) ?? []), f])
  // Headline features first, then other modelling logic, then cosmetic loss.
  const rank = ([feature, rows]: [string, UnsupportedFeature[]]) => {
    const i = HEADLINE.indexOf(feature)
    return i >= 0 ? i : rows[0].kind === 'complex' ? HEADLINE.length : HEADLINE.length + 1
  }
  const sorted = [...groups.entries()].sort((a, b) => rank(a) - rank(b) || b[1].length - a[1].length)
  const complex = sorted.filter(([, rows]) => rows[0].kind === 'complex')
  const cosmetic = sorted.filter(([, rows]) => rows[0].kind !== 'complex')

  return (
    <div className={`loaded-banner${reason ? ' ro' : ''}`}>
      <div className="loaded-head">
        {loadedFrom.importedFrom && <span className="loaded-tag" title="Converted by a ps-utils generate-sml-from-* operation">Imported</span>}
        <span className={`loaded-tag${loadedFrom.builtHere ? ' here' : ''}`}
          title={loadedFrom.builtHere
            ? 'catalog.yml carries the "Built with AtScale Environment Manager" comment'
            : 'No Environment Manager marker - built (or last rewritten) in Design Center or by hand'}>
          {loadedFrom.builtHere ? 'Built here' : 'Built elsewhere'}
        </span>
        {reason ? <span>{reason}</span> : <span className="muted">Build can write this model back as-is.</span>}
        {reason && groups.size > 0 && (
          <span className="link-btn" onClick={() => setOpen((v) => !v)}>{open ? 'hide details' : `show ${groups.size} feature${groups.size === 1 ? '' : 's'}`}</span>
        )}
      </div>
      {reason && !open && groups.size > 0 && (
        <div className="loaded-chips">
          {complex.map(([feature, rows]) => (
            <span key={feature} className="loaded-chip complex">{feature}{rows.length > 1 ? ` ×${rows.length}` : ''}</span>
          ))}
          {cosmetic.length > 0 && (
            <span className="loaded-chip" title={cosmetic.map(([f, rows]) => `${f} ×${rows.length}`).join('\n')}>
              + {cosmetic.reduce((n, [, rows]) => n + rows.length, 0)} cosmetic ({cosmetic.slice(0, 3).map(([f]) => f.toLowerCase()).join(', ')}{cosmetic.length > 3 ? ', …' : ''})
            </span>
          )}
        </div>
      )}
      {reason && open && (
        <div className="loaded-details">
          {sorted.map(([feature, rows]) => (
            <details key={feature}>
              <summary>{feature} <span className="muted">({rows.length}{rows[0].kind === 'detail' ? ' · cosmetic' : ''})</span></summary>
              {rows.map((r, i) => (
                <div key={i} className="loaded-row"><span className="mono">{r.file}</span> {r.detail}</div>
              ))}
            </details>
          ))}
        </div>
      )}
    </div>
  )
}
