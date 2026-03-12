// ============================================================
// Pharma vertical plugin
//
// Covers: pharmaceutical, biotech, and life sciences schemas.
// Key identifiers: clinical_trial_id, compound_id, ndc, adverse_event_id,
//   ind_number, cohort_id, molecule_id, therapeutic_area, moa, dosage.
// ============================================================

import { JdbcColumnMeta, SemanticMeasure, toTitleCase } from "../../types.js";
import { AbstractVerticalPlugin, HierarchySequence } from "../base-plugin.js";

export class PharmaPlugin extends AbstractVerticalPlugin {
  readonly name = "Pharma";
  readonly description =
    "Pharmaceutical, biotech, and life sciences schemas.";

  protected readonly signalPatterns: RegExp[] = [
    /^clinical_trial_id$|^study_id$|^protocol_id$/,
    /^compound_id$|^compound_code$|^drug_code$/,
    /^ndc$|^ndc_code$|^national_drug_code$/,
    /^adverse_event_id$|^ae_id$|^ae_code$/,
    /^ind_number$|^nda_number$|^bla_number$/,
    /^cohort_id$|^arm_id$|^treatment_group$/,
    /^molecule_id$|^molecule_code$/,
    /^investigator_id$|^pi_id$|^principal_investigator$/,
    /^lot_number$|^batch_number_pharma$|^manufacture_lot$/,
    /^therapeutic_area$|^ta_code$/,
    /^mechanism_of_action$|^moa$|^moa_code$/,
    /^dosage$|^dose$|^dose_amount$/,
    /^formulation$|^formulation_code$|^dosage_form$/,
    /^regulatory_agency$|^regulatory_pathway$/,
  ];

  protected readonly detectionThreshold = 3;

  protected readonly verticalHierarchies: HierarchySequence[] = [
    {
      name: "Compound Taxonomy Hierarchy",
      levelPatterns: [
        /^therapeutic_area$|^ta_code$/,
        /^drug_class$|^atc_code$/,
        /^mechanism_of_action$|^moa$/,
        /^compound$|^compound_name$|^drug_name$/,
        /^formulation$|^dosage_form$/,
      ],
    },
    {
      name: "Clinical Phase Hierarchy",
      levelPatterns: [
        /^phase$|^trial_phase$|^development_phase$/,
        /^study_type$|^trial_type$/,
        /^trial_status$|^study_status$/,
      ],
    },
    {
      name: "Regulatory Pathway Hierarchy",
      levelPatterns: [
        /^regulatory_agency$|^agency_code$/,
        /^application_type$|^submission_type$/,
        /^approval_status$|^regulatory_status$/,
      ],
    },
    {
      name: "Manufacturing Site Hierarchy",
      levelPatterns: [
        /^manufacturing_site$|^site_code$|^facility_id$/,
        /^manufacturing_line$|^production_line$/,
        /^batch_number$|^lot_number$/,
      ],
    },
  ];

  // Dosage/rate columns: AVG/MIN/MAX only (summing doses or rates is meaningless).
  // Count columns: SUM/AVG/MIN/MAX.
  override inferMeasures(columns: JdbcColumnMeta[]): SemanticMeasure[] {
    const measures: SemanticMeasure[] = [];

    const avgOnlyPatterns =
      /dosage|dose_amount|dose_mg|adverse_event_rate|completion_rate|response_rate/;
    const countPatterns = /enrollment_count|subject_count|patient_count/;

    for (const col of columns) {
      const lower = col.columnName.toLowerCase();

      if (avgOnlyPatterns.test(lower)) {
        const base = toTitleCase(col.columnName);
        for (const agg of ["AVG", "MIN", "MAX"] as const) {
          measures.push({
            name: `${agg === "AVG" ? "Average" : agg === "MIN" ? "Minimum" : "Maximum"} ${base}`,
            sourceColumn: col.columnName,
            dataType: "decimal",
            aggregation: agg,
          });
        }
      } else if (countPatterns.test(lower)) {
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
