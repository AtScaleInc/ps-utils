// Mirrors api/smlgen/naming.py's slug rule exactly (Git repo/branch names
// can't contain spaces or most punctuation) so the input's live transform
// matches what the server will actually save/deploy under.
export function slugifyModelName(name: string): string {
  // No trim() here (unlike the server-side rule) - this runs on every
  // keystroke, and trimming a trailing space the instant it's typed would
  // silently swallow the separator before the next character arrives,
  // merging "Sales " + "Model" into "SalesModel" instead of "Sales-Model".
  const spaced = name.replace(/\s+/g, '-')
  return spaced.replace(/[^A-Za-z0-9._-]/g, '')
}

export const MODEL_NAME_HINT = "Letters, numbers, '-' and '_' only — spaces become '-'."
