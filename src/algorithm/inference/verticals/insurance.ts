// ============================================================
// Insurance vertical plugin
//
// Covers: property & casualty, life, and health insurance schemas.
// Key identifiers: policy_number, claim_id, premium, deductible,
//   loss_ratio, naic_code, coverage_type, underwriter_id.
// ============================================================

import { JdbcColumnMeta, SemanticMeasure, toTitleCase } from "../../types.js";
import { AbstractVerticalPlugin, HierarchySequence } from "../base-plugin.js";

export class InsurancePlugin extends AbstractVerticalPlugin {
  readonly name = "Insurance";
  readonly description =
    "Property & casualty, life, and health insurance schemas.";

  protected readonly signalPatterns: RegExp[] = [
    /^policy_number$|^policy_id$/,
    /^claim_id$|^claim_number$/,
    /^premium$|^premium_amount$|^written_premium$/,
    /^deductible$|^deductible_amount$/,
    /^loss_ratio$|^combined_ratio$|^expense_ratio$/,
    /^underwriter_id$|^underwriter_code$/,
    /^risk_score$|^risk_tier$/,
    /^naic_code$|^naic_group$/,
    /^coverage_type$|^coverage_code$/,
    /^policy_term$|^policy_duration$/,
    /^claimant_id$|^insured_id$/,
    /^adjuster_id$|^examiner_id$/,
    /^carrier_code$|^carrier_id$|^insurer_id$/,
    /^peril_code$|^cause_of_loss$/,
  ];

  protected readonly detectionThreshold = 3;

  protected readonly verticalHierarchies: HierarchySequence[] = [
    {
      name: "Policy Lifecycle Hierarchy",
      levelPatterns: [
        /coverage_type|coverage_code/,
        /^policy_status$|^policy_phase$/,
        /^policy_term$|^policy_duration$/,
      ],
    },
    {
      name: "Risk Classification Hierarchy",
      levelPatterns: [
        /^risk_class$|^risk_group$/,
        /^risk_tier$|^risk_category$/,
        /^risk_score$|^risk_band$/,
      ],
    },
    {
      name: "Claim Type Hierarchy",
      levelPatterns: [
        /^claim_type$|^loss_type$/,
        /^peril_code$|^cause_of_loss$/,
        /^claim_status$|^claim_phase$/,
      ],
    },
    {
      name: "Distribution Channel Hierarchy",
      levelPatterns: [
        /^channel$|^distribution_channel$/,
        /^agency$|^agency_code$/,
        /^agent_id$|^producer_id$/,
      ],
    },
  ];

  // Ratio columns: AVG/MIN/MAX only (summing ratios is meaningless).
  // Monetary amount columns: SUM/AVG/MIN/MAX.
  override inferMeasures(columns: JdbcColumnMeta[]): SemanticMeasure[] {
    const measures: SemanticMeasure[] = [];

    const ratioPatterns = /loss_ratio|combined_ratio|expense_ratio/;
    const amountPatterns =
      /premium|deductible|claim_amount|paid_loss|incurred_loss/;

    for (const col of columns) {
      const lower = col.columnName.toLowerCase();

      if (ratioPatterns.test(lower)) {
        const base = toTitleCase(col.columnName);
        for (const agg of ["AVG", "MIN", "MAX"] as const) {
          measures.push({
            name: `${agg === "AVG" ? "Average" : agg === "MIN" ? "Minimum" : "Maximum"} ${base}`,
            sourceColumn: col.columnName,
            dataType: "decimal",
            aggregation: agg,
          });
        }
      } else if (amountPatterns.test(lower)) {
        const base = toTitleCase(col.columnName);
        for (const agg of ["SUM", "AVG", "MIN", "MAX"] as const) {
          measures.push({
            name: `${agg === "SUM" ? "Total" : agg === "AVG" ? "Average" : agg === "MIN" ? "Minimum" : "Maximum"} ${base}`,
            sourceColumn: col.columnName,
            dataType: "decimal",
            aggregation: agg,
          });
        }
      }
    }

    return measures;
  }
}
