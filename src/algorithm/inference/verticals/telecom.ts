// ============================================================
// Telecommunications vertical plugin
//
// Covers: mobile, fixed-line, broadband, and CDR data.
// Key identifiers: MSISDN, IMSI, IMEI, ICCID, cell_id, MCC/MNC.
// Standard hierarchies: network topology, technology generation,
//   subscriber account, geographic coverage.
// ============================================================

import { AbstractVerticalPlugin, HierarchySequence } from "../base-plugin.js";

export class TelecomPlugin extends AbstractVerticalPlugin {
  readonly name = "Telecommunications";
  readonly description =
    "Mobile, fixed-line, CDR, and network infrastructure schemas.";

  protected readonly signalPatterns: RegExp[] = [
    /^msisdn$|^calling_number$|^called_number$/,
    /^imsi$|^imsi_number$/,
    /^imei$|^imei_number$/,
    /^iccid$|^sim_id$|^sim_number$/,
    /^cell_id$|^cell_name$|^bts_id$/,
    /^mcc$|^mnc$|^mcc_mnc$|^plmn$/,
    /^call_duration$|^duration_seconds$|^call_start_time$/,
    /^roaming_flag$|^is_roaming$|^home_network$/,
    /^rate_plan_code$|^rate_plan$/,
    /^arpu$|^mou$|^churn_flag$|^churn_date$/,
    /^enb_id$|^rnc_id$|^bsc_id$|^lac$|^tac$/,
    /^data_usage_mb$|^data_usage_gb$/,
  ];

  protected readonly detectionThreshold = 3;

  protected readonly verticalHierarchies: HierarchySequence[] = [
    // Radio access network topology
    {
      name: "Network Topology Hierarchy",
      levelPatterns: [
        /^region$|^network_region$/,
        /^area$|^area_name$|^area_code$/,
        /^cluster$|^cluster_name$|^cluster_id$/,
        /^site_id$|^site_name$|^cell_site$|^bts_id$/,
        /^sector$|^sector_id$|^sector_name$/,
        /^cell_id$|^cell_name$/,
      ],
    },
    // Technology generation (2G → 3G → 4G → 5G)
    {
      name: "Technology Generation Hierarchy",
      levelPatterns: [
        /^technology_gen$|^network_generation$|^generation$/,
        /^access_type$|^radio_access_type$|^rat$/,
        /^radio_technology$|^radio_access_technology$|^technology$/,
      ],
    },
    // Subscriber / account hierarchy
    {
      name: "Subscriber Account Hierarchy",
      levelPatterns: [
        /^enterprise_account$|^corporate_account$/,
        /^billing_account$|^account_id$|^account_number$/,
        /^subscriber_id$|^msisdn$/,
        /^device_id$|^imei$|^handset_id$/,
      ],
    },
    // Product / plan hierarchy
    {
      name: "Product Plan Hierarchy",
      levelPatterns: [
        /^product_line$|^product_category$/,
        /^bundle_id$|^bundle_name$|^package_id$/,
        /^plan_code$|^rate_plan_code$|^service_plan$/,
        /^add_on_code$|^feature_code$|^add_on_name$/,
      ],
    },
    // Geographic coverage hierarchy
    {
      name: "Coverage Geography Hierarchy",
      levelPatterns: [
        /^country$|^country_code$|^country_name$/,
        /^state$|^province$|^state_code$/,
        /^city$|^city_name$/,
        /^district$|^zone$|^coverage_zone$/,
        /^cell_coverage_area$|^coverage_area$/,
      ],
    },
    // ISO/market hierarchy (for wholesale/roaming)
    {
      name: "Roaming Network Hierarchy",
      levelPatterns: [
        /^iso_id$|^operator_id$|^carrier_id$/,
        /^pricing_zone$|^tariff_zone$/,
        /^load_zone$|^coverage_zone$/,
        /^mcc_mnc$|^plmn$|^visited_network$/,
      ],
    },
  ];
}
