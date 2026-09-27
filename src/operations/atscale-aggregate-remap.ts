/**
 * Rewrite a source export payload so it imports cleanly into the target
 * model. Ids differ per host (catalogId / modelId, instance ids, key and
 * role-play reference ids inside `planJson`), so every source id in the
 * payload is substituted with the target's before POSTing it to
 * `/v1/aggregates/import/catalogs/{c}/models/{m}`:
 *
 *   - `exportCatalogId`/`exportModelId` and each value's `catalogId`/`modelId`,
 *     plus every occurrence inside `planJson` -> target catalog / model id
 *   - `activeInstanceId`/`latestInstanceId` -> the target counterpart's
 *     instance, when the same aggregate already exists there (blocked); for a
 *     genuinely new aggregate the source ids are kept. The engine's import
 *     (AggregateImportHelper) never reads them — it creates new definitions —
 *     but the import request schema requires non-null strings, so a `null`
 *     from the export (or a hand-edited file) is rejected with a 400.
 *   - key / role-play reference ids inside `planJson` -> the target's ids for
 *     the same *names* (atscale-aggregate-idmap.ts); an aggregate whose plan
 *     references an object missing on the target is skipped, not imported.
 *   - `connectionId` (values + `exportSummary`) -> the target model's
 *     connection, when it differs
 *
 * Ported from Atscale-Environment-Manager's api/promote/remap.py.
 */
import { planIds, translatePlan } from "./atscale-aggregate-idmap.js";

export type RemapProblem = { id: string; reason: string };

// z.string() (non-optional) fields of each value in the import request schema
// (SML/apps/api/src/public/aggregate/models/import-aggregate.dto.ts).
export const REQUIRED_STRINGS = [
  "activeInstanceId", "latestInstanceId", "baseType", "catalogId", "connectionId",
  "createdAt", "id", "modelId", "subType", "triggeringQueryId",
] as const;

function isRecord(o: unknown): o is Record<string, unknown> {
  return typeof o === "object" && o !== null && !Array.isArray(o);
}

function swap(o: unknown, ids: Record<string, string>): unknown {
  if (typeof o === "string") return ids[o] ?? o;
  if (Array.isArray(o)) return o.map((v) => swap(v, ids));
  if (isRecord(o)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) out[k] = swap(v, ids);
    return out;
  }
  return o;
}

/**
 * Same id on the target -> keep it; exactly one target connection -> use it;
 * otherwise ambiguous (`undefined`).
 */
export function targetConnection(sourceConn: string | undefined, targetConns: string[]): string | undefined {
  if (sourceConn && targetConns.includes(sourceConn)) return sourceConn;
  if (targetConns.length === 1) return targetConns[0];
  return undefined;
}

export type RemapExportOptions = {
  targetCatalogId: string;
  targetModelId: string;
  /** Source definition id -> the target counterpart's instance id, when the same aggregate already exists there (blocked). */
  targetInstances?: Record<string, string | undefined>;
  targetConnections?: string[];
  /** Source-host id -> logical name map (atscale-aggregate-idmap.ts idNames), for key/reference translation. */
  sourceNames?: Record<string, string>;
  /** Logical name -> target-host id map (atscale-aggregate-idmap.ts nameIds), for key/reference translation. */
  targetIdsByName?: Record<string, string>;
};

/** (payload for the target, problems — aggregates skipped and why). */
export function remapExport(
  payload: Record<string, unknown>,
  opts: RemapExportOptions,
): { payload: Record<string, unknown>; problems: RemapProblem[] } {
  const out: Record<string, unknown> = JSON.parse(JSON.stringify(payload));
  const ids: Record<string, string> = {
    [String(payload.exportCatalogId)]: opts.targetCatalogId,
    [String(payload.exportModelId)]: opts.targetModelId,
  };
  const conns: Record<string, string> = {};
  const problems: RemapProblem[] = [];
  const values: Record<string, unknown>[] = [];

  const aggregates = isRecord(payload.aggregates) ? payload.aggregates : {};
  const sourceValues = Array.isArray(aggregates.values) ? aggregates.values : [];

  for (const raw of sourceValues) {
    if (!isRecord(raw)) continue;
    const v = raw;
    const objectIds: Record<string, string> = {};

    if (opts.sourceNames && opts.targetIdsByName) {
      const missing: string[] = [];
      for (const oid of planIds(v.planJson)) {
        const name = opts.sourceNames[oid];
        if (name && opts.targetIdsByName[name]) {
          objectIds[oid] = opts.targetIdsByName[name];
        } else {
          missing.push(name ?? oid);
        }
      }
      if (missing.length > 0) {
        problems.push({ id: String(v.id), reason: "Not on target model: " + Array.from(new Set(missing)).sort().join(", ") });
        continue;
      }
    }

    const srcConn = typeof v.connectionId === "string" ? v.connectionId : undefined;
    const tgtConn = opts.targetConnections && opts.targetConnections.length > 0
      ? targetConnection(srcConn, opts.targetConnections)
      : srcConn;
    if (srcConn && !tgtConn) {
      problems.push({ id: String(v.id), reason: `Connection ${srcConn} has no unambiguous match on the target` });
      continue;
    }
    if (srcConn && tgtConn && srcConn !== tgtConn) {
      conns[srcConn] = tgtConn;
    }

    const allIds = { ...ids, ...conns };
    let nv = swap(JSON.parse(JSON.stringify(v)), allIds) as Record<string, unknown>;
    const plan = v.planJson;
    if (typeof plan === "string") {
      try {
        nv.planJson = JSON.stringify(swap(JSON.parse(plan), ids));
      } catch {
        nv.planJson = plan;
      }
    }
    if (Object.keys(objectIds).length > 0) {
      nv.planJson = translatePlan(nv.planJson, objectIds);
    }

    const counterpart = opts.targetInstances?.[String(v.id)];
    nv.activeInstanceId = counterpart || v.activeInstanceId || v.latestInstanceId || "";
    nv.latestInstanceId = counterpart || v.latestInstanceId || v.activeInstanceId || "";
    for (const field of REQUIRED_STRINGS) {
      if (typeof nv[field] !== "string") nv[field] = "";
    }
    if (!isRecord(nv.notes) || typeof (nv.notes as Record<string, unknown>).dimensional !== "boolean") {
      nv.notes = { dimensional: false };
    }
    values.push(nv);
  }

  out.exportCatalogId = opts.targetCatalogId;
  out.exportModelId = opts.targetModelId;
  out.aggregates = { ...(isRecord(payload.aggregates) ? payload.aggregates : {}), count: values.length, values };

  const summary = isRecord(out.exportSummary) ? out.exportSummary : undefined;
  const connectionIds = summary && isRecord(summary.connectionIds) ? summary.connectionIds : undefined;
  const summaryValues = connectionIds && Array.isArray(connectionIds.values) ? connectionIds.values : [];
  const mapped = Array.from(new Set(summaryValues.map((c) => (typeof c === "string" ? conns[c] ?? c : c)))).sort();
  out.exportSummary = { ...(summary ?? {}), connectionIds: { count: mapped.length, values: mapped } };

  return { payload: out, problems };
}
