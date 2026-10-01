import {
  aliasesOf,
  levelsOf,
  secondariesOf,
  useModelStore,
  type AggFn,
  type ColumnKey,
  type DimRole,
  type TimeUnit,
} from '../modelStore'

const AGG_OPTIONS: AggFn[] = ['SUM', 'MIN', 'MAX', 'COUNT', 'COUNT DISTINCT', 'AVG']
const TIME_UNIT_OPTIONS: TimeUnit[] = ['year', 'halfyear', 'quarter', 'month', 'week', 'day']

function titleCase(s: string) {
  return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

export function Inspector() {
  const nodes = useModelStore((s) => s.nodes)
  const joins = useModelStore((s) => s.joins)
  const selection = useModelStore((s) => s.selection)
  const select = useModelStore((s) => s.select)
  const setNodeRole = useModelStore((s) => s.setNodeRole)
  const setNodeField = useModelStore((s) => s.setNodeField)
  const setNodeIsTime = useModelStore((s) => s.setNodeIsTime)
  const cfg = useModelStore((s) => s.cfg)
  const setColumnConfig = useModelStore((s) => s.setColumnConfig)
  const setColumnDimRole = useModelStore((s) => s.setColumnDimRole)
  const setLevelOrder = useModelStore((s) => s.setLevelOrder)
  const fullState = useModelStore((s) => s)

  const node = selection ? nodes.find((n) => n.id === selection.node) : undefined

  if (!node) {
    return (
      <aside className="panel-right">
        <div className="section-label">Column Inspector</div>
        <div style={{ color: 'var(--as-muted)' }}>No selection</div>
      </aside>
    )
  }

  const joinCount = joins.filter((j) => j.a.node === node.id || j.b.node === node.id).length
  const levels = levelsOf(fullState, node.id)

  if (node.package) {
    // A shared dimension: its package repo owns it (api/smlgen/packages.py).
    const keys = levels.map((l) => l.config.keyColumn || l.column)
    return (
      <aside className="panel-right">
        <div className="section-label">
          Column Inspector <span className="status-word">SHARED DIMENSION</span>
        </div>
        <div className="identity-path">{node.package.name} / {node.schema} / {node.table}</div>
        <div className="identity-title">{node.dimName}</div>
        <div className="identity-chips">
          <span className="chip chip-neutral">{levels.length} LEVELS</span>
          <span className="chip chip-neutral">{joinCount} JOINS</span>
        </div>
        <div className="field-note" style={{ margin: '10px 0' }}>
          Read-only - this dimension comes from <a href={node.package.url} target="_blank" rel="noreferrer">{node.package.url}</a>{' '}
          ({node.package.branch} @ <code>{node.package.version.replace('commit:', '').slice(0, 7)}</code>) and is listed in the
          model's <code>package.yml</code>. Change it in its own repo, then pick it again in Shared dims to move to the new commit.
        </div>
        <div className="section-label">Hierarchy {node.hierName}</div>
        {[...levels].reverse().map((l) => (
          <div key={l.key} className="field-note" style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
            <span>{l.config.display || l.column}</span>
            <code>{l.config.keyColumn || l.column}</code>
          </div>
        ))}
        <div className="field-note" style={{ marginTop: 10 }}>
          Join a fact (or one of your dimensions) to a level key: {keys.map((k) => <code key={k}>{k} </code>)}
        </div>
      </aside>
    )
  }

  if (!selection?.column) {
    // 4a. Table selected.
    return (
      <aside className="panel-right">
        <div className="section-label">
          Column Inspector <span className="status-word">{node.role ? node.role.toUpperCase() : 'ROLE NOT SET'}</span>
        </div>

        <div className="identity-path">
          {node.schema} / {node.table}
        </div>
        <div className="identity-title">{node.table}</div>
        <div className="identity-chips">
          <span className="chip chip-neutral">{node.columns.length} COLUMNS</span>
          <span className="chip chip-neutral">{joinCount} JOINS</span>
        </div>

        <div className="role-segment">
          <button
            className={`role-btn ${node.role === 'fact' ? 'role-btn-fact-active' : ''}`}
            onClick={() => setNodeRole(node.id, 'fact')}
          >
            Fact
          </button>
          <button
            className={`role-btn ${node.role === 'dimension' ? 'role-btn-dim-active' : ''}`}
            onClick={() => setNodeRole(node.id, 'dimension')}
          >
            Dimension
          </button>
        </div>

        {node.role === 'fact' && (
          <label className="field">
            Fact dataset name
            <input
              value={node.factName ?? ''}
              onChange={(e) => setNodeField(node.id, 'factName', e.target.value)}
            />
            <span className="field-note">Every metric and degenerate dimension on this table belongs to this fact dataset.</span>
          </label>
        )}

        {node.role === 'dimension' && (
          <>
            <label className="field">
              Dimension name
              <input value={node.dimName ?? ''} onChange={(e) => setNodeField(node.id, 'dimName', e.target.value)} />
            </label>
            <div className="hier-name-block">
              <label className="field">
                Hierarchy name
                <input
                  value={node.hierName ?? ''}
                  onChange={(e) => setNodeField(node.id, 'hierName', e.target.value)}
                />
                <span className="field-note">
                  Every level, alias and secondary attribute defined on this table is created under this hierarchy.
                </span>
              </label>
            </div>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={!!node.isTime}
                onChange={(e) => setNodeIsTime(node.id, e.target.checked)}
              />
              Time dimension
            </label>
            <div className="field-note" style={{ marginBottom: 12 }}>
              Marks this as SML <code>type: time</code> - each level is emitted with a <code>time_unit</code>.
            </div>
          </>
        )}

        {node.role === 'dimension' && (
          <HierarchyReadout nodeId={node.id} hierName={node.hierName} />
        )}
        {node.role === 'fact' && <MetricsReadout nodeId={node.id} factName={node.factName} />}
      </aside>
    )
  }

  // 4b. Column selected.
  const key: ColumnKey = `${node.id}::${selection.column}`
  const column = node.columns.find((c) => c.name === selection.column)
  const c = cfg[key] ?? {}

  function seedNames(patch: Partial<typeof c>) {
    const display = c.display || titleCase(selection!.column!)
    const query = c.query || selection!.column!
    setColumnConfig(key, { display, query, ...patch })
  }

  return (
    <aside className="panel-right">
      <div className="section-label">
        Column Inspector <span className="status-word">{node.role ? node.role.toUpperCase() : 'ROLE NOT SET'}</span>
      </div>

      <div className="identity-path">
        {node.schema} / {node.table}
      </div>
      <div className="identity-title-lg">{selection.column}</div>
      <div className="identity-chips">
        <span className="chip chip-neutral">{column?.type}</span>
      </div>

      <div className="role-strip">
        <span className={`chip ${node.role === 'fact' ? 'chip-fact' : 'chip-dimension'}`}>
          {(node.role ?? 'unset').toUpperCase()}
        </span>
        {node.role === 'dimension' && node.dimName}
        <button className="btn-table-back" onClick={() => select({ node: node.id, column: null })}>
          TABLE
        </button>
      </div>

      {node.role === 'fact' && (
        <>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={!!c.measure}
              onChange={(e) => (e.target.checked ? seedNames({ measure: true, agg: c.agg ?? 'SUM' }) : setColumnConfig(key, { measure: false }))}
            />
            Create metric
          </label>
          {c.measure && (
            <div className="config-block config-block-fact">
              <label className="field">
                Aggregate function
                <select value={c.agg ?? 'SUM'} onChange={(e) => setColumnConfig(key, { agg: e.target.value as AggFn })}>
                  {AGG_OPTIONS.map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                Display name
                <input value={c.display ?? ''} onChange={(e) => setColumnConfig(key, { display: e.target.value })} />
              </label>
              <label className="field">
                Query name
                <input
                  className="mono-input"
                  value={c.query ?? ''}
                  onChange={(e) => setColumnConfig(key, { query: e.target.value })}
                />
              </label>
            </div>
          )}

          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={!!c.degen}
              onChange={(e) =>
                e.target.checked
                  ? setColumnConfig(key, {
                      degen: true,
                      degenDisplay: c.degenDisplay || titleCase(selection!.column!),
                      degenQuery: c.degenQuery || selection!.column!,
                    })
                  : setColumnConfig(key, { degen: false })
              }
            />
            Degenerate dimension
          </label>
          <div className="field-note">Expose this fact column as an attribute without a dimension table.</div>
          {c.degen && (
            <div className="config-block config-block-dim">
              <label className="field">
                Display name
                <input
                  value={c.degenDisplay ?? ''}
                  onChange={(e) => setColumnConfig(key, { degenDisplay: e.target.value })}
                />
              </label>
              <label className="field">
                Query name
                <input
                  className="mono-input"
                  value={c.degenQuery ?? ''}
                  onChange={(e) => setColumnConfig(key, { degenQuery: e.target.value })}
                />
              </label>
            </div>
          )}
        </>
      )}

      {node.role === 'dimension' && (
        <>
          <div className="attr-role-cards">
            {(
              [
                ['none', 'Not modelled', 'This column is not exposed in the model.'],
                ['level', 'Hierarchy level', 'Added to the end of this table’s level chain.'],
                ['secondary', 'Secondary attribute', 'Hangs off a level and inherits its key.'],
                ['alias', 'Level alias', 'Replaces a level’s label - same key, alternate name column.'],
              ] as [DimRole, string, string][]
            ).map(([role, label, note]) => (
              <label key={role} className={`attr-card ${(c.dimRole ?? 'none') === role ? 'attr-card-selected' : ''}`}>
                <input
                  type="radio"
                  name="dimRole"
                  checked={(c.dimRole ?? 'none') === role}
                  onChange={() => setColumnDimRole(node.id, key, role)}
                />
                <div>
                  <div className="attr-card-label">{label}</div>
                  <div className="attr-card-note">{note}</div>
                </div>
              </label>
            ))}
          </div>

          {(c.dimRole === 'secondary' || c.dimRole === 'alias') && (
            <label className="field">
              {c.dimRole === 'secondary' ? 'Attach to hierarchy level' : 'Alias of level'}
              <select
                value={c.attachToKey ?? ''}
                onChange={(e) => setColumnConfig(key, { attachToKey: e.target.value })}
              >
                <option value="">Select a level…</option>
                {levels.map((l) => (
                  <option key={l.key} value={l.key}>
                    L{l.levelOrder + 1} — {l.config.display ?? titleCase(l.column)}
                  </option>
                ))}
              </select>
              {levels.length === 0 && (
                <span className="field-note">
                  No levels defined yet on this table - mark a column as "Hierarchy level" first.
                </span>
              )}
            </label>
          )}

          {c.dimRole && c.dimRole !== 'none' && (
            <div className="config-block config-block-dim">
              <label className="field">
                Display name
                <input value={c.display ?? ''} onChange={(e) => setColumnConfig(key, { display: e.target.value })} />
              </label>
              <label className="field">
                Query name
                <input
                  className="mono-input"
                  value={c.query ?? ''}
                  onChange={(e) => setColumnConfig(key, { query: e.target.value })}
                />
              </label>
              <label className="field">
                Key column
                <select
                  value={c.keyColumn ?? ''}
                  onChange={(e) => setColumnConfig(key, { keyColumn: e.target.value || undefined })}
                >
                  <option value="">(same as this column — {selection.column})</option>
                  {node.columns
                    .filter((col) => col.name !== selection!.column)
                    .map((col) => (
                      <option key={col.name} value={col.name}>
                        {col.name}
                      </option>
                    ))}
                </select>
                <span className="field-note">
                  The join/identity column, if different from the one you selected (e.g. a level whose
                  Display name is "Product Category Level" keys on <code>productcategorykey</code>).
                </span>
              </label>
              <label className="field">
                Value column
                <select
                  value={c.displayColumn ?? ''}
                  onChange={(e) => setColumnConfig(key, { displayColumn: e.target.value || undefined })}
                >
                  <option value="">(same as this column — {selection.column})</option>
                  {node.columns
                    .filter((col) => col.name !== selection!.column)
                    .map((col) => (
                      <option key={col.name} value={col.name}>
                        {col.name}
                      </option>
                    ))}
                </select>
                <span className="field-note">
                  The column whose value is shown to users, if different (e.g. key on{' '}
                  <code>productcategorykey</code>, value <code>productcategoryname</code>).
                </span>
              </label>
              {node.isTime && c.dimRole === 'level' && (
                <label className="field">
                  Time unit
                  <select
                    value={c.timeUnit ?? ''}
                    onChange={(e) => setColumnConfig(key, { timeUnit: (e.target.value || undefined) as TimeUnit | undefined })}
                  >
                    <option value="">Select a time unit…</option>
                    {TIME_UNIT_OPTIONS.map((u) => (
                      <option key={u} value={u}>
                        {u === 'halfyear' ? 'Half-year' : u[0].toUpperCase() + u.slice(1)}
                      </option>
                    ))}
                  </select>
                  <span className="field-note">
                    Required for AtScale to treat this level as a real calendar unit (rollups, time-intelligence
                    calcs) - without it, the generated SML guesses from the column name, which is often wrong.
                  </span>
                </label>
              )}
            </div>
          )}
        </>
      )}

      {node.role === 'dimension' && <HierarchyReadout nodeId={node.id} hierName={node.hierName} />}
      {node.role === 'fact' && <MetricsReadout nodeId={node.id} factName={node.factName} />}
    </aside>
  )

  function MetricsReadout({ nodeId, factName }: { nodeId: string; factName?: string }) {
    const state = useModelStore.getState()
    const entries = Object.entries(state.cfg).filter(([k]) => k.startsWith(`${nodeId}::`))
    const metrics = entries.filter(([, c]) => c.measure)
    const degenerates = entries.filter(([, c]) => c.degen)
    if (metrics.length === 0 && degenerates.length === 0) {
      return null
    }
    return (
      <div className="hierarchy-readout">
        <div className="hierarchy-title">
          <span className="hierarchy-glyph">
            <span />
            <span />
            <span />
            <span />
          </span>
          <span className="hierarchy-title-text" title={factName || 'Untitled Fact Dataset'}>
            {factName || 'Untitled Fact Dataset'}
          </span>
        </div>
        {metrics.map(([k, c]) => (
          <div key={k} className="metric-row">
            <span className="chip chip-fact">Σ {c.agg}</span>
            <span className="attr-label" title={c.display ?? k.split('::')[1]}>
              {c.display ?? k.split('::')[1]}
            </span>
            <span className="level-source" title={c.query ?? k.split('::')[1]}>
              {c.query ?? k.split('::')[1]}
            </span>
            <button className="row-remove" title="Remove metric" onClick={() => setColumnConfig(k, { measure: false })}>
              ✕
            </button>
          </div>
        ))}
        {degenerates.map(([k, c]) => (
          <div key={k} className="metric-row">
            <span className="chip chip-dimension">DEGEN</span>
            <span className="attr-label" title={c.degenDisplay ?? k.split('::')[1]}>
              {c.degenDisplay ?? k.split('::')[1]}
            </span>
            <span className="level-source" title={c.degenQuery ?? k.split('::')[1]}>
              {c.degenQuery ?? k.split('::')[1]}
            </span>
            <button className="row-remove" title="Remove degenerate dimension" onClick={() => setColumnConfig(k, { degen: false })}>
              ✕
            </button>
          </div>
        ))}
      </div>
    )
  }

  function HierarchyReadout({ nodeId, hierName }: { nodeId: string; hierName?: string }) {
    const state = useModelStore.getState()
    const lvls = levelsOf(state, nodeId)
    const isTime = state.nodes.find((n) => n.id === nodeId)?.isTime ?? false
    if (lvls.length === 0) {
      return null
    }
    return (
      <div className="hierarchy-readout">
        <div className="hierarchy-title">
          <span className="hierarchy-glyph">
            <span />
            <span />
            <span />
            <span />
          </span>
          <span className="hierarchy-title-text" title={hierName || 'Untitled Hierarchy'}>
            {hierName || 'Untitled Hierarchy'}
          </span>
        </div>
        {/* AtScale's own hierarchy browser lists a dimension's levels
            coarsest-first, top to bottom, with the leaf (L1 - the join/key
            level) at the very bottom - confirmed against a real deployed
            cube's "Date Month Hierarchy" panel. `levelsOf` sorts ascending
            by levelOrder (L1 first, matching the actual build order), so
            this view reverses just the rendering to match that convention;
            L-numbering, the flag color, and setLevelOrder's own up/down
            semantics all still key off l.levelOrder, not this display index. */}
        {[...lvls].reverse().map((l) => {
          const secs = secondariesOf(state, l.key)
          const aliases = aliasesOf(state, l.key)
          const isLeaf = l.levelOrder === 0
          return (
            <div key={l.key}>
              <div className="level-row">
                <span className="level-flag" style={{ color: isLeaf ? 'var(--as-flag-l1)' : 'var(--as-flag-other)' }}>
                  ⚑
                </span>
                <div className="level-row-content">
                  {/* Visually "up" now means toward the coarser/top end of
                      the list, i.e. a *larger* levelOrder - the store's own
                      'up'/'down' still mean toward L1/toward the end of the
                      ascending-sorted array, so the two are intentionally
                      swapped here. */}
                  <button
                    className="level-reorder"
                    disabled={l.levelOrder === lvls.length - 1}
                    onClick={() => setLevelOrder(nodeId, l.key, 'down')}
                  >
                    ▲
                  </button>
                  <button className="level-reorder" disabled={isLeaf} onClick={() => setLevelOrder(nodeId, l.key, 'up')}>
                    ▼
                  </button>
                  <span className="level-arrow">↳</span>
                  <span className="level-name" title={l.config.display ?? titleCase(l.column)}>
                    {l.config.display ?? titleCase(l.column)}
                  </span>
                  <span className="level-source" title={l.column}>
                    {l.column}
                  </span>
                  {isTime && (
                    <span className={`chip ${l.config.timeUnit ? 'chip-dimension' : 'chip-join'}`}>
                      {l.config.timeUnit ?? 'NO TIME UNIT'}
                    </span>
                  )}
                  <span className="chip chip-level">L{l.levelOrder + 1}</span>
                  <button
                    className="row-remove"
                    title="Remove level"
                    onClick={() => setColumnDimRole(nodeId, l.key, 'none')}
                  >
                    ✕
                  </button>
                </div>
              </div>
              {aliases.map((a) => (
                <AttrRow
                  key={a.key}
                  label={a.config.display ?? a.key.split('::')[1]}
                  tag="ALIAS"
                  depth={1}
                  onRemove={() => setColumnDimRole(nodeId, a.key, 'none')}
                />
              ))}
              {secs.map((s) => (
                <AttrRow
                  key={s.key}
                  label={s.config.display ?? s.key.split('::')[1]}
                  tag="SECONDARY"
                  depth={1}
                  onRemove={() => setColumnDimRole(nodeId, s.key, 'none')}
                />
              ))}
            </div>
          )
        })}
      </div>
    )
  }

  function AttrRow({
    label,
    tag,
    depth,
    onRemove,
  }: {
    label: string
    tag: string
    depth: number
    onRemove: () => void
  }) {
    return (
      <div className="attr-row" style={{ paddingLeft: 28 + depth * 14 }}>
        <span className="attr-ring" />
        <span className="attr-label" title={label}>
          {label}
        </span>
        <span className="chip chip-join">{tag}</span>
        <button className="row-remove" title={`Remove ${tag.toLowerCase()}`} onClick={onRemove}>
          ✕
        </button>
      </div>
    )
  }
}
