// ============================================================
// Logistics vertical plugin
//
// Covers: supply chain, freight, warehousing, and distribution schemas.
// Key identifiers: shipment_id, tracking_number, carrier_code,
//   bol_number, container_id, freight_class, route_id, warehouse_id.
// ============================================================

import { JdbcColumnMeta, SemanticMeasure, toTitleCase } from "../../types.js";
import { AbstractVerticalPlugin, HierarchySequence } from "../base-plugin.js";

export class LogisticsPlugin extends AbstractVerticalPlugin {
  readonly name = "Logistics";
  readonly description =
    "Supply chain, freight, warehousing, and distribution schemas.";

  protected readonly signalPatterns: RegExp[] = [
    /^shipment_id$|^shipment_number$/,
    /^tracking_number$|^tracking_id$/,
    /^carrier_code$|^carrier_id$|^scac_code$/,
    /^bol_number$|^bill_of_lading$/,
    /^container_id$|^container_number$/,
    /^freight_class$|^nmfc_code$/,
    /^origin_zip$|^origin_port$|^origin_location$/,
    /^dest_zip$|^destination_port$|^destination_location$/,
    /^transit_days$|^transit_time$/,
    /^route_id$|^lane_code$|^lane_id$/,
    /^warehouse_id$|^dc_id$|^fulfillment_center_id$/,
    /^dock_id$|^dock_door$/,
    /^load_id$|^load_number$/,
    /^on_time_delivery$|^otd_flag$/,
  ];

  protected readonly detectionThreshold = 3;

  protected readonly verticalHierarchies: HierarchySequence[] = [
    {
      name: "Origin Geography Hierarchy",
      levelPatterns: [
        /origin_country|ship_from_country/,
        /origin_state|ship_from_state/,
        /origin_city|ship_from_city/,
        /origin_zip|ship_from_zip/,
      ],
    },
    {
      name: "Destination Geography Hierarchy",
      levelPatterns: [
        /dest_country|ship_to_country/,
        /dest_state|ship_to_state/,
        /dest_city|ship_to_city/,
        /dest_zip|ship_to_zip/,
      ],
    },
    {
      name: "Carrier Network Hierarchy",
      levelPatterns: [
        /^mode$|^transport_mode$|^shipment_mode$/,
        /^carrier$|^carrier_name$|^carrier_code$/,
        /^service_level$|^service_type$/,
        /^route_id$|^lane_code$/,
      ],
    },
    {
      name: "Warehouse Hierarchy",
      levelPatterns: [
        /^region$|^dc_region$/,
        /^warehouse$|^warehouse_name$|^dc_name$/,
        /^zone$|^pick_zone$/,
        /^aisle$|^bin$|^location_code$/,
      ],
    },
  ];

  // Transit days: AVG/MIN/MAX only (summing transit days is meaningless).
  // Rate columns: AVG/MIN/MAX only.
  // Freight cost / weight / unit count columns: SUM/AVG/MIN/MAX.
  override inferMeasures(columns: JdbcColumnMeta[]): SemanticMeasure[] {
    const measures: SemanticMeasure[] = [];

    const avgOnlyPatterns =
      /transit_days|on_time_delivery_rate|fill_rate|otd_rate/;
    const sumPatterns = /freight_cost|freight_amount|weight|pieces|units/;

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
      } else if (sumPatterns.test(lower)) {
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
