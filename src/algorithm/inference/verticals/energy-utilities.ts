// ============================================================
// Energy / Utilities vertical plugin
//
// Covers: electric, gas, water utilities; wholesale energy markets.
// Key identifiers: meter ID, service point, consumption kWh/MWh,
//   rate class, SAIDI/SAIFI, fuel type, ISO/RTO node.
// Standard hierarchies: grid topology, customer class,
//   energy source, ISO market, interval time.
// ============================================================

import { AbstractVerticalPlugin, HierarchySequence } from "../base-plugin.js";

export class EnergyUtilitiesPlugin extends AbstractVerticalPlugin {
  readonly name = "Energy / Utilities";
  readonly description =
    "Electric, gas, and water utility metering, grid, and wholesale energy schemas.";

  protected readonly signalPatterns: RegExp[] = [
    /^meter_id$|^meter_number$|^smart_meter_id$|^meter_serial_number$/,
    /^service_point_id$|^premise_id$|^utility_account$/,
    /^consumption_kwh$|^consumption_mwh$|^consumption_therms$|^consumption_ccf$/,
    /^demand_kw$|^peak_demand_kw$|^interval_kwh$|^interval_value$/,
    /^rate_class$|^rate_schedule$|^tariff_code$|^rate_code$/,
    /^saidi$|^saifi$|^caidi$|^outage_id$|^outage_count$/,
    /^fuel_type$|^fuel_code$|^energy_source$|^fuel_category$/,
    /^capacity_mw$|^capacity_kva$|^nameplate_capacity$/,
    /^substation_id$|^feeder_id$|^transformer_id$|^circuit_id$/,
    /^iso_id$|^lmp_node_id$|^lmp$|^market_id$/,
    /^balancing_authority$|^transmission_zone$|^load_zone$/,
    /^read_type$|^estimated_flag$|^register_read$/,
  ];

  protected readonly detectionThreshold = 3;

  protected readonly verticalHierarchies: HierarchySequence[] = [
    // Electric grid / network topology
    {
      name: "Grid Topology Hierarchy",
      levelPatterns: [
        /^balancing_authority$|^control_area$/,
        /^transmission_zone$|^transmission_area$/,
        /^substation_id$|^substation_name$|^substation_code$/,
        /^feeder_id$|^feeder_name$|^feeder_code$|^circuit_id$|^circuit_name$/,
        /^transformer_id$|^transformer_name$/,
        /^service_point_id$|^premise_id$/,
        /^meter_id$|^meter_number$|^smart_meter_id$/,
      ],
    },
    // Utility service territory
    {
      name: "Service Territory Hierarchy",
      levelPatterns: [
        /^service_territory$|^utility_territory$/,
        /^division$|^division_name$|^division_code$/,
        /^district$|^district_name$|^district_code$/,
        /^circuit_id$|^circuit_name$/,
        /^premise_id$|^premise_address$|^service_address$/,
      ],
    },
    // Customer / rate class hierarchy
    {
      name: "Customer Class Hierarchy",
      levelPatterns: [
        /^customer_class$|^customer_category$/,
        /^customer_segment$|^customer_type$/,
        /^rate_class$|^rate_schedule$|^rate_code$/,
        /^service_type$|^service_class$/,
      ],
    },
    // Energy source taxonomy (generation side)
    {
      name: "Energy Source Hierarchy",
      levelPatterns: [
        /^fuel_category$|^energy_category$/,
        /^fuel_type$|^fuel_code$|^energy_source$/,
        /^technology_type$|^generation_technology$|^technology$/,
        /^plant_id$|^plant_code$|^plant_name$|^generation_unit$/,
        /^unit_id$|^unit_code$|^unit_name$/,
      ],
    },
    // ISO/RTO wholesale market hierarchy
    {
      name: "ISO Market Hierarchy",
      levelPatterns: [
        /^iso_id$|^iso_name$|^rto_id$|^rto_name$/,
        /^pricing_zone$|^tariff_zone$|^zone_name$/,
        /^load_zone$|^load_area$/,
        /^lmp_node_id$|^node_id$|^bus_id$/,
      ],
    },
    // Interval / AMI time hierarchy
    {
      name: "Interval Time Hierarchy",
      levelPatterns: [
        /^year$/,
        /^month$/,
        /^day$|^read_date$/,
        /^hour$|^hour_ending$/,
        /^interval_id$|^interval_start$|^interval_end$/,
      ],
    },
  ];
}
