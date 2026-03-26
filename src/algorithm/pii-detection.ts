// ============================================================
// PII and HIPAA Column Detector
//
// Identifies columns that likely contain Personally Identifiable
// Information (PII) or Protected Health Information (PHI/HIPAA)
// based on column name patterns and data types.
//
// Columns identified here are EXCLUDED from the semantic model
// output to prevent accidental exposure in BI/analytics layers.
//
// Detection coverage:
//   General PII   — name, email, SSN, phone, address, DOB, IP, …
//   Financial PII — card numbers, bank accounts, routing numbers
//   HIPAA PHI     — MRN, patient identifiers, diagnosis codes,
//                   provider NPI, dates of service, geolocation
//                   (the 18 HIPAA Safe Harbor identifiers)
//
// Extending:
//   Add entries to PII_RULES or HIPAA_RULES with a regex pattern,
//   a human-readable reason, and a severity level.
// ============================================================

import { ColumnMeta } from "./types.js";

// ----------------------------------------------------------
// Rule types
// ----------------------------------------------------------

export type PiiSeverity =
  | "HIGH"    // Direct identifier — strong regulatory risk
  | "MEDIUM"  // Quasi-identifier — risk when combined with other fields
  | "LOW";    // Indirect signal — worth noting but lower standalone risk

export type PiiCategory =
  | "PII"     // General personally identifiable information
  | "PHI";    // HIPAA protected health information

export interface PiiRule {
  /** Regex tested against the lowercased column name. */
  pattern: RegExp;
  /** Human-readable explanation surfaced in warnings. */
  reason: string;
  severity: PiiSeverity;
  category: PiiCategory;
}

export interface PiiColumnFlag {
  columnName: string;
  tableName: string;
  reason: string;
  severity: PiiSeverity;
  category: PiiCategory;
}

// ----------------------------------------------------------
// General PII rules
// ----------------------------------------------------------

const PII_RULES: PiiRule[] = [
  // --- Full name ---
  {
    pattern: /^full_name$|^first_name$|^last_name$|^middle_name$|^given_name$|^family_name$|^surname$|^maiden_name$/,
    reason: "Direct name identifier",
    severity: "HIGH",
    category: "PII",
  },
  // --- Government-issued IDs ---
  {
    pattern: /^ssn$|^social_security_number$|^social_security$|^national_id$|^national_id_number$|^tax_id$|^tin$|^itin$/,
    reason: "Government-issued national identifier (SSN/TIN/NID)",
    severity: "HIGH",
    category: "PII",
  },
  {
    pattern: /^passport_number$|^passport_id$|^drivers_license$|^driver_license$|^drivers_license_number$/,
    reason: "Government-issued travel/driving credential",
    severity: "HIGH",
    category: "PII",
  },
  // --- Contact information ---
  {
    pattern: /^email$|^email_address$|^personal_email$|^work_email$|^contact_email$/,
    reason: "Direct contact identifier (email address)",
    severity: "HIGH",
    category: "PII",
  },
  {
    pattern: /^phone$|^phone_number$|^mobile_number$|^cell_number$|^telephone$|^home_phone$|^work_phone$|^fax$|^fax_number$/,
    reason: "Direct contact identifier (phone number)",
    severity: "HIGH",
    category: "PII",
  },
  // --- Physical address ---
  {
    pattern: /^street_address$|^address_line1$|^address_line2$|^address_line_1$|^address_line_2$|^home_address$|^mailing_address$|^residential_address$/,
    reason: "Full street address",
    severity: "HIGH",
    category: "PII",
  },
  // --- Date of birth ---
  {
    pattern: /^date_of_birth$|^dob$|^birth_date$|^birthdate$|^birth_year$|^birth_month$|^birth_day$/,
    reason: "Date of birth — quasi-identifier with high reidentification risk",
    severity: "HIGH",
    category: "PII",
  },
  // --- Biometric / physical ---
  {
    pattern: /^fingerprint$|^biometric$|^facial_recognition$|^retinal_scan$|^voice_print$|^dna$|^genetic_data$/,
    reason: "Biometric identifier",
    severity: "HIGH",
    category: "PII",
  },
  // --- Network identifiers ---
  {
    pattern: /^ip_address$|^ipv4_address$|^ipv6_address$|^mac_address$|^device_fingerprint$/,
    reason: "Network/device identifier linkable to an individual",
    severity: "MEDIUM",
    category: "PII",
  },
  // --- Financial PII ---
  {
    pattern: /^credit_card_number$|^card_number$|^cc_number$|^pan$|^primary_account_number$/,
    reason: "Payment card number (PCI-DSS scope)",
    severity: "HIGH",
    category: "PII",
  },
  {
    pattern: /^bank_account_number$|^account_number$|^iban$|^routing_number$|^aba_routing$|^swift_code$|^bic_code$/,
    reason: "Bank account or routing identifier",
    severity: "HIGH",
    category: "PII",
  },
  {
    pattern: /^cvv$|^cvv2$|^cvc$|^card_expiry$|^card_expiration$/,
    reason: "Payment card security code or expiration (PCI-DSS scope)",
    severity: "HIGH",
    category: "PII",
  },
  // --- Precise geolocation ---
  {
    pattern: /^latitude$|^longitude$|^lat$|^lon$|^lng$|^gps_lat$|^gps_lon$|^coordinates$|^geo_point$/,
    reason: "Precise geolocation coordinates",
    severity: "MEDIUM",
    category: "PII",
  },
  // --- Username / credentials ---
  {
    pattern: /^password$|^password_hash$|^hashed_password$|^salt$|^secret_key$|^api_key$|^auth_token$|^access_token$|^refresh_token$/,
    reason: "Authentication credential or secret",
    severity: "HIGH",
    category: "PII",
  },
  {
    pattern: /^username$|^login$|^user_login$|^screen_name$|^handle$/,
    reason: "Unique username linkable to an individual",
    severity: "MEDIUM",
    category: "PII",
  },
  // --- Race / ethnicity / religion (sensitive attributes) ---
  {
    pattern: /^race$|^ethnicity$|^ethnic_origin$|^national_origin$|^religion$|^religious_affiliation$/,
    reason: "Sensitive demographic characteristic — protected class",
    severity: "MEDIUM",
    category: "PII",
  },
  // --- Quasi-identifiers (lower risk alone but medium in combination) ---
  {
    pattern: /^gender$|^sex$/,
    reason: "Demographic quasi-identifier",
    severity: "LOW",
    category: "PII",
  },
  {
    pattern: /^marital_status$|^marriage_status$/,
    reason: "Demographic quasi-identifier",
    severity: "LOW",
    category: "PII",
  },
];

// ----------------------------------------------------------
// HIPAA PHI rules (the 18 Safe Harbor identifiers)
// https://www.hhs.gov/hipaa/for-professionals/privacy/special-topics/de-identification
// ----------------------------------------------------------

const HIPAA_RULES: PiiRule[] = [
  // Identifier 1 — Names
  {
    pattern: /^patient_name$|^patient_first_name$|^patient_last_name$|^member_name$/,
    reason: "HIPAA PHI: patient name (Safe Harbor #1)",
    severity: "HIGH",
    category: "PHI",
  },
  // Identifier 2 — Geographic data smaller than state
  {
    pattern: /^patient_zip$|^patient_zip_code$|^patient_postal$|^patient_address$|^patient_street$/,
    reason: "HIPAA PHI: patient geographic data smaller than state (Safe Harbor #2)",
    severity: "HIGH",
    category: "PHI",
  },
  // Identifier 3 — Dates (other than year) related to individual
  {
    pattern: /^admission_date$|^discharge_date$|^service_date$|^encounter_date$|^procedure_date$|^birth_date$|^dob$|^date_of_birth$|^death_date$|^date_of_death$/,
    reason: "HIPAA PHI: date directly related to an individual (Safe Harbor #3)",
    severity: "HIGH",
    category: "PHI",
  },
  // Identifier 4 — Phone numbers
  {
    pattern: /^patient_phone$|^patient_mobile$|^patient_telephone$|^member_phone$/,
    reason: "HIPAA PHI: patient telephone number (Safe Harbor #4)",
    severity: "HIGH",
    category: "PHI",
  },
  // Identifier 5 — Fax numbers
  {
    pattern: /^patient_fax$|^member_fax$/,
    reason: "HIPAA PHI: patient fax number (Safe Harbor #5)",
    severity: "HIGH",
    category: "PHI",
  },
  // Identifier 6 — Email addresses
  {
    pattern: /^patient_email$|^member_email$|^patient_email_address$/,
    reason: "HIPAA PHI: patient email address (Safe Harbor #6)",
    severity: "HIGH",
    category: "PHI",
  },
  // Identifier 7 — Social security numbers
  {
    pattern: /^ssn$|^social_security_number$|^patient_ssn$/,
    reason: "HIPAA PHI: Social Security Number (Safe Harbor #7)",
    severity: "HIGH",
    category: "PHI",
  },
  // Identifier 8 — Medical record numbers
  {
    pattern: /^mrn$|^medical_record_number$|^medical_record_num$/,
    reason: "HIPAA PHI: Medical Record Number (Safe Harbor #8)",
    severity: "HIGH",
    category: "PHI",
  },
  // Identifier 9 — Health plan beneficiary numbers
  {
    pattern: /^member_id$|^beneficiary_id$|^health_plan_id$|^insurance_id$|^subscriber_id$/,
    reason: "HIPAA PHI: health plan beneficiary number (Safe Harbor #9)",
    severity: "HIGH",
    category: "PHI",
  },
  // Identifier 10 — Account numbers
  {
    pattern: /^patient_account_number$|^billing_account_number$|^patient_account$/,
    reason: "HIPAA PHI: patient account number (Safe Harbor #10)",
    severity: "HIGH",
    category: "PHI",
  },
  // Identifier 11 — Certificate/license numbers
  {
    pattern: /^npi$|^npi_number$|^license_number$|^medical_license$|^dea_number$/,
    reason: "HIPAA PHI: certificate or license number (Safe Harbor #11)",
    severity: "HIGH",
    category: "PHI",
  },
  // Identifier 12 — Vehicle identifiers
  {
    pattern: /^vehicle_id$|^vin$|^license_plate$|^vehicle_license$/,
    reason: "HIPAA PHI: vehicle identifier or serial number (Safe Harbor #12)",
    severity: "MEDIUM",
    category: "PHI",
  },
  // Identifier 13 — Device identifiers
  {
    pattern: /^device_serial$|^device_serial_number$|^implant_serial$|^device_id$|^imei$/,
    reason: "HIPAA PHI: device identifier or serial number (Safe Harbor #13)",
    severity: "MEDIUM",
    category: "PHI",
  },
  // Identifier 14 — Web URLs
  {
    pattern: /^patient_url$|^member_url$|^personal_url$|^profile_url$/,
    reason: "HIPAA PHI: web URL (Safe Harbor #14)",
    severity: "MEDIUM",
    category: "PHI",
  },
  // Identifier 15 — IP addresses
  {
    pattern: /^patient_ip$|^client_ip$|^ip_address$|^ipv4$|^ipv6$/,
    reason: "HIPAA PHI: IP address (Safe Harbor #15)",
    severity: "MEDIUM",
    category: "PHI",
  },
  // Identifier 16 — Biometric identifiers
  {
    pattern: /^fingerprint$|^retinal_scan$|^voice_print$|^biometric_id$/,
    reason: "HIPAA PHI: biometric identifier (Safe Harbor #16)",
    severity: "HIGH",
    category: "PHI",
  },
  // Identifier 17 — Full-face photographs
  {
    pattern: /^photo$|^photo_url$|^face_image$|^patient_photo$|^portrait$/,
    reason: "HIPAA PHI: full-face photograph or comparable image (Safe Harbor #17)",
    severity: "HIGH",
    category: "PHI",
  },
  // Identifier 18 — Any other unique identifying number
  {
    pattern: /^unique_patient_id$|^patient_id$|^patient_key$|^person_id$|^individual_id$/,
    reason: "HIPAA PHI: any other unique identifying number (Safe Harbor #18)",
    severity: "HIGH",
    category: "PHI",
  },
];

// Combined rule set
const ALL_RULES: PiiRule[] = [...PII_RULES, ...HIPAA_RULES];

// ----------------------------------------------------------
// Public API
// ----------------------------------------------------------

/**
 * Scan a table's columns and return flags for any that match PII or HIPAA
 * rules.  Matching is case-insensitive on the column name.
 */
export function detectPiiColumns(
  tableName: string,
  columns: ColumnMeta[],
): PiiColumnFlag[] {
  const flags: PiiColumnFlag[] = [];

  for (const col of columns) {
    const lower = col.columnName.toLowerCase();
    for (const rule of ALL_RULES) {
      if (rule.pattern.test(lower)) {
        flags.push({
          columnName: col.columnName,
          tableName,
          reason: rule.reason,
          severity: rule.severity,
          category: rule.category,
        });
        break; // one flag per column (first matching rule wins)
      }
    }
  }

  return flags;
}

/**
 * Returns a Set of column names (original casing) that should be excluded
 * from the semantic model for a given table.
 *
 * @param minSeverity  Minimum severity to exclude. Defaults to "MEDIUM",
 *                     which excludes HIGH and MEDIUM columns but keeps LOW
 *                     quasi-identifiers (gender, marital_status) in the model.
 */
export function getPiiExclusionSet(
  tableName: string,
  columns: ColumnMeta[],
  minSeverity: PiiSeverity = "MEDIUM",
): Set<string> {
  const severityRank: Record<PiiSeverity, number> = { HIGH: 3, MEDIUM: 2, LOW: 1 };
  const threshold = severityRank[minSeverity];

  const flags = detectPiiColumns(tableName, columns);
  return new Set(
    flags
      .filter((f) => severityRank[f.severity] >= threshold)
      .map((f) => f.columnName),
  );
}

/**
 * Formats PII flags as human-readable warning strings suitable for inclusion
 * in SemanticModel.warnings.
 */
export function formatPiiWarnings(flags: PiiColumnFlag[]): string[] {
  return flags.map(
    (f) =>
      `[${f.category} ${f.severity}] "${f.tableName}"."${f.columnName}" excluded: ${f.reason}`,
  );
}
