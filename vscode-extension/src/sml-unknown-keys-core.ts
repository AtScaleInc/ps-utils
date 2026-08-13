/**
 * Finds keys an SML file uses that the specification does not document.
 *
 * ## Why this is not `additionalProperties: false`
 *
 * The generated schemas are permissive on purpose (see the header of
 * `src/scripts/generate-sml-schema.ts`): the upstream prose lags the
 * implementation, so a closed schema puts *errors* on valid files — including
 * ps-utils' own output, which emits `visualize_in_bi_tool`. JSON Schema has no
 * severity knob, so "unknown key" and "missing required property" would arrive at
 * the same weight, and the only way to silence the false ones is to stop
 * validating altogether.
 *
 * So unknown keys are found here instead, reported at *warning* severity by the
 * caller. A typo gets flagged; a genuine spec gap is a squiggle rather than a
 * blocker, and the ones already known about are allowlisted from the generator's
 * `KNOWN_UNDOCUMENTED` table via `index.json`.
 *
 * ## Deliberately conservative
 *
 * Nothing is reported unless the walk resolved an object schema that actually
 * declares `properties`. Anywhere the schema runs out — a `$ref` that does not
 * resolve, an `anyOf`, a value whose type disagrees with the schema — the walk
 * stops silently rather than guessing. A false "this key is wrong" is far more
 * expensive than a missed typo, because it teaches people to ignore the channel.
 *
 * This module must stay free of `vscode` imports: it is unit-tested from the repo
 * root against the committed SML corpus (`src/scripts/__tests__/`), which is the
 * regression test that valid SML produces no findings.
 */
import { isMap, isScalar, isSeq, parseDocument } from "yaml";
import type { Node } from "yaml";

export interface JsonSchema {
  $ref?: string;
  $defs?: Record<string, JsonSchema>;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  [keyword: string]: unknown;
}

/**
 * One entry of `index.json`'s `knownUndocumented` — a key the toolchain emits that
 * the specification omits.
 *
 * `objectType` and `class` narrow it to the one place the gap is known to exist, so
 * allowlisting `is_unique_key` on a secondary attribute does not also silence it
 * somewhere it would be a genuine mistake. Both are optional; omitting them
 * allowlists the key everywhere, which is the right default for a key with no
 * documented home at all.
 */
export interface KnownUndocumented {
  key: string;
  objectType?: string;
  class?: string;
  where?: string;
}

/** Matches a key against the known spec gaps, in the context it was found. */
export class Allowlist {
  private constructor(private readonly entries: readonly KnownUndocumented[]) {}

  static from(entries: readonly KnownUndocumented[]): Allowlist {
    return new Allowlist(entries);
  }

  static empty(): Allowlist {
    return new Allowlist([]);
  }

  get size(): number {
    return this.entries.length;
  }

  has(key: string, objectType: string | undefined, className: string | undefined): boolean {
    return this.entries.some(
      (entry) =>
        entry.key === key &&
        (entry.objectType === undefined || entry.objectType === objectType) &&
        (entry.class === undefined || entry.class === className),
    );
  }
}

export interface UnknownKey {
  /** The offending key, as written. */
  key: string;
  /**
   * Path to the object that contains it, in `columns[0].map_column` form.
   * Empty at the document root.
   */
  path: string;
  /** Character offsets of the key token, for turning into an editor range. */
  start: number;
  end: number;
  /** Closest documented sibling, when one is near enough to be worth naming. */
  suggestion?: string;
}

/** Only local `#/$defs/Name` pointers are emitted by the generator. */
const DEF_POINTER = /^#\/\$defs\/(.+)$/;

/** A `$ref` chain deeper than this means the schema is malformed; stop rather than loop. */
const MAX_REF_DEPTH = 10;

/**
 * Keys that are YAML mechanics rather than SML content. `<<` is the merge key: its
 * *value* is spliced into the mapping by the parser, so the anchor's own keys are
 * checked where they are defined and the merge site must not be second-guessed.
 */
const YAML_INTRINSICS = new Set(["<<"]);

/**
 * Optimal string alignment distance — Levenshtein plus adjacent transposition.
 *
 * Transposition matters more than the extra dozen lines suggest: `tabel` for
 * `table` and `lable` for `label` are two of the commonest SML typos, and plain
 * Levenshtein scores them 2, the same as a genuinely different word.
 */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Three rolling rows are enough for OSA: previous-previous, previous, current.
  let twoBack: number[] = [];
  let oneBack: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
  let current: number[] = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const substitution = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(
        oneBack[j] + 1, // deletion
        current[j - 1] + 1, // insertion
        oneBack[j - 1] + substitution,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, twoBack[j - 2] + 1); // transposition
      }
      current[j] = best;
    }
    twoBack = oneBack;
    oneBack = current;
    current = new Array<number>(b.length + 1);
  }

  return oneBack[b.length];
}

/**
 * How far a candidate may sit from the written key and still be offered.
 *
 * Scaled by length because two edits inside `qds_materialization` is a typo while
 * two edits inside `sql` is a different word.
 */
const suggestionThreshold = (key: string): number =>
  key.length <= 4 ? 1 : key.length <= 8 ? 2 : 3;

/**
 * The documented sibling closest to `key`, or undefined when nothing is close
 * enough — or when two candidates tie, since naming an arbitrary one of them in a
 * "did you mean" is worse than saying nothing.
 */
export function suggestFor(key: string, documented: readonly string[]): string | undefined {
  const limit = suggestionThreshold(key);
  const lower = key.toLowerCase();

  let best: string | undefined;
  let bestDistance = Infinity;
  let tied = false;

  for (const candidate of documented) {
    const distance = editDistance(lower, candidate.toLowerCase());
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
      tied = false;
    } else if (distance === bestDistance) {
      tied = true;
    }
  }

  return best !== undefined && bestDistance <= limit && !tied ? best : undefined;
}

/**
 * A schema with the `$defs` name it was reached through, which is what the
 * allowlist scopes on: `is_unique_key` is documented on `LevelAttribute` but not on
 * `SecondaryAttribute`, and the two are told apart only by that name.
 */
interface Resolved {
  schema: JsonSchema;
  className?: string;
}

/** Follow `$ref` to the schema that actually carries the constraints. */
function deref(
  schema: JsonSchema | undefined,
  root: JsonSchema,
  depth = 0,
  className?: string,
): Resolved | undefined {
  if (!schema || depth > MAX_REF_DEPTH) return undefined;
  if (typeof schema.$ref !== "string") return { schema, className };
  const name = DEF_POINTER.exec(schema.$ref)?.[1];
  const target = name ? root.$defs?.[name] : undefined;
  return deref(target, root, depth + 1, name);
}

const join = (path: string, segment: string): string =>
  path.length === 0 ? segment : `${path}.${segment}`;

/**
 * Report every key in `text` that its schema does not document.
 *
 * @param text        the YAML source
 * @param schema      the object type's schema, as loaded from `media/sml-schema/`
 * @param objectType  the SML `object_type`, used to scope allowlist entries
 * @param allowlist   known spec gaps, from `index.json`'s `knownUndocumented`
 */
export function findUnknownKeys(
  text: string,
  schema: JsonSchema,
  objectType?: string,
  allowlist: Allowlist = Allowlist.empty(),
): UnknownKey[] {
  const findings: UnknownKey[] = [];

  // A file mid-edit is usually unparseable for a keystroke or two. Parsing errors
  // are the YAML extension's job to report; here they just mean "no findings yet".
  let contents: Node | null;
  try {
    contents = parseDocument(text).contents;
  } catch {
    return findings;
  }
  if (!contents) return findings;

  const walk = (node: unknown, at: JsonSchema | undefined, path: string): void => {
    const resolved = deref(at as JsonSchema | undefined, schema);
    if (!resolved) return;
    const { schema: current, className } = resolved;

    if (isMap(node)) {
      const properties = current.properties;
      // No `properties` means the schema does not describe this shape (a free-form
      // map, a composition keyword, or a value whose type disagrees with the
      // document). Descending would invent constraints, so stop.
      if (!properties) return;
      const documented = Object.keys(properties);

      for (const pair of node.items) {
        const key = pair.key;
        if (!isScalar(key) || typeof key.value !== "string") continue;
        const name = key.value;
        if (YAML_INTRINSICS.has(name)) continue;

        const child = properties[name];
        if (!child) {
          if (!allowlist.has(name, objectType, className)) {
            const range = key.range;
            findings.push({
              key: name,
              path,
              start: range ? range[0] : 0,
              end: range ? range[1] : 0,
              suggestion: suggestFor(name, documented),
            });
          }
          // An unknown key's *contents* are unknown too — anything below it would
          // be reported against a schema that does not apply.
          continue;
        }

        if (pair.value) walk(pair.value, child, join(path, name));
      }
      return;
    }

    if (isSeq(node)) {
      const items = current.items;
      if (!items) return;
      node.items.forEach((item, index) => {
        if (item) walk(item, items, `${path}[${index}]`);
      });
    }
  };

  walk(contents, schema, "");
  return findings;
}
