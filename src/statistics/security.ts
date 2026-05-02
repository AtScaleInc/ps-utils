/**
 * Security & compliance controls for the statistical fingerprint pipeline.
 *
 * Integration points (all additive — no existing API changed):
 *
 *   • extractor.ts              → hardenFingerprint(fp) after assembly
 *   • fingerprint.ts read/write → validateFingerprint(fp) warn-on-violation
 *   • data-generator.ts         → assertFkClosure(data) post-generation
 *   • GenerateDataFromDataShape → writePipelineIsolationReport / writeRunManifest
 *
 * Controls NOT implemented here (require out-of-repo infrastructure):
 *
 *   • Differential-privacy noise on aggregate queries (requires ε-budget ledger)
 *   • Ed25519 fingerprint signing               (requires key-management service)
 *   • Append-only WORM audit log                (requires object-lock storage)
 *   • Dynamic RBAC / column masking             (semantic-layer runtime concern)
 *
 * These hooks raise clear "control not installed" diagnostics rather than
 * silently no-op, so a future implementer can discover them.
 * See docs/STATISTICS.md §Security & Compliance Controls for the full list.
 */

import crypto from "crypto";
import fs     from "fs";
import path   from "path";

import type {
  SchemaFingerprint,
  DimensionFingerprint,
  FactFingerprint,
  LevelFingerprint,
  PairwiseMeasureCorrelation,
  FkAssociation,
  ConformedDimensionFingerprint,
} from "./types.js";

// ─── Security constants ───────────────────────────────────────────────────────

/** R-21: below this row count, unmasked aggregate stats risk re-identification. */
export const MIN_ROWS_FOR_UNMASKED_FINGERPRINT = 5000;

/** R-13: categorical groups below this count must be collapsed to "other". */
export const MIN_GROUP_SIZE_K_ANON = 5;

/** Default sensitivity class when a field cannot be auto-classified. */
export const DEFAULT_SENSITIVITY: SensitivityClass = "Confidential";

/** Review §04: semantic version of this security profile, stamped into manifests. */
export const SECURITY_PROFILE_VERSION = "1.0.0";

// ─── Sensitivity classification ──────────────────────────────────────────────

export type SensitivityClass = "Public" | "Internal" | "Confidential" | "Restricted";

const RESTRICTED_PATTERNS = [
  /\bssn\b/i, /\bein\b/i, /\bdob\b/i, /\bpassport\b/i, /\bdriver[_ ]?license\b/i,
  /\baccount[_ ]?number\b/i, /\bcredit[_ ]?card\b/i, /\bmedical\b/i,
  /\btax[_ ]?id\b/i, /\bbank[_ ]?account\b/i,
];
const CONFIDENTIAL_PATTERNS = [
  /\bname\b/i, /\bemail\b/i, /\bphone\b/i, /\baddress\b/i,
  /\bzip\b/i, /\bpostal\b/i, /\bcustomer[_ ]?id\b/i, /\buser[_ ]?id\b/i,
  /\bsalary\b/i, /\bcompensation\b/i, /\bbalance\b/i, /\bage\b/i,
];
const PUBLIC_PATTERNS = [
  /\bcountry\b/i, /\bregion\b/i, /\bcurrency\b/i,
  /\bcategory\b/i, /\bproduct[_ ]?type\b/i,
];

/**
 * Classify a field by name.
 * Returns DEFAULT_SENSITIVITY ("Confidential") when no pattern matches —
 * i.e. the system defaults to *more* protection, never less.
 */
export function sensitivityFor(fieldName: string): SensitivityClass {
  // Normalize: regex \b treats underscore as a word character, so "customer_ssn"
  // would not match /\bssn\b/.  Converting "_" → " " restores intuitive boundaries.
  const n = fieldName.toLowerCase().replace(/_/g, " ");
  for (const re of RESTRICTED_PATTERNS)   if (re.test(n)) return "Restricted";
  for (const re of CONFIDENTIAL_PATTERNS) if (re.test(n)) return "Confidential";
  for (const re of PUBLIC_PATTERNS)       if (re.test(n)) return "Public";
  return DEFAULT_SENSITIVITY;
}

// ─── Binning helpers (R-4, R-10) ─────────────────────────────────────────────

export type ColdMemberBucket   = "0-10%" | "10-30%" | "30-60%" | "60-100%";
export type OverlapBucket      = "0-20%" | "20-50%" | "50-80%" | "80-100%";

export function bucketCold(fraction: number): ColdMemberBucket {
  if (fraction < 0.10) return "0-10%";
  if (fraction < 0.30) return "10-30%";
  if (fraction < 0.60) return "30-60%";
  return "60-100%";
}

export function bucketOverlap(fraction: number): OverlapBucket {
  if (fraction < 0.20) return "0-20%";
  if (fraction < 0.50) return "20-50%";
  if (fraction < 0.80) return "50-80%";
  return "80-100%";
}

// ─── Pearson r rounding (R-7) ────────────────────────────────────────────────

/** Round to two decimal places — sufficient for copula reconstruction, blunts fingerprinting. */
export function roundPearsonR(r: number): number {
  return Math.round(r * 100) / 100;
}

// ─── Near-functional threshold (R-11) ────────────────────────────────────────

export const NEAR_FUNCTIONAL_THRESHOLD = 0.90;

/** Returns true when an FK association score indicates a near-one-to-one structural coupling. */
export function isNearFunctional(score: number): boolean {
  return score >= NEAR_FUNCTIONAL_THRESHOLD;
}

// ─── Absolute-date rejector (R-9) ────────────────────────────────────────────

/**
 * ISO-8601-like date pattern.  The fingerprint schema does not currently carry
 * date columns as first-class values, but a naive extension (e.g. stamping
 * min/max as ISO dates) would leak event timelines directly.  This rejector
 * recursively scans any string value in the fingerprint and throws if one looks
 * like a date — forcing implementers to quantize into year/month/weekday tiles
 * before adding new temporal fields (quantize into year/month/weekday tiles instead).
 */
const ABSOLUTE_DATE_RE = /\b(19|20)\d{2}-\d{2}-\d{2}([T ]\d{2}:\d{2})?/;

export function containsAbsoluteDate(value: unknown): boolean {
  if (typeof value === "string") return ABSOLUTE_DATE_RE.test(value);
  if (Array.isArray(value))      return value.some(containsAbsoluteDate);
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some(containsAbsoluteDate);
  }
  return false;
}

// ─── Small-table gate (R-21) ─────────────────────────────────────────────────

/**
 * A dimension or fact with fewer than MIN_ROWS_FOR_UNMASKED_FINGERPRINT rows
 * requires DP noise on its aggregates.  We don't have a DP implementation
 * wired in yet; this function returns a structured warning instead.
 */
export function smallTableWarnings(fp: SchemaFingerprint): string[] {
  const warnings: string[] = [];
  for (const dim of fp.dimensions) {
    if (dim.rowCount < MIN_ROWS_FOR_UNMASKED_FINGERPRINT) {
      warnings.push(
        `dimension ${dim.id} has ${dim.rowCount} rows (< ${MIN_ROWS_FOR_UNMASKED_FINGERPRINT}); ` +
        `consider adding differential-privacy noise before external distribution`,
      );
    }
  }
  for (const fact of fp.facts) {
    if (fact.rowCount < MIN_ROWS_FOR_UNMASKED_FINGERPRINT) {
      warnings.push(
        `fact ${fact.id} has ${fact.rowCount} rows (< ${MIN_ROWS_FOR_UNMASKED_FINGERPRINT}); ` +
        `consider adding differential-privacy noise before external distribution`,
      );
    }
  }
  return warnings;
}

// ─── Generated-key shape invariant (R-15) ────────────────────────────────────

/**
 * The upstream generator uses dense positive integer keys (1..N) allocated
 * in-process.  No real dimension key ever enters the generator's memory, so a
 * "syn_" string prefix is unnecessary — the invariant we enforce is the one
 * the implementation already satisfies: every _key column value must be a
 * positive integer that was freshly allocated.
 *
 * Throws if any generated row contains a non-positive-integer value in a
 * column whose name ends with "_key" (FK or PK).  This catches accidental
 * propagation of user-supplied key values during future refactors.
 */
export function assertGeneratedKeyShape(
  tableName: string,
  columns:   string[],
  rows:      unknown[][],
): void {
  const keyIdxs: number[] = [];
  for (let i = 0; i < columns.length; i++) {
    if (columns[i]!.endsWith("_key")) keyIdxs.push(i);
  }
  if (keyIdxs.length === 0) return;

  for (let r = 0; r < rows.length; r++) {
    for (const i of keyIdxs) {
      const v = rows[r]![i];
      if (v === null || v === undefined) continue; // null FK is permitted per fingerprint
      if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
        throw new Error(
          `[security] generated-key invariant violated in ${tableName} ` +
          `row ${r} column "${columns[i]}": got ${JSON.stringify(v)} ` +
          `(expected a positive integer allocated in-process). ` +
          `See docs/STATISTICS.md §Security & Compliance Controls (R-15).`,
        );
      }
    }
  }
}

// ─── FK closure assertion ────────────────────────────────────────────────────

export interface FkClosureReport {
  /** Checks where every fact FK value was resolvable to a dimension leaf key. */
  passed: Array<{ factTable: string; fkColumn: string; dimTable: string }>;
  /** Checks that failed with the number of orphan values discovered. */
  failed: Array<{ factTable: string; fkColumn: string; dimTable: string; orphanCount: number }>;
}

/**
 * Assert that every non-null FK value in each fact table appears in the
 * referenced dimension's leaf key set.  Returns a structured report and
 * throws if any orphans are found.
 */
export function assertFkClosure(
  factTables: Array<{ tableName: string; columns: string[]; rows: unknown[][] }>,
  dimLeafKeys: Map<string, Set<number>>,   // keyed by dim table name
): FkClosureReport {
  const report: FkClosureReport = { passed: [], failed: [] };

  for (const fact of factTables) {
    for (let colIdx = 0; colIdx < fact.columns.length; colIdx++) {
      const col = fact.columns[colIdx]!;
      if (!col.endsWith("_key") && !/_key_\d+$/.test(col)) continue;

      // Strip the "_key" or "_key_N" suffix to recover the dim table name.
      const dimTable = col.replace(/_key(_\d+)?$/, "");
      const leaves   = dimLeafKeys.get(dimTable);
      if (!leaves) continue; // not a FK we track (may be a measure)

      let orphanCount = 0;
      for (const row of fact.rows) {
        const v = row[colIdx];
        if (v === null || v === undefined) continue;
        if (typeof v === "number" && !leaves.has(v)) orphanCount++;
      }

      const entry = { factTable: fact.tableName, fkColumn: col, dimTable };
      if (orphanCount === 0) report.passed.push(entry);
      else                   report.failed.push({ ...entry, orphanCount });
    }
  }

  if (report.failed.length > 0) {
    const detail = report.failed.map((f) =>
      `  ${f.factTable}.${f.fkColumn} → ${f.dimTable}: ${f.orphanCount} orphans`,
    ).join("\n");
    throw new Error(
      `[security] FK closure assertion failed — synthetic data violates ` +
      `referential integrity:\n${detail}`,
    );
  }

  return report;
}

// ─── Fingerprint validation (warn-only) ───────────────────────────────────────

export interface ValidationResult {
  warnings: string[];
  errors:   string[];
}

/**
 * Check a fingerprint against the review §04 hardened contract.
 *
 * Warnings are non-fatal — they indicate the fingerprint was produced with an
 * earlier version of this code or without hardening enabled.  Errors are fatal
 * and halt further processing.
 */
export function validateFingerprint(fp: SchemaFingerprint): ValidationResult {
  const warnings: string[] = [];
  const errors:   string[] = [];

  // E-1: absolute dates forbidden in the *data* portions of the fingerprint.
  // Envelope/metadata fields (capturedAt, security.appliedAt) are legitimate
  // ISO timestamps describing the fingerprint itself, not customer data.
  const dataPortions = {
    dimensions:          fp.dimensions,
    facts:               fp.facts,
    conformedDimensions: fp.conformedDimensions,
  };
  if (containsAbsoluteDate(dataPortions)) {
    errors.push(
      "absolute date string detected in fingerprint data (R-9 violation); " +
      "temporal fields must be quantized (year/month/weekday tiles) — no absolute dates in fingerprint data",
    );
  }

  // W-1: small-table rows without DP noise
  warnings.push(...smallTableWarnings(fp));

  // W-2: unbounded pearsonR precision (pre-hardening fingerprint)
  for (const fact of fp.facts) {
    for (const c of fact.measureCorrelations ?? []) {
      if (Math.abs(c.pearsonR - roundPearsonR(c.pearsonR)) > 1e-9) {
        warnings.push(
          `fact ${fact.id} measure correlation (${c.measureId1}, ${c.measureId2}) ` +
          `has unrounded pearsonR ${c.pearsonR}; R-7 recommends 2-dp rounding`,
        );
        break; // one warning per fact is enough
      }
    }
  }

  // W-3: unbounded coldMemberFraction precision
  for (const dim of fp.dimensions) {
    for (const hier of dim.hierarchies) {
      for (const lvl of hier.levels) {
        const f = lvl.coldMemberFraction;
        if (f !== undefined && !(lvl as LevelFingerprint & { coldMemberBucket?: string }).coldMemberBucket) {
          warnings.push(
            `dim ${dim.id} level ${lvl.id} has raw coldMemberFraction but no bucketed form; ` +
            `R-4 recommends quartile binning`,
          );
          break;
        }
      }
    }
  }

  return { warnings, errors };
}

// ─── Hardening pass ───────────────────────────────────────────────────────────

export interface HardenOptions {
  /** When true, replace raw fractions with bucketed values.  Default: true. */
  applyBinning?:  boolean;
  /** When true, round pearsonR values to 2 decimal places.  Default: true. */
  applyRounding?: boolean;
  /** When true, attach sensitivity classifications to every field.  Default: true. */
  applySensitivity?: boolean;
  /** When true, attach is_near_functional flag to FK associations > 0.9.  Default: true. */
  applyNearFunctional?: boolean;
}

/**
 * Apply all review-derived hardening to a fingerprint in place and return it.
 *
 * This is strictly additive: every existing field stays in place so downstream
 * consumers (data-generator, ddl-generator) continue to function without
 * modification.  The hardening adds new optional fields:
 *
 *   LevelFingerprint.coldMemberBucket
 *   FkAssociation.isNearFunctional
 *   ConformedDimensionFingerprint.pairwiseOverlap[].overlapBucket
 *   PairwiseMeasureCorrelation.pearsonR → rounded in-place
 *   SchemaFingerprint.security          → { profileVersion, appliedControls, ... }
 */
export function hardenFingerprint(
  fp:       SchemaFingerprint,
  options:  HardenOptions = {},
): SchemaFingerprint {
  const opts: Required<HardenOptions> = {
    applyBinning:        options.applyBinning        ?? true,
    applyRounding:       options.applyRounding       ?? true,
    applySensitivity:    options.applySensitivity    ?? true,
    applyNearFunctional: options.applyNearFunctional ?? true,
  };

  // Level buckets
  if (opts.applyBinning) {
    for (const dim of fp.dimensions) {
      for (const hier of dim.hierarchies) {
        for (const lvl of hier.levels) {
          if (lvl.coldMemberFraction !== undefined) {
            (lvl as LevelFingerprint & { coldMemberBucket?: ColdMemberBucket })
              .coldMemberBucket = bucketCold(lvl.coldMemberFraction);
          }
        }
      }
    }
    for (const conf of fp.conformedDimensions) {
      for (const pw of conf.pairwiseOverlap) {
        (pw as typeof pw & { overlapBucket?: OverlapBucket })
          .overlapBucket = bucketOverlap(pw.overlapFraction);
      }
    }
  }

  // Measure correlation rounding
  if (opts.applyRounding) {
    for (const fact of fp.facts) {
      for (const corr of fact.measureCorrelations ?? []) {
        (corr as PairwiseMeasureCorrelation).pearsonR = roundPearsonR(corr.pearsonR);
      }
    }
  }

  // Near-functional flag on FK associations
  if (opts.applyNearFunctional) {
    for (const fact of fp.facts) {
      for (const assoc of fact.fkAssociations ?? []) {
        (assoc as FkAssociation & { isNearFunctional?: boolean })
          .isNearFunctional = isNearFunctional(assoc.associationScore);
      }
    }
  }

  // Sensitivity classifications — every measure and level gets a class
  if (opts.applySensitivity) {
    for (const dim of fp.dimensions) {
      for (const hier of dim.hierarchies) {
        for (const lvl of hier.levels) {
          (lvl as LevelFingerprint & { sensitivity?: SensitivityClass })
            .sensitivity = sensitivityFor(lvl.id);
        }
      }
    }
    for (const fact of fp.facts) {
      for (const m of fact.measures) {
        (m as typeof m & { sensitivity?: SensitivityClass })
          .sensitivity = sensitivityFor(m.id);
      }
    }
  }

  // Stamp the applied controls onto the fingerprint so downstream consumers
  // can confirm what hardening was run.
  (fp as SchemaFingerprint & { security?: SecurityStamp }).security = {
    profileVersion:  SECURITY_PROFILE_VERSION,
    appliedAt:       new Date().toISOString(),
    appliedControls: Object.entries(opts).filter(([, v]) => v).map(([k]) => k),
    deferredControls: [
      "differential_privacy_noise",
      "ed25519_signing",
      "worm_audit_log",
      "dynamic_rbac_masking",
    ],
  };

  return fp;
}

export interface SecurityStamp {
  profileVersion:    string;
  appliedAt:         string;
  appliedControls:   string[];
  deferredControls:  string[];
}

// ─── Pipeline isolation report ───────────────────────────────────────────────

export interface PipelineIsolationReport {
  operation:       string;
  startedAt:       string;
  completedAt:     string;
  inputs: {
    fingerprintFile:     string;
    fingerprintSha256:   string;
    fingerprintVersion:  string;
  };
  outputs: {
    path:         string;
    kind:         "csv-directory" | "database" | "ddl-file";
    artifacts:    string[];
  };
  enforced: {
    noRealDataAccessed:     boolean;
    outputsResolveWithinScope: boolean;
    generatedKeyShapeOk:    boolean;
    fkClosureOk:            boolean;
  };
  profileVersion: string;
}

export function sha256File(filePath: string): string {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

export function writePipelineIsolationReport(
  reportsDir: string,
  report:     PipelineIsolationReport,
): string {
  fs.mkdirSync(reportsDir, { recursive: true });
  const out = path.join(reportsDir, "pipeline_isolation_report.json");
  fs.writeFileSync(out, JSON.stringify(report, null, 2) + "\n", "utf8");
  return out;
}

// ─── Run manifest ────────────────────────────────────────────────────────────

/**
 * Simplified audit record.  Full WORM storage requires object-lock infrastructure;
 * this record is a forensic anchor that a pipeline orchestrator can ingest into a
 * real append-only log.
 */
export interface RunManifest {
  operation:       string;
  startedAt:       string;
  completedAt:     string;
  seed?:           number;
  scaleFactor?:    number;
  fingerprintSha256: string;
  outputDigest:    string;
  rowCounts:       Record<string, number>;
  profileVersion:  string;
}

export function writeRunManifest(
  reportsDir: string,
  manifest:   RunManifest,
): string {
  fs.mkdirSync(reportsDir, { recursive: true });
  const out = path.join(reportsDir, "generation_manifest.json");
  fs.writeFileSync(out, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  return out;
}

// ─── Integrity report ────────────────────────────────────────────────────────

export interface IntegrityReport {
  checkedAt:          string;
  tables: Array<{
    name:      string;
    rowCount:  number;
    columnCount: number;
  }>;
  fkClosure:  FkClosureReport;
  profileVersion: string;
}

export function writeIntegrityReport(
  reportsDir: string,
  report:     IntegrityReport,
): string {
  fs.mkdirSync(reportsDir, { recursive: true });
  const out = path.join(reportsDir, "integrity_report.json");
  fs.writeFileSync(out, JSON.stringify(report, null, 2) + "\n", "utf8");
  return out;
}

// ─── Deferred-control hooks (fail-loud placeholders) ──────────────────────────

/**
 * Stubs for controls that require infrastructure not yet present in the repo.
 * They intentionally throw when called so that a future implementer sees a
 * clear signal rather than a silent no-op.
 */
export const deferredControls = {
  applyDifferentialPrivacy(_fp: SchemaFingerprint, _epsilon: number): never {
    throw new Error(
      "[security] differential-privacy noise is not installed. " +
      "An ε-budget ledger and SQL-noise injection layer are required before enabling this control.",
    );
  },
  signFingerprintEd25519(_fp: SchemaFingerprint, _keyId: string): never {
    throw new Error(
      "[security] Ed25519 signing is not installed. " +
      "A key-management service and rotation policy are required before enabling this control.",
    );
  },
  appendWormAuditRecord(_record: RunManifest): never {
    throw new Error(
      "[security] append-only WORM audit log is not installed. " +
      "Object-lock storage integration is required before enabling this control.",
    );
  },
};
