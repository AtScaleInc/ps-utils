/**
 * Turning an `atscale-list-model-errors` run into something the editor can show.
 *
 * The operation reports problems positionally-blind: its `location` field names
 * SML objects (`datasets/sales_fact`, `models/ → rel_date`), not files and lines,
 * because it validates a directory of YAML through the AtScale engine and never
 * tracks where in a file a given `unique_name` was written. To put a squiggle on
 * the offending line, the problems have to be mapped back onto source positions
 * here.
 *
 * Kept free of `vscode` imports so it can be unit-tested from the repo root
 * against the committed SML corpus, the same arrangement as
 * `sml-unknown-keys-core.ts`.
 */

/** One problem as emitted by the operation's JSON report. */
export interface ModelProblem {
  phase: "structural" | "engine";
  severity: "error" | "warning";
  message: string;
  location?: string;
}

/** The JSON document the operation writes to stdout as its last act. */
export interface ValidationReport {
  model: string;
  problems: ModelProblem[];
  summary?: { errors: number; warnings: number };
}

/** Where a `unique_name` was declared. */
export interface Declaration {
  /** Absolute path of the file it was declared in. */
  file: string;
  /** Zero-based line of the `unique_name:` key. */
  line: number;
  /** Zero-based column where the *value* starts. */
  column: number;
  /** Length of the value, so the squiggle covers the name and nothing else. */
  length: number;
  /** Immediate parent directory, lowercased — `datasets`, `dimensions`, `models`. */
  directory: string;
}

/**
 * Recover the JSON report from the operation's stdout.
 *
 * The report shares stdout with the human-readable log lines (`buildLogger`
 * sends `log`/`info` there too), so it cannot simply be `JSON.parse`d. It is
 * always written last and always with `JSON.stringify(…, null, 2)`, which puts a
 * bare `{` on its first line and a bare `}` on its last — so the last such pair
 * that parses is the report. Searching from the end rather than the start means
 * a stray `{` in a log line costs nothing.
 */
export function parseReport(stdout: string): ValidationReport | undefined {
  const lines = stdout.split(/\r?\n/);

  for (let end = lines.length - 1; end >= 0; end--) {
    if (lines[end].trimEnd() !== "}") continue;
    for (let start = end; start >= 0; start--) {
      if (lines[start].trimEnd() !== "{") continue;
      try {
        const parsed = JSON.parse(lines.slice(start, end + 1).join("\n")) as ValidationReport;
        if (parsed && Array.isArray(parsed.problems)) return parsed;
      } catch {
        // Not the report — keep widening backwards.
      }
    }
  }
  return undefined;
}

/**
 * `unique_name: sales_fact`, tolerating quotes and trailing comments.
 *
 * Matched by regex rather than by parsing the YAML because the position of the
 * value is the whole point, and a parsed tree would have to be walked back to
 * source offsets anyway.
 */
const UNIQUE_NAME = /^(\s*)unique_name\s*:[ \t]*(["']?)([^"'#\r\n]+)\2/;

const directoryOf = (file: string): string => {
  const parts = file.split(/[\\/]/);
  return (parts[parts.length - 2] ?? "").toLowerCase();
};

/**
 * Index every `unique_name` declared across the given files.
 *
 * A name can legitimately appear more than once — a dimension's level attributes
 * carry their own `unique_name`, and one may match a dataset's — so every
 * declaration is kept and the caller disambiguates by directory.
 */
export function buildNameIndex(
  files: readonly { file: string; text: string }[],
): Map<string, Declaration[]> {
  const index = new Map<string, Declaration[]>();

  for (const { file, text } of files) {
    const directory = directoryOf(file);
    text.split(/\r?\n/).forEach((line, number) => {
      const match = UNIQUE_NAME.exec(line);
      if (!match) return;
      const value = match[3].trimEnd();
      if (!value) return;
      const column = line.indexOf(match[3]);
      const declarations = index.get(value) ?? [];
      declarations.push({ file, line: number, column, length: value.length, directory });
      index.set(value, declarations);
    });
  }

  return index;
}

/**
 * Directory hint and object name out of a `location` field.
 *
 * The operation writes four shapes, all from string literals in
 * `AtScaleListModelErrorsOperation.ts`:
 *
 *   `datasets/sales_fact`        → dataset by name
 *   `dimensions/dim_date`        → dimension by name
 *   `models/ → rel_date_sales`   → a relationship inside the model file
 *   `connectionId: default`      → no SML object at all; not locatable
 */
export function parseLocation(
  location: string | undefined,
): { directory?: string; name: string } | undefined {
  if (!location) return undefined;

  const arrow = /^(\w+)\/\s*(?:→|->)\s*(.+)$/.exec(location);
  if (arrow) return { directory: arrow[1].toLowerCase(), name: arrow[2].trim() };

  const slash = /^(\w+)\/(.+)$/.exec(location);
  if (slash) return { directory: slash[1].toLowerCase(), name: slash[2].trim() };

  // `connectionId: …` and anything else name no SML object.
  return undefined;
}

/** Every `'quoted'` token in a message, in order — the operation's own convention. */
export function quotedNames(message: string): string[] {
  return [...message.matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

/**
 * Best-effort source position for a problem.
 *
 * Tries the structured `location` first, then the names quoted in the message,
 * which catches problems the operation reports without a location at all (a
 * relationship missing `from.dataset`, for instance). Returns undefined rather
 * than guessing when nothing matches — an unlocated problem is still shown, just
 * attached to the model file instead of to a line that may have nothing to do
 * with it.
 */
export function locateProblem(
  problem: ModelProblem,
  index: ReadonlyMap<string, Declaration[]>,
): Declaration | undefined {
  const parsed = parseLocation(problem.location);

  const pick = (name: string, directory?: string): Declaration | undefined => {
    const declarations = index.get(name);
    if (!declarations?.length) return undefined;
    // Prefer a declaration in the directory the location named: `sales_fact` in
    // `datasets/` is the dataset, while a same-named level attribute lives under
    // `dimensions/` and would be the wrong line to point at.
    const preferred = directory
      ? declarations.find((d) => d.directory === directory)
      : undefined;
    return preferred ?? declarations[0];
  };

  if (parsed) {
    const hit = pick(parsed.name, parsed.directory);
    if (hit) return hit;
  }

  for (const name of quotedNames(problem.message)) {
    const hit = pick(name, parsed?.directory);
    if (hit) return hit;
  }

  return undefined;
}

/**
 * Move a located problem from the object's `unique_name` line onto the value that
 * actually caused it, when that value appears in the same file.
 *
 * `locateProblem` can only resolve as far as the SML object the operation named,
 * which for "Dataset 'queries': connection_id 'ghost' not found" is the dataset's
 * declaration — while the line needing the edit is `connection_id: ghost` further
 * down. The operation quotes the offending value in its message, so if that value
 * is written somewhere else in the same file, that is the better place to point.
 *
 * Falls back to the declaration whenever the value is absent, which is the common
 * case for "not found" errors about things that were never there.
 */
export function refineWithinFile(
  declaration: Declaration,
  problem: ModelProblem,
  text: string,
): Declaration {
  const lines = text.split(/\r?\n/);
  const own = lines[declaration.line]?.slice(
    declaration.column,
    declaration.column + declaration.length,
  );

  for (const name of quotedNames(problem.message)) {
    if (name === own) continue; // the declaration itself; no improvement
    for (let line = 0; line < lines.length; line++) {
      if (line === declaration.line) continue;
      const column = valuePosition(lines[line], name);
      if (column === undefined) continue;
      return { ...declaration, line, column, length: name.length };
    }
  }

  return declaration;
}

/**
 * Where `name` appears in `line` as a whole value, or undefined.
 *
 * Bounded on both sides so `user` does not match inside `user_id`, and anchored
 * after a `:` or a `-` so a substring of some unrelated prose does not win.
 */
function valuePosition(line: string, name: string): number | undefined {
  const pattern = new RegExp(
    `(?:^|[:\\-]\\s*)["']?(${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})["']?\\s*(?:#.*)?$`,
  );
  const match = pattern.exec(line);
  return match ? line.indexOf(match[1], match.index) : undefined;
}

/** One line of the human-readable log, matching the operation's own format. */
export function formatProblem(problem: ModelProblem): string {
  const tag = problem.severity === "error" ? "ERROR" : "WARN ";
  const location = problem.location ? ` [${problem.location}]` : "";
  return `  [${tag}][${problem.phase}]${location} ${problem.message}`;
}

/**
 * Error text to surface when the CLI produced no parseable report.
 *
 * The operation throws for the ordinary misconfigurations — no model file, a
 * missing connection entry, `--sml-dir` pointing somewhere without `models/` —
 * and `cli-runner.ts` prints those to stderr. Preferring stderr keeps the real
 * message rather than the generic exit code.
 */
export function describeFailure(stdout: string, stderr: string, code: number | null): string {
  const detail = stripNodeWarnings(stderr).trim() || stdout.trim();
  const lastLine = detail.split(/\r?\n/).filter(Boolean).pop();
  return lastLine ?? `atscale-list-model-errors exited with code ${code ?? "unknown"}`;
}

/**
 * Drop Node's own warning blocks from stderr.
 *
 * The bundled CLI currently emits a multi-line AWS SDK node-version warning at
 * startup, whose last line is `(Use \`node --trace-warnings …\`)`. Taking the last
 * line of stderr would report that instead of the operation's actual error — the
 * failure would be real and the reason shown would be noise.
 *
 * A block runs from a `(node:PID) Warning:` line to the `(Use …)` terminator, or
 * to the end if there is none.
 */
export function stripNodeWarnings(stderr: string): string {
  const kept: string[] = [];
  let inWarning = false;

  for (const line of stderr.split(/\r?\n/)) {
    if (/^\(node:\d+\)\s/.test(line)) {
      inWarning = true;
      continue;
    }
    if (inWarning) {
      // The trace-warnings hint closes the block; a blank line does not, since
      // these warnings are prose wrapped over several paragraphs.
      if (/^\(Use `node /.test(line)) inWarning = false;
      continue;
    }
    kept.push(line);
  }

  return kept.join("\n");
}
