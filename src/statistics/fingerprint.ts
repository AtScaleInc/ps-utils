/**
 * Serialize a SchemaFingerprint to YAML and write it to disk.
 *
 * The output file is human-readable and machine-parseable.  No original table
 * or column names appear — all entities are referenced by their opaque IDs.
 */

import fs   from "fs";
import path from "path";
import yaml from "js-yaml";

import type { SchemaFingerprint } from "./types.js";
import { validateFingerprint }    from "./security.js";

/**
 * Read and parse a fingerprint YAML file produced by writeFingerprintFile.
 * Throws if the file does not exist, cannot be parsed, or fails any
 * fatal security validation (review/04 §Hardened Fingerprint Contract).
 * Non-fatal warnings are surfaced on stderr so CI logs capture them.
 */
export function readFingerprintFile(inputPath: string): SchemaFingerprint {
  const resolved = path.resolve(inputPath);
  const raw = fs.readFileSync(resolved, "utf8");
  const fp  = yaml.load(raw) as SchemaFingerprint;

  const { errors, warnings } = validateFingerprint(fp);
  for (const w of warnings) process.stderr.write(`[security/fingerprint] warn: ${w}\n`);
  if (errors.length > 0) {
    throw new Error(`[security/fingerprint] validation failed:\n  - ${errors.join("\n  - ")}`);
  }
  return fp;
}

/**
 * Serialise the fingerprint to a YAML string.
 * No lossy transformations — all numeric values are written as-is.
 */
export function fingerprintToYaml(fp: SchemaFingerprint): string {
  return yaml.dump(fp, {
    lineWidth:  -1,       // no wrapping
    sortKeys:   false,    // preserve declaration order
    noRefs:     true,
    indent:     2,
  });
}

/**
 * Write the fingerprint to `outputPath`, creating parent directories as needed.
 */
export function writeFingerprintFile(fp: SchemaFingerprint, outputPath: string): void {
  const { errors } = validateFingerprint(fp);
  if (errors.length > 0) {
    throw new Error(
      `[security/fingerprint] refusing to write fingerprint — validation failed:\n  - ${errors.join("\n  - ")}`,
    );
  }
  const resolved = path.resolve(outputPath);
  const dir      = path.dirname(resolved);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(resolved, fingerprintToYaml(fp), "utf8");
}
