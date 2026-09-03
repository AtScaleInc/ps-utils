/**
 * AtScale XML project (project_2_0 schema) → SML YAML converter.
 *
 * Implements the algorithm documented in CONVERSION.md.
 *
 * Output keys in the returned Map are relative file paths:
 *   catalog.yml
 *   connections/<connectionName>.yml
 *   datasets/<datasetName>.yml
 *   dimensions/<dimensionName>.yml
 *   metrics/<metricName>.yml
 *   models/<modelName>.yml
 */

import { Parser } from "xml2js";
import { dump } from "js-yaml";
import { createHash } from "crypto";
import type { Logger } from "../../logging.js";

// ============================================================
// Public API
// ============================================================

export interface XmlConversionOptions {
  /** SML connection unique_name. If omitted, extracted from XML <physical><connection id="...">. */
  connectionName?: string;
  /** Optional connection type (e.g. "snowflake"). Written as comment only. */
  connectionType?: string;
  /** Override the catalog label. Defaults to schema name. */
  catalogName?: string;
  /** Database name to embed in the connection file (moves db out of individual datasets). */
  connectionDb?: string;
  /** Schema name to embed in the connection file (moves schema out of individual datasets). */
  connectionSchema?: string;
  /** Original XML filename — included in the generated README.md for traceability. */
  xmlFileName?: string;
}

/**
 * Parse an AtScale XML project file and emit a Map of relative-path → YAML.
 */
export async function convertXmlToSml(
  xmlContent: string,
  opts: XmlConversionOptions,
  logger: Logger,
): Promise<Map<string, string>> {
  const parser = new Parser({
    explicitArray: true,
    attrkey: "$",
    charkey: "_",
    explicitCharkey: false,
    trim: true,
    xmlns: false,
  });

  let parsed: Record<string, unknown>;
  try {
    parsed = await parser.parseStringPromise(xmlContent);
  } catch (e) {
    throw new Error(`Failed to parse XML: ${e instanceof Error ? e.message : String(e)}`);
  }

  // xml2js does NOT wrap the root element in an array (only child elements are wrapped).
  const rawSchema = parsed.schema ?? parsed["xsd:schema"] ?? parsed["ns0:schema"] ??
    (Object.values(parsed)[0] as unknown);

  // Normalise: if it's an array (edge case), unwrap; otherwise use as-is.
  const schemaEl = (Array.isArray(rawSchema) ? rawSchema[0] : rawSchema) as
    | Record<string, unknown>
    | undefined;

  if (!schemaEl || typeof schemaEl !== "object") {
    throw new Error("No <schema> element found in XML");
  }

  const schemaName = a(schemaEl, "name") ?? "Model";
  const catalogName = opts.catalogName ?? schemaName;
  const output = new Map<string, string>();

  // ---------------------------------------------------------------
  // Conversion report accumulators
  // ---------------------------------------------------------------

  const rptDatasets: DatasetRecord[] = [];
  const rptDimensions: DimRecord[] = [];
  const rptMetrics: MetricRecord[] = [];
  const rptModels: ModelRecord[] = [];
  const rptOmissions: OmissionRecord[] = [];
  const rptUnboundByCube: CubeBindingRecord[] = [];

  // Structural omissions: check for XML features the converter doesn't handle.
  const hasRoles        = arr(schemaEl.roles).length > 0 || arr((schemaEl as Record<string, unknown>)["role"]).length > 0;
  const hasPerspectives = arr(schemaEl.perspectives).length > 0 || arr((schemaEl as Record<string, unknown>).perspective).length > 0;
  const hasTranslations = arr(schemaEl.translations).length > 0 || arr((schemaEl as Record<string, unknown>).translation).length > 0;

  if (hasPerspectives) {
    rptOmissions.push({
      category: "Structural",
      item: "Perspectives",
      reason: "Perspective definitions are not converted — no equivalent in SML.",
      recommendation: "Recreate perspectives using row-level security or BI-tool-level views in the consuming application.",
    });
  }
  if (hasRoles) {
    rptOmissions.push({
      category: "Structural",
      item: "Security Roles",
      reason: "Role and grant definitions are not converted.",
      recommendation: "Recreate security roles in the AtScale Design Center after deployment.",
    });
  }
  if (hasTranslations) {
    rptOmissions.push({
      category: "Structural",
      item: "Translations / Localization",
      reason: "Translation overrides are not converted.",
      recommendation: "Add multi-language labels manually to the SML files if localization is required.",
    });
  }

  // ---------------------------------------------------------------
  // Phase 1: Build UUID resolution maps
  // ---------------------------------------------------------------

  // datasetIdToName: id → name (for resolving data-set-ref IDs)
  const datasetIdToName = new Map<string, string>();
  // datasetNameToPhysical: name → { db?, schema?, tableName?, sql? }
  const datasetNameToPhysical = new Map<string, DatasetPhysical>();

  for (const dsSec of arr(schemaEl["data-sets"])) {
    for (const ds of arr(dsSec["data-set"])) {
      const id = a(ds, "id");
      const name = a(ds, "name");
      if (id && name) datasetIdToName.set(id, name);
      if (name) {
        const phys = parseDatasetPhysical(ds);
        if (phys) datasetNameToPhysical.set(name, phys);
      }
    }
  }

  // Datasets with no physical table or SQL binding (will be emitted with placeholder table name)
  const unboundDatasetNames = new Set<string>();
  for (const dsSec of arr(schemaEl["data-sets"])) {
    for (const ds of arr(dsSec["data-set"])) {
      const dsName = a(ds, "name");
      if (!dsName) continue;
      const phys = datasetNameToPhysical.get(dsName);
      if (!phys || (!phys.tableName && !phys.sql)) {
        unboundDatasetNames.add(dsName);
      }
    }
  }

  // Resolve connection name: use explicit option, else extract from XML <physical><connection id="...">, else fallback
  let connName = opts.connectionName;
  if (!connName) {
    for (const phys of datasetNameToPhysical.values()) {
      if (phys.connectionName) { connName = phys.connectionName; break; }
    }
    connName = connName ?? "connection";
  }

  // keyMap: UUID → KeyRefEntry[]
  const keyMap = new Map<string, KeyRefEntry[]>();
  // attrMap: UUID → AttrRefEntry
  const attrMap = new Map<string, AttrRefEntry>();

  function ingestLogical(logicalEl: Record<string, unknown>, datasetName: string): void {
    for (const kr of arr(logicalEl["key-ref"])) {
      const id = a(kr, "id");
      if (!id) continue;
      const complete = a(kr, "complete") ?? "true";
      const unique = a(kr, "unique") === "true";
      const columns = extractColumns(arr(kr.column));
      // Extract role_play from <ref-path><new-ref><ref-naming>Date Created.{0}</ref-naming>
      let rolePlay: string | undefined;
      const refPathEl = first(arr(kr["ref-path"])) as Record<string, unknown> | undefined;
      if (refPathEl) {
        const newRefEl = first(arr(refPathEl["new-ref"])) as Record<string, unknown> | undefined;
        if (newRefEl) {
          const refNaming = s(first(arr(newRefEl["ref-naming"])));
          if (refNaming) rolePlay = refNaming;
        }
      }
      if (columns.length > 0) {
        const entries = keyMap.get(id) ?? [];
        entries.push({ datasetName, columns, complete, unique, rolePlay });
        keyMap.set(id, entries);
      }
    }
    for (const ar of arr(logicalEl["attribute-ref"])) {
      const id = a(ar, "id");
      if (!id) continue;
      const cols = extractColumns(arr(ar.column));
      if (cols.length > 0) {
        attrMap.set(id, { datasetName, column: cols[0] });
      }
    }
  }

  // Schema-level datasets
  for (const dsSec of arr(schemaEl["data-sets"])) {
    for (const ds of arr(dsSec["data-set"])) {
      const dsName = a(ds, "name");
      if (!dsName) continue;
      for (const logSec of arr(ds.logical)) {
        ingestLogical(logSec as Record<string, unknown>, dsName);
      }
    }
  }

  // Phase 1b: keyed-attribute definitions (schema-level + cube-level)
  const attrDef = new Map<string, AttrDefEntry>();

  function ingestKeyedAttrs(attrsEl: Record<string, unknown>): void {
    for (const ka of arr(attrsEl["keyed-attribute"])) {
      const id = a(ka, "id");
      if (!id) continue;
      const name = a(ka, "name") ?? id;
      const keyUuid = a(ka, "key-ref") ?? "";
      const props = first(arr(ka.properties)) as Record<string, unknown> | undefined;
      const caption = props ? s(first(arr(props.caption))) : undefined;
      const folder = props ? s(first(arr(props.folder))) : undefined;
      const visibleStr = props ? s(first(arr(props.visible))) : undefined;
      const visible = visibleStr !== "false";
      const fmtEl = props ? first(arr(props.formatting)) as Record<string, unknown> | undefined : undefined;
      const formatString = fmtEl ? s(first(arr(fmtEl["format-string"]))) : undefined;
      const namedFormat = fmtEl ? s(first(arr(fmtEl["named-format"]))) : undefined;
      const description = props ? s(first(arr(props.description))) : undefined;
      const allowedCalcTypesEl = props
        ? (first(arr(props["allowed-calculation-types"])) as Record<string, unknown> | undefined)
        : undefined;
      const allowedCalcTypes = allowedCalcTypesEl
        ? arr(allowedCalcTypesEl["calculation-type"]).map(s).filter((t): t is string => Boolean(t))
        : undefined;
      attrDef.set(id, {
        name, caption, keyUuid, formatString, namedFormat, folder, visible, description,
        allowedCalcTypes: allowedCalcTypes?.length ? allowedCalcTypes : undefined,
      });
    }
  }

  // Schema-level attributes
  for (const attrsSec of arr(schemaEl.attributes)) {
    ingestKeyedAttrs(attrsSec as Record<string, unknown>);
  }

  // Collect cubes for processing and gather their data
  const cubeEls: Record<string, unknown>[] = [];
  for (const cubesSec of arr(schemaEl.cubes)) {
    for (const cube of arr(cubesSec.cube)) {
      cubeEls.push(cube as Record<string, unknown>);
    }
  }

  // Cube-level attributes and data-set-refs
  // Datasets no cube ever references are dead schema artifacts (common in migrated/legacy
  // projects) and should not be emitted — tracked here so Phase 2 can skip them.
  const referencedDatasetNames = new Set<string>();
  for (const cube of cubeEls) {
    for (const attrsSec of arr(cube.attributes)) {
      ingestKeyedAttrs(attrsSec as Record<string, unknown>);
    }
    for (const dsSec of arr(cube["data-sets"])) {
      for (const dsRef of arr(dsSec["data-set-ref"])) {
        const refId = a(dsRef, "id");
        const dsName = refId ? (datasetIdToName.get(refId) ?? refId) : undefined;
        if (!dsName) continue;
        referencedDatasetNames.add(dsName);
        for (const logSec of arr(dsRef.logical)) {
          ingestLogical(logSec as Record<string, unknown>, dsName);
        }
      }
    }
  }

  // ---------------------------------------------------------------
  // Phase 2: Emit dataset files
  // ---------------------------------------------------------------

  // Datasets without an explicit <physical> column list (e.g. fact tables meant to be
  // introspected live from the database) still need every referenced column declared in
  // SML. Collect every column any key-ref/attribute-ref points to, per dataset.
  const referencedColumnsByDataset = new Map<string, Set<string>>();
  function addReferencedColumn(datasetName: string, column: string): void {
    const set = referencedColumnsByDataset.get(datasetName) ?? new Set<string>();
    set.add(column);
    referencedColumnsByDataset.set(datasetName, set);
  }
  for (const entries of keyMap.values()) {
    for (const entry of entries) {
      for (const col of entry.columns) addReferencedColumn(entry.datasetName, col);
    }
  }
  for (const entry of attrMap.values()) {
    addReferencedColumn(entry.datasetName, entry.column);
  }
  collectMeasureColumns(cubeEls, datasetIdToName, keyMap, attrMap, addReferencedColumn);

  // The actual dataset-emission loop runs after Phase 3b (dimensions), once
  // referencedDatasetNames also accounts for datasets only used by dimensions — see there.

  // ---------------------------------------------------------------
  // Phase 3: Collect dimension elements
  // ---------------------------------------------------------------

  // Schema-level shared dimensions (keyed by name)
  const schemaDims = new Map<string, Record<string, unknown>>();
  for (const dimsSec of arr(schemaEl.dimensions)) {
    for (const dim of arr(dimsSec.dimension)) {
      const name = a(dim, "name");
      if (name) schemaDims.set(name, dim as Record<string, unknown>);
    }
  }

  // Per-cube inline dimensions (emitted later, scoped to each cube)
  // Also build a global map for dimension YAML emission (all dims across all cubes)
  const allDims = new Map<string, Record<string, unknown>>(schemaDims);
  for (const cube of cubeEls) {
    for (const dimsSec of arr(cube.dimensions)) {
      for (const dim of arr(dimsSec.dimension)) {
        const name = a(dim, "name");
        if (name) allDims.set(name, dim as Record<string, unknown>);
      }
    }
  }

  // User Defined Aggregates reference dimension attributes by id, with an optional
  // ref-path for attributes reached through a snowflake/embedded relationship rather than
  // hosted natively — resolve both mappings once, up front, for all dimensions.
  const { attrIdToDimName, refIdToHostDimName } = collectAttributeDimensionOwnership(allDims);

  // A composite key's default name_column (below) needs to know which of its columns are
  // themselves the sole key of some OTHER level elsewhere in the schema — see
  // collectSoleKeyColumns for the reasoning.
  const soleKeyColumns = collectSoleKeyColumns(allDims, attrDef, keyMap);

  // We emit dimension YAMLs after processing cubes (so we know which dims are referenced)
  const referencedDimNames = new Set<string>();
  // inferRelationships already determines, per cube, whether a dimension is degenerate
  // (no relationship, attaches directly) or has a real relationship — buildDimensionYaml
  // must use that same determination for its own is_degenerate/type field rather than
  // re-deriving it independently, or the two can disagree for a multi-fact cube (a
  // dimension can be degenerate relative to one cube-bound dataset yet have a genuine
  // relationship from the cube's primary fact table via a different dataset/column).
  // A dimension used by multiple cubes with a real relationship in any of them is not
  // degenerate overall, so the relationship set takes precedence when both are present.
  const globalDegenerateDimNames = new Set<string>();
  const globalRelationshipDimNames = new Set<string>();

  // ---------------------------------------------------------------
  // Phase 7: Schema-level calculated members
  // ---------------------------------------------------------------

  const calcMemberDefs = new Map<string, CalcMemberDef>();
  for (const cmSec of arr(schemaEl["calculated-members"])) {
    for (const cm of arr(cmSec["calculated-member"])) {
      const id = a(cm, "id");
      if (!id) continue;
      const def = parseCalcMember(cm as Record<string, unknown>);
      if (def) calcMemberDefs.set(id, def);
    }
  }

  // Map every measure/calculated-member's original name to its final unique_name, so
  // calculation expressions referencing other metrics by name can be rewritten to match.
  const measureRefMap = buildMeasureRefMap(cubeEls, calcMemberDefs);

  // ---------------------------------------------------------------
  // Phase 4+5+Model: Process each cube
  // ---------------------------------------------------------------

  for (const cube of cubeEls) {
    const cubeName = a(cube, "name") ?? schemaName;

    // Classify all dataset refs for this cube as bound or unbound
    const cubeBoundDatasets: string[] = [];
    const cubeUnboundDatasets: string[] = [];
    for (const dsSec of arr(cube["data-sets"])) {
      for (const dsRef of arr(dsSec["data-set-ref"])) {
        const refId = a(dsRef, "id");
        if (!refId) continue;
        const dsName = datasetIdToName.get(refId);
        if (!dsName) continue; // completely unknown ID — skip
        if (unboundDatasetNames.has(dsName)) {
          if (!cubeUnboundDatasets.includes(dsName)) cubeUnboundDatasets.push(dsName);
        } else {
          if (!cubeBoundDatasets.includes(dsName)) cubeBoundDatasets.push(dsName);
        }
      }
    }
    if (cubeUnboundDatasets.length > 0) {
      rptUnboundByCube.push({ cubeName, boundDatasets: cubeBoundDatasets, unboundDatasets: cubeUnboundDatasets });
    }

    // Find fact dataset name for this cube
    const factDatasetName = getFactDatasetName(cube, datasetIdToName);

    // Extract include_default_drillthrough from <actions><properties><include-default-drill-through>
    const actionsEl = first(arr(cube.actions)) as Record<string, unknown> | undefined;
    const actionPropsEl = actionsEl
      ? (first(arr(actionsEl.properties)) as Record<string, unknown> | undefined)
      : undefined;
    const includeDefaultDrillthrough = actionPropsEl
      ? s(first(arr(actionPropsEl["include-default-drill-through"]))) === "true"
      : false;

    const metricNames: Array<{ uniqueName: string; folder?: string }> = [];
    // The same measure/calc name can legitimately appear under multiple XML attribute ids
    // (e.g. a visible=false leftover from a rename) — dedupe by the transformed unique_name
    // so the model's metrics: list never contains the same entry twice.
    const seenMetricNames = new Set<string>();
    // Tracks, per emitted measure unique_name, whether its column actually resolved to a
    // declared physical column on its dataset — see the duplicate-measure handling below.
    const metricHasKnownColumn = new Map<string, boolean>();
    // User Defined Aggregates reference measures/calc members by attribute id — record each
    // emitted metric's id alongside its transformed unique_name so aggregate parsing (below)
    // can resolve them the same way the reference converter does.
    const attrIdToMetricUniqueName = new Map<string, string>();

    // Phase 4: Emit measures
    for (const attrsSec of arr(cube.attributes)) {
      for (const attrEl of arr((attrsSec as Record<string, unknown>).attribute)) {
        const attrId = a(attrEl, "id");
        const attrNameRaw = a(attrEl, "name") ?? "";
        if (!attrId) continue;

        const props = first(arr((attrEl as Record<string, unknown>).properties)) as
          | Record<string, unknown>
          | undefined;
        if (!props) continue;

        const typeEl = first(arr(props.type)) as Record<string, unknown> | undefined;
        if (!typeEl) continue;

        const measureEl = first(arr(typeEl.measure)) as Record<string, unknown> | undefined;
        const countDistEl = first(arr(typeEl["count-distinct"])) as
          | Record<string, unknown>
          | undefined;
        const countNonNullEl = first(arr(typeEl["count-nonnull"])) as
          | Record<string, unknown>
          | undefined;
        const exprEl = s(first(arr((attrEl as Record<string, unknown>).expression)));

        const caption = s(first(arr(props.caption)));
        const folder = s(first(arr(props.folder)));
        const description = s(first(arr(props.description)));
        const visibleStr = s(first(arr(props.visible)));
        const visible = visibleStr !== "false";
        const fmtEl = first(arr(props.formatting)) as Record<string, unknown> | undefined;
        const formatString = fmtEl ? s(first(arr(fmtEl["format-string"]))) : undefined;
        const namedFormat = fmtEl ? s(first(arr(fmtEl["named-format"]))) : undefined;
        const format = resolveFormat(formatString, namedFormat);

        if (measureEl || countDistEl || countNonNullEl) {
          // Regular measure
          const aggText = measureEl
            ? (s(first(arr(measureEl["default-aggregation"])))?.toUpperCase() ?? "SUM")
            : countDistEl
            ? "DISTINCT_COUNT_ESTIMATE"
            : "COUNT";
          const aggregation = mapAggregation(aggText);

          // Resolve column: prefer the inline <key-ref id="..."> nested under <measure>/
          // <count-distinct>/<count-nonnull> (resolved through keyMap, same as dimension
          // level attributes), then attrMap[attrId] (attribute-ref in the fact dataset's
          // logical section), then fall back to guessing the column from the attribute's own name.
          const measureTypeEl = measureEl ?? countDistEl ?? countNonNullEl;
          const keyRefEl = measureTypeEl
            ? (first(arr(measureTypeEl["key-ref"])) as Record<string, unknown> | undefined)
            : undefined;
          const keyRefId = keyRefEl ? a(keyRefEl, "id") : undefined;
          const keyRefEntries = keyRefId ? keyMap.get(keyRefId) ?? [] : [];
          const keyRefAuthEntry = keyRefEntries.find((e) => e.complete === "true") ?? keyRefEntries[0];

          const colRef = attrMap.get(attrId);
          const column = keyRefAuthEntry?.columns[0] ?? colRef?.column ?? parseColumnFromAttrName(attrNameRaw);
          // A cube can bind multiple fact datasets (data-set-refs); factDatasetName is only
          // the first one and is a last-resort fallback for name-guessed columns with no
          // resolved reference. Whenever the key-ref/attribute-ref actually resolved, prefer
          // ITS dataset — otherwise every measure in a multi-fact cube silently gets bound to
          // the first fact table regardless of which one its own column actually lives in.
          const measureDatasetName = keyRefAuthEntry?.datasetName ?? colRef?.datasetName ?? factDatasetName;
          if (!column || !measureDatasetName) {
            rptOmissions.push({
              category: "Metric",
              item: attrNameRaw,
              reason: !measureDatasetName
                ? "No fact dataset could be identified for this cube"
                : "Could not resolve the measure column reference from attribute-ref mapping",
              recommendation: "Add this measure manually to the appropriate metrics/*.yml file after verifying the fact table column name.",
            });
            continue;
          }

          const label = caption ?? toTitleCase(attrNameRaw);
          // Preserve the source XML's own casing (matching how dimensions/levels already
          // behave, and the reference converter) — BI tools like Power BI/Excel/Tableau
          // bind report fields to the exact unique_name string, so force-lowercasing here
          // silently breaks every existing report built against a prior deployment.
          // Duplicate detection below still normalizes to lowercase, so a same-name
          // collision that only differs by case is still caught rather than producing two
          // SML objects that a case-insensitive target might treat as duplicates anyway.
          const uniqueName = truncateUniqueName(safeName(attrNameRaw));
          const dedupKey = uniqueName.toLowerCase();
          const isKnownColumn = datasetNameToPhysical.get(measureDatasetName)?.columns?.some((c) => c.name === column) ?? false;
          if (seenMetricNames.has(dedupKey)) {
            // The source XML can define the same measure name twice, bound to different
            // columns — e.g. a stale duplicate whose column was never actually declared on
            // its dataset. Silently keeping "whichever came first" can pin the measure to a
            // column SML can't type (falls back to string), breaking any calc that does
            // arithmetic with it. Prefer whichever duplicate resolves to a real declared
            // physical column, matching the reference converter's own dedup behavior.
            if (isKnownColumn && !metricHasKnownColumn.get(dedupKey)) {
              attrIdToMetricUniqueName.set(attrId, uniqueName);
              metricHasKnownColumn.set(dedupKey, true);
              const fname = safeFilename(uniqueName);
              output.set(
                `metrics/${fname}.yml`,
                buildMetricYaml(uniqueName, label, aggregation, measureDatasetName, column, format, folder, visible, description),
              );
              logger.log(`  → metrics/${fname}.yml (replacing an earlier duplicate with an unresolved column)`);
            } else {
              rptOmissions.push({
                category: "Metric",
                item: attrNameRaw,
                reason: `Duplicate measure name (unique_name "${uniqueName}" already emitted by another attribute in this cube) — excluded to avoid an invalid duplicate entry in the model's metrics list.`,
                recommendation: "If both attributes are genuinely needed, rename one in the source XML so they produce distinct unique_names.",
              });
            }
            continue;
          }
          seenMetricNames.add(dedupKey);
          metricHasKnownColumn.set(dedupKey, isKnownColumn);
          attrIdToMetricUniqueName.set(attrId, uniqueName);
          const fname = safeFilename(uniqueName);
          output.set(
            `metrics/${fname}.yml`,
            buildMetricYaml(uniqueName, label, aggregation, measureDatasetName, column, format, folder, visible, description),
          );
          logger.log(`  → metrics/${fname}.yml`);
          metricNames.push({ uniqueName, folder: folder || undefined });
          rptMetrics.push({ name: uniqueName, label, file: `metrics/${fname}.yml`, metricType: "measure", aggregation, folder: folder || undefined, isHidden: !visible });
        } else if (exprEl) {
          // Inline expression (calculated measure on attribute element)
          const label = caption ?? toTitleCase(attrNameRaw);
          const uniqueName = truncateUniqueName(safeName(attrNameRaw));
          if (seenMetricNames.has(uniqueName.toLowerCase())) {
            rptOmissions.push({
              category: "Metric",
              item: attrNameRaw,
              reason: `Duplicate measure name (unique_name "${uniqueName}" already emitted by another attribute in this cube) — excluded to avoid an invalid duplicate entry in the model's metrics list.`,
              recommendation: "If both attributes are genuinely needed, rename one in the source XML so they produce distinct unique_names.",
            });
            continue;
          }
          seenMetricNames.add(uniqueName.toLowerCase());
          attrIdToMetricUniqueName.set(attrId, uniqueName);
          const fname = safeFilename(uniqueName);
          output.set(
            `metrics/${fname}.yml`,
            buildCalcMetricYaml(uniqueName, label, rewriteMeasureRefs(unescapeHtml(exprEl), measureRefMap), format, folder, visible, description),
          );
          logger.log(`  → metrics/${fname}.yml`);
          metricNames.push({ uniqueName, folder: folder || undefined });
          rptMetrics.push({ name: uniqueName, label, file: `metrics/${fname}.yml`, metricType: "calculated_measure", folder: folder || undefined, isHidden: !visible });
        }
      }
    }

    // Phase 7: Emit calculated members referenced by this cube
    for (const cmSec of arr(cube["calculated-members"])) {
      for (const cmRef of arr(cmSec["calculated-member-ref"])) {
        const refId = a(cmRef, "id");
        const def = refId ? calcMemberDefs.get(refId) : undefined;
        if (!def) continue;
        const label = def.caption ?? def.name;
        const uniqueName = truncateUniqueName(safeName(def.name));
        if (seenMetricNames.has(uniqueName.toLowerCase())) {
          rptOmissions.push({
            category: "Calculated Member",
            item: def.name,
            reason: `Duplicate calculated member name (unique_name "${uniqueName}" already emitted by another attribute in this cube) — excluded to avoid an invalid duplicate entry in the model's metrics list.`,
            recommendation: "If both are genuinely needed, rename one in the source XML so they produce distinct unique_names.",
          });
          continue;
        }
        seenMetricNames.add(uniqueName.toLowerCase());
        attrIdToMetricUniqueName.set(refId!, uniqueName);
        const format = resolveFormat(def.formatString, def.namedFormat);
        const fname = safeFilename(uniqueName);
        output.set(
          `calculations/${fname}.yml`,
          buildCalcMemberYaml(uniqueName, label, rewriteMeasureRefs(def.expression, measureRefMap), format, def.folder, def.visible, def.description),
        );
        logger.log(`  → calculations/${fname}.yml`);
        metricNames.push({ uniqueName, folder: def.folder || undefined });
        rptMetrics.push({ name: uniqueName, label, file: `calculations/${fname}.yml`, metricType: "calculated_member", folder: def.folder || undefined, isHidden: !def.visible });
      }
    }

    // Phase 8: User Defined Aggregates (hinted aggregate tables)
    //
    // <cube><aggregates><aggregate id name><attributes><attribute-ref id>[<ref-path><ref id>]>
    // mixes dimension attributes and measures in the same <attributes> list — there is no
    // separate <metrics> element in the source XML. Each attribute-ref id is resolved
    // against whatever this cube already emitted/knows about: a measure/calc-member id
    // (attrIdToMetricUniqueName) routes to the aggregate's metrics: list; a dimension
    // keyed-attribute id (attrIdToDimName) routes to attributes: as {name, dimension}. A
    // ref-path present on the attribute-ref means the attribute is reached through a
    // snowflake/embedded relationship rather than hosted natively — its host dimension is
    // looked up via refIdToHostDimName and combined into relationships_path.
    const aggregates: AggregateDef[] = [];
    for (const aggsSec of arr(cube.aggregates)) {
      for (const aggEl of arr((aggsSec as Record<string, unknown>).aggregate)) {
        const aggName = a(aggEl, "name");
        if (!aggName) continue;

        const attributes: AggregateDef["attributes"] = [];
        const metrics: string[] = [];

        for (const attrsWrap of arr((aggEl as Record<string, unknown>).attributes)) {
          for (const attrRef of arr((attrsWrap as Record<string, unknown>)["attribute-ref"])) {
            const refAttrId = a(attrRef, "id");
            if (!refAttrId) continue;

            const metricUniqueName = attrIdToMetricUniqueName.get(refAttrId);
            if (metricUniqueName) {
              metrics.push(metricUniqueName);
              continue;
            }

            const kaDef = attrDef.get(refAttrId);
            const targetDimName = attrIdToDimName.get(refAttrId);
            if (!kaDef || !targetDimName) {
              rptOmissions.push({
                category: "User Defined Aggregate",
                item: `${aggName} → ${refAttrId}`,
                reason: "Could not resolve this attribute-ref to a known measure or dimension attribute — the id may point at a schema element this converter does not yet parse.",
                recommendation: `Verify attribute id ${refAttrId} manually and add it to models/*.yml aggregates[].attributes or .metrics if needed.`,
              });
              continue;
            }

            const attrOut: AggregateDef["attributes"][number] = { name: truncateUniqueName(kaDef.name), dimension: targetDimName };

            const refPathEl = first(arr((attrRef as Record<string, unknown>)["ref-path"])) as
              | Record<string, unknown>
              | undefined;
            const pathRefId = refPathEl ? a(first(arr(refPathEl.ref)) as Record<string, unknown> | undefined ?? {}, "id") : undefined;
            if (pathRefId) {
              const hostDimName = refIdToHostDimName.get(pathRefId);
              if (hostDimName) {
                attrOut.relationshipsPath = [
                  `${hostDimName.replace(/\s+/g, "")}_${targetDimName.replace(/\s+/g, "")}`,
                ];
              }
            }

            attributes.push(attrOut);
          }
        }

        if (attributes.length === 0 && metrics.length === 0) continue;
        aggregates.push({ uniqueName: aggName, label: aggName, attributes, metrics });
      }
    }

    // Cube-level structural omission checks (run once per cube)
    if (arr(cube["named-sets"]).length > 0 || arr((cube as Record<string, unknown>)["named-set"]).length > 0) {
      if (!rptOmissions.some((o) => o.item === "Named Sets")) {
        rptOmissions.push({
          category: "Structural",
          item: "Named Sets",
          reason: "Named set definitions (cube-level) are not converted — no direct SML equivalent.",
          recommendation: "Recreate named sets as saved filters or query parameters in the consuming BI tool.",
        });
      }
    }
    if (arr(cube.kpis).length > 0 || arr((cube as Record<string, unknown>).kpi).length > 0) {
      if (!rptOmissions.some((o) => o.item === "KPIs")) {
        rptOmissions.push({
          category: "Structural",
          item: "KPIs",
          reason: "KPI definitions are not converted — no direct SML equivalent.",
          recommendation: "Recreate KPI targets and statuses as calculated metrics or in the BI tool layer.",
        });
      }
    }

    // Build per-cube relevant dims: this cube's inline dims + schema-level shared dims
    const cubeLevelDims = new Map<string, Record<string, unknown>>();
    for (const dimsSec of arr(cube.dimensions)) {
      for (const dim of arr(dimsSec.dimension)) {
        const name = a(dim, "name");
        if (name) cubeLevelDims.set(name, dim as Record<string, unknown>);
      }
    }
    // Schema-level dims referenced via dimension-ref
    for (const dimsSec of arr(cube.dimensions)) {
      for (const dimRef of arr(dimsSec["dimension-ref"])) {
        const refId = a(dimRef, "id");
        if (!refId) continue;
        // Find the schema dim with this id
        for (const [dname, del] of schemaDims) {
          if (a(del, "id") === refId) {
            cubeLevelDims.set(dname, del);
            break;
          }
        }
      }
    }
    const relevantDims = new Map([...schemaDims, ...cubeLevelDims]);

    // Phase 5: Infer relationships
    const { relationships, degenerateDimNames } = inferRelationships(cube, factDatasetName, keyMap, attrDef, relevantDims, datasetIdToName);

    // The model's flat dimensions: list only holds dimensions with no relationship (they
    // attach directly via is_degenerate) — degenerate schema/cube dims. Dimensions with a
    // relationship are referenced solely via relationships[].to.dimension and must not
    // also appear here, or the two representations contradict each other. A cube-level
    // dim (inline, or via <dimension-ref>) matching neither category has no possible join
    // in this cube at all (e.g. its dataset is never bound to any data-set-ref) and is
    // excluded entirely, rather than forced into dimensions: with no real attachment.
    const cubeDimNames: string[] = [...new Set(degenerateDimNames)];
    // Dimension YAML files still need to be emitted for every dimension actually used by
    // this cube, whether degenerate (flat dimensions: list) or joined via a relationship.
    for (const n of cubeDimNames) referencedDimNames.add(n);
    for (const rel of relationships) referencedDimNames.add(rel.toDimension);
    for (const n of degenerateDimNames) globalDegenerateDimNames.add(n);
    for (const rel of relationships) globalRelationshipDimNames.add(rel.toDimension);

    // Cube visibility
    const cubeProps = first(arr(cube.properties)) as Record<string, unknown> | undefined;
    const cubeVisible = cubeProps ? s(first(arr(cubeProps.visible))) !== "false" : true;

    // Emit model file
    const modelYaml = buildModelYaml(cubeName, relationships, cubeDimNames, metricNames, aggregates, !cubeVisible, includeDefaultDrillthrough);
    const fname = safeFilename(cubeName);
    output.set(`models/${fname}.yml`, modelYaml);
    logger.log(`  → models/${fname}.yml`);

    // Dimension datasets: datasets backing this cube's dimensions (not the fact tables)
    const dimDsSet = new Set<string>();
    for (const rel of relationships) {
      if (rel.dimensionDataset && !cubeBoundDatasets.includes(rel.dimensionDataset)) {
        dimDsSet.add(rel.dimensionDataset);
      }
    }

    rptModels.push({
      name: cubeName,
      file: `models/${fname}.yml`,
      relationships,
      relationshipCount: relationships.length,
      dimensionCount: cubeDimNames.length,
      metricCount: metricNames.length,
      aggregateCount: aggregates.length,
      hasDefaultDrillthrough: includeDefaultDrillthrough,
      isHidden: !cubeVisible,
      factDatasets: cubeBoundDatasets,
      dimensionDatasets: [...dimDsSet],
    });
  }

  // ---------------------------------------------------------------
  // Phase 3b: Emit dimension YAML files for all referenced dims
  // ---------------------------------------------------------------

  for (const dimName of referencedDimNames) {
    const dimEl = allDims.get(dimName);
    if (!dimEl) continue;
    // A real relationship anywhere wins over a degenerate determination elsewhere — a
    // dimension used by multiple cubes could be degenerate in one and properly joined
    // in another.
    const isDegenerate = globalDegenerateDimNames.has(dimName) && !globalRelationshipDimNames.has(dimName);
    const { yaml: dimYaml, meta: dimMeta } = buildDimensionYaml(dimEl, dimName, attrDef, keyMap, attrMap, isDegenerate, soleKeyColumns, datasetNameToPhysical);
    const fname = safeFilename(dimName);
    output.set(`dimensions/${fname}.yml`, dimYaml);
    logger.log(`  → dimensions/${fname}.yml`);

    rptDimensions.push({
      name: dimName,
      file: `dimensions/${fname}.yml`,
      type: dimMeta.type,
      hierarchyCount: dimMeta.hierarchyCount,
      levelCount: dimMeta.levelCount,
      hasDefaultMembers: dimMeta.hasDefaultMembers,
    });
    for (const skipped of dimMeta.skippedCrossDimRefs) {
      rptOmissions.push({
        category: "Secondary Attribute",
        item: `attribute ${skipped.attrId} in dimension "${skipped.dimName}"`,
        reason: "Cross-dimension embedded relationship (ref-id) cannot be represented as a secondary attribute in SML",
        recommendation: "Verify that the dimension-to-dimension relationship is covered by a model relationship, or add it manually as a secondary attribute referencing the correct dataset.",
      });
    }
  }

  // ---------------------------------------------------------------
  // Phase 2: Emit dataset files
  // ---------------------------------------------------------------

  // Schema-level dimensions never appear in a cube's own data-set-ref list — they're
  // pulled in via keyed-attribute key-refs instead — so datasets they use only show up
  // here, once the dimension YAML (built above) is available to scan.
  for (const [key, dimYaml] of output) {
    if (!key.startsWith("dimensions/")) continue;
    // Dataset names can contain spaces (e.g. "CUSTOMER AGE MONTHLY") — anchor to the
    // trailing ".dataset" at end of line rather than a non-whitespace-only match, which
    // would incorrectly capture just the last word of a multi-word name.
    for (const m of dimYaml.matchAll(/^\s*dataset:\s*(.+)\.dataset\s*$/gm)) {
      referencedDatasetNames.add(m[1]);
    }
  }

  // Without an explicit --connection-db/--connection-schema override, datasets can
  // legitimately span multiple database/schema pairs under one AtScale connection (e.g.
  // several schemas in the same warehouse). Represent each distinct pair as its own
  // connection — matching AtScale's own reference converter — instead of a nested
  // `table: {db, schema, name}` object, which the live engine rejects even though it's
  // schema-valid. The first distinct pair encountered keeps the base connection name;
  // every other pair gets a `_<schema>` suffix.
  const connectionIdByDataset = new Map<string, string>(); // dataset name -> connection unique_name
  const connectionDbSchema = new Map<string, { db?: string; schema?: string }>(); // connection unique_name -> its db/schema
  if (!opts.connectionDb && !opts.connectionSchema) {
    const pairToConnId = new Map<string, string>();
    for (const dsName of referencedDatasetNames) {
      const phys = datasetNameToPhysical.get(dsName);
      if (!phys?.db && !phys?.schema) continue;
      const pairKey = `${phys.db ?? ""}|${phys.schema ?? ""}`;
      let connId = pairToConnId.get(pairKey);
      if (!connId) {
        connId = pairToConnId.size === 0 ? connName : `${connName}_${phys.schema ?? phys.db}`;
        pairToConnId.set(pairKey, connId);
        connectionDbSchema.set(connId, { db: phys.db, schema: phys.schema });
      }
      connectionIdByDataset.set(dsName, connId);
    }
  }

  for (const dsSec of arr(schemaEl["data-sets"])) {
    for (const ds of arr(dsSec["data-set"])) {
      const dsName = a(ds, "name");
      if (!dsName) continue;
      if (!referencedDatasetNames.has(dsName)) {
        rptOmissions.push({
          category: "Dataset",
          item: dsName,
          reason: "Declared in the schema but not referenced by any cube's data-set-ref or dimension — excluded from output.",
          recommendation: "If this dataset is actually needed, add it manually to datasets/ and reference it from the relevant model or dimension.",
        });
        continue;
      }
      const dsYaml = buildDatasetYaml(
        ds as Record<string, unknown>, dsName,
        connectionIdByDataset.get(dsName) ?? connName,
        referencedColumnsByDataset.get(dsName),
      );
      const fname = safeFilename(dsName);
      output.set(`datasets/${fname}.yml`, dsYaml);
      logger.log(`  → datasets/${fname}.yml`);

      // Report tracking
      const physRpt = parseDatasetPhysical(ds as Record<string, unknown>);
      const allColumnNames = new Set(physRpt?.columns?.map((c) => c.name) ?? []);
      for (const col of referencedColumnsByDataset.get(dsName) ?? []) allColumnNames.add(col);
      rptDatasets.push({
        name: dsName,
        file: `datasets/${fname}.yml`,
        type: physRpt?.sql ? "sql" : "table",
        columnCount: allColumnNames.size,
        isImmutable: physRpt?.immutable ?? false,
        isUnbound: unboundDatasetNames.has(dsName),
      });
    }
  }

  // ---------------------------------------------------------------
  // Phase 6: Catalog and connection
  // ---------------------------------------------------------------

  output.set("catalog.yml", buildCatalogYaml(catalogName));

  // Always emit the default connection, plus one per extra db/schema pair discovered
  // above (all variants of the same underlying AtScale-registered connection).
  const allConnectionIds = new Set<string>([connName, ...connectionDbSchema.keys()]);
  for (const connId of allConnectionIds) {
    const dbSchema = connectionDbSchema.get(connId);
    output.set(
      `connections/${safeFilename(connId)}.yml`,
      buildConnectionYaml(
        connId, opts.connectionType,
        dbSchema?.db ?? opts.connectionDb, dbSchema?.schema ?? opts.connectionSchema,
        connName,
      ),
    );
    logger.log(`  → connections/${safeFilename(connId)}.yml`);
  }
  logger.log(`  → catalog.yml`);

  // ---------------------------------------------------------------
  // Phase 8: Generate README.md conversion report
  // ---------------------------------------------------------------

  const readme = buildReadme(
    catalogName, connName, opts.xmlFileName,
    rptDatasets, rptDimensions, rptMetrics, rptModels, rptOmissions, rptUnboundByCube,
  );
  output.set("README.md", readme);
  logger.log(`  → README.md`);

  return output;
}

// ============================================================
// Internal types
// ============================================================

interface KeyRefEntry {
  datasetName: string;
  columns: string[];
  complete: string; // "true" | "false" | "partial"
  unique?: boolean;
  rolePlay?: string;
}

interface AttrRefEntry {
  datasetName: string;
  column: string;
}

interface AttrDefEntry {
  name: string;
  caption?: string;
  keyUuid: string;
  formatString?: string;
  namedFormat?: string;
  folder?: string;
  visible: boolean;
  description?: string;
  allowedCalcTypes?: string[];
}

interface CalcMemberDef {
  name: string;
  caption?: string;
  folder?: string;
  visible: boolean;
  formatString?: string;
  namedFormat?: string;
  expression: string;
  description?: string;
}

interface DatasetPhysical {
  db?: string;
  schema?: string;
  tableName?: string;
  sql?: string;
  connectionName?: string;
  columns?: Array<{ name: string; dataType: string; sql?: string }>;
  immutable?: boolean;
}

// ============================================================
// Conversion report types
// ============================================================

interface DatasetRecord {
  name: string;
  file: string;
  type: "table" | "sql";
  columnCount: number;
  isImmutable: boolean;
  /** True when the source XML has no physical table or SQL binding for this dataset. */
  isUnbound: boolean;
}

interface CubeBindingRecord {
  cubeName: string;
  /** Datasets fully bound (have a physical table or SQL in the XML). */
  boundDatasets: string[];
  /** Datasets referenced by this cube but with no physical binding — need to be created/bound. */
  unboundDatasets: string[];
}

interface DimRecord {
  name: string;
  file: string;
  type: "time" | "standard" | "degenerate";
  hierarchyCount: number;
  levelCount: number;
  hasDefaultMembers: boolean;
}

interface MetricRecord {
  name: string;
  label: string;
  file: string;
  metricType: "measure" | "calculated_measure" | "calculated_member";
  aggregation?: string;
  folder?: string;
  isHidden: boolean;
}

interface ModelRecord {
  name: string;
  file: string;
  relationships: RelationshipDef[];
  relationshipCount: number;
  dimensionCount: number;
  metricCount: number;
  aggregateCount: number;
  hasDefaultDrillthrough: boolean;
  isHidden: boolean;
  /** Datasets explicitly bound to this cube as fact tables (cube data-set-refs). */
  factDatasets: string[];
  /** Datasets used by the model's dimensions but not listed as cube fact tables. */
  dimensionDatasets: string[];
}

/** A User Defined Aggregate (hinted aggregate table) declared on a cube. */
interface AggregateDef {
  uniqueName: string;
  label: string;
  attributes: Array<{ name: string; dimension: string; relationshipsPath?: string[] }>;
  metrics: string[];
}

interface OmissionRecord {
  category: string;
  item: string;
  reason: string;
  recommendation: string;
}

/** Metadata extracted alongside YAML during dimension conversion. */
interface DimMeta {
  type: "time" | "standard" | "degenerate";
  hierarchyCount: number;
  levelCount: number;
  hasDefaultMembers: boolean;
  /** Secondary attribute refs skipped because they carried a cross-dimension ref-id. */
  skippedCrossDimRefs: Array<{ dimName: string; attrId: string }>;
}

interface RelationshipDef {
  uniqueName: string;
  fromDataset: string;
  fromColumns: string[];
  toDimension: string;
  toLevel: string;
  rolePlay?: string;
  /** Dataset that backs the dimension key (complete=true side of the join). */
  dimensionDataset?: string;
}

// ============================================================
// XML navigation helpers
// ============================================================

/** Get first element of an array, or undefined. */
function first<T>(arr: T[] | undefined): T | undefined {
  return arr?.[0];
}

/** Ensure value is an array (handles xml2js output). */
function arr(val: unknown): Record<string, unknown>[] {
  if (!val) return [];
  if (Array.isArray(val)) return val as Record<string, unknown>[];
  return [val as Record<string, unknown>];
}

/** Get text content from an xml2js parsed value. */
function s(val: unknown): string | undefined {
  if (val == null) return undefined;
  if (typeof val === "string") return val || undefined;
  if (Array.isArray(val)) {
    const v = val[0];
    return v == null ? undefined : typeof v === "string" ? (v || undefined) : s(v);
  }
  if (typeof val === "object") {
    const obj = val as Record<string, unknown>;
    if (typeof obj._ === "string") return obj._ || undefined;
  }
  return String(val) || undefined;
}

/** Get attribute value from an xml2js element. */
function a(el: unknown, name: string): string | undefined {
  if (!el || typeof el !== "object") return undefined;
  const obj = el as Record<string, unknown>;
  const attrs = obj.$ as Record<string, string> | undefined;
  return attrs?.[name];
}

/** Extract column name from a <column> element (plain text OR structured form). */
function extractColumnName(col: unknown): string | undefined {
  if (typeof col === "string") return col || undefined;
  if (col && typeof col === "object") {
    const obj = col as Record<string, unknown>;
    // Structured: <column><name>X</name><sql>...</sql><type>Y</type></column>
    const nameVal = first(arr(obj.name));
    if (nameVal) {
      const n = s(nameVal);
      if (n) return n;
    }
    // Plain text stored as charkey
    if (typeof obj._ === "string") return obj._ || undefined;
  }
  return undefined;
}

/** Extract all column names from raw column array. */
function extractColumns(rawCols: Record<string, unknown>[]): string[] {
  return rawCols.map(extractColumnName).filter((c): c is string => Boolean(c));
}

// ============================================================
// String / format helpers
// ============================================================

function toTitleCase(s: string): string {
  return s
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Convert a name to a safe filesystem/unique_name slug (no special chars). */
function safeName(s: string): string {
  return s
    .replace(/[^a-zA-Z0-9_\-]/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^_|_$/g, "");
}

/** SML unique_name values must not exceed this length. */
const MAX_UNIQUE_NAME_LENGTH = 63;

/** Deterministically shorten a unique_name to fit SML's 63-character limit. */
function truncateUniqueName(name: string): string {
  if (name.length <= MAX_UNIQUE_NAME_LENGTH) return name;
  const hash = createHash("sha1").update(name).digest("hex").slice(0, 8);
  const keep = MAX_UNIQUE_NAME_LENGTH - hash.length - 1;
  return `${name.slice(0, keep)}_${hash}`;
}

/**
 * Build a map from every measure/calculated-member's original XML name to its final
 * (safeName + truncated) unique_name. Calculation expressions reference other metrics
 * by their original name (e.g. "[Measures].[Sales Amount-Prev]"), but the output uses
 * the transformed unique_name — this map lets those references be rewritten to match.
 */
function buildMeasureRefMap(
  cubeEls: Record<string, unknown>[],
  calcMemberDefs: Map<string, CalcMemberDef>,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const def of calcMemberDefs.values()) {
    map.set(def.name, truncateUniqueName(safeName(def.name)));
  }
  for (const cube of cubeEls) {
    for (const attrsSec of arr(cube.attributes)) {
      for (const attrEl of arr((attrsSec as Record<string, unknown>).attribute)) {
        const attrNameRaw = a(attrEl, "name");
        if (!attrNameRaw) continue;
        const props = first(arr((attrEl as Record<string, unknown>).properties)) as
          | Record<string, unknown>
          | undefined;
        if (!props) continue;
        const typeEl = first(arr(props.type)) as Record<string, unknown> | undefined;
        if (!typeEl) continue;
        const isMeasure =
          arr(typeEl.measure).length > 0 ||
          arr(typeEl["count-distinct"]).length > 0 ||
          arr(typeEl["count-nonnull"]).length > 0;
        const hasExpr = arr((attrEl as Record<string, unknown>).expression).length > 0;
        if (!isMeasure && !hasExpr) continue;
        map.set(attrNameRaw, truncateUniqueName(safeName(attrNameRaw)));
      }
    }
  }
  return map;
}

/** Rewrite "[Measures].[Original Name]" references to match transformed unique_names. */
function rewriteMeasureRefs(text: string, nameMap: Map<string, string>): string {
  return text.replace(/\[Measures\]\.\[([^\]]+)\]/g, (full, name) => {
    const mapped = nameMap.get(name);
    return mapped ? `[Measures].[${mapped}]` : full;
  });
}

/** Convert a name to a safe filename (lowercase, hyphens). */
function safeFilename(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\-_.]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
}

/** Unescape HTML entities from XML-encoded SQL or MDX. */
function unescapeHtml(s: string): string {
  return s
    .replace(/&#xA;/g, "\n")
    .replace(/&#x9;/g, "\t")
    .replace(/&#xD;/g, "\r")
    .replace(/&#39;/g, "'")
    .replace(/&#34;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

/** Map XML aggregation string → SML calculation_method. */
function mapAggregation(raw: string): string {
  switch (raw.toUpperCase()) {
    case "SUM":            return "sum";
    case "AVG":            return "average";
    case "MIN":            return "minimum";
    case "MAX":            return "maximum";
    case "COUNT":          return "count non-null";
    case "COUNT_DISTINCT":                return "count distinct";
    case "DISTINCT_COUNT_ESTIMATE":
    case "DISTINCTCOUNTESTIMATE":         return "estimated count distinct";
    default:               return "sum";
  }
}

/** Normalize a named format keyword (e.g. "General Number", "Short Date") to a lowercase SML format token. */
function normalizeNamedFormat(named: string): string {
  switch (named.toLowerCase()) {
    case "percent":  return "percent:1";
    case "standard": return "decimal:2";
    case "currency": return "currency:0";
    default:         return named.toLowerCase(); // pass through (e.g. "short date")
  }
}

/** Map XML format-string or named-format → SML format. */
function resolveFormat(formatString?: string, namedFormat?: string): string | undefined {
  if (namedFormat) {
    return normalizeNamedFormat(namedFormat);
  }
  if (formatString) {
    switch (formatString) {
      case "#,##0":     return "#,##0";
      case "#,##0.00":  return "#,##0.00";
      case "0%":        return "0%";
      case "#,##0.0%":  return "#,##0.0%";
      case "$#,##0":    return "$#,##0";
      case "#,##0%":    return "#,##0%";
      default:
        // format-string can also hold a named format (e.g. "General Number") rather than a numeric pattern
        return /[a-zA-Z]/.test(formatString) ? normalizeNamedFormat(formatString) : formatString;
    }
  }
  return undefined;
}

/**
 * Parse the column name from a measure attribute name.
 * Convention: m_{COLUMN_NAME}_{agg_suffix}  OR  just the raw name.
 * Returns the column portion, or the full name if no convention is detected.
 */
function parseColumnFromAttrName(attrName: string): string {
  // Strip leading m_ prefix
  const withoutPrefix = attrName.replace(/^m_/i, "");
  // Strip trailing _sum / _avg / _min / _max / _count / _distinct
  return withoutPrefix.replace(/_(sum|avg|min|max|count|distinct|average|minimum|maximum)$/i, "");
}

/** The fact dataset for a cube is the first <data-set-ref> listed under its <data-sets>. */
function getFactDatasetName(
  cube: Record<string, unknown>,
  datasetIdToName: Map<string, string>,
): string | undefined {
  for (const dsSec of arr(cube["data-sets"])) {
    for (const dsRef of arr(dsSec["data-set-ref"])) {
      const refId = a(dsRef, "id");
      if (refId) return datasetIdToName.get(refId) ?? refId;
    }
  }
  return undefined;
}

/**
 * Resolve every cube measure's column using the same priority order as the real emission
 * logic (inline key-ref, then attribute-ref, then a name-based guess) and record it against
 * its fact dataset — including fallback name-guessed columns, which otherwise never get
 * declared in the dataset's columns: list even though the metric YAML ends up referencing them.
 */
function collectMeasureColumns(
  cubeEls: Record<string, unknown>[],
  datasetIdToName: Map<string, string>,
  keyMap: Map<string, KeyRefEntry[]>,
  attrMap: Map<string, AttrRefEntry>,
  addReferencedColumn: (datasetName: string, column: string) => void,
): void {
  for (const cube of cubeEls) {
    const factDatasetName = getFactDatasetName(cube, datasetIdToName);
    if (!factDatasetName) continue;

    for (const attrsSec of arr(cube.attributes)) {
      for (const attrEl of arr((attrsSec as Record<string, unknown>).attribute)) {
        const attrId = a(attrEl, "id");
        const attrNameRaw = a(attrEl, "name") ?? "";
        if (!attrId) continue;

        const props = first(arr((attrEl as Record<string, unknown>).properties)) as
          | Record<string, unknown>
          | undefined;
        if (!props) continue;
        const typeEl = first(arr(props.type)) as Record<string, unknown> | undefined;
        if (!typeEl) continue;

        const measureEl = first(arr(typeEl.measure)) as Record<string, unknown> | undefined;
        const countDistEl = first(arr(typeEl["count-distinct"])) as Record<string, unknown> | undefined;
        const countNonNullEl = first(arr(typeEl["count-nonnull"])) as Record<string, unknown> | undefined;
        if (!measureEl && !countDistEl && !countNonNullEl) continue;

        const measureTypeEl = measureEl ?? countDistEl ?? countNonNullEl;
        const keyRefEl = measureTypeEl
          ? (first(arr(measureTypeEl["key-ref"])) as Record<string, unknown> | undefined)
          : undefined;
        const keyRefId = keyRefEl ? a(keyRefEl, "id") : undefined;
        const keyRefEntries = keyRefId ? keyMap.get(keyRefId) ?? [] : [];
        const keyRefAuthEntry = keyRefEntries.find((e) => e.complete === "true") ?? keyRefEntries[0];

        const colRef = attrMap.get(attrId);
        const column = keyRefAuthEntry?.columns[0] ?? colRef?.column ?? parseColumnFromAttrName(attrNameRaw);
        // Mirror the dataset resolution used at emission time (see the Phase 4 measure
        // loop) — otherwise a multi-fact cube's measures get their referenced columns
        // recorded against the wrong dataset, which manufactures a "phantom" column on
        // the cube's first fact dataset instead of the one the measure actually lives on.
        const measureDatasetName = keyRefAuthEntry?.datasetName ?? colRef?.datasetName ?? factDatasetName;
        if (column) addReferencedColumn(measureDatasetName, column);
      }
    }
  }
}

/** Map XML dimension-type/level-type to SML time_unit. */
function mapLevelType(xmlLevelType: string | undefined): string | undefined {
  if (!xmlLevelType) return undefined;
  switch (xmlLevelType) {
    case "TimeYears":     return "year";
    case "TimeHalfYears": return "halfyear";
    case "TimeQuarters":  return "quarter";
    case "TimeMonths":    return "month";
    case "TimeWeeks":     return "week";
    case "TimeDays":      return "day";
    case "TimeHours":     return "hour";
    case "TimeMinutes":   return "minute";
    case "TimeSeconds":   return "second";
    default:              return undefined;
  }
}

/**
 * Ordered [pattern, time_unit] fallbacks for levels inside a time dimension whose
 * XML level-type is missing or unrecognized (e.g. custom levels like "customquarter").
 */
const TIME_UNIT_NAME_PATTERNS: Array<[RegExp, string]> = [
  [/\byear\b|\byr\b/i,          "year"],
  [/\bquarter\b|\bqtr\b/i,      "quarter"],
  [/\bhalf.?year\b|\bh[12]\b/i, "halfyear"],
  [/\bmonth\b/i,                "month"],
  [/\bweek\b|\bwk\b/i,          "week"],
  [/\bday\b|\bdate\b/i,         "day"],
  [/\bhour\b|\bhr\b/i,          "hour"],
  [/\bminute\b|\bmin\b/i,       "minute"],
  [/\bsecond\b|\bsec\b/i,       "second"],
  [/year/i,                     "year"],
  [/quarter/i,                  "quarter"],
  [/half.?year|halfyr/i,        "halfyear"],
  [/month/i,                    "month"],
  [/week/i,                     "week"],
  [/date|day/i,                 "day"],
  [/hour/i,                     "hour"],
  [/minute/i,                   "minute"],
  [/second/i,                   "second"],
];

/** Fallback: infer a level's time_unit from its name when the XML level-type is missing/unrecognized. */
function inferTimeUnitFromName(levelName: string): string | undefined {
  for (const [pattern, unit] of TIME_UNIT_NAME_PATTERNS) {
    if (pattern.test(levelName)) return unit;
  }
  return undefined;
}

// ============================================================
// Dataset physical section parser
// ============================================================

/** Map XML column type strings to SML data_type values. */
function mapDataType(xmlType: string | undefined): string {
  if (!xmlType) return "string";
  switch (xmlType.toLowerCase()) {
    case "string":    return "string";
    case "int":
    case "integer":   return "int";
    case "long":      return "long";
    case "float":
    case "double":
    case "decimal":
    case "numeric":   return "decimal";
    case "date":      return "date";
    // AtScale's engine rejects "timestamp" as an unrecognized physical type at deploy
    // time even though it's a valid static data_type token — the reference converter
    // always emits "datetime" instead, so both map there for engine compatibility.
    case "timestamp":
    case "datetime":  return "datetime";
    case "boolean":
    case "bool":      return "boolean";
    // Semi-structured/JSON types (e.g. Snowflake VARIANT) have no SML equivalent — treat as string.
    case "variant":
    case "json":
    case "object":
    case "array":     return "string";
    default:          return xmlType.toLowerCase();
  }
}

function parseDatasetPhysical(dsEl: Record<string, unknown>): DatasetPhysical | undefined {
  const physSec = first(arr(dsEl.physical)) as Record<string, unknown> | undefined;
  if (!physSec) return undefined;

  // Connection name from <connection id="...">
  const connEl = first(arr(physSec.connection)) as Record<string, unknown> | undefined;
  const connectionName = connEl ? a(connEl, "id") : undefined;

  // Immutable flag from <immutable>true</immutable>
  const immutableStr = s(first(arr(physSec.immutable)));
  const immutable = immutableStr === "true" ? true : undefined;

  // Column definitions from <column><name>...</name><type>...</type></column>, optionally
  // <sql>...</sql> for a computed column (an expression aliased under this column name,
  // rather than a direct passthrough of a real table column) — without it, the computed
  // column's own name would be queried against the real table as if it existed there
  // directly. Source XML can genuinely declare the same column twice (a copy-paste
  // artifact) — dedupe by name, keeping the first occurrence, since a duplicate column
  // name is invalid SML.
  const columns: Array<{ name: string; dataType: string; sql?: string }> = [];
  const seenColumnNames = new Set<string>();
  for (const col of arr(physSec.column)) {
    const colName = s(first(arr((col as Record<string, unknown>).name)));
    const colType = s(first(arr((col as Record<string, unknown>).type)));
    const colSqlRaw = s(first(arr((col as Record<string, unknown>).sql)));
    const colSql = colSqlRaw ? unescapeHtml(colSqlRaw).replace(/\t/g, "  ") : undefined;
    if (colName && !seenColumnNames.has(colName)) {
      seenColumnNames.add(colName);
      columns.push({ name: colName, dataType: mapDataType(colType), sql: colSql });
    }
  }
  const colsResult = columns.length ? columns : undefined;

  const tableEl = first(arr(physSec.table)) as Record<string, unknown> | undefined;
  const queryEl = first(arr(physSec.query)) as Record<string, unknown> | undefined;

  if (tableEl) {
    const db = s(first(arr(tableEl.database)));
    const schema = s(first(arr(tableEl.schema)));
    const tableName = s(first(arr(tableEl.name)));
    return { db, schema, tableName, connectionName, columns: colsResult, immutable };
  }

  if (queryEl) {
    const rawSql = s(first(arr(queryEl.sql)));
    if (rawSql) {
      // Replace tabs with spaces so js-yaml can use block literal (| style) rather than quoted
      return { sql: unescapeHtml(rawSql).replace(/\t/g, "  "), connectionName, columns: colsResult, immutable };
    }
  }

  return { connectionName, columns: colsResult, immutable };
}

// ============================================================
// Phase 2: Dataset YAML
// ============================================================

function buildDatasetYaml(
  dsEl: Record<string, unknown>,
  dsName: string,
  connectionId: string,
  /** Every column any key-ref/attribute-ref points to for this dataset, regardless of <physical>. */
  referencedColumns?: Set<string>,
): string {
  const phys = parseDatasetPhysical(dsEl) ?? {};

  const obj: Record<string, unknown> = {
    unique_name: `${dsName}.dataset`,
    object_type: "dataset",
    label: dsName,          // preserve original casing; do not title-case
    connection_id: connectionId,
  };

  if (phys.immutable) obj.immutable = true;

  if (phys.sql) {
    obj.sql = phys.sql;
  } else {
    // db/schema always live on the connection (see connectionIdByDataset) — a dataset's
    // own table is always a plain string; a nested {db, schema, name} object here is
    // schema-valid SML but rejected by AtScale's live engine.
    obj.table = phys.tableName ?? dsName;
  }

  const columns: Array<{ name: string; data_type: string; sql?: string }> =
    (phys.columns ?? [])
      // A column whose XML type has no SML equivalent (e.g. Snowflake BINARY) is only
      // safe to keep if something actually references it (a key/relationship column);
      // otherwise it's dead physical metadata that fails catalog validation outright —
      // drop it, matching the reference converter's own "unused, will be removed"
      // behavior for these columns.
      .filter((c) => !c.dataType.startsWith("binary") || referencedColumns?.has(c.name))
      .map((c) => ({ name: c.name, data_type: c.dataType, ...(c.sql ? { sql: c.sql } : {}) }));

  if (referencedColumns?.size) {
    const known = new Set(columns.map((c) => c.name));
    for (const col of referencedColumns) {
      if (!known.has(col)) columns.push({ name: col, data_type: "string" }); // unknown — mark for review
    }
  }

  if (columns.length) obj.columns = columns;

  return toYaml(obj);
}

/**
 * Resolves which dimension "owns" each attribute id, for User Defined Aggregate parsing.
 *
 * An attribute is hosted natively by whichever dimension references it via a plain
 * `<keyed-attribute-ref attribute-id="X">` with no `ref-id` (the same distinction
 * buildDimensionYaml already uses to separate secondary attributes from skipped
 * cross-dimension refs). When a `ref-id` IS present, the id is instead an opaque
 * "path token" pairing the CURRENT (host) dimension with a foreign attribute reached via
 * a snowflake/embedded relationship — there is no separate declaration to look up, so the
 * ref-id itself is recorded against the host dimension's name for later synthesis of
 * `relationships_path` as `{hostDimension}_{targetDimensionNoSpaces}`.
 */
function collectAttributeDimensionOwnership(
  allDims: Map<string, Record<string, unknown>>,
): { attrIdToDimName: Map<string, string>; refIdToHostDimName: Map<string, string> } {
  const attrIdToDimName = new Map<string, string>();
  const refIdToHostDimName = new Map<string, string>();

  for (const [dimName, dimEl] of allDims) {
    for (const hierEl of arr(dimEl.hierarchy)) {
      for (const levelEl of arr(hierEl.level)) {
        const primaryAttrUuid = a(levelEl, "primary-attribute");
        if (primaryAttrUuid && !attrIdToDimName.has(primaryAttrUuid)) {
          attrIdToDimName.set(primaryAttrUuid, dimName);
        }
        for (const kref of arr(levelEl["keyed-attribute-ref"])) {
          const attrId = a(kref, "attribute-id");
          const refId = a(kref, "ref-id");
          if (!attrId) continue;
          if (refId) {
            if (!refIdToHostDimName.has(refId)) refIdToHostDimName.set(refId, dimName);
          } else if (!attrIdToDimName.has(attrId)) {
            attrIdToDimName.set(attrId, dimName);
          }
        }
      }
    }
  }

  return { attrIdToDimName, refIdToHostDimName };
}

/**
 * Collects every column that is, on its own, the entire (single-column) key of some level
 * anywhere in the schema — used to pick a sane default name_column for a DIFFERENT level
 * whose own key is composite.
 *
 * A composite key is typically a coarser identifier concatenated with the level's own
 * column (e.g. a "cube" level keyed on [org_id, project_id, cube_id], where org_id and
 * project_id belong to separate ORG/PROJECT dimensions/levels and only cube_id is this
 * level's own identity). Defaulting name_column to the first key column — which happens
 * to be correct when nothing is composite, or when a composite key mixes columns that are
 * never independently a level's own key elsewhere — is wrong whenever a column in the key
 * IS independently the sole key of another level: that column represents a foreign
 * identity, not this level's own name, so it should be excluded from consideration in
 * favor of whichever column remains.
 */
function collectSoleKeyColumns(
  allDims: Map<string, Record<string, unknown>>,
  attrDef: Map<string, AttrDefEntry>,
  keyMap: Map<string, KeyRefEntry[]>,
): Set<string> {
  const soleKeyColumns = new Set<string>();

  for (const dimEl of allDims.values()) {
    for (const hierEl of arr(dimEl.hierarchy)) {
      for (const levelEl of arr(hierEl.level)) {
        const primaryAttrUuid = a(levelEl, "primary-attribute");
        if (!primaryAttrUuid) continue;
        const def = attrDef.get(primaryAttrUuid);
        if (!def) continue;
        const keyEntries = keyMap.get(def.keyUuid) ?? [];
        const authEntry = keyEntries.find((e) => e.complete === "true") ?? keyEntries[0];
        if (authEntry?.columns.length === 1) {
          soleKeyColumns.add(authEntry.columns[0]);
        }
      }
    }
  }

  return soleKeyColumns;
}

/**
 * Default name_column for a level's (possibly composite) key: exclude any column that is
 * either (a) independently the sole key of some other level in the schema (see
 * collectSoleKeyColumns) or (b) a date/datetime-typed column, then take the last
 * remaining column — composite keys are built coarse-to-fine, so after removing
 * foreign/borrowed identity columns and pure date qualifiers, the last of what's left is
 * this level's own most granular, nameable column.
 *
 * Both exclusions are needed together: a column can be the sole key of another dimension
 * (e.g. an account or customer's own id) yet still be the right name_column for THIS
 * level, when the only other candidate is a date column tacked on purely to scope a
 * snapshot (e.g. "account as of month-end") — a date is essentially never what a user
 * wants as a dimension member's display name. Conversely a column can be a perfectly
 * ordinary string/id with no date involved, yet still need excluding because it belongs
 * to a genuinely separate dimension (e.g. an org id inside a project/cube/perspective
 * key). Excluding only one of the two signals produces wrong answers for the other
 * pattern, so both apply and whichever columns end up excluded are removed together.
 *
 * If every column ends up excluded, or nothing does, there is no positive signal to act
 * on, so the original first-column default is kept unchanged.
 */
function defaultNameColumn(
  keyColumns: string[],
  datasetName: string,
  soleKeyColumns: Set<string>,
  datasetNameToPhysical: Map<string, DatasetPhysical>,
): string {
  if (keyColumns.length <= 1) return keyColumns[0];
  const physColumns = datasetNameToPhysical.get(datasetName)?.columns;
  const isDateLike = (col: string): boolean => {
    const dataType = physColumns?.find((c) => c.name === col)?.dataType;
    return dataType === "date" || dataType === "datetime";
  };
  const remaining = keyColumns.filter((c) => !soleKeyColumns.has(c) && !isDateLike(c));
  if (remaining.length > 0 && remaining.length < keyColumns.length) {
    return remaining[remaining.length - 1];
  }
  return keyColumns[0];
}

// ============================================================
// Phase 3: Dimension YAML
// ============================================================

interface SecondaryAttrDef {
  uniqueName: string;
  label: string;
  dataset: string;
  keyColumns: string[];
  nameColumn: string;
  sortColumn: string;
  allowedCalcsForDma?: string[];
  format?: string;
}

interface LevelAttrDef {
  uniqueName: string;
  label: string;
  dataset: string;
  keyColumns: string[];
  nameColumn: string;
  sortColumn?: string;
  timeUnit?: string;
  isHiddenFromUi?: boolean;
  isUniqueKey?: boolean;
  folder?: string;
  description?: string;
  allowedCalcsForDma?: string[];
}

function buildDimensionYaml(
  dimEl: Record<string, unknown>,
  dimName: string,
  attrDef: Map<string, AttrDefEntry>,
  keyMap: Map<string, KeyRefEntry[]>,
  attrMap: Map<string, AttrRefEntry>,
  /** Whether inferRelationships determined this dimension is degenerate (no relationship
   * in any cube that uses it) — the single source of truth for is_degenerate/type, so it
   * can never disagree with the model's own dimensions:/relationships: placement. */
  isDegenerate: boolean,
  /** Columns that are the sole key of some other level in the schema — see
   * collectSoleKeyColumns/defaultNameColumn for how this refines a composite key's
   * default name_column. */
  soleKeyColumns: Set<string>,
  datasetNameToPhysical: Map<string, DatasetPhysical>,
): { yaml: string; meta: DimMeta } {
  const props = first(arr(dimEl.properties)) as Record<string, unknown> | undefined;
  const dimTypeRaw = props ? s(first(arr(props["dimension-type"]))) : undefined;
  const isTime = dimTypeRaw === "Time";
  const label = props ? (s(first(arr(props.caption))) ?? dimName) : dimName;
  const dimDescription = props ? s(first(arr(props.description))) : undefined;

  // Meta tracking
  let metaTotalLevels = 0;
  let metaHasDefaultMembers = false;
  const metaSkippedCrossDimRefs: Array<{ dimName: string; attrId: string }> = [];

  // Collect level attributes (de-duplicated by uniqueName)
  const levelAttrMap = new Map<string, LevelAttrDef>();

  const hierarchies: Array<{
    uniqueName: string;
    label: string;
    filterEmpty?: string;
    folder?: string;
    description?: string;
    defaultMember?: { literal_value: string; apply_in_query?: boolean };
    levels: Array<{
      uniqueName: string;
      timeUnit?: string;
      isHidden?: boolean;
      secondaryAttributes?: SecondaryAttrDef[];
    }>;
  }> = [];

  for (const hierEl of arr(dimEl.hierarchy)) {
    const hierName = a(hierEl, "name") ?? "Hierarchy";
    const hierProps = first(arr(hierEl.properties)) as Record<string, unknown> | undefined;
    const hierCaption = hierProps ? s(first(arr(hierProps.caption))) : undefined;
    const hierFolder = hierProps ? s(first(arr(hierProps.folder))) : undefined;
    const hierDescription = hierProps ? s(first(arr(hierProps.description))) : undefined;

    // filter_empty: only store when NOT "always" ("always" is the SML default)
    const filterEmptyRaw = hierProps ? s(first(arr(hierProps["filter-empty"]))) : undefined;
    const filterEmpty =
      filterEmptyRaw && filterEmptyRaw.toLowerCase() !== "always"
        ? filterEmptyRaw.toLowerCase()
        : undefined;

    // Default member — structured object with literal_value (and apply_in_query only when true)
    const defaultMemberEl = hierProps
      ? (first(arr(hierProps["default-member"])) as Record<string, unknown> | undefined)
      : undefined;
    const literalMember = defaultMemberEl
      ? s(first(arr(defaultMemberEl["literal-member"])))
      : undefined;
    let defaultMember: { literal_value: string; apply_in_query?: boolean } | undefined;
    if (literalMember) {
      const applyRaw =
        a(defaultMemberEl!, "applyInQuery") ??
        s(first(arr((defaultMemberEl as Record<string, unknown>).applyInQuery)));
      const applyInQuery = applyRaw === "true";
      defaultMember = {
        literal_value: unescapeHtml(literalMember),
        ...(applyInQuery ? { apply_in_query: true } : {}),
      };
      metaHasDefaultMembers = true;
    }

    const hierLevels: Array<{
      uniqueName: string;
      timeUnit?: string;
      isHidden?: boolean;
      secondaryAttributes?: SecondaryAttrDef[];
    }> = [];

    for (const levelEl of arr(hierEl.level)) {
      const primaryAttrUuid = a(levelEl, "primary-attribute");
      if (!primaryAttrUuid) continue;

      const def = attrDef.get(primaryAttrUuid);
      if (!def) continue;

      const levelName = def.caption ?? def.name;
      const levelUniqueName = def.name;

      // Resolve key columns for the primary level attribute
      const keyEntries = keyMap.get(def.keyUuid) ?? [];
      const authEntry = keyEntries.find((e) => e.complete === "true") ?? keyEntries[0];
      if (!authEntry) continue;

      const keyColumns = authEntry.columns;
      const datasetRef = `${authEntry.datasetName}.dataset`;
      const isUniqueKey = authEntry.unique ?? false;

      // Process keyed-attribute-refs:
      //   role="name"|"label"  → overrides name_column for the primary level attribute
      //   role="sort"          → sets sort_column for the primary level attribute
      //   no role / ref-id set → secondary attribute (or cross-dim ref, skipped if ref-id present)
      let nameColumn = defaultNameColumn(keyColumns, authEntry.datasetName, soleKeyColumns, datasetNameToPhysical);
      let sortColumn: string | undefined;
      const secondaryAttrs: SecondaryAttrDef[] = [];

      for (const kref of arr(levelEl["keyed-attribute-ref"])) {
        const attrId = a(kref, "attribute-id");
        const role = a(kref, "role");
        const refId = a(kref, "ref-id"); // cross-dimension embedded relationship — skip
        if (!attrId || refId) {
          if (refId && attrId) metaSkippedCrossDimRefs.push({ dimName, attrId });
          continue;
        }

        // Resolve the display column for this attribute reference
        let resolvedCol: string | undefined;
        const attrRefEntry = attrMap.get(attrId);
        if (attrRefEntry) {
          resolvedCol = attrRefEntry.column;
        }

        if (role === "sort") {
          // Explicit sort role → sets sort_column on the primary level attr
          if (resolvedCol) sortColumn = resolvedCol;
        } else if (role === "name" || role === "label") {
          // Explicit name/label role → overrides name_column on the primary level attr
          if (resolvedCol) nameColumn = resolvedCol;
        } else {
          // No role (or unrecognised role) → secondary attribute
          const kaDef = attrDef.get(attrId);
          if (!kaDef) continue;
          const kaKeyEntries = keyMap.get(kaDef.keyUuid) ?? [];
          const kaAuthEntry = kaKeyEntries.find((e) => e.complete === "true") ?? kaKeyEntries[0];
          if (!kaAuthEntry) continue;
          const saKeyColumns = kaAuthEntry.columns;
          const saDataset = `${kaAuthEntry.datasetName}.dataset`;
          const saNameCol = resolvedCol ?? saKeyColumns[0];
          secondaryAttrs.push({
            uniqueName: truncateUniqueName(kaDef.name),
            label: kaDef.caption ?? kaDef.name,
            dataset: saDataset,
            keyColumns: saKeyColumns,
            nameColumn: saNameCol,
            sortColumn: saNameCol, // reference converter defaults sort_column to name_column
            allowedCalcsForDma: kaDef.allowedCalcTypes,
            format: resolveFormat(kaDef.formatString, kaDef.namedFormat),
          });
        }
      }

      const levelVisibleStr = (() => {
        const lProps = first(arr(levelEl.properties)) as Record<string, unknown> | undefined;
        return lProps ? s(first(arr(lProps.visible))) : undefined;
      })();
      const isHidden = levelVisibleStr === "false" || !def.visible;

      const levelTypeRaw = (() => {
        const lProps = first(arr(levelEl.properties)) as Record<string, unknown> | undefined;
        return lProps ? s(first(arr(lProps["level-type"]))) : undefined;
      })();
      const timeUnit = mapLevelType(levelTypeRaw) ?? (isTime ? inferTimeUnitFromName(levelName) : undefined);

      // Build or merge the level attribute entry (de-duplicated by unique name)
      if (!levelAttrMap.has(levelUniqueName)) {
        levelAttrMap.set(levelUniqueName, {
          uniqueName: levelUniqueName,
          label: levelName,
          dataset: datasetRef,
          keyColumns,
          nameColumn,
          sortColumn,
          timeUnit,
          isHiddenFromUi: isHidden || undefined,
          isUniqueKey: isUniqueKey || undefined,
          folder: def.folder,
          description: def.description,
          allowedCalcsForDma: def.allowedCalcTypes,
        });
      }

      hierLevels.push({
        uniqueName: levelUniqueName,
        timeUnit,
        isHidden: isHidden || undefined,
        secondaryAttributes: secondaryAttrs.length ? secondaryAttrs : undefined,
      });
    }

    if (hierLevels.length > 0) {
      metaTotalLevels += hierLevels.length;
      hierarchies.push({
        uniqueName: hierName,
        label: hierCaption ?? hierName,
        filterEmpty,
        folder: hierFolder,
        description: hierDescription,
        defaultMember,
        levels: hierLevels,
      });
    }
  }

  // Build YAML structure
  const obj: Record<string, unknown> = {
    unique_name: dimName,
    object_type: "dimension",
    label,
  };

  if (dimDescription) obj.description = dimDescription;
  if (isDegenerate) {
    obj.is_degenerate = true;
  } else if (isTime) {
    obj.type = "time";
  } else {
    obj.type = "standard";
  }

  if (hierarchies.length > 0) {
    obj.hierarchies = hierarchies.map((h) => {
      const hierObj: Record<string, unknown> = {
        unique_name: h.uniqueName,
        label: h.label,
      };
      if (h.description) hierObj.description = h.description;
      if (h.filterEmpty) hierObj.filter_empty = h.filterEmpty;
      if (h.folder) hierObj.folder = h.folder;
      if (h.defaultMember) hierObj.default_member = h.defaultMember;
      hierObj.levels = h.levels.map((l) => {
        const lObj: Record<string, unknown> = { unique_name: l.uniqueName };
        if (l.isHidden) lObj.is_hidden = true;
        if (l.secondaryAttributes?.length) {
          lObj.secondary_attributes = l.secondaryAttributes.map((sa) => {
            const saObj: Record<string, unknown> = {
              unique_name: sa.uniqueName,
              label: sa.label,
              dataset: sa.dataset,
              key_columns: sa.keyColumns,
              name_column: sa.nameColumn,
              sort_column: sa.sortColumn,
            };
            if (sa.format) saObj.format = sa.format;
            if (sa.allowedCalcsForDma?.length) {
              saObj.allowed_calcs_for_dma = sa.allowedCalcsForDma;
            }
            return saObj;
          });
        }
        return lObj;
      });
      return hierObj;
    });
  }

  if (levelAttrMap.size > 0) {
    obj.level_attributes = Array.from(levelAttrMap.values()).map((la) => {
      const laObj: Record<string, unknown> = {
        unique_name: la.uniqueName,
        label: la.label,
        dataset: la.dataset,
        name_column: la.nameColumn,
        key_columns: la.keyColumns,
      };
      if (la.description) laObj.description = la.description;
      if (la.sortColumn && la.sortColumn !== la.nameColumn) laObj.sort_column = la.sortColumn;
      if (la.timeUnit) laObj.time_unit = la.timeUnit;
      if (la.isUniqueKey) laObj.is_unique_key = true;
      if (la.folder) laObj.folder = la.folder;
      if (la.isHiddenFromUi) laObj.is_hidden = true;
      if (la.allowedCalcsForDma?.length) laObj.allowed_calcs_for_dma = la.allowedCalcsForDma;
      return laObj;
    });
  }

  const meta: DimMeta = {
    type: isDegenerate ? "degenerate" : isTime ? "time" : "standard",
    hierarchyCount: hierarchies.length,
    levelCount: metaTotalLevels,
    hasDefaultMembers: metaHasDefaultMembers,
    skippedCrossDimRefs: metaSkippedCrossDimRefs,
  };

  return { yaml: toYaml(obj), meta };
}

// ============================================================
// Phase 4: Metric YAML
// ============================================================

function buildMetricYaml(
  uniqueName: string,
  label: string,
  calculationMethod: string,
  factDatasetName: string,
  column: string,
  format?: string,
  folder?: string,
  visible = true,
  description?: string,
): string {
  const obj: Record<string, unknown> = {
    unique_name: uniqueName,
    object_type: "metric",
    label,
    calculation_method: calculationMethod,
    dataset: `${factDatasetName}.dataset`,
    column,
  };
  if (description) obj.description = description;
  if (format) obj.format = format;
  if (folder) obj.folder = folder;
  if (!visible) obj.is_hidden = true;
  return toYaml(obj);
}

function buildCalcMetricYaml(
  uniqueName: string,
  label: string,
  formula: string,
  format?: string,
  folder?: string,
  visible = true,
  description?: string,
): string {
  const obj: Record<string, unknown> = {
    unique_name: uniqueName,
    object_type: "metric",
    label,
    formula,
  };
  if (description) obj.description = description;
  if (format) obj.format = format;
  if (folder) obj.folder = folder;
  if (!visible) obj.is_hidden = true;
  return toYaml(obj);
}

/**
 * Emit a schema-level calculated member as a `metric_calc` YAML object.
 * These live in /calculations/ and use `expression:` rather than `formula:`.
 */
function buildCalcMemberYaml(
  uniqueName: string,
  label: string,
  expression: string,
  format?: string,
  folder?: string,
  visible = true,
  description?: string,
): string {
  const obj: Record<string, unknown> = {
    unique_name: uniqueName,
    object_type: "metric_calc",
    label,
    expression,
  };
  if (description) obj.description = description;
  if (format) obj.format = format;
  if (folder) obj.folder = folder;
  if (!visible) obj.is_hidden = true;
  return toYaml(obj);
}

// ============================================================
// Phase 7: Calculated member parser
// ============================================================

function parseCalcMember(cm: Record<string, unknown>): CalcMemberDef | undefined {
  const name = a(cm, "name");
  if (!name) return undefined;
  const props = first(arr(cm.properties)) as Record<string, unknown> | undefined;
  const caption = props ? s(first(arr(props.caption))) : undefined;
  const folder = props ? s(first(arr(props.folder))) : undefined;
  const description = props ? s(first(arr(props.description))) : undefined;
  const visibleStr = props ? s(first(arr(props.visible))) : undefined;
  const visible = visibleStr !== "false";
  const fmtEl = props ? (first(arr(props.formatting)) as Record<string, unknown> | undefined) : undefined;
  const formatString = fmtEl ? s(first(arr(fmtEl["format-string"]))) : undefined;
  const namedFormat = fmtEl ? s(first(arr(fmtEl["named-format"]))) : undefined;
  const exprRaw = s(first(arr(cm.expression)));
  if (!exprRaw) return undefined;
  return {
    name,
    caption,
    folder,
    description,
    visible,
    formatString,
    namedFormat,
    expression: unescapeHtml(exprRaw),
  };
}

// ============================================================
// Phase 5: Relationship inference
// ============================================================

interface CubeKeyRole {
  columns: string[];
  rolePlay?: string;
  complete: string;
  datasetName: string;
}

interface CubeLevelMatch {
  matchId: string;
  toLevel: string;
  dimKeyUuid?: string;
}

/**
 * Scan every level of every hierarchy in a dimension for matches against the cube's
 * key-refs — a dimension can have multiple hierarchies (e.g. a date dimension with
 * separate Calendar/Reporting/Custom hierarchies) each needing their own relationship
 * to the same fact-table FK, so this returns ALL matches, not just the first.
 * Two distinct matching mechanisms exist in the source XML:
 *   - Role-played FKs (e.g. "Order Date" / "Ship Date" both pointing at the same Date
 *     Dimension level): the cube's <key-ref><ref-path><new-ref attribute-id="..."> value
 *     equals the level's own `primary-attribute` id directly.
 *   - Plain FKs / degenerate attributes: matched via the keyed-attribute's own
 *     `key-ref="..."` XML attribute (def.keyUuid), same as before.
 * Each match's `matchId` is what to look up in cubeKeyRoles; `dimKeyUuid` is the
 * dimension's own canonical key, used separately to resolve which dataset backs it —
 * these differ for role-played matches, where matchId is cube-local.
 */
function findCubeMatchingLevels(
  dimEl: Record<string, unknown>,
  attrDef: Map<string, AttrDefEntry>,
  cubeKeyRoles: Map<string, CubeKeyRole[]>,
): CubeLevelMatch[] {
  const matches: CubeLevelMatch[] = [];
  for (const hierEl of arr(dimEl.hierarchy)) {
    for (const levelEl of arr(hierEl.level)) {
      const pa = a(levelEl, "primary-attribute");
      if (!pa) continue;
      const def = attrDef.get(pa);
      if (cubeKeyRoles.has(pa)) {
        matches.push({ matchId: pa, toLevel: def?.name ?? pa, dimKeyUuid: def?.keyUuid });
        continue;
      }
      if (def?.keyUuid && cubeKeyRoles.has(def.keyUuid)) {
        matches.push({ matchId: def.keyUuid, toLevel: def.name, dimKeyUuid: def.keyUuid });
      }
    }
  }
  return matches;
}

function inferRelationships(
  cubeEl: Record<string, unknown>,
  factDatasetName: string | undefined,
  keyMap: Map<string, KeyRefEntry[]>,
  attrDef: Map<string, AttrDefEntry>,
  relevantDims: Map<string, Record<string, unknown>>,
  datasetIdToName: Map<string, string>,
): { relationships: RelationshipDef[]; degenerateDimNames: string[] } {
  if (!factDatasetName) return { relationships: [], degenerateDimNames: [] };

  // Build the set of ids that appear in this cube's data-set-ref logical sections, mapped to
  // every distinct role that id represents. Role-played FKs (e.g. "Order Date" and "Ship
  // Date" both pointing at the same Date Dimension level) share the same outer <key-ref id>
  // but have different <ref-path><new-ref attribute-id="..."> values — that attribute-id
  // equals the dimension level's own primary-attribute id, so it's used as the map key
  // instead of the (colliding) outer id. The same outer id can also appear, unchanged, in
  // MULTIPLE <data-set-ref> blocks of a multi-fact cube (e.g. a "query" fact and a "sub-
  // query" fact both keying against the same dimension under different column names) — so
  // each data-set-ref's own dataset name is tracked per role, not assumed to be the cube's
  // single factDatasetName, and every distinct (dataset, columns) pair is kept as a separate
  // role rather than the last one silently overwriting the others.
  const cubeKeyRoles = new Map<string, CubeKeyRole[]>();
  for (const dsSec of arr(cubeEl["data-sets"])) {
    for (const dsRef of arr(dsSec["data-set-ref"])) {
      const refId = a(dsRef, "id");
      const dsDatasetName = refId ? (datasetIdToName.get(refId) ?? refId) : undefined;
      if (!dsDatasetName) continue;

      for (const logSec of arr(dsRef.logical)) {
        for (const kr of arr(logSec["key-ref"])) {
          const id = a(kr, "id");
          if (!id) continue;
          const cols = extractColumns(arr(kr.column));
          if (cols.length === 0) continue;
          const complete = a(kr, "complete") ?? "true";

          const refPathEl = first(arr(kr["ref-path"])) as Record<string, unknown> | undefined;
          const newRefEl = refPathEl
            ? (first(arr(refPathEl["new-ref"])) as Record<string, unknown> | undefined)
            : undefined;
          const roleAttrId = newRefEl ? a(newRefEl, "attribute-id") : undefined;
          const rolePlay = newRefEl ? s(first(arr(newRefEl["ref-naming"]))) : undefined;
          const matchId = roleAttrId ?? id;

          const roles = cubeKeyRoles.get(matchId) ?? [];
          const colKey = `${dsDatasetName}|${cols.join(",")}`;
          const existingIdx = roles.findIndex((r) => `${r.datasetName}|${r.columns.join(",")}` === colKey);
          if (existingIdx === -1) {
            roles.push({ columns: cols, rolePlay, complete, datasetName: dsDatasetName });
          } else if (complete === "false") {
            // Prefer the explicit-FK (complete=false) version of the same column set
            roles[existingIdx] = { columns: cols, rolePlay, complete, datasetName: dsDatasetName };
          }
          cubeKeyRoles.set(matchId, roles);
        }
      }
    }
  }

  const relationships: RelationshipDef[] = [];
  const degenerateDimNames: string[] = [];
  const seen = new Set<string>();
  const usedNames = new Set<string>();

  for (const [dimName, dimEl] of relevantDims) {
    // Find every level (across every hierarchy) of this dimension matching the cube's
    // key-refs — a dimension can have multiple hierarchies each needing their own
    // relationship to the same fact-table FK (e.g. a date dimension's Calendar/Reporting/
    // Custom hierarchies all role-played as both "Order Date" and "Ship Date").
    const matches = findCubeMatchingLevels(dimEl, attrDef, cubeKeyRoles);
    if (matches.length === 0) continue; // Dimension not used by this cube

    let isDegenerate = false;

    for (const { matchId, toLevel, dimKeyUuid } of matches) {
      const roles = cubeKeyRoles.get(matchId) ?? [];
      if (roles.length === 0) continue;

      // Dimension dataset: the complete=true side of the dimension's own key (the lookup
      // table) — distinct from matchId, which may be a cube-local role-play identifier.
      const dimDataset = dimKeyUuid
        ? keyMap.get(dimKeyUuid)?.find((e) => e.complete === "true")?.datasetName
        : undefined;

      for (const role of roles) {
        // Degenerate dimensions (their own dataset IS the role's own fact-side dataset)
        // attach directly via is_degenerate — a relationship here would be a self-join.
        if (dimDataset === role.datasetName) {
          isDegenerate = true;
          continue;
        }

        const relKey = `${dimName}|${toLevel}|${role.datasetName}|${role.columns.join(",")}`;
        if (seen.has(relKey)) continue;
        seen.add(relKey);

        const baseName = `${safeName(role.datasetName)}_to_${safeName(dimName)}_${safeName(role.columns.join("_"))}`;
        let relUniqueName = baseName;
        let suffix = 1;
        while (usedNames.has(relUniqueName)) {
          relUniqueName = `${baseName}_${++suffix}`;
        }
        usedNames.add(relUniqueName);

        relationships.push({
          uniqueName: relUniqueName,
          fromDataset: role.datasetName,
          fromColumns: role.columns,
          toDimension: dimName,
          toLevel,
          rolePlay: role.rolePlay,
          dimensionDataset: dimDataset,
        });
      }
    }

    // A dimension in the flat dimensions: list is implicitly degenerate (no relationship
    // needed); one referenced only via relationships[].to.dimension must not also appear
    // there, so only degenerate dims are tracked here.
    if (isDegenerate) degenerateDimNames.push(dimName);
  }

  return { relationships, degenerateDimNames };
}

// ============================================================
// Phase 6: Catalog, connection, model YAML
// ============================================================

function buildCatalogYaml(catalogName: string): string {
  return toYaml({
    unique_name: `${catalogName}.catalog`,
    object_type: "catalog",
    label: catalogName,
    version: 1.5,
    aggressive_agg_promotion: false,
    build_speculative_aggs: false,
  });
}

function buildConnectionYaml(
  connName: string,
  connType?: string,
  db?: string,
  schema?: string,
  /** The base AtScale-registered connection this one is a db/schema variant of, if any. */
  asConnection?: string,
): string {
  const obj: Record<string, unknown> = {
    unique_name: connName,
    object_type: "connection",
    label: connName,
    as_connection: asConnection ?? connName,
  };
  if (connType) obj.connection_type = connType;
  if (db) obj.database = db;
  if (schema) obj.schema = schema;
  return toYaml(obj);
}

function buildModelYaml(
  modelName: string,
  relationships: RelationshipDef[],
  dimNames: string[],
  metricNames: Array<{ uniqueName: string; folder?: string }>,
  aggregates: AggregateDef[] = [],
  isHidden = false,
  includeDefaultDrillthrough = false,
): string {
  const obj: Record<string, unknown> = {
    unique_name: modelName,
    object_type: "model",
    label: modelName,
  };

  // Models use visible (default true), not is_hidden — a different property
  // from every other SML object type that carries a hidden flag.
  if (isHidden) obj.visible = false;
  if (includeDefaultDrillthrough) obj.include_default_drillthrough = true;

  obj.relationships = relationships.map((r) => {
    const relObj: Record<string, unknown> = {
      unique_name: r.uniqueName,
      from: {
        dataset: `${r.fromDataset}.dataset`,
        join_columns: r.fromColumns,
      },
      to: {
        dimension: r.toDimension,
        level: r.toLevel,
      },
    };
    if (r.rolePlay) relObj.role_play = r.rolePlay;
    return relObj;
  });

  if (dimNames.length > 0) {
    obj.dimensions = dimNames;
  }

  if (metricNames.length > 0) {
    obj.metrics = metricNames.map((m) => {
      const mObj: Record<string, unknown> = { unique_name: m.uniqueName };
      if (m.folder) mObj.folder = m.folder;
      return mObj;
    });
  }

  if (aggregates.length > 0) {
    obj.aggregates = aggregates.map((agg) => {
      const aggObj: Record<string, unknown> = {
        unique_name: agg.uniqueName,
        label: agg.label,
      };
      if (agg.attributes.length > 0) {
        aggObj.attributes = agg.attributes.map((attr) => {
          const attrObj: Record<string, unknown> = { name: attr.name, dimension: attr.dimension };
          if (attr.relationshipsPath?.length) attrObj.relationships_path = attr.relationshipsPath;
          return attrObj;
        });
      }
      if (agg.metrics.length > 0) aggObj.metrics = agg.metrics;
      return aggObj;
    });
  }

  return toYaml(obj);
}

// ============================================================
// YAML serialization
// ============================================================

function toYaml(obj: unknown): string {
  return dump(obj, {
    indent: 2,
    lineWidth: -1,
    noRefs: true,
    sortKeys: false,
    quotingType: '"',
    forceQuotes: false,
  });
}

// ============================================================
// Mermaid schema diagram
// ============================================================

/**
 * Sanitize a name to a valid Mermaid erDiagram entity identifier.
 * Entity names must start with a letter; only A-Z, 0-9, and _ are safe.
 */
function mermaidEnt(name: string): string {
  let id = name.toUpperCase().replace(/[^A-Z0-9]/g, "_").replace(/__+/g, "_").replace(/^_+|_+$/g, "");
  // Mermaid entity names must start with a letter
  if (/^[0-9]/.test(id)) id = "T_" + id;
  return id || "ENTITY";
}

/**
 * Build a Mermaid erDiagram code block showing fact datasets,
 * dimensions, and the join relationships between them.
 */
function buildMermaidDiagram(models: ModelRecord[], dimensions: DimRecord[]): string {
  const dimByName = new Map<string, DimRecord>();
  for (const d of dimensions) dimByName.set(d.name, d);

  // Collect all unique fact datasets and their join columns across all models
  const factColumns = new Map<string, Set<string>>(); // mermaid-entity-name → join cols
  // Collect all unique dimension entities used in any relationship
  const dimEntities = new Map<string, string>(); // mermaid-entity-name → original dim name
  // Relationship lines (deduped)
  const relLines: string[] = [];
  const seenRels = new Set<string>();

  for (const model of models) {
    for (const rel of model.relationships) {
      const factEnt = mermaidEnt(rel.fromDataset);
      const dimEnt  = mermaidEnt(rel.toDimension);

      if (!factColumns.has(factEnt)) factColumns.set(factEnt, new Set());
      for (const col of rel.fromColumns) factColumns.get(factEnt)!.add(col);

      if (!dimEntities.has(dimEnt)) dimEntities.set(dimEnt, rel.toDimension);

      const label   = (rel.rolePlay ?? rel.fromColumns.join(", ")).replace(/"/g, "'");
      const relKey  = `${factEnt}|${dimEnt}|${label}`;
      if (!seenRels.has(relKey)) {
        seenRels.add(relKey);
        relLines.push(`    ${factEnt} }o--|| ${dimEnt} : "${label}"`);
      }
    }
  }

  if (relLines.length === 0) return "";

  const lines: string[] = ["```mermaid", "erDiagram"];

  // Emit fact entities with their join columns (cap at 10)
  const MAX_COLS = 10;
  for (const [factEnt, cols] of factColumns) {
    const colArr = [...cols];
    lines.push(`    ${factEnt} {`);
    for (const col of colArr.slice(0, MAX_COLS)) {
      const colId = col.toUpperCase().replace(/[^A-Z0-9]/g, "_").replace(/^_+|_+$/g, "") || "COL";
      lines.push(`        string ${colId}`);
    }
    if (colArr.length > MAX_COLS) {
      lines.push(`        string etc "...${colArr.length - MAX_COLS} more"`);
    }
    lines.push("    }");
  }

  // Emit dimension entities with type and level count
  for (const [dimEnt, dimName] of dimEntities) {
    const dim = dimByName.get(dimName);
    lines.push(`    ${dimEnt} {`);
    lines.push(`        string dim_type "${dim?.type ?? "standard"}"`);
    lines.push(`        int level_count "${dim?.levelCount ?? 0}"`);
    lines.push("    }");
  }

  // Emit relationships
  lines.push(...relLines);

  lines.push("```");
  return lines.join("\n");
}

// ============================================================
// README.md generation
// ============================================================

function buildReadme(
  catalogName: string,
  connectionName: string,
  xmlFileName: string | undefined,
  datasets: DatasetRecord[],
  dimensions: DimRecord[],
  metrics: MetricRecord[],
  models: ModelRecord[],
  omissions: OmissionRecord[],
  unboundByCube: CubeBindingRecord[] = [],
): string {
  const date = new Date().toISOString().split("T")[0];
  const measures      = metrics.filter((m) => m.metricType === "measure");
  const calcMeasures  = metrics.filter((m) => m.metricType === "calculated_measure");
  const calcMembers   = metrics.filter((m) => m.metricType === "calculated_member");
  const structural    = omissions.filter((o) => o.category === "Structural");
  const itemLevel     = omissions.filter((o) => o.category !== "Structural");

  const lines: string[] = [];

  // ── Title ──
  lines.push(`# SML Conversion Report: ${catalogName}`, "");
  lines.push(`**Source:** \`${xmlFileName ?? "unknown"}\`  `);
  lines.push(`**Generated:** ${date}  `);
  lines.push(`**Connection:** \`${connectionName}\``, "");

  // ── Schema diagram ──
  const diagram = buildMermaidDiagram(models, dimensions);
  if (diagram) {
    lines.push("## Schema Diagram", "");
    lines.push(diagram, "");
    lines.push("---", "");
  }

  // ── TOC ──
  lines.push("## Table of Contents", "");
  lines.push("- [Summary](#summary)");
  lines.push("- [Successful Conversions](#successful-conversions)");
  lines.push("  - [Catalog and Connection](#catalog-and-connection)");
  lines.push(`  - [Datasets (${datasets.length})](#datasets)`);
  lines.push(`  - [Dimensions (${dimensions.length})](#dimensions)`);
  lines.push(`  - [Metrics and Calculations (${metrics.length})](#metrics-and-calculations)`);
  lines.push(`  - [Models (${models.length})](#models)`);
  if (models.some((m) => m.dimensionDatasets.length > 0)) {
    lines.push("  - [Model Dataset Dependencies](#model-dataset-dependencies)");
  }
  lines.push("- [Omissions and Recommendations](#omissions-and-recommendations)");
  if (unboundByCube.length > 0) lines.push("  - [Unbound Datasets](#unbound-datasets)");
  if (structural.length > 0)    lines.push("  - [Structural Omissions](#structural-omissions)");
  if (itemLevel.length > 0)     lines.push("  - [Item-Level Omissions](#item-level-omissions)");
  lines.push("", "---", "");

  // ── Summary ──
  const unboundCount = datasets.filter((d) => d.isUnbound).length;
  lines.push("## Summary", "");
  lines.push("| Category | Count |");
  lines.push("|----------|-------|");
  lines.push(`| Datasets | ${datasets.length} |`);
  if (unboundCount > 0) lines.push(`| ⚠ Unbound Datasets | ${unboundCount} |`);
  lines.push(`| Dimensions | ${dimensions.length} |`);
  lines.push(`| Measures | ${measures.length} |`);
  lines.push(`| Calculated Measures | ${calcMeasures.length} |`);
  lines.push(`| Calculated Members | ${calcMembers.length} |`);
  lines.push(`| Models | ${models.length} |`);
  const aggregateTotal = models.reduce((sum, m) => sum + m.aggregateCount, 0);
  if (aggregateTotal > 0) lines.push(`| User Defined Aggregates | ${aggregateTotal} |`);
  lines.push(`| Omissions | ${omissions.length} |`);
  lines.push("", "---", "");

  // ── Successful Conversions ──
  lines.push("## Successful Conversions", "");

  // Catalog & Connection
  lines.push("### Catalog and Connection", "");
  lines.push("| File | Object |");
  lines.push("|------|--------|");
  lines.push(`| \`catalog.yml\` | Catalog: **${catalogName}** |`);
  lines.push(`| \`connections/${safeFilename(connectionName)}.yml\` | Connection: **${connectionName}** |`);
  lines.push("");

  // Datasets
  lines.push("### Datasets", "");
  if (datasets.length === 0) {
    lines.push("_No datasets were converted._", "");
  } else {
    lines.push("| Dataset | File | Type | Columns | Notes |");
    lines.push("|---------|------|------|---------|-------|");
    for (const ds of datasets) {
      const noteParts: string[] = [];
      if (ds.isImmutable) noteParts.push("immutable");
      if (ds.isUnbound)   noteParts.push("⚠ no physical binding");
      const cols = ds.columnCount > 0 ? String(ds.columnCount) : "—";
      lines.push(`| ${ds.name} | \`${ds.file}\` | ${ds.type} | ${cols} | ${noteParts.join(", ")} |`);
    }
    lines.push("");
  }

  // Dimensions
  lines.push("### Dimensions", "");
  if (dimensions.length === 0) {
    lines.push("_No dimensions were converted._", "");
  } else {
    lines.push("| Dimension | File | Type | Hierarchies | Levels | Default Member |");
    lines.push("|-----------|------|------|-------------|--------|----------------|");
    for (const dim of dimensions) {
      const dm = dim.hasDefaultMembers ? "yes" : "—";
      lines.push(`| ${dim.name} | \`${dim.file}\` | ${dim.type} | ${dim.hierarchyCount} | ${dim.levelCount} | ${dm} |`);
    }
    lines.push("");
  }

  // Metrics
  lines.push("### Metrics and Calculations", "");
  if (metrics.length === 0) {
    lines.push("_No metrics were converted._", "");
  } else {
    lines.push("| Metric | Label | File | Type | Aggregation | Folder |");
    lines.push("|--------|-------|------|------|-------------|--------|");
    for (const m of metrics) {
      const agg    = m.aggregation ?? "—";
      const folder = m.folder ?? "—";
      const hidden = m.isHidden ? " *(hidden)*" : "";
      lines.push(`| \`${m.name}\` | ${m.label}${hidden} | \`${m.file}\` | ${m.metricType.replace("_", " ")} | ${agg} | ${folder} |`);
    }
    lines.push("");
  }

  // Models
  lines.push("### Models", "");
  if (models.length === 0) {
    lines.push("_No models were converted._", "");
  } else {
    const hasAggregates = models.some((m) => m.aggregateCount > 0);
    const aggHeader = hasAggregates ? " Aggregates |" : "";
    const aggSep = hasAggregates ? "-----------|" : "";
    lines.push(`| Model | File | Relationships | Dimensions | Metrics |${aggHeader} Notes |`);
    lines.push(`|-------|------|---------------|------------|---------|${aggSep}-------|`);
    for (const m of models) {
      const notes: string[] = [];
      if (m.isHidden) notes.push("hidden");
      if (m.hasDefaultDrillthrough) notes.push("drillthrough");
      const aggCell = hasAggregates ? ` ${m.aggregateCount} |` : "";
      lines.push(`| ${m.name} | \`${m.file}\` | ${m.relationshipCount} | ${m.dimensionCount} | ${m.metricCount} |${aggCell} ${notes.join(", ")} |`);
    }
    lines.push("");
  }

  // Model dataset dependencies table
  const modelsWithDimDs = models.filter((m) => m.dimensionDatasets.length > 0);
  if (modelsWithDimDs.length > 0) {
    lines.push("### Model Dataset Dependencies", "");
    lines.push(
      "Each model requires both its directly-bound fact tables (cube `data-set-ref`s) and the " +
      "dimension datasets that back its join dimensions. Both sets of tables must exist in the " +
      "warehouse and be accessible via the connection.", "");
    lines.push("| Model | Fact Tables | Dimension Tables |");
    lines.push("|-------|-------------|------------------|");
    for (const m of modelsWithDimDs) {
      const factStr = m.factDatasets.length > 0 ? m.factDatasets.join(", ") : "—";
      const dimStr  = m.dimensionDatasets.join(", ");
      lines.push(`| **${m.name}** | ${factStr} | ${dimStr} |`);
    }
    lines.push("");
  }

  lines.push("---", "");

  // ── Omissions ──
  lines.push("## Omissions and Recommendations", "");

  if (omissions.length === 0 && unboundByCube.length === 0) {
    lines.push("✅ No omissions detected.", "");
    lines.push("---");
    return lines.join("\n");
  }

  // ── Unbound datasets ──
  if (unboundByCube.length > 0) {
    lines.push("### Unbound Datasets", "");
    lines.push(
      "The following models reference datasets that have no physical table or SQL binding " +
      "in the source XML. Placeholder YAML was emitted but **these models will not execute** " +
      "until every listed dataset is bound to a real database table.", "");
    lines.push("| Model | Currently Bound | Needs Binding |");
    lines.push("|-------|-----------------|---------------|");
    for (const rec of unboundByCube) {
      const bound   = rec.boundDatasets.length  > 0 ? rec.boundDatasets.join(", ")   : "—";
      const unbound = rec.unboundDatasets.join(", ");
      lines.push(`| **${rec.cubeName}** | ${bound} | ${unbound} |`);
    }
    lines.push("");
  }

  if (structural.length > 0) {
    lines.push("### Structural Omissions", "");
    lines.push("The following XML features have no direct SML equivalent and were not converted:", "");
    lines.push("| Feature | Reason | Recommendation |");
    lines.push("|---------|--------|----------------|");
    for (const o of structural) {
      lines.push(`| **${o.item}** | ${o.reason} | ${o.recommendation} |`);
    }
    lines.push("");
  }

  if (itemLevel.length > 0) {
    lines.push("### Item-Level Omissions", "");
    lines.push("| Category | Item | Reason | Recommendation |");
    lines.push("|----------|------|--------|----------------|");
    for (const o of itemLevel) {
      lines.push(`| ${o.category} | \`${o.item}\` | ${o.reason} | ${o.recommendation} |`);
    }
    lines.push("");
  }

  lines.push("---");
  return lines.join("\n");
}
