-- Media & Advertising vertical DDL (3NF)

CREATE TABLE dim_campaign (
    campaign_id         BIGINT          PRIMARY KEY,
    campaign_name       VARCHAR(200),
    campaign_type       VARCHAR(50),
    advertiser_name     VARCHAR(200),
    brand_name          VARCHAR(200),
    agency_name         VARCHAR(200),
    insertion_order_id  BIGINT,
    io_number           VARCHAR(50),
    ad_group_id         BIGINT,
    adset_id            BIGINT,
    line_item_id        BIGINT,
    deal_id             VARCHAR(50)
);

CREATE TABLE dim_creative (
    creative_id         BIGINT          PRIMARY KEY,
    creative_name       VARCHAR(200),
    creative_type       VARCHAR(50),
    creative_format     VARCHAR(50),
    ad_format           VARCHAR(50),
    ad_size             VARCHAR(50),
    attribution_model   VARCHAR(100),
    attribution_window  VARCHAR(50)
);

CREATE TABLE dim_placement (
    placement_id        BIGINT          PRIMARY KEY,
    placement_name      VARCHAR(200),
    placement_type      VARCHAR(50),
    site_id             BIGINT,
    publisher_name      VARCHAR(200),
    section_name        VARCHAR(200),
    page_name           VARCHAR(200),
    ad_slot             VARCHAR(100),
    media_type          VARCHAR(50),
    platform_name       VARCHAR(100),
    channel_name        VARCHAR(100)
);

CREATE TABLE dim_audience (
    audience_id         BIGINT          PRIMARY KEY,
    audience_category   VARCHAR(100),
    sub_segment         VARCHAR(100),
    dma_code            VARCHAR(10),
    dma_name            VARCHAR(100),
    country_name        VARCHAR(100),
    state_name          VARCHAR(100),
    city_name           VARCHAR(100),
    zip_code            VARCHAR(10)
);

CREATE TABLE dim_report_date (
    report_date_id      BIGINT          PRIMARY KEY,
    report_date         DATE,
    report_year         INTEGER,
    report_month        INTEGER,
    report_week         INTEGER,
    report_quarter      VARCHAR(10)
);

CREATE TABLE media_ad_performance_fact (
    record_id               BIGINT          PRIMARY KEY,
    campaign_id             BIGINT,
    creative_id             BIGINT,
    placement_id            BIGINT,
    audience_id             BIGINT,
    report_date_id          BIGINT,
    -- Measures
    impressions             BIGINT,
    clicks                  BIGINT,
    ctr                     DECIMAL(10,6),
    cpm                     DECIMAL(12,4),
    cpc                     DECIMAL(12,4),
    cpa                     DECIMAL(12,4),
    roas                    DECIMAL(12,4),
    spend                   DECIMAL(14,2),
    media_cost              DECIMAL(14,2),
    data_cost               DECIMAL(14,2),
    revenue                 DECIMAL(14,2),
    conversions_count       INTEGER,
    conversion_value        DECIMAL(14,2),
    video_views             BIGINT,
    video_completions       BIGINT,
    video_25_pct            BIGINT,
    reach                   BIGINT,
    frequency               DECIMAL(10,4),
    engagement_count        BIGINT,
    FOREIGN KEY (campaign_id)    REFERENCES dim_campaign(campaign_id),
    FOREIGN KEY (creative_id)    REFERENCES dim_creative(creative_id),
    FOREIGN KEY (placement_id)   REFERENCES dim_placement(placement_id),
    FOREIGN KEY (audience_id)    REFERENCES dim_audience(audience_id),
    FOREIGN KEY (report_date_id) REFERENCES dim_report_date(report_date_id)
);
