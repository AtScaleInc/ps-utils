// ============================================================
// Human Resources / Workforce vertical plugin
//
// Covers: employee master, payroll, recruiting, and performance.
// Key identifiers: employee_id/emp_id, hire/termination dates,
//   job_code, pay_grade, cost_center, FTE, compa_ratio.
// Standard hierarchies: org chart, job classification,
//   compensation band, recruiting funnel.
// ============================================================

import { AbstractVerticalPlugin, HierarchySequence } from "../base-plugin.js";

export class HumanResourcesPlugin extends AbstractVerticalPlugin {
  readonly name = "Human Resources";
  readonly description =
    "Employee, payroll, recruiting, compensation, and workforce analytics schemas.";

  protected readonly signalPatterns: RegExp[] = [
    /^employee_id$|^emp_id$|^employee_number$|^badge_number$|^worker_id$/,
    /^hire_date$|^rehire_date$|^termination_date$|^last_day_worked$/,
    /^job_code$|^job_title$|^job_family$|^job_function$/,
    /^pay_grade$|^grade_level$|^salary_band$|^band$/,
    /^cost_center$|^cost_center_code$/,
    /^fte$|^fte_value$|^full_time_flag$|^part_time_flag$/,
    /^compa_ratio$|^pay_equity_ratio$/,
    /^requisition_id$|^job_opening_id$|^time_to_fill$|^time_to_hire$/,
    /^headcount$|^turnover_rate$|^attrition_rate$/,
    /^exempt_flag$|^flsa_status$|^union_code$/,
    /^performance_rating$|^engagement_score$|^enps$/,
    /^total_compensation$|^total_cash$|^total_target_comp$|^ttc$/,
  ];

  protected readonly detectionThreshold = 3;

  protected readonly verticalHierarchies: HierarchySequence[] = [
    // Org chart hierarchy (the canonical HR hierarchy)
    {
      name: "Organization Hierarchy",
      levelPatterns: [
        /^company$|^company_code$|^legal_entity_id$|^legal_entity$/,
        /^business_unit_id$|^business_unit$|^bu_code$/,
        /^division_id$|^division_code$|^division_name$|^division$/,
        /^department_id$|^department_code$|^department_name$|^department$/,
        /^team_id$|^team_name$|^team_code$|^team$/,
        /^employee_id$|^emp_id$|^worker_id$/,
      ],
    },
    // Job classification hierarchy
    {
      name: "Job Classification Hierarchy",
      levelPatterns: [
        /^job_family_group$|^job_category_group$/,
        /^job_family$|^job_category$/,
        /^job_function$|^job_subfamily$/,
        /^job_level$|^job_grade$|^level$/,
        /^pay_grade$|^grade_level$|^salary_band$|^band$/,
      ],
    },
    // Compensation band hierarchy
    {
      name: "Compensation Band Hierarchy",
      levelPatterns: [
        /^band_group$|^comp_band_group$/,
        /^band$|^salary_band$|^comp_band$/,
        /^pay_grade$|^grade$|^grade_level$/,
        /^step$|^step_number$|^pay_step$/,
      ],
    },
    // Work location / geography
    {
      name: "Work Location Hierarchy",
      levelPatterns: [
        /^region$|^region_name$|^region_code$/,
        /^country$|^country_code$|^country_name$/,
        /^state$|^state_code$|^province$/,
        /^city$|^city_name$/,
        /^location_id$|^work_location$|^office_id$|^site_id$/,
      ],
    },
    // Recruiting funnel
    {
      name: "Recruiting Funnel Hierarchy",
      levelPatterns: [
        /^requisition_id$|^job_opening_id$/,
        /^application_id$|^candidate_id$/,
        /^source_code$|^source_channel$|^recruitment_source$/,
      ],
    },
  ];
}
