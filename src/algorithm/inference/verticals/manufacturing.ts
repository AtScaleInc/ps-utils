// ============================================================
// Manufacturing / Supply Chain vertical plugin
//
// Covers: production, quality, procurement, and logistics.
// Key identifiers: work order, part number, BOM, lot/batch,
//   plant code, OEE, OTIF.
// Standard hierarchies: facility, product/BOM, supplier,
//   org structure, shift.
// ============================================================

import { AbstractVerticalPlugin, HierarchySequence } from "../base-plugin.js";

export class ManufacturingPlugin extends AbstractVerticalPlugin {
  readonly name = "Manufacturing / Supply Chain";
  readonly description =
    "Production, quality, procurement, and logistics schemas.";

  protected readonly signalPatterns: RegExp[] = [
    /^work_order_id$|^work_order_number$|^shop_order_id$/,
    /^part_number$|^part_id$|^item_number$|^item_code$/,
    /^bom_id$|^bill_of_materials$|^routing_id$/,
    /^batch_number$|^batch_id$|^lot_number$|^lot_id$/,
    /^plant_id$|^plant_code$|^plant_name$/,
    /^machine_id$|^machine_code$|^equipment_id$/,
    /^work_center_id$|^work_center_code$/,
    /^scrap_rate$|^scrap_code$|^defect_code$/,
    /^oee$|^first_pass_yield$|^fpq$/,
    /^purchase_order_id$|^po_number$|^po_line_id$/,
    /^shift_id$|^shift_code$/,
    /^otif$|^on_time_in_full$|^on_time_delivery$/,
  ];

  protected readonly detectionThreshold = 3;

  protected readonly verticalHierarchies: HierarchySequence[] = [
    // Plant / facility hierarchy
    {
      name: "Manufacturing Facility Hierarchy",
      levelPatterns: [
        /^enterprise$|^enterprise_name$/,
        /^region$|^region_code$|^region_name$/,
        /^plant_id$|^plant_code$|^plant_name$|^site_id$|^site_code$/,
        /^building$|^building_id$|^building_code$/,
        /^work_center_id$|^work_center_code$|^work_center_name$/,
        /^machine_id$|^machine_code$|^machine_name$|^equipment_id$/,
      ],
    },
    // Product / BOM hierarchy
    {
      name: "Product BOM Hierarchy",
      levelPatterns: [
        /^product_family$|^product_family_name$/,
        /^product_line$|^product_line_name$|^product_line_code$/,
        /^model$|^model_number$|^model_code$|^model_name$/,
        /^part_number$|^part_id$|^item_number$|^item_code$/,
        /^component_id$|^component_code$|^component_number$/,
      ],
    },
    // Supplier hierarchy
    {
      name: "Supplier Hierarchy",
      levelPatterns: [
        /^supplier_category$|^supplier_type$|^vendor_category$/,
        /^supplier_id$|^supplier_code$|^supplier_name$|^vendor_id$|^vendor_code$/,
        /^supplier_site$|^vendor_site$|^supplier_location$/,
      ],
    },
    // Organizational cost structure
    {
      name: "Organization Cost Hierarchy",
      levelPatterns: [
        /^company$|^company_code$/,
        /^division$|^division_code$|^division_name$/,
        /^plant_id$|^plant_code$/,
        /^department$|^department_code$|^dept$/,
        /^cost_center$|^cost_center_code$/,
      ],
    },
    // Production shift hierarchy
    {
      name: "Production Shift Hierarchy",
      levelPatterns: [
        /^year$/,
        /^quarter$/,
        /^month$/,
        /^week$/,
        /^day$|^production_date$|^work_date$/,
        /^shift_id$|^shift_code$|^shift_name$/,
      ],
    },
    // Quality classification
    {
      name: "Quality Classification Hierarchy",
      levelPatterns: [
        /^defect_category$|^defect_class$/,
        /^defect_code$|^defect_type$|^defect_name$/,
        /^reject_reason$|^scrap_code$|^nonconformance_type$/,
      ],
    },
  ];
}
