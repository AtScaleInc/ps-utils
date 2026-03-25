-- Telecommunications vertical DDL (3NF)

CREATE TABLE dim_network (
    network_id          BIGINT          PRIMARY KEY,
    network_region      VARCHAR(100),
    network_area        VARCHAR(100),
    cluster_name        VARCHAR(100),
    site_id             VARCHAR(50),
    site_name           VARCHAR(100),
    sector_id           VARCHAR(50),
    cell_id             VARCHAR(50),
    cell_name           VARCHAR(100),
    bts_id              VARCHAR(50),
    enb_id              VARCHAR(50),
    rnc_id              VARCHAR(50),
    bsc_id              VARCHAR(50),
    lac                 VARCHAR(20),
    tac                 VARCHAR(20),
    mcc                 VARCHAR(5),
    mnc                 VARCHAR(5),
    mcc_mnc             VARCHAR(10),
    plmn                VARCHAR(10),
    technology_gen      VARCHAR(20),
    access_type         VARCHAR(50),
    radio_technology    VARCHAR(50)
);

CREATE TABLE dim_subscriber (
    subscriber_id       BIGINT          PRIMARY KEY,
    msisdn              VARCHAR(20),
    imsi                VARCHAR(20),
    imei                VARCHAR(20),
    iccid               VARCHAR(25),
    sim_id              VARCHAR(25),
    enterprise_account  VARCHAR(100),
    billing_account     VARCHAR(100),
    device_id           VARCHAR(50),
    rate_plan_code      VARCHAR(50),
    roaming_flag        BOOLEAN,
    is_roaming          BOOLEAN
);

CREATE TABLE dim_product_plan (
    plan_id             BIGINT          PRIMARY KEY,
    product_line        VARCHAR(100),
    bundle_name         VARCHAR(100),
    plan_code           VARCHAR(50),
    add_on_code         VARCHAR(50)
);

CREATE TABLE dim_coverage_geography (
    geography_id        BIGINT          PRIMARY KEY,
    country_code        VARCHAR(10),
    state_name          VARCHAR(100),
    city_name           VARCHAR(100),
    district_name       VARCHAR(100),
    coverage_area       VARCHAR(100)
);

CREATE TABLE dim_event_time (
    event_time_id       BIGINT          PRIMARY KEY,
    event_year          INTEGER,
    event_month         INTEGER,
    event_date          DATE,
    event_hour          INTEGER
);

CREATE TABLE telecom_cdr_fact (
    record_id               BIGINT          PRIMARY KEY,
    network_id              BIGINT,
    subscriber_id           BIGINT,
    plan_id                 BIGINT,
    geography_id            BIGINT,
    event_time_id           BIGINT,
    -- Measures
    call_duration           DECIMAL(12,4),
    duration_seconds        DECIMAL(12,4),
    data_usage_mb           DECIMAL(14,4),
    data_usage_gb           DECIMAL(14,6),
    arpu                    DECIMAL(12,4),
    mou                     DECIMAL(12,4),
    voice_revenue           DECIMAL(12,4),
    data_revenue            DECIMAL(12,4),
    sms_revenue             DECIMAL(12,4),
    total_revenue           DECIMAL(14,4),
    sms_count               INTEGER,
    voice_calls_count       INTEGER,
    dropped_calls           INTEGER,
    failed_calls            INTEGER,
    churn_flag              BOOLEAN,
    FOREIGN KEY (network_id)    REFERENCES dim_network(network_id),
    FOREIGN KEY (subscriber_id) REFERENCES dim_subscriber(subscriber_id),
    FOREIGN KEY (plan_id)       REFERENCES dim_product_plan(plan_id),
    FOREIGN KEY (geography_id)  REFERENCES dim_coverage_geography(geography_id),
    FOREIGN KEY (event_time_id) REFERENCES dim_event_time(event_time_id)
);
