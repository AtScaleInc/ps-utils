// ============================================================
// Real Estate vertical plugin
//
// Covers: residential listings, commercial properties, REITs,
//   leasing, and property valuation.
// Key identifiers: parcel ID (APN), MLS number, property type,
//   cap rate, NOI, price/sqft.
// Standard hierarchies: geographic/administrative, property
//   type, commercial portfolio, MLS region.
// ============================================================

import { AbstractVerticalPlugin, HierarchySequence } from "../base-plugin.js";

export class RealEstatePlugin extends AbstractVerticalPlugin {
  readonly name = "Real Estate";
  readonly description =
    "Residential listings, commercial properties, leasing, and valuation schemas.";

  protected readonly signalPatterns: RegExp[] = [
    /^parcel_id$|^apn$|^assessor_parcel_number$/,
    /^mls_number$|^mls_id$|^mls_listing_id$/,
    /^days_on_market$|^dom$|^cumulative_dom$|^cdom$/,
    /^price_per_sqft$|^sale_price_per_sqft$|^rent_per_sqft$/,
    /^lot_size_sqft$|^lot_size_acres$|^building_sqft$|^gross_sqft$/,
    /^cap_rate$|^noi$|^net_operating_income$/,
    /^zoning_code$|^zoning_description$|^land_use_code$/,
    /^listing_status$|^mls_status$|^property_type$/,
    /^lease_id$|^tenant_id$|^landlord_id$/,
    /^assessed_value$|^appraised_value$|^market_value$/,
    /^bedroom|^bathroom|^half_bath|^num_units$|^total_rooms$/,
    /^folio_number$|^deed_book$/,
  ];

  protected readonly detectionThreshold = 3;

  protected readonly verticalHierarchies: HierarchySequence[] = [
    // Administrative geography (the primary real-estate hierarchy)
    {
      name: "Property Geography Hierarchy",
      levelPatterns: [
        /^state$|^state_code$|^state_name$/,
        /^county$|^county_code$|^county_name$|^parish$/,
        /^city$|^municipality$|^city_name$/,
        /^zip_code$|^postal_code$|^zip$/,
        /^neighborhood$|^neighborhood_name$|^neighborhood_code$/,
        /^subdivision$|^subdivision_name$/,
        /^street$|^street_name$|^street_address$/,
      ],
    },
    // Property type classification
    {
      name: "Property Type Hierarchy",
      levelPatterns: [
        /^asset_class$|^property_asset_class$/,
        /^property_type$|^property_category$/,
        /^property_subtype$|^property_sub_type$/,
        /^use_type$|^use_code$|^land_use_code$/,
      ],
    },
    // Commercial portfolio hierarchy (REITs, institutional)
    {
      name: "Commercial Portfolio Hierarchy",
      levelPatterns: [
        /^fund$|^fund_name$|^fund_id$/,
        /^portfolio$|^portfolio_name$|^portfolio_id$|^portfolio_code$/,
        /^market$|^market_name$|^primary_market$/,
        /^sub_market$|^submarket$|^sub_market_name$/,
        /^property_id$|^property_name$|^property_code$/,
        /^floor$|^floor_number$|^floor_id$/,
        /^unit$|^unit_number$|^suite$|^unit_id$/,
      ],
    },
    // MLS regional hierarchy
    {
      name: "MLS Region Hierarchy",
      levelPatterns: [
        /^mls_region$|^mls_area_region$/,
        /^mls_area$|^mls_area_code$/,
        /^city$|^city_name$/,
        /^zip_code$|^postal_code$/,
        /^subdivision$|^subdivision_name$/,
      ],
    },
    // Listing agent / brokerage
    {
      name: "Brokerage Hierarchy",
      levelPatterns: [
        /^brokerage_id$|^brokerage_name$|^office_id$|^office_name$/,
        /^listing_agent_id$|^listing_agent$|^agent_id$/,
      ],
    },
  ];
}
