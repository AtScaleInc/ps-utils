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

/**
 * Read and parse a fingerprint YAML file produced by writeFingerprintFile.
 * Throws if the file does not exist or cannot be parsed.
 */
export function readFingerprintFile(inputPath: string): SchemaFingerprint {
  const resolved = path.resolve(inputPath);
  const raw = fs.readFileSync(resolved, "utf8");
  return yaml.load(raw) as SchemaFingerprint;
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
  const resolved = path.resolve(outputPath);
  const dir      = path.dirname(resolved);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(resolved, fingerprintToYaml(fp), "utf8");
}
