/**
 * Identity of an aggregate across hosts: the set of objects its logical plan
 * selects (from the export payload's `planJson`), independent of any
 * host-specific ids. Ids differ per host, so key / reference ids are first
 * translated to their logical names (see atscale-aggregate-idmap.ts) before
 * hashing, and both a column's `alias` and its owning `model` id (which also
 * legitimately differ between hosts) are dropped before hashing.
 *
 * Ported from Atscale-Environment-Manager's api/atscale/backend.py
 * (`plan_fingerprint`).
 */
import { createHash } from "node:crypto";
import { translatePlan } from "./atscale-aggregate-idmap.js";

function isRecord(o: unknown): o is Record<string, unknown> {
  return typeof o === "object" && o !== null && !Array.isArray(o);
}

function strip(o: unknown): unknown {
  if (isRecord(o)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(o).sort()) {
      if (key === "alias" || key === "model") continue;
      out[key] = strip(o[key]);
    }
    return out;
  }
  if (Array.isArray(o)) return o.map(strip);
  return o;
}

/**
 * Order-insensitive fingerprint of a plan's selected columns, or `undefined`
 * when the plan can't be parsed or has no `selection.columns`.
 */
export function planFingerprint(plan: unknown, names?: Record<string, string>): string | undefined {
  let obj: unknown = plan;
  if (typeof obj === "string") {
    try {
      obj = JSON.parse(obj);
    } catch {
      return undefined;
    }
  }
  if (names) {
    obj = translatePlan(obj, names);
  }
  const columns = isRecord(obj) && isRecord(obj.selection) ? obj.selection.columns : undefined;
  if (!Array.isArray(columns) || columns.length === 0) {
    return undefined;
  }
  const canon = columns
    .map((c) => JSON.stringify(strip({ value: isRecord(c) ? c.value : undefined, agg: isRecord(c) ? c["aggregation-type"] : undefined })))
    .sort();
  return createHash("sha1").update(canon.join("\n")).digest("hex");
}
