/**
 * Authoritative operation groupings.
 *
 * This is the single machine-readable source of truth for how operations are grouped.
 * It is consumed by:
 *   - `printUsage()` in `src/cli-runner.ts` (the CLI help listing)
 *   - `src/scripts/generate-extension-manifest.ts` (the VS Code extension manifest)
 *
 * The group names and membership must stay in sync with the README `### <Group Name>`
 * section diagrams and the `action.yml` composite-action steps (see CLAUDE.md
 * "Operation groupings — keep all three in sync"). When adding, moving, or renaming an
 * operation, update this array first, then mirror the change in README and action.yml.
 */

/** A named group of operations, in display order. */
export interface OperationGroup {
  name: string;
  operations: string[];
}

/**
 * Operation groups, in the order they should appear in help output and menus.
 * Any registered operation not listed here is surfaced under a synthetic "Other"
 * group by consumers that choose to display uncategorized operations.
 */
export const OPERATION_GROUPS: OperationGroup[] = [
  {
    name: "Visualization and Namespace Processing",
    operations: [
      "generate-metrics-from-model",
      "generate-namespace-from-model",
      "extract-model-from-atscale",
      "extract-model-from-sml",
    ],
  },
  {
    name: "SML Creation and Manipulation",
    operations: [
      "execute-sql-on-connection",
      "extract-ddl-from-connection",
      "generate-sml-from-connection",
      "generate-sml-from-ddl",
      "generate-sml-from-xml",
      "apply-style-to-sml",
      "generate-sml-docs",
      "generate-shared-model-plan",
      "apply-shared-model-plan-option",
      "generate-ddl-from-atscale",
    ],
  },
  {
    name: "Synthetic Data Generation",
    operations: [
      "extract-data-shape-from-connection",
      "generate-ddl-from-data-shape",
      "generate-data-from-data-shape",
      "generate-data-from-data-shape-to-connection",
    ],
  },
  {
    name: "BI Tool Integration",
    operations: [
      "generate-tableau-from-namespace",
      "generate-excel-from-namespace",
      "generate-powerbi-from-namespace",
    ],
  },
  {
    name: "Testing / Query Processing",
    operations: [
      "generate-queries-from-sml",
      "generate-queries-from-model",
      "extract-query-stats-from-atscale",
      "extract-queries-from-atscale",
      "execute-atscale-query-harness",
      "execute-query-on-connection",
      "generate-enhanced-query-results",
      "execute-run-analysis",
    ],
  },
  {
    name: "AtScale Config",
    operations: [
      "generate-atscale-install-yaml",
      "atscale-list-data-sources",
      "atscale-create-data-source",
      "atscale-list-repos",
      "atscale-create-repo",
      "atscale-list-deployments",
      "atscale-deploy-catalog",
      "atscale-list-model-errors",
    ],
  },
  {
    name: "Web Services",
    operations: ["execute-web-services"],
  },
  {
    name: "Utilities",
    operations: ["version"],
  },
];
