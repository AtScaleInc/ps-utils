// ============================================================
// Media / Advertising vertical plugin
//
// Covers: digital advertising, programmatic, social, and
//   media publishing.
// Key identifiers: campaign_id, ad_group_id, creative_id,
//   insertion_order_id, impression/click counts, CPM/CPC/ROAS.
// Standard hierarchies: campaign structure, publisher inventory,
//   media channel, audience segmentation, DMA geography.
// ============================================================

import { AbstractVerticalPlugin, HierarchySequence } from "../base-plugin.js";

export class MediaAdvertisingPlugin extends AbstractVerticalPlugin {
  readonly name = "Media / Advertising";
  readonly description =
    "Digital advertising campaigns, publisher inventory, and media measurement schemas.";

  protected readonly signalPatterns: RegExp[] = [
    /^campaign_id$|^campaign_name$|^campaign_type$/,
    /^ad_group_id$|^adset_id$|^line_item_id$/,
    /^creative_id$|^creative_name$|^creative_type$|^creative_format$/,
    /^placement_id$|^placement_name$|^site_id$/,
    /^insertion_order_id$|^io_number$|^deal_id$/,
    /^impression_count$|^impressions$|^click_count$|^clicks$/,
    /^ctr$|^cpm$|^cpc$|^cpa$|^cpv$|^roas$/,
    /^attribution_model$|^attribution_window$|^touch_type$/,
    /^ad_format$|^ad_size$|^banner_size$/,
    /^dma_code$|^dma_name$|^designated_market_area$/,
    /^video_views$|^video_completions$|^video_25_pct$/,
    /^spend$|^media_cost$|^data_cost$/,
  ];

  protected readonly detectionThreshold = 3;

  protected readonly verticalHierarchies: HierarchySequence[] = [
    // Advertiser → campaign → ad group → creative
    {
      name: "Campaign Hierarchy",
      levelPatterns: [
        /^advertiser_id$|^advertiser_name$|^advertiser$/,
        /^brand_id$|^brand_name$|^brand$/,
        /^campaign_id$|^campaign_name$|^campaign_code$/,
        /^ad_group_id$|^adset_id$|^ad_group_name$|^line_item_id$/,
        /^ad_id$|^creative_id$|^ad_name$|^creative_name$/,
      ],
    },
    // Agency → insertion order → line item → placement
    {
      name: "Media Buy Hierarchy",
      levelPatterns: [
        /^agency_id$|^agency_name$|^agency$/,
        /^advertiser_id$|^advertiser_name$/,
        /^insertion_order_id$|^io_id$|^io_name$|^io_number$/,
        /^line_item_id$|^line_item_name$/,
        /^placement_id$|^placement_name$|^placement_code$/,
      ],
    },
    // Publisher inventory hierarchy
    {
      name: "Publisher Inventory Hierarchy",
      levelPatterns: [
        /^publisher_id$|^publisher_name$|^publisher$/,
        /^site_id$|^site_name$|^site_domain$/,
        /^section_id$|^section_name$|^section_path$/,
        /^page_id$|^page_name$|^page_url$/,
        /^ad_slot_id$|^placement_id$|^ad_unit_id$/,
      ],
    },
    // Media channel / platform hierarchy
    {
      name: "Media Channel Hierarchy",
      levelPatterns: [
        /^media_type$|^channel_type$/,
        /^platform_id$|^platform_name$|^platform$/,
        /^channel$|^channel_name$|^channel_code$/,
        /^placement_type$|^inventory_type$/,
      ],
    },
    // Audience segmentation
    {
      name: "Audience Hierarchy",
      levelPatterns: [
        /^audience_category$|^audience_type$/,
        /^audience_id$|^segment_id$|^audience_name$|^segment_name$/,
        /^sub_segment$|^sub_segment_id$|^audience_sub_segment$/,
      ],
    },
    // Geographic — DMA-centric (US digital advertising standard)
    {
      name: "DMA Geography Hierarchy",
      levelPatterns: [
        /^country$|^country_code$|^country_name$/,
        /^region$|^state$|^state_code$/,
        /^dma_code$|^dma_name$|^designated_market_area$/,
        /^city$|^city_name$|^geo_city$/,
        /^zip$|^zip_code$|^postal_code$/,
      ],
    },
  ];
}
