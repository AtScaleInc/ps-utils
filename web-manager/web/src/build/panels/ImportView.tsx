import { useState } from 'react'
import type { ImportKind } from '../client'
import { IMPORT_KINDS } from '../lib/importKinds'
import { ImportWizard } from './ImportWizard'

interface Props {
  hostId: string
  /** The converted model is on the canvas (read-only) - switch to Develop. */
  onDone: () => void
  /** Existing SML: Develop's Save / Load. */
  onLoadSml: () => void
  /** Live database schema / Database DDL: the new-model Wizard, planning from
   *  the warehouse's table listing or from a DDL file's CREATE TABLEs. */
  onWizard: (mode: 'live' | 'ddl') => void
}

type Card =
  | { id: ImportKind; title: string; file: string; note: string; operation: string }
  | { id: 'sml' | 'live' | 'ddl'; title: string; file: string; note: string; operation?: string; elsewhere: string }

const CARDS: Card[] = [
  { id: 'xml', title: IMPORT_KINDS.xml.label, file: IMPORT_KINDS.xml.file, operation: IMPORT_KINDS.xml.operation,
    note: 'Migrate an existing AtScale model into SML.' },
  { id: 'tabular', title: IMPORT_KINDS.tabular.label, file: IMPORT_KINDS.tabular.file, operation: IMPORT_KINDS.tabular.operation,
    note: 'Convert an Analysis Services Tabular model export. DAX measures are translated to SQL.' },
  { id: 'ssas', title: IMPORT_KINDS.ssas.label, file: IMPORT_KINDS.ssas.file, operation: IMPORT_KINDS.ssas.operation,
    note: 'Convert a classic OLAP cube using its DataSourceView.' },
  { id: 'live', title: 'Live database schema', file: 'A data source on this host', elsewhere: 'Opens the new-model Wizard',
    note: 'Pick tables from a warehouse and generate a starter model.' },
  { id: 'sml', title: 'Existing SML', file: 'SML files or an existing Git repository', elsewhere: 'Opens Develop › Save / Load',
    note: 'Continue work on a model that is already written in SML.' },
  { id: 'ddl', title: 'Database DDL', file: 'SQL CREATE TABLE definitions (.sql)', elsewhere: 'Opens the new-model Wizard with the DDL\'s tables',
    note: 'Plan a starter model from the database structure - declared primary and foreign keys become the joins.' },
]

/** Build › Import & convert: pick what the model comes from, then walk it
 *  into SML (ImportWizard) - every converter is a ps-utils operation. */
export function ImportView({ hostId, onDone, onLoadSml, onWizard }: Props) {
  const [selected, setSelected] = useState<Card['id']>('xml')
  const [running, setRunning] = useState<ImportKind | null>(null)
  const card = CARDS.find((c) => c.id === selected)!

  if (running) {
    return (
      <div className="import-page">
        <ImportWizard key={running} hostId={hostId} kind={running} onClose={() => setRunning(null)} onDone={onDone} />
      </div>
    )
  }

  function start() {
    if (card.id === 'sml') onLoadSml()
    else if (card.id === 'live' || card.id === 'ddl') onWizard(card.id)
    else setRunning(card.id)
  }

  return (
    <div className="import-page">
      <header className="import-head">
        <span className="eyebrow">Build · Import &amp; convert</span>
        <span className="import-title">Bring an existing model in as SML.</span>
        <span className="field-note">
          Choose what it comes from. The export is converted by ps-utils, its connections are pointed at a data source on this
          host, validated, then saved, linked or deployed. It opens in Develop read-only.
        </span>
      </header>
      <div className="import-steps">
        {['Choose source', 'Convert', 'Connect', 'Validate', 'Save, link or deploy'].map((s, i) => (
          <span key={s} className="import-step">{i > 0 && <span className="muted">→ </span>}{s}</span>
        ))}
      </div>
      <div className="import-grid">
        <div className="import-cards">
          {CARDS.map((c) => (
            <button key={c.id} type="button" className={`import-card ${selected === c.id ? 'on' : ''}`}
              onClick={() => setSelected(c.id)} onDoubleClick={() => { setSelected(c.id); start() }}>
              <b>{c.title}</b>
              <span className="muted">{c.file}</span>
              <span>{c.note}</span>
            </button>
          ))}
        </div>
        <aside className="import-side">
          <span className="eyebrow">Selected source</span>
          <span className="import-side-title">{card.title}</span>
          <span>{card.file}</span>
          {card.operation && (
            <>
              <span className="field-note">ps-utils operation</span>
              <span className="mono import-op">{card.operation}</span>
            </>
          )}
          {'elsewhere' in card && <span className="field-note">{card.elsewhere}</span>}
          {card.id !== 'ddl' && card.id !== 'sml' && card.id !== 'live' && (
            <>
              <b className="import-side-sub">Review before accepting</b>
              <span className="field-note">
                Name collisions can keep the query names reports already use. The conversion report lists what was renamed,
                truncated or left out, and sml-cli validates the result before anything is pushed.
              </span>
            </>
          )}
          {(card.id === 'ddl' || card.id === 'live') && (
            <>
              <b className="import-side-sub">Editable, not read-only</b>
              <span className="field-note">
                The Wizard puts the plan on the canvas like any model you build by hand. Pick the data source and schema the
                tables live in; tables found there can be profiled before planning.
              </span>
            </>
          )}
          <button type="button" className="btn btn-primary" onClick={start}>
            {card.id === 'sml' ? 'Open Save / Load' : card.id === 'live' || card.id === 'ddl' ? 'Open the Wizard' : 'Start import'}
          </button>
        </aside>
      </div>
    </div>
  )
}
