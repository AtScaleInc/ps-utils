// ============================================================
// Financial Services / Capital Markets vertical plugin
//
// Covers: equities, fixed income, derivatives, funds, portfolios.
// Key identifiers: ticker, CUSIP, ISIN, SEDOL, FIGI, LEI.
// Standard classification: GICS (11 sectors → 24 industry groups
//   → 69 industries → 158 sub-industries).
// ============================================================

import { JdbcColumnMeta, SemanticMeasure, toTitleCase } from "../../types.js";
import { AbstractVerticalPlugin, HierarchySequence } from "../base-plugin.js";

export class FinancialServicesPlugin extends AbstractVerticalPlugin {
  readonly name = "Financial Services";
  readonly description =
    "Capital markets, securities, portfolios, and fund management schemas.";

  // Strong signals — identifiers essentially unique to financial data
  protected readonly signalPatterns: RegExp[] = [
    /^ticker$|^ticker_symbol$|^ticker_code$/,
    /^cusip$|^cusip_/,
    /^isin$|^isin_/,
    /^sedol$|^sedol_/,
    /^figi$|^bbgid$|^bloomberg_id$/,
    /^lei$|^lei_code$|^legal_entity_identifier$/,
    /^ric$|^ric_code$|^reuters_ric$/,
    /exchange_code|exchange_mic|^mic_code$/,
    /^gics_sector$|^gics_industry|^sic_code$/,
    /^nav$|^nav_date$|^aum$/,
    /^yield_to_maturity$|^ytm$|^coupon_rate$/,
    /^market_cap$|^enterprise_value$/,
    /^portfolio_id$|^fund_id$|^strategy_id$/,
    /^asset_class$|^instrument_type$|^security_type$/,
  ];

  protected readonly detectionThreshold = 3;

  protected readonly verticalHierarchies: HierarchySequence[] = [
    // GICS industry classification (the dominant equity standard)
    {
      name: "GICS Industry Hierarchy",
      levelPatterns: [
        /^gics_sector$/,
        /^gics_industry_group$/,
        /^gics_industry$/,
        /^gics_sub_industry$/,
      ],
    },
    // Exchange → security
    {
      name: "Exchange Listing Hierarchy",
      levelPatterns: [
        /region|geography/,
        /^country$/,
        /exchange_code|exchange_name|primary_exchange|listing_exchange/,
        /market_segment|market_code/,
        /^ticker$|^ticker_symbol$|^ticker_code$/,
      ],
    },
    // Asset class breakdown
    {
      name: "Asset Class Hierarchy",
      levelPatterns: [
        /^asset_class$/,
        /^asset_sub_class$|^asset_subclass$/,
        /^instrument_type$/,
        /^security_type$/,
      ],
    },
    // Portfolio / fund structure
    {
      name: "Portfolio Hierarchy",
      levelPatterns: [
        /^firm$|^firm_name$/,
        /^division$|^division_name$/,
        /^fund_family$|^fund_group$/,
        /^fund_id$|^fund_name$|^fund_code$/,
        /^portfolio_id$|^portfolio_name$|^portfolio_code$/,
        /^strategy_id$|^strategy_name$/,
        /^sleeve_id$|^sleeve_name$/,
      ],
    },
    // SIC classification (legacy but still common)
    {
      name: "SIC Industry Hierarchy",
      levelPatterns: [
        /^sic_division$/,
        /^sic_major_group$/,
        /^sic_industry_group$/,
        /^sic_code$|^sic$/,
      ],
    },
    // Credit rating hierarchy (fixed income)
    {
      name: "Credit Rating Hierarchy",
      levelPatterns: [
        /^rating_agency$/,
        /^credit_rating$|^moody_rating$|^sp_rating$|^fitch_rating$/,
        /^bond_type$|^security_type$/,
      ],
    },
  ];

  // Financial vertical adds ratio/performance measures that generic inference misses
  override inferMeasures(columns: JdbcColumnMeta[]): SemanticMeasure[] {
    const measures: SemanticMeasure[] = [];
    const ratioColumns = [
      "pe_ratio", "pb_ratio", "ps_ratio", "ev_ebitda",
      "dividend_yield", "sharpe_ratio", "information_ratio",
      "tracking_error", "alpha", "beta", "volatility",
    ];

    for (const col of columns) {
      const lower = col.columnName.toLowerCase();
      if (ratioColumns.some((r) => lower.includes(r))) {
        // Ratio columns: AVG, MIN, MAX only (summing is meaningless)
        const base = toTitleCase(col.columnName);
        for (const agg of ["AVG", "MIN", "MAX"] as const) {
          measures.push({
            name: `${agg === "AVG" ? "Average" : agg === "MIN" ? "Minimum" : "Maximum"} ${base}`,
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
