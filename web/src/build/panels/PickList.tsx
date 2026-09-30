import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

/** A searchable drop-down pick list for long lists (warehouses, schemas,
 *  tables): a closed field shows the pick, the open panel filters as you type,
 *  groups options, and renders at most MAX_SHOWN rows so a 5,000-table schema
 *  stays responsive. Single pick by default; `multi` keeps the panel open and
 *  shows the picks as chips. Keyboard: ↑ ↓ to move, Enter to pick, Esc to close. */

export interface PickOption {
  value: string
  label: string
  /** Options with the same group are listed under one heading, in first-seen order. */
  group?: string
  /** Shown before the label once picked (e.g. the warehouse of a database). */
  prefix?: string
  /** Right-aligned note (column count, "fact?", "profiled"...). */
  hint?: string
  /** Extra text the search matches besides the label. */
  keywords?: string
  disabled?: boolean
}

const MAX_SHOWN = 200

interface BaseProps {
  options: PickOption[]
  placeholder?: string
  searchPlaceholder?: string
  /** Shown instead of the list while the options are still loading. */
  loading?: ReactNode
  emptyNote?: string
  disabled?: boolean
  autoFocus?: boolean
}

interface SingleProps extends BaseProps {
  multi?: false
  value: string | null
  onChange: (value: string) => void
}

interface MultiProps extends BaseProps {
  multi: true
  value: string[]
  onChange: (value: string[]) => void
}

export function PickList(props: SingleProps | MultiProps) {
  const { options, placeholder = 'Select…', searchPlaceholder = 'Type to search', loading, emptyNote, disabled, autoFocus } = props
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const root = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const search = useRef<HTMLInputElement>(null)

  const picked = useMemo(() => new Set(props.multi ? props.value : props.value ? [props.value] : []), [props.multi, props.value])
  const byValue = useMemo(() => new Map(options.map((o) => [o.value, o])), [options])

  const matches = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    if (!words.length) return options
    return options.filter((o) => {
      const hay = `${o.label} ${o.group ?? ''} ${o.keywords ?? ''}`.toLowerCase()
      return words.every((w) => hay.includes(w))
    })
  }, [options, query])
  const shown = matches.slice(0, MAX_SHOWN)

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => !root.current?.contains(e.target as Node) && setOpen(false)
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])
  useEffect(() => {
    if (open) {
      setQuery('')
      const at = shown.findIndex((o) => picked.has(o.value))
      setCursor(Math.max(0, at))
      requestAnimationFrame(() => search.current?.focus())
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
  useEffect(() => setCursor(0), [query])
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-i="${cursor}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [cursor, open])

  function choose(o: PickOption) {
    if (o.disabled) return
    if (props.multi) {
      props.onChange(picked.has(o.value) ? props.value.filter((v) => v !== o.value) : [...props.value, o.value])
    } else {
      props.onChange(o.value)
      setOpen(false)
    }
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setCursor((c) => Math.min(shown.length - 1, c + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setCursor((c) => Math.max(0, c - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (shown[cursor]) choose(shown[cursor])
    } else if (e.key === 'Escape') {
      e.stopPropagation()
      setOpen(false)
    }
  }

  const single = !props.multi && props.value ? byValue.get(props.value) : undefined
  const chips = props.multi ? props.value : []

  let lastGroup: string | undefined
  return (
    <div className={`picklist ${open ? 'open' : ''} ${disabled ? 'disabled' : ''}`} ref={root}>
      <button
        type="button"
        className="picklist-field"
        disabled={disabled}
        autoFocus={autoFocus}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (!open && (e.key === 'ArrowDown' || e.key === 'Enter')) {
            e.preventDefault()
            setOpen(true)
          }
        }}
      >
        {props.multi ? (
          chips.length ? (
            <span className="picklist-chips">
              {chips.slice(0, 8).map((v) => (
                <span key={v} className="picklist-chip">
                  {byValue.get(v)?.label ?? v}
                  <span
                    className="picklist-chip-x"
                    role="button"
                    aria-label="Remove"
                    onClick={(e) => {
                      e.stopPropagation()
                      props.onChange(props.value.filter((x) => x !== v))
                    }}
                  >
                    ×
                  </span>
                </span>
              ))}
              {chips.length > 8 && <span className="picklist-chip more">+{chips.length - 8} more</span>}
            </span>
          ) : (
            <span className="picklist-placeholder">{placeholder}</span>
          )
        ) : single ? (
          <span className="picklist-value">
            {single.prefix && <span className="picklist-value-group">{single.prefix} ·</span>}
            {single.label}
          </span>
        ) : (
          <span className="picklist-placeholder">{placeholder}</span>
        )}
        <span className="picklist-caret">▾</span>
      </button>

      {open && (
        <div className="picklist-panel" onKeyDown={onKey}>
          <div className="picklist-search">
            <input ref={search} value={query} placeholder={searchPlaceholder} onChange={(e) => setQuery(e.target.value)} />
            <span className="picklist-count">
              {matches.length.toLocaleString()}
              {query ? ` of ${options.length.toLocaleString()}` : ''}
            </span>
          </div>
          <div className="picklist-options" ref={list} role="listbox">
            {loading ? (
              <div className="picklist-note">{loading}</div>
            ) : shown.length === 0 ? (
              <div className="picklist-note">{query ? `Nothing matches “${query}”.` : emptyNote ?? 'Nothing to pick.'}</div>
            ) : (
              shown.map((o, i) => {
                const heading = o.group !== lastGroup && o.group ? o.group : null
                lastGroup = o.group
                const on = picked.has(o.value)
                return (
                  <div key={o.value}>
                    {heading && <div className="picklist-group">{heading}</div>}
                    <div
                      data-i={i}
                      role="option"
                      aria-selected={on}
                      className={`picklist-option ${i === cursor ? 'cursor' : ''} ${on ? 'on' : ''} ${o.disabled ? 'off' : ''}`}
                      onMouseEnter={() => setCursor(i)}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => choose(o)}
                    >
                      {props.multi && <span className={`picklist-check ${on ? 'on' : ''}`}>{on ? '✓' : ''}</span>}
                      <span className="picklist-label">{o.label}</span>
                      {o.hint && <span className="picklist-hint">{o.hint}</span>}
                    </div>
                  </div>
                )
              })
            )}
            {matches.length > MAX_SHOWN && (
              <div className="picklist-note">
                Showing {MAX_SHOWN} of {matches.length.toLocaleString()} - keep typing to narrow the list.
              </div>
            )}
          </div>
          {props.multi && (
            <div className="picklist-foot">
              <span>{props.value.length} selected</span>
              <span className="link-btn" onClick={() => props.onChange([])}>clear</span>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(false)}>Done</button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
