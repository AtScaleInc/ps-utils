// ============================================================
// Education vertical plugin
//
// Covers: higher education, K-12, and EdTech schemas.
// Key identifiers: student_id, course_id, enrollment_id, gpa,
//   academic_year, district_id, campus_id, grade_level.
// ============================================================

import { ColumnMeta, SemanticMeasure, toTitleCase } from "../../types.js";
import { AbstractVerticalPlugin, HierarchySequence } from "../base-plugin.js";

export class EducationPlugin extends AbstractVerticalPlugin {
  readonly name = "Education";
  readonly description = "Higher education, K-12, and EdTech schemas.";

  protected readonly signalPatterns: RegExp[] = [
    /^student_id$/,
    /^course_id$|^course_code$/,
    /^enrollment_id$|^enrollment_date$/,
    /^gpa$|^grade_point_average$/,
    /^academic_year$|^school_year$/,
    /^district_id$|^district_code$/,
    /^campus_id$|^school_id$/,
    /^grade_level$|^grade_band$/,
    /^section_id$|^class_id$/,
    /^instructor_id$|^teacher_id$|^faculty_id$/,
    /^graduation_year$|^cohort_year$/,
    /^attendance_rate$|^attendance_pct$/,
    /^test_score$|^assessment_score$/,
    /^credit_hours$|^credit_units$/,
    /^degree_type$|^credential_type$/,
  ];

  protected readonly detectionThreshold = 3;

  protected readonly verticalHierarchies: HierarchySequence[] = [
    {
      name: "Academic Calendar Hierarchy",
      levelPatterns: [
        /academic_year|school_year/,
        /semester|term|quarter/,
        /^week$|^academic_week$/,
        /^day$|^class_date$/,
      ],
    },
    {
      name: "District Hierarchy",
      levelPatterns: [
        /^district$|^district_name$/,
        /^campus$|^school$|^school_name$/,
        /^grade_level$|^grade_band$/,
        /^section|^class_id$/,
      ],
    },
    {
      name: "Course Taxonomy Hierarchy",
      levelPatterns: [
        /^subject_area$|^subject_code$/,
        /^department$|^dept_code$/,
        /^course$|^course_name$/,
        /^section_id$|^class_id$/,
      ],
    },
    {
      name: "Credential Hierarchy",
      levelPatterns: [
        /^degree_type$|^credential_type$/,
        /^major$|^major_code$/,
        /^minor$|^minor_code$/,
      ],
    },
  ];

  // Rate/score columns: AVG/MIN/MAX only (summing is meaningless).
  // Count/hours columns: SUM/AVG/MIN/MAX.
  override inferMeasures(columns: ColumnMeta[]): SemanticMeasure[] {
    const measures: SemanticMeasure[] = [];

    const ratePatterns =
      /gpa|grade_point|attendance_rate|test_score|assessment_score|pass_rate|completion_rate|graduation_rate/;
    const countPatterns = /credit_hours|enrollment_count|headcount/;

    for (const col of columns) {
      const lower = col.columnName.toLowerCase();

      if (ratePatterns.test(lower)) {
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
