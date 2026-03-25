-- Retail / E-Commerce vertical DDL (3NF)

CREATE TABLE dim_product (
    product_id          BIGINT          PRIMARY KEY,
    sku                 VARCHAR(50),
    sku_code            VARCHAR(50),
    upc_code            VARCHAR(20),
    ean_code            VARCHAR(20),
    style_code          VARCHAR(50),
    item_number         VARCHAR(50),
    product_line        VARCHAR(100),
    sub_category_name   VARCHAR(100),
    category_name       VARCHAR(100),
    department_name     VARCHAR(100),
    vendor_name         VARCHAR(100),
    brand_name          VARCHAR(100)
);

CREATE TABLE dim_store (
    store_id            BIGINT          PRIMARY KEY,
    store_number        VARCHAR(20),
    store_name          VARCHAR(100),
    pos_terminal_id     VARCHAR(50),
    register_id         VARCHAR(20),
    market_name         VARCHAR(100),
    district_name       VARCHAR(100),
    region_name         VARCHAR(100),
    sales_channel       VARCHAR(50),
    channel_type        VARCHAR(50)
);

CREATE TABLE dim_promotion (
    promotion_id        BIGINT          PRIMARY KEY,
    promo_code          VARCHAR(50),
    promotion_code      VARCHAR(50),
    promotion_name      VARCHAR(200),
    offer_code          VARCHAR(50),
    campaign_name       VARCHAR(200)
);

CREATE TABLE dim_customer (
    customer_id         BIGINT          PRIMARY KEY,
    loyalty_id          BIGINT,
    loyalty_number      VARCHAR(50),
    membership_id       VARCHAR(50),
    customer_segment    VARCHAR(100),
    customer_tier       VARCHAR(50),
    lifecycle_stage     VARCHAR(50)
);

CREATE TABLE dim_fiscal_calendar (
    fiscal_calendar_id  BIGINT          PRIMARY KEY,
    fiscal_week         INTEGER,
    fiscal_month        INTEGER,
    fiscal_quarter      VARCHAR(10),
    fiscal_year         INTEGER,
    transaction_date    DATE
);

CREATE TABLE retail_sales_fact (
    record_id               BIGINT          PRIMARY KEY,
    product_id              BIGINT,
    store_id                BIGINT,
    promotion_id            BIGINT,
    customer_id             BIGINT,
    fiscal_calendar_id      BIGINT,
    -- Measures
    net_sales               DECIMAL(14,2),
    gross_sales             DECIMAL(14,2),
    cost_of_goods           DECIMAL(14,2),
    gross_margin            DECIMAL(14,2),
    units_sold              INTEGER,
    units_returned          INTEGER,
    discount_amount         DECIMAL(12,2),
    freight_amount          DECIMAL(12,2),
    basket_size             INTEGER,
    basket_value            DECIMAL(12,2),
    markdown_pct            DECIMAL(8,4),
    markdown_amount         DECIMAL(12,2),
    sell_through_rate       DECIMAL(8,4),
    inventory_turnover      DECIMAL(8,4),
    on_hand_units           INTEGER,
    FOREIGN KEY (product_id)         REFERENCES dim_product(product_id),
    FOREIGN KEY (store_id)           REFERENCES dim_store(store_id),
    FOREIGN KEY (promotion_id)       REFERENCES dim_promotion(promotion_id),
    FOREIGN KEY (customer_id)        REFERENCES dim_customer(customer_id),
    FOREIGN KEY (fiscal_calendar_id) REFERENCES dim_fiscal_calendar(fiscal_calendar_id)
);
