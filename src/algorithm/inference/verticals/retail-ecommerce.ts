// ============================================================
// Retail / E-Commerce vertical plugin
//
// Covers: brick-and-mortar retail, online retail, omnichannel.
// Key identifiers: SKU, UPC/EAN, store number, promotion codes.
// Standard hierarchies: product taxonomy, store geography,
//   promotional campaign structure, fiscal calendar.
// ============================================================

import { AbstractVerticalPlugin, HierarchySequence } from "../base-plugin.js";

export class RetailEcommercePlugin extends AbstractVerticalPlugin {
  readonly name = "Retail / E-Commerce";
  readonly description =
    "Retail product, store, customer, and promotion schemas.";

  protected readonly signalPatterns: RegExp[] = [
    /^sku$|^sku_code$|^sku_number$/,
    /^upc$|^upc_code$|^ean$|^ean_code$|^barcode$/,
    /^store_id$|^store_number$|^store_code$/,
    /^promo_code$|^promotion_code$|^coupon_code$|^discount_code$/,
    /^basket_size$|^basket_value$/,
    /^loyalty_id$|^loyalty_number$|^membership_id$/,
    /^pos_terminal_id$|^register_id$/,
    /^sell_through_rate$|^inventory_turnover$/,
    /^channel_type$|^sales_channel$|^order_source$/,
    /^fiscal_week$|^fiscal_month$|^fiscal_quarter$|^fiscal_year$/,
    /^style_code$|^item_number$/,
    /^markdown_pct$|^markdown_amount$/,
  ];

  protected readonly detectionThreshold = 3;

  protected readonly verticalHierarchies: HierarchySequence[] = [
    // Product taxonomy (the canonical retail hierarchy)
    {
      name: "Product Taxonomy Hierarchy",
      levelPatterns: [
        /^department$|^dept$|^dept_name$|^department_name$/,
        /^category$|^category_name$|^category_code$/,
        /^sub_category$|^subcategory$|^sub_cat$/,
        /^product_line$|^product_family$/,
        /^sku$|^sku_code$|^sku_number$/,
      ],
    },
    // Store / location hierarchy
    {
      name: "Store Geography Hierarchy",
      levelPatterns: [
        /^region$|^region_name$|^region_code$/,
        /^district$|^district_name$|^district_code$/,
        /^market$|^market_name$/,
        /^store_id$|^store_number$|^store_code$|^store_name$/,
        /^register_id$|^pos_terminal_id$/,
      ],
    },
    // Promotional campaign structure
    {
      name: "Promotion Hierarchy",
      levelPatterns: [
        /^campaign_id$|^campaign_name$|^campaign_code$/,
        /^promotion_id$|^promotion_name$|^promotion_type$/,
        /^offer_id$|^offer_name$|^offer_code$/,
        /^promo_code$|^coupon_code$|^discount_code$/,
      ],
    },
    // Brand / vendor
    {
      name: "Brand Hierarchy",
      levelPatterns: [
        /^vendor_id$|^supplier_id$|^manufacturer_id$/,
        /^brand$|^brand_name$|^brand_code$/,
        /^product_line$|^product_family$/,
      ],
    },
    // Fiscal calendar (4-4-5 / 4-5-4 common in retail)
    {
      name: "Fiscal Calendar Hierarchy",
      levelPatterns: [
        /^fiscal_year$|^fy$/,
        /^fiscal_quarter$|^fq$/,
        /^fiscal_month$|^fm$/,
        /^fiscal_week$|^fw$/,
      ],
    },
    // Customer segmentation
    {
      name: "Customer Segment Hierarchy",
      levelPatterns: [
        /^customer_segment$|^segment$/,
        /^customer_tier$|^tier$|^loyalty_tier$/,
        /^lifecycle_stage$|^customer_lifecycle$/,
      ],
    },
  ];
}
