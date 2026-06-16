// ============================================================
// Travel / Hospitality vertical plugin
//
// Covers: hotel, airline, car rental, and loyalty programs.
// Key identifiers: reservation/confirmation number, check-in/
//   check-out dates, room type, rate code, loyalty tier,
//   ADR, RevPAR, PNR, fare class, load factor.
// Standard hierarchies: hotel portfolio, property → room,
//   airline network, loyalty tier, revenue management.
// ============================================================

import { AbstractVerticalPlugin, HierarchySequence } from "../base-plugin.js";

export class TravelHospitalityPlugin extends AbstractVerticalPlugin {
  readonly name = "Travel / Hospitality";
  readonly description =
    "Hotel reservations, airline bookings, loyalty programs, and revenue management schemas.";

  protected readonly signalPatterns: RegExp[] = [
    /^reservation_id$|^booking_id$|^confirmation_number$|^conf_number$/,
    /^check_in_date$|^arrival_date$|^check_out_date$|^departure_date$/,
    /^room_type$|^room_type_code$|^room_category$|^room_class$/,
    /^rate_code$|^rate_plan_code$|^daily_rate$|^room_rate$/,
    /^loyalty_id$|^loyalty_number$|^loyalty_tier$|^loyalty_status$/,
    /^adr$|^average_daily_rate$/,
    /^revpar$|^revenue_per_available_room$/,
    /^occupancy_rate$|^occ_pct$/,
    /^los$|^length_of_stay$|^num_nights$|^room_nights$/,
    /^pnr$|^fare_class$|^booking_class$|^cabin_class$/,
    /^load_factor$|^passenger_load_factor$|^plf$/,
    /^no_show_rate$|^cancellation_rate$/,
  ];

  protected readonly detectionThreshold = 3;

  protected readonly verticalHierarchies: HierarchySequence[] = [
    // Hotel brand / portfolio hierarchy
    {
      name: "Hotel Portfolio Hierarchy",
      levelPatterns: [
        /^brand_family$|^hotel_family$/,
        /^chain_id$|^chain_code$|^chain_name$|^chain$/,
        /^brand_id$|^brand_code$|^brand_name$|^brand$/,
        /^region$|^region_name$|^region_code$/,
        /^property_id$|^hotel_id$|^property_code$|^hotel_code$/,
        /^room_type_code$|^room_category$|^room_class$/,
        /^room_id$|^room_number$/,
      ],
    },
    // Revenue management hierarchy (property → rate)
    {
      name: "Revenue Management Hierarchy",
      levelPatterns: [
        /^property_id$|^hotel_id$|^property_code$/,
        /^room_category$|^room_class$/,
        /^room_type$|^room_type_code$/,
        /^rate_plan_code$|^rate_plan$|^rate_category$/,
        /^rate_code$|^rate_name$/,
      ],
    },
    // Hotel geography hierarchy
    {
      name: "Hotel Geography Hierarchy",
      levelPatterns: [
        /^region$|^region_name$|^geo_region$/,
        /^country$|^country_code$|^country_name$/,
        /^state$|^state_code$|^province$/,
        /^market$|^city$|^market_name$|^city_name$/,
        /^sub_market$|^submarket$/,
        /^property_id$|^hotel_id$/,
      ],
    },
    // Loyalty program hierarchy
    {
      name: "Loyalty Program Hierarchy",
      levelPatterns: [
        /^loyalty_program$|^program_id$|^program_name$/,
        /^loyalty_tier$|^loyalty_status$|^tier_name$|^membership_tier$/,
        /^loyalty_id$|^loyalty_number$|^member_id$/,
      ],
    },
    // Airline network hierarchy
    {
      name: "Airline Network Hierarchy",
      levelPatterns: [
        /^alliance$|^airline_alliance$/,
        /^carrier_code$|^iata_code$|^icao_code$|^carrier_id$/,
        /^hub$|^hub_airport$|^home_base$/,
        /^route_code$|^route_id$|^origin_destination$/,
        /^flight_number$|^flight_id$/,
        /^cabin_class$|^class_of_service$/,
        /^fare_class$|^booking_class$|^rbd$/,
      ],
    },
    // Booking lead-time segmentation
    {
      name: "Booking Lead Time Hierarchy",
      levelPatterns: [
        /^booking_window$|^lead_time_band$|^booking_lead_band$/,
        /^booking_date$|^created_date$/,
        /^arrival_date$|^check_in_date$/,
      ],
    },
  ];
}
