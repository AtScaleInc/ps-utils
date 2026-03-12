// ============================================================
// Government vertical plugin
//
// Covers: federal, state, and local government budget, grant,
//   and program schemas.
// Key identifiers: fund_code, agency_code, program_code,
//   cfda_number, grant_id, appropriation, object_class,
//   budget_authority, obligation, outlay.
// ============================================================

import { JdbcColumnMeta, SemanticMeasure } from "../../types.js";
import { AbstractVerticalPlugin, HierarchySequence } from "../base-plugin.js";

export class GovernmentPlugin extends AbstractVerticalPlugin {
  readonly name = "Government";
  readonly description =
    "Federal, state, and local government budget, grant, and program schemas.";

  protected readonly signalPatterns: RegExp[] = [
    /^fund_code$|^fund_id$|^fund_number$/,
    /^agency_code$|^agency_id$/,
    /^program_code$|^program_id$/,
    /^cfda_number$|^cfda_code$/,
    /^grant_id$|^grant_number$/,
    /^appropriation$|^appropriation_code$/,
    /^object_class$|^object_class_code$/,
    /^budget_authority$/,
    /^obligation$|^obligation_amount$/,
    /^outlay$|^outlay_amount$/,
    /^function_code$|^budget_function$/,
    /^subfund_code$|^subfund_id$/,
    /^treasury_account$|^tas_code$/,
    /^fiscal_period$|^accounting_period$/,
  ];

  protected readonly detectionThreshold = 3;

  protected readonly verticalHierarchies: HierarchySequence[] = [
    {
      name: "Budget Structure Hierarchy",
      levelPatterns: [
        /^agency$|^agency_name$|^department$/,
        /^bureau$|^bureau_code$/,
        /^program$|^program_name$/,
        /^activity$|^activity_code$|^project_code$/,
      ],
    },
    {
      name: "Fund Type Hierarchy",
      levelPatterns: [
        /^fund_group$|^fund_type_group$/,
        /^fund_type$|^fund_category$/,
        /^fund$|^fund_name$|^fund_code$/,
        /^subfund$|^subfund_code$/,
      ],
    },
    {
      name: "Object Classification Hierarchy",
      levelPatterns: [
        /^object_class_group$|^major_object_class$/,
        /^object_class$|^object_class_code$/,
        /^subobject_class$|^minor_object_class$/,
      ],
    },
    {
      name: "Geographic Hierarchy",
      levelPatterns: [
        /^state$|^state_code$|^state_fips$/,
        /^county$|^county_code$|^county_fips$/,
        /^congressional_district$|^district_code$/,
        /^zip$|^zip_code$/,
      ],
    },
  ];

  // Government plugin uses default measure inference for budget_authority,
  // obligation, outlay, and grant_amount columns.
  override inferMeasures(_columns: JdbcColumnMeta[]): SemanticMeasure[] {
    return [];
  }
}
