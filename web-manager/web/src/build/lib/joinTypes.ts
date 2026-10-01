// Join-key type guardrail: a relationship may only join columns of the same
// type family (int to int, string to string, ...). A string-to-int join makes
// the warehouse cast on every query (or fails outright) and silently drops
// keys like '007' vs 7. Mirrors api/smlgen/rules.py join_type_family - keep
// the two in sync.

export type JoinTypeFamily = 'integer' | 'decimal' | 'float' | 'string' | 'date' | 'datetime' | 'boolean'

/** Maps an AtScale metadata type (Int, Long, String, Decimal(38,0), ...) to
 *  its join family. Int/Long/BigInt/SmallInt and zero-scale decimals are all
 *  'integer' (widening is safe). Null for an empty/unknown type - the caller
 *  can't tell, so it doesn't block. */
export function joinTypeFamily(type: string | null | undefined): JoinTypeFamily | null {
  const t = (type ?? '').trim().toLowerCase()
  if (!t) return null
  const base = t.replace(/\(.*$/, '').trim()
  if (/^(int|integer|bigint|smallint|tinyint|long|int\d+|byte|short)$/.test(base)) return 'integer'
  if (/^(decimal|numeric|number|money)$/.test(base)) {
    const scale = /\(\s*\d+\s*,\s*(\d+)\s*\)/.exec(t)
    return scale && Number(scale[1]) === 0 ? 'integer' : 'decimal'
  }
  if (/^(float|double|real|float\d+|double precision)$/.test(base)) return 'float'
  if (/(char|text|string|varchar|nvarchar|clob)/.test(base)) return 'string'
  if (base === 'date') return 'date'
  if (/^(datetime|timestamp)/.test(base)) return 'datetime'
  if (/^(boolean|bool|bit)$/.test(base)) return 'boolean'
  return null
}

/** Why these two join columns can't be joined, or null if they can. */
export function joinTypeMismatch(
  a: { table: string; column: string; type?: string | null },
  b: { table: string; column: string; type?: string | null },
): string | null {
  const fa = joinTypeFamily(a.type)
  const fb = joinTypeFamily(b.type)
  if (!fa || !fb || fa === fb) return null
  return (
    `Can't join ${a.table}.${a.column} (${a.type}) to ${b.table}.${b.column} (${b.type}) - ` +
    `join keys must be the same type (${fa} vs ${fb}).`
  )
}
