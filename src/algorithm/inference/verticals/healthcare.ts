// ============================================================
// Healthcare / Life Sciences vertical plugin
//
// Covers: clinical, claims, pharmacy, and provider data.
// Key identifiers: MRN, NPI, ICD-10, CPT, NDC, DRG.
// Standard hierarchies: facility, ICD clinical classification,
//   drug taxonomy, provider specialty, payer.
// ============================================================

import { AbstractVerticalPlugin, HierarchySequence } from "../base-plugin.js";

export class HealthcarePlugin extends AbstractVerticalPlugin {
  readonly name = "Healthcare";
  readonly description =
    "Clinical encounters, claims, pharmacy, and provider schemas.";

  protected readonly signalPatterns: RegExp[] = [
    /^mrn$|^medical_record_number$/,
    /^npi$|^npi_number$|^npi_code$/,
    /^icd_code$|^icd10_code$|^icd9_code$|^icd10$|^icd9$/,
    /^cpt_code$|^cpt4_code$|^hcpcs_code$/,
    /^ndc$|^ndc_code$|^ndc_number$/,
    /^drg_code$|^ms_drg$|^apr_drg$/,
    /^diagnosis_code$|^procedure_code$/,
    /^encounter_id$|^visit_id$|^claim_id$/,
    /^length_of_stay$|^los$|^admit_source$/,
    /^member_id$|^beneficiary_id$|^subscriber_id$/,
    /^pmpm$|^hcc_score$|^risk_score$/,
    /^discharge_disposition$|^admission_type$/,
  ];

  protected readonly detectionThreshold = 3;

  protected readonly verticalHierarchies: HierarchySequence[] = [
    // Facility / care setting hierarchy
    {
      name: "Care Facility Hierarchy",
      levelPatterns: [
        /^health_system$|^health_system_name$/,
        /^hospital_id$|^hospital_name$|^facility_id$|^facility_name$/,
        /^department$|^department_name$|^dept_name$/,
        /^unit_id$|^unit_name$|^nursing_unit$/,
        /^room$|^room_number$|^room_id$/,
        /^bed$|^bed_number$|^bed_id$/,
      ],
    },
    // ICD-10 clinical classification
    {
      name: "ICD Diagnosis Hierarchy",
      levelPatterns: [
        /^icd_chapter$|^icd10_chapter$/,
        /^icd_block$|^icd10_block$|^icd_category_block$/,
        /^icd_category$|^icd10_category$|^diagnosis_category$/,
        /^icd_code$|^icd10_code$|^diagnosis_code$/,
      ],
    },
    // CPT procedure classification
    {
      name: "CPT Procedure Hierarchy",
      levelPatterns: [
        /^cpt_category$|^procedure_category$/,
        /^cpt_section$|^procedure_section$/,
        /^cpt_code$|^cpt4_code$|^procedure_code$/,
      ],
    },
    // Drug taxonomy
    {
      name: "Drug Taxonomy Hierarchy",
      levelPatterns: [
        /^drug_class$|^drug_category$/,
        /^therapeutic_class$|^therapeutic_category$|^pharmacological_class$/,
        /^generic_name$|^drug_name$/,
        /^brand_name$|^trade_name$/,
        /^ndc$|^ndc_code$/,
      ],
    },
    // Provider specialty
    {
      name: "Provider Hierarchy",
      levelPatterns: [
        /^health_system$|^health_system_name$/,
        /^medical_group$|^medical_group_name$|^practice_group$/,
        /^specialty_code$|^specialty_name$|^provider_specialty$/,
        /^provider_id$|^physician_id$|^npi$/,
      ],
    },
    // MDC → DRG (inpatient classification)
    {
      name: "DRG Hierarchy",
      levelPatterns: [
        /^mdc$|^major_diagnostic_category$/,
        /^drg_type$|^drg_category$/,
        /^drg_code$|^ms_drg$|^apr_drg$/,
      ],
    },
    // Payer / insurance hierarchy
    {
      name: "Payer Hierarchy",
      levelPatterns: [
        /^payer_type$|^insurance_type$|^coverage_type$/,
        /^payer_id$|^payer_name$|^insurance_company$/,
        /^plan_id$|^plan_name$|^benefit_plan$/,
        /^member_id$|^subscriber_id$|^beneficiary_id$/,
      ],
    },
  ];
}
