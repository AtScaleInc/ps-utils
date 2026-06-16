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

  // Collect fact dataset names (first data-set-ref per cube) for degenerate dim detection
  const factDatasetNames = new Set<string>();
  for (const cube of cubeEls) {
    outer: for (const dsSec of arr(cube["data-sets"])) {
      for (const dsRef of arr(dsSec["data-set-ref"])) {
        const refId = a(dsRef, "id");
        if (refId) {
          const dsName = datasetIdToName.get(refId);
          if (dsName) factDatasetNames.add(dsName);
        }
        break outer; // only the first data-set-ref is the fact table
      }
    }
  }

  // Cube-level attributes and data-set-refs
  for (const cube of cubeEls) {
    for (const attrsSec of arr(cube.attributes)) {
      ingestKeyedAttrs(attrsSec as Record<string, unknown>);
    }
    for (const dsSec of arr(cube["data-sets"])) {
      for (const dsRef of arr(dsSec["data-set-ref"])) {
        const refId = a(dsRef, "id");
        const dsName = refId ? (datasetIdToName.get(refId) ?? refId) : undefined;
        if (!dsName) continue;
        for (const logSec of arr(dsRef.logical)) {
          ingestLogical(logSec as Record<string, unknown>, dsName);
        }
      }
    }
  }

  // ---------------------------------------------------------------
  // Phase 2: Emit dataset files
  // ---------------------------------------------------------------

  for (const dsSec of arr(schemaEl["data-sets"])) {
    for (const ds of arr(dsSec["data-set"])) {
      const dsName = a(ds, "name");
      if (!dsName) continue;
      const dsYaml = buildDatasetYaml(
        ds as Record<string, unknown>, dsName, connName,
        Boolean(opts.connectionDb || opts.connectionSchema),
      );
      const fname = safeFilename(dsName);
      output.set(`datasets/${fname}.yml`, dsYaml);
      logger.log(`  → datasets/${fname}.yml`);

      // Report tracking
      const physRpt = parseDatasetPhysical(ds as Record<string, unknown>);
      rptDatasets.push({
        name: dsName,
        file: `datasets/${fname}.yml`,
        type: physRpt?.sql ? "sql" : "table",
        columnCount: physRpt?.columns?.length ?? 0,
        isImmutable: physRpt?.immutable ?? false,
        isUnbound: unboundDatasetNames.has(dsName),
      });
    }
  }

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

  // We emit dimension YAMLs after processing cubes (so we know which dims are referenced)
  const referencedDimNames = new Set<string>();

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
    let factDatasetName: string | undefined;
    for (const dsSec of arr(cube["data-sets"])) {
      for (const dsRef of arr(dsSec["data-set-ref"])) {
        const refId = a(dsRef, "id");
        if (refId) {
          factDatasetName = datasetIdToName.get(refId) ?? refId;
          break;
        }
      }
      if (factDatasetName) break;
    }

    // Extract include_default_drillthrough from <actions><properties><include-default-drill-through>
    const actionsEl = first(arr(cube.actions)) as Record<string, unknown> | undefined;
    const actionPropsEl = actionsEl
      ? (first(arr(actionsEl.properties)) as Record<string, unknown> | undefined)
      : undefined;
    const includeDefaultDrillthrough = actionPropsEl
      ? s(first(arr(actionPropsEl["include-default-drill-through"]))) === "true"
      : false;

    const metricNames: Array<{ uniqueName: string; folder?: string }> = [];

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

        if (measureEl || countDistEl) {
          // Regular measure
          const aggText = measureEl
            ? s(first(arr(measureEl["default-aggregation"])))?.toUpperCase()
            : "DISTINCT_COUNT_ESTIMATE";
          const aggregation = mapAggregation(
            aggText ?? (countDistEl ? "COUNT_DISTINCT" : "SUM"),
          );

          // Resolve column: attrMap[attrId] → column
          const colRef = attrMap.get(attrId);
          const column = colRef?.column ?? parseColumnFromAttrName(attrNameRaw);
          if (!column || !factDatasetName) {
            rptOmissions.push({
              category: "Metric",
              item: attrNameRaw,
              reason: !factDatasetName
                ? "No fact dataset could be identified for this cube"
                : "Could not resolve the measure column reference from attribute-ref mapping",
              recommendation: "Add this measure manually to the appropriate metrics/*.yml file after verifying the fact table column name.",
            });
            continue;
          }

          const label = caption ?? toTitleCase(attrNameRaw);
          const uniqueName = safeName(attrNameRaw).toLowerCase();
          const fname = safeFilename(uniqueName);
          output.set(
            `metrics/${fname}.yml`,
            buildMetricYaml(uniqueName, label, aggregation, factDatasetName, column, format, folder, visible, description),
          );
          logger.log(`  → metrics/${fname}.yml`);
          metricNames.push({ uniqueName, folder: folder || undefined });
          rptMetrics.push({ name: uniqueName, label, file: `metrics/${fname}.yml`, metricType: "measure", aggregation, folder: folder || undefined, isHidden: !visible });
        } else if (exprEl) {
          // Inline expression (calculated measure on attribute element)
          const label = caption ?? toTitleCase(attrNameRaw);
          const uniqueName = safeName(attrNameRaw).toLowerCase();
          const fname = safeFilename(uniqueName);
          output.set(
            `metrics/${fname}.yml`,
            buildCalcMetricYaml(uniqueName, label, unescapeHtml(exprEl), format, folder, visible, description),
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
        if (!def.visible) {
          rptOmissions.push({
            category: "Calculated Member",
            item: def.name,
            reason: "Marked as not visible (visible=false) in the source XML — excluded from output",
            recommendation: `If this calculated member is needed, create \`calculations/${safeFilename(safeName(def.name).toLowerCase())}.yml\` manually with \`is_hidden_from_ui: false\`.`,
          });
          continue;
        }
        const label = def.caption ?? def.name;
        const uniqueName = safeName(def.name).toLowerCase();
        const format = resolveFormat(def.formatString, def.namedFormat);
        const fname = safeFilename(uniqueName);
        output.set(
          `calculations/${fname}.yml`,
          buildCalcMemberYaml(uniqueName, label, def.expression, format, def.folder, def.visible, def.description),
        );
        logger.log(`  → calculations/${fname}.yml`);
        metricNames.push({ uniqueName, folder: def.folder || undefined });
        rptMetrics.push({ name: uniqueName, label, file: `calculations/${fname}.yml`, metricType: "calculated_member", folder: def.folder || undefined, isHidden: false });
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
    const relationships = inferRelationships(cube, factDatasetName, keyMap, attrDef, relevantDims);

    // Collect dimension names: inline cube dims + any schema dim referenced via a relationship
    const cubeDimNames: string[] = [...cubeLevelDims.keys()];
    for (const rel of relationships) {
      if (!cubeDimNames.includes(rel.toDimension)) {
        cubeDimNames.push(rel.toDimension);
      }
    }
    // Mark all referenced dims for YAML emission
    for (const n of cubeDimNames) referencedDimNames.add(n);

    // Cube visibility
    const cubeProps = first(arr(cube.properties)) as Record<string, unknown> | undefined;
    const cubeVisible = cubeProps ? s(first(arr(cubeProps.visible))) !== "false" : true;

    // Emit model file
    const modelYaml = buildModelYaml(cubeName, relationships, cubeDimNames, metricNames, !cubeVisible, includeDefaultDrillthrough);
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
    const { yaml: dimYaml, meta: dimMeta } = buildDimensionYaml(dimEl, dimName, attrDef, keyMap, attrMap, factDatasetNames);
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
  // Phase 6: Catalog and connection
  // ---------------------------------------------------------------

  output.set("catalog.yml", buildCatalogYaml(catalogName));
  output.set(
    `connections/${safeFilename(connName)}.yml`,
    buildConnectionYaml(connName, opts.connectionType, opts.connectionDb, opts.connectionSchema),
  );
  logger.log(`  → catalog.yml`);
  logger.log(`  → connections/${safeFilename(connName)}.yml`);

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
  columns?: Array<{ name: string; dataType: string }>;
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
  hasDefaultDrillthrough: boolean;
  isHidden: boolean;
  /** Datasets explicitly bound to this cube as fact tables (cube data-set-refs). */
  factDatasets: string[];
  /** Datasets used by the model's dimensions but not listed as cube fact tables. */
  dimensionDatasets: string[];
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
    case "COUNT_DISTINCT":
    case "DISTINCT_COUNT_ESTIMATE":
    case "DISTINCTCOUNTESTIMATE": return "distinct count estimate";
    default:               return "sum";
  }
}

/** Map XML format-string or named-format → SML format. */
function resolveFormat(formatString?: string, namedFormat?: string): string | undefined {
  if (namedFormat) {
    switch (namedFormat.toLowerCase()) {
      case "percent":  return "percent:1";
      case "standard": return "decimal:2";
      case "currency": return "currency:0";
      default:         return namedFormat.toLowerCase(); // pass through (e.g. "short date")
    }
  }
  if (formatString) {
    switch (formatString) {
      case "#,##0":     return "#,##0";
      case "#,##0.00":  return "#,##0.00";
      case "0%":        return "0%";
      case "#,##0.0%":  return "#,##0.0%";
      case "$#,##0":    return "$#,##0";
      case "#,##0%":    return "#,##0%";
      default:          return formatString;
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

/** Map XML dimension-type/level-type to SML time_unit. */
function mapLevelType(xmlLevelType: string | undefined): string | undefined {
  if (!xmlLevelType) return undefined;
  switch (xmlLevelType) {
    case "TimeYears":   return "year";
    case "TimeMonths":  return "month";
    case "TimeDays":    return "day";
    case "TimeWeeks":   return "week";
    default:            return undefined;
  }
}

// ============================================================
// Dataset physical section parser
// ============================================================

/** Map XML column type strings to SML data_type values. */
function mapDataType(xmlType: string | undefined): string {
  if (!xmlType) return "string";
  switch (xmlType.toLowerCase()) {
    case "string":    return "string";
    case "integer":
    case "int":
    case "long":      return "integer";
    case "float":
    case "double":
    case "decimal":
    case "numeric":   return "decimal";
    case "date":      return "date";
    case "timestamp":
    case "datetime":  return "timestamp";
    case "boolean":
    case "bool":      return "boolean";
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

  // Column definitions from <column><name>...</name><type>...</type></column>
  const columns: Array<{ name: string; dataType: string }> = [];
  for (const col of arr(physSec.column)) {
    const colName = s(first(arr((col as Record<string, unknown>).name)));
    const colType = s(first(arr((col as Record<string, unknown>).type)));
    if (colName) columns.push({ name: colName, dataType: mapDataType(colType) });
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
  connName: string,
  /** When true, db/schema live in the connection file — use a plain table name string. */
  connectionHasDbSchema: boolean,
): string {
  const phys = parseDatasetPhysical(dsEl) ?? {};

  const obj: Record<string, unknown> = {
    unique_name: `${dsName}.dataset`,
    object_type: "dataset",
    label: dsName,          // preserve original casing; do not title-case
    connection_id: connName,
  };

  if (phys.immutable) obj.immutable = true;

  if (phys.sql) {
    obj.sql = phys.sql;
  } else if (connectionHasDbSchema || (!phys.db && !phys.schema)) {
    // db/schema are in the connection file (or absent): use a simple table name string
    obj.table = phys.tableName ?? dsName;
  } else {
    // db/schema are dataset-specific: use structured table object
    obj.table = {
      ...(phys.db ? { db: phys.db } : {}),
      ...(phys.schema ? { schema: phys.schema } : {}),
      name: phys.tableName ?? dsName,
    };
  }

  if (phys.columns?.length) {
    obj.columns = phys.columns.map((c) => ({ name: c.name, data_type: c.dataType }));
  }

  return toYaml(obj);
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
}

function buildDimensionYaml(
  dimEl: Record<string, unknown>,
  dimName: string,
  attrDef: Map<string, AttrDefEntry>,
  keyMap: Map<string, KeyRefEntry[]>,
  attrMap: Map<string, AttrRefEntry>,
  factDatasetNames: Set<string>,
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
      let nameColumn = keyColumns[0];
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
            uniqueName: kaDef.name,
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
      const timeUnit = mapLevelType(levelTypeRaw);

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

  // Detect degenerate: all resolved level attributes reference a fact-table dataset
  const isDegenerate =
    levelAttrMap.size > 0 &&
    Array.from(levelAttrMap.values()).every((la) =>
      factDatasetNames.has(la.dataset.replace(/\.dataset$/, "")),
    );

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
        if (l.isHidden) lObj.is_hidden_from_ui = true;
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
      if (la.isHiddenFromUi) laObj.is_hidden_from_ui = true;
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
  if (!visible) obj.is_hidden_from_ui = true;
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
  if (!visible) obj.is_hidden_from_ui = true;
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
  if (!visible) obj.is_hidden_from_ui = true;
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

/**
 * Scan all levels of all hierarchies in a dimension to find one whose key-ref UUID
 * appears in cubeKeyCols (the set of key UUIDs referenced by the cube).
 * Returns { keyUuid, toLevel } for the first matching level, or undefined if none match.
 * This handles both degenerate dims (complete=true in cube) and cross-table dims
 * (complete=false in cube + complete=true in dim dataset), as well as multi-level
 * hierarchies where only the leaf level has a FK in the fact table.
 */
function findCubeMatchingLevel(
  dimEl: Record<string, unknown>,
  attrDef: Map<string, AttrDefEntry>,
  cubeKeyCols: Map<string, string[]>,
): { keyUuid: string; toLevel: string } | undefined {
  for (const hierEl of arr(dimEl.hierarchy)) {
    for (const levelEl of arr(hierEl.level)) {
      const pa = a(levelEl, "primary-attribute");
      if (!pa) continue;
      const def = attrDef.get(pa);
      if (!def?.keyUuid) continue;
      if (cubeKeyCols.has(def.keyUuid)) {
        return { keyUuid: def.keyUuid, toLevel: def.name };
      }
    }
  }
  return undefined;
}

function inferRelationships(
  cubeEl: Record<string, unknown>,
  factDatasetName: string | undefined,
  keyMap: Map<string, KeyRefEntry[]>,
  attrDef: Map<string, AttrDefEntry>,
  relevantDims: Map<string, Record<string, unknown>>,
): RelationshipDef[] {
  if (!factDatasetName) return [];

  // Build the set of key-ref UUIDs that appear in this cube's data-set-ref logical sections,
  // mapped to the fact-table columns that hold that key.
  // We prefer complete="false" entries (explicit FK) but also accept complete="true" (degenerate).
  const cubeKeyCols = new Map<string, string[]>(); // keyUuid → fact columns
  const cubeKeyRolePlays = new Map<string, string>(); // keyUuid → role_play name
  for (const dsSec of arr(cubeEl["data-sets"])) {
    for (const dsRef of arr(dsSec["data-set-ref"])) {
      for (const logSec of arr(dsRef.logical)) {
        for (const kr of arr(logSec["key-ref"])) {
          const id = a(kr, "id");
          if (!id) continue;
          const cols = extractColumns(arr(kr.column));
          if (cols.length === 0) continue;
          // Store once; prefer complete=false (explicit FK) over complete=true (degenerate)
          const complete = a(kr, "complete") ?? "true";
          if (!cubeKeyCols.has(id) || complete === "false") {
            cubeKeyCols.set(id, cols);
            // Extract role_play from <ref-path><new-ref><ref-naming>
            const refPathEl = first(arr(kr["ref-path"])) as Record<string, unknown> | undefined;
            if (refPathEl) {
              const newRefEl = first(arr(refPathEl["new-ref"])) as Record<string, unknown> | undefined;
              if (newRefEl) {
                const refNaming = s(first(arr(newRefEl["ref-naming"])));
                if (refNaming) cubeKeyRolePlays.set(id, refNaming);
              }
            }
          }
        }
      }
    }
  }

  const relationships: RelationshipDef[] = [];
  const seen = new Set<string>();

  for (const [dimName, dimEl] of relevantDims) {
    // Find the first level of this dimension whose key UUID appears in the cube's key-refs.
    // For multi-level hierarchies (e.g. date dims) the cube FK is typically on the leaf level;
    // for degenerate dims it is usually the sole level.
    const match = findCubeMatchingLevel(dimEl, attrDef, cubeKeyCols);
    if (!match) continue; // Dimension not used by this cube

    const { keyUuid, toLevel } = match;
    const fromColumns = cubeKeyCols.get(keyUuid)!;

    const relKey = `${dimName}|${fromColumns.join(",")}`;
    if (seen.has(relKey)) continue;
    seen.add(relKey);

    const relUniqueName = `${safeName(factDatasetName)}_to_${safeName(dimName)}_${safeName(fromColumns.join("_"))}`;

    // Dimension dataset: the complete=true side of the key-ref (the lookup table)
    const dimDataset = keyMap.get(keyUuid)?.find((e) => e.complete === "true")?.datasetName;

    relationships.push({
      uniqueName: relUniqueName,
      fromDataset: factDatasetName,
      fromColumns,
      toDimension: dimName,
      toLevel,
      rolePlay: cubeKeyRolePlays.get(keyUuid),
      dimensionDataset: dimDataset,
    });
  }

  return relationships;
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

function buildConnectionYaml(connName: string, connType?: string, db?: string, schema?: string): string {
  const obj: Record<string, unknown> = {
    unique_name: connName,
    object_type: "connection",
    label: connName,
    as_connection: connName,
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
  isHidden = false,
  includeDefaultDrillthrough = false,
): string {
  const obj: Record<string, unknown> = {
    unique_name: modelName,
    object_type: "model",
    label: modelName,
  };

  if (isHidden) obj.is_hidden_from_ui = true;
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
    obj.dimensions = dimNames.map((n) => ({ unique_name: n }));
  }

  if (metricNames.length > 0) {
    obj.metrics = metricNames.map((m) => {
      const mObj: Record<string, unknown> = { unique_name: m.uniqueName };
      if (m.folder) mObj.folder = m.folder;
      return mObj;
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
    lines.push("| Model | File | Relationships | Dimensions | Metrics | Notes |");
    lines.push("|-------|------|---------------|------------|---------|-------|");
    for (const m of models) {
      const notes: string[] = [];
      if (m.isHidden) notes.push("hidden");
      if (m.hasDefaultDrillthrough) notes.push("drillthrough");
      lines.push(`| ${m.name} | \`${m.file}\` | ${m.relationshipCount} | ${m.dimensionCount} | ${m.metricCount} | ${notes.join(", ")} |`);
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
