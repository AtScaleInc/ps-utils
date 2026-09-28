import { useState } from 'react'
import { useModelStore } from '../modelStore'

interface Props {
  onClose: () => void
}

/** A stand-alone list of calculated metrics (SML `metric_calc`) the user can
 *  add or edit - a raw MDX expression box, not a guided calc builder (see
 *  README's "Known limitations": no MDX authoring/validation UI here). */
export function CalculationsModal({ onClose }: Props) {
  const calculations = useModelStore((s) => s.calculations)
  const addCalculation = useModelStore((s) => s.addCalculation)
  const updateCalculation = useModelStore((s) => s.updateCalculation)
  const removeCalculation = useModelStore((s) => s.removeCalculation)

  const [selectedId, setSelectedId] = useState<string | null>(calculations[0]?.id ?? null)
  const selected = calculations.find((c) => c.id === selectedId)

  function handleAdd() {
    const id = addCalculation()
    setSelectedId(id)
  }

  function handleRemove(id: string) {
    removeCalculation(id)
    if (selectedId === id) setSelectedId(null)
  }

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="sml-modal" onClick={(e) => e.stopPropagation()}>
        <div className="sml-modal-header">
          <div>
            <div className="eyebrow" style={{ color: 'var(--as-join)' }}>
              CALCULATIONS
            </div>
            <div className="identity-title">{calculations.length} calculated metrics</div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-primary" onClick={handleAdd}>
              + Add calculation
            </button>
            <button className="btn btn-ghost" onClick={onClose}>
              Close
            </button>
          </div>
        </div>

        <div className="sml-modal-body">
          <div className="sml-file-tabs">
            {calculations.length === 0 && (
              <div className="field-note" style={{ padding: 12 }}>
                No calculations yet.
              </div>
            )}
            {calculations.map((c) => (
              <div
                key={c.id}
                className={`sml-file-tab ${c.id === selectedId ? 'sml-file-tab-active' : ''}`}
                onClick={() => setSelectedId(c.id)}
              >
                {c.uniqueName || '(untitled)'}
              </div>
            ))}
          </div>

          <div style={{ flex: 1, padding: 20, overflow: 'auto' }}>
            {!selected && <div className="field-note">Select a calculation, or add a new one.</div>}
            {selected && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <label className="field">
                  Unique name
                  <input
                    className="mono-input"
                    value={selected.uniqueName}
                    onChange={(e) => updateCalculation(selected.id, { uniqueName: e.target.value })}
                  />
                </label>
                <label className="field">
                  Label
                  <input
                    value={selected.label}
                    onChange={(e) => updateCalculation(selected.id, { label: e.target.value })}
                  />
                </label>
                <label className="field">
                  Description
                  <input
                    value={selected.description ?? ''}
                    onChange={(e) => updateCalculation(selected.id, { description: e.target.value })}
                  />
                </label>
                <label className="field">
                  MDX expression
                  <textarea
                    className="mono-input"
                    rows={8}
                    style={{ resize: 'vertical', padding: 8, background: 'var(--as-field)', border: '1px solid var(--as-muted-30)', color: 'var(--as-ink)' }}
                    placeholder="e.g. ([Measures].[sales_amount] / [Measures].[order_quantity])"
                    value={selected.expression}
                    onChange={(e) => updateCalculation(selected.id, { expression: e.target.value })}
                  />
                  <span className="field-note">
                    Passed through as-is to the generated SML - not validated against AtScale's MDX
                    function whitelist here. Run "Validate with sml-cli" after generating to catch
                    unsupported functions.
                  </span>
                </label>
                <button className="btn btn-ghost" onClick={() => handleRemove(selected.id)}>
                  Delete this calculation
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
