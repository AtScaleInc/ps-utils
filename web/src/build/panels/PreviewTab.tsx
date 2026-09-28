import { useEffect, useRef, useState } from 'react'
import {
  fetchPreviewCatalogs,
  fetchPreviewMetadata,
  runFreehandQuery,
  runPreviewQuery,
  type CatalogCube,
  type PreviewMetadata,
  type PreviewQueryResult,
} from '../client'

const DRAG_MIME = 'application/x-preview-item'

type DragKind = 'hierarchy' | 'level' | 'measure'

interface DragItem {
  kind: DragKind
  uniqueName: string
  caption: string
}

type Mode = 'dmv' | 'freehand'

/** Last [..] part of a unique name: [Measures].[salesamount] -> salesamount,
 *  the SQL interface's column name for that measure / level. */
function sqlName(uniqueName: string): string {
  const parts = uniqueName.match(/\[([^\]]*)\]/g)
  return parts ? parts[parts.length - 1].slice(1, -1) : uniqueName
}

function template(dialect: 'mdx' | 'sql', cube: string): string {
  return dialect === 'mdx'
    ? `SELECT\n  { } ON COLUMNS,\n  NON EMPTY { } ON ROWS\nFROM [${cube}]`
    : `SELECT\n  \nFROM "${cube}"\nGROUP BY 1`
}

/** Cube data preview: pick a deployed catalog/cube, then either
 *  - DMV: drag dimensions/hierarchies/levels and measures (read from the cube's
 *    MDSCHEMA_* rowsets) onto the query builder, or
 *  - Freehand: type MDX or SQL (drag the same items into the editor to insert
 *    their names),
 *  and run it as MDX or SQL.
 *  Ported query logic (XMLA templates, MDX/SQL building, result parsing) lives
 *  in api/atscale/preview.py - this component only drives that API. */
export function PreviewTab() {
  const [catalogCubes, setCatalogCubes] = useState<CatalogCube[]>([])
  const [selectedKey, setSelectedKey] = useState('')
  const [metadata, setMetadata] = useState<PreviewMetadata | null>(null)
  const [dialect, setDialect] = useState<'mdx' | 'sql'>('mdx')
  const [rows, setRows] = useState<DragItem[]>([])
  const [measures, setMeasures] = useState<DragItem[]>([])
  const [result, setResult] = useState<PreviewQueryResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [log, setLog] = useState<string[]>(['Cube Data Preview ready.'])
  const [mode, setMode] = useState<Mode>('dmv')
  // One draft per dialect, so switching the SQL checkbox doesn't lose what was typed.
  const [drafts, setDrafts] = useState<Record<'mdx' | 'sql', string>>({ mdx: '', sql: '' })
  const editor = useRef<HTMLTextAreaElement>(null)
  const cube = selectedKey ? selectedKey.split('||')[1] : ''
  const draft = drafts[dialect] || (cube ? template(dialect, cube) : '')
  const setDraft = (text: string) => setDrafts((d) => ({ ...d, [dialect]: text }))

  function appendLog(message: string) {
    setLog((l) => [...l.slice(-199), message])
  }

  useEffect(() => {
    appendLog('Loading catalogs…')
    fetchPreviewCatalogs()
      .then((list) => {
        setCatalogCubes(list)
        appendLog(`Loaded ${list.length} catalog/cube combinations.`)
      })
      .catch((e) => appendLog(`Error fetching catalogs: ${e.message}`))
  }, [])

  function keyFor(cc: CatalogCube) {
    return `${cc.catalog}||${cc.cube}`
  }

  function handleSelectCatalogCube(key: string) {
    setSelectedKey(key)
    setMetadata(null)
    setRows([])
    setMeasures([])
    setResult(null)
    if (!key) return
    const [catalog, cube] = key.split('||')
    appendLog(`Loading metadata for: ${catalog} -> ${cube}`)
    fetchPreviewMetadata(catalog, cube)
      .then((md) => {
        setMetadata(md)
        appendLog(`Loaded ${md.dimensions.length} dimensions, ${md.measures.length} measure folders.`)
      })
      .catch((e) => appendLog(`Error loading metadata: ${e.message}`))
  }

  function onDragStart(e: React.DragEvent, item: DragItem) {
    e.dataTransfer.effectAllowed = 'copy'
    e.dataTransfer.setData(DRAG_MIME, JSON.stringify(item))
  }

  function onDropOn(target: 'rows' | 'measures') {
    return (e: React.DragEvent) => {
      e.preventDefault()
      const raw = e.dataTransfer.getData(DRAG_MIME)
      if (!raw) return
      const item = JSON.parse(raw) as DragItem
      if (target === 'rows' && item.kind === 'measure') return
      if (target === 'measures' && item.kind !== 'measure') return
      const setter = target === 'rows' ? setRows : setMeasures
      setter((list) => (list.some((i) => i.uniqueName === item.uniqueName) ? list : [...list, item]))
    }
  }

  function removeRow(uniqueName: string) {
    setRows((list) => list.filter((i) => i.uniqueName !== uniqueName))
  }

  function removeMeasure(uniqueName: string) {
    setMeasures((list) => list.filter((i) => i.uniqueName !== uniqueName))
  }

  async function handleExecute() {
    if (!selectedKey) {
      appendLog('Please select a catalog and cube first.')
      return
    }
    if (measures.length === 0 || (dialect === 'mdx' && rows.length === 0)) {
      appendLog('Please drag at least one dimension/hierarchy and one measure onto the query builder.')
      return
    }
    const [catalog, cube] = selectedKey.split('||')
    setBusy(true)
    setResult(null)
    try {
      appendLog(`Executing ${dialect.toUpperCase()} query…`)
      const res = await runPreviewQuery({
        catalog,
        cube,
        dialect,
        hierarchies: rows.map((r) => r.uniqueName),
        measures: measures.map((m) => m.uniqueName),
      })
      setResult(res)
      appendLog(`Query executed successfully (${res.rows.length} rows)${res.truncated ? ' - truncated to 1000' : ''}.`)
    } catch (e) {
      appendLog(`Query execution error: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  /** Insert at the caret (or replace the selection) and keep focus in the editor. */
  function insertText(text: string) {
    const el = editor.current
    const start = el?.selectionStart ?? draft.length
    const end = el?.selectionEnd ?? draft.length
    const next = draft.slice(0, start) + text + draft.slice(end)
    setDraft(next)
    requestAnimationFrame(() => {
      el?.focus()
      el?.setSelectionRange(start + text.length, start + text.length)
    })
  }

  function textFor(item: DragItem): string {
    return dialect === 'sql' ? `"${sqlName(item.uniqueName)}"` : item.uniqueName
  }

  function onDropEditor(e: React.DragEvent<HTMLTextAreaElement>) {
    const raw = e.dataTransfer.getData(DRAG_MIME)
    if (!raw) return
    e.preventDefault()
    // Place the caret where the item was dropped before inserting.
    const el = e.currentTarget
    el.focus()
    // Only when the browser resolves the point inside this textarea; otherwise
    // keep the current caret (a drop outside the text, or no support).
    const doc = document as Document & { caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null }
    const pos = doc.caretPositionFromPoint?.(e.clientX, e.clientY)
    if (pos && (pos.offsetNode === el || el.contains(pos.offsetNode))) el.setSelectionRange(pos.offset, pos.offset)
    insertText(textFor(JSON.parse(raw) as DragItem))
  }

  async function handleExecuteFreehand() {
    if (!selectedKey) {
      appendLog('Please select a catalog and cube first.')
      return
    }
    const query = draft.trim()
    if (!query) {
      appendLog('Type a query first.')
      return
    }
    const [catalog, cubeName] = selectedKey.split('||')
    setBusy(true)
    setResult(null)
    try {
      appendLog(`Executing freehand ${dialect.toUpperCase()} query…`)
      const res = await runFreehandQuery({ catalog, cube: cubeName, dialect, query })
      setResult(res)
      appendLog(`Query executed successfully (${res.rows.length} rows)${res.truncated ? ' - truncated to 1000' : ''}.`)
    } catch (e) {
      appendLog(`Query execution error: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <select
          className="source-select"
          value={selectedKey}
          onChange={(e) => handleSelectCatalogCube(e.target.value)}
        >
          <option value="">Select Catalog || Cube</option>
          {catalogCubes.map((cc) => (
            <option key={keyFor(cc)} value={keyFor(cc)}>
              {cc.catalog} || {cc.cube}
            </option>
          ))}
        </select>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <div className="preview-mode" role="tablist" aria-label="Query mode">
            {([['dmv', 'DMV'], ['freehand', 'Freehand']] as [Mode, string][]).map(([m, label]) => (
              <button key={m} type="button" role="tab" aria-selected={mode === m} className={mode === m ? 'on' : ''}
                title={m === 'dmv' ? 'Build the query by dragging from the cube metadata' : 'Type your own query (drag items in to insert their names)'}
                onClick={() => setMode(m)}>{label}</button>
            ))}
          </div>
          <label className="checkbox-row">
            <input type="checkbox" checked={dialect === 'sql'} onChange={(e) => setDialect(e.target.checked ? 'sql' : 'mdx')} />
            SQL Dialect
          </label>
        </div>
      </div>

      <div style={{ flex: 1, display: 'flex', gap: 16, padding: '0 16px', minHeight: 0 }}>
        <div style={{ flex: '0 0 320px', display: 'flex', flexDirection: 'column', gap: 16, overflowY: 'auto' }}>
          <div>
            <div className="section-label">Dimensions &amp; Hierarchies ({mode === 'dmv' ? 'drag to Rows' : 'drag into the editor'})</div>
            <div className="preview-listbox">
              {metadata?.dimensions.map((dim) => (
                <div key={dim.uniqueName}>
                  <div className="preview-listbox-header">{dim.caption}</div>
                  {dim.hierarchies.map((hier) => (
                    <div key={hier.uniqueName}>
                      <div
                        className="preview-listbox-item preview-listbox-hierarchy"
                        draggable
                        onDragStart={(e) => onDragStart(e, { kind: 'hierarchy', uniqueName: hier.uniqueName, caption: hier.caption })}
                      >
                        [H] {hier.caption}
                      </div>
                      {hier.levels.map((lvl) => (
                        <div key={lvl.uniqueName}>
                          <div
                            className="preview-listbox-item preview-listbox-level"
                            draggable
                            onDragStart={(e) => onDragStart(e, { kind: 'level', uniqueName: lvl.uniqueName, caption: lvl.caption })}
                          >
                            [L] {lvl.caption}
                          </div>
                          {lvl.secondaryAttributes.map((attr) => (
                            <div
                              key={attr.name}
                              className="preview-listbox-item preview-listbox-secondary"
                              title="Secondary attribute - browsable here, not yet queryable on its own (drag the level instead)"
                            >
                              <span className="chip chip-dimension">SEC</span> {attr.caption}
                            </div>
                          ))}
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>

          <div>
            <div className="section-label">Measures ({mode === 'dmv' ? 'drag to Measures' : 'drag into the editor'})</div>
            <div className="preview-listbox">
              {metadata?.measures.map((group) => (
                <div key={group.folder || '__none'}>
                  {group.folder && <div className="preview-listbox-header preview-listbox-folder">{group.folder}</div>}
                  {group.items.map((m) => (
                    <div
                      key={m.uniqueName}
                      className="preview-listbox-item"
                      draggable
                      onDragStart={(e) => onDragStart(e, { kind: 'measure', uniqueName: m.uniqueName, caption: m.caption })}
                    >
                      {m.caption}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>

        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
          {mode === 'dmv' ? (
            <>
            <div style={{ display: 'flex', gap: 12 }}>
              <div
                className="preview-dropzone"
                style={{ flex: 1 }}
                onDragOver={(e) => e.preventDefault()}
                onDrop={onDropOn('rows')}
              >
                <div className="section-label">Rows</div>
                {rows.length === 0 && <div className="field-note">Drag a hierarchy or level here.</div>}
                {rows.map((r) => (
                  <span key={r.uniqueName} className="preview-chip">
                    {r.caption}
                    <button onClick={() => removeRow(r.uniqueName)}>✕</button>
                  </span>
                ))}
              </div>
              <div
                className="preview-dropzone"
                style={{ flex: 1 }}
                onDragOver={(e) => e.preventDefault()}
                onDrop={onDropOn('measures')}
              >
                <div className="section-label">Measures</div>
                {measures.length === 0 && <div className="field-note">Drag a measure here.</div>}
                {measures.map((m) => (
                  <span key={m.uniqueName} className="preview-chip">
                    {m.caption}
                    <button onClick={() => removeMeasure(m.uniqueName)}>✕</button>
                  </span>
                ))}
              </div>
            </div>

            <button className="btn btn-primary" onClick={handleExecute} disabled={busy}>
              {busy ? 'Executing…' : 'Execute Query'}
            </button>
            </>
          ) : (
            <>
              <div className="preview-editor-head">
                <div className="section-label">{dialect === 'mdx' ? 'MDX' : 'SQL'} query</div>
                <span className="field-note" style={{ margin: 0 }}>Drag items in to insert {dialect === 'mdx' ? 'unique names' : 'column names'} · ⌘/Ctrl + Enter runs</span>
                <div style={{ display: 'flex', gap: 8, marginLeft: 'auto' }}>
                  <button className="btn btn-ghost btn-sm" disabled={!result?.query} title="Copy the last query built in DMV mode" onClick={() => result?.query && setDraft(result.query)}>Use last query</button>
                  <button className="btn btn-ghost btn-sm" disabled={!cube} onClick={() => setDraft(template(dialect, cube))}>Template</button>
                </div>
              </div>
              <textarea
                ref={editor}
                className="preview-editor"
                spellCheck={false}
                placeholder={cube ? '' : 'Select a catalog and cube first'}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onDragOver={(e) => { if (e.dataTransfer.types.includes(DRAG_MIME)) e.preventDefault() }}
                onDrop={onDropEditor}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); handleExecuteFreehand() }
                  if (e.key === 'Tab') { e.preventDefault(); insertText('  ') }
                }}
              />
              <button className="btn btn-primary" onClick={handleExecuteFreehand} disabled={busy || !cube}>
                {busy ? 'Executing…' : `Execute ${dialect === 'mdx' ? 'MDX' : 'SQL'}`}
              </button>
            </>
          )}

          {mode === 'dmv' && result?.query && (
            <details className="preview-query">
              <summary>Generated {dialect.toUpperCase()}</summary>
              <pre>{result.query}</pre>
            </details>
          )}
          <div className="preview-results" style={{ flex: 1, overflow: 'auto' }}>
            {result && result.rows.length > 0 && (
              <table className="preview-table">
                <thead>
                  <tr>
                    {result.columns.map((c) => (
                      <th key={c}>{c}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((row, i) => (
                    <tr key={i}>
                      {row.map((cell, j) => (
                        <td key={j}>{cell ?? ''}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>

      <div className="preview-log">
        {log.map((line, i) => (
          <div key={i}>{line}</div>
        ))}
      </div>
    </div>
  )
}
