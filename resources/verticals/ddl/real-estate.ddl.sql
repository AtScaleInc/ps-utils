-- Real Estate vertical DDL (3NF)

CREATE TABLE dim_property (
    property_id         BIGINT          PRIMARY KEY,
    parcel_id           VARCHAR(50),
    apn                 VARCHAR(50),
    assessor_parcel_number VARCHAR(50),
    mls_number          VARCHAR(50),
    mls_id              BIGINT,
    folio_number        VARCHAR(50),
    property_type       VARCHAR(100),
    asset_class         VARCHAR(100),
    property_subtype    VARCHAR(100),
    use_type            VARCHAR(100),
    zoning_code         VARCHAR(20),
    land_use_code       VARCHAR(20),
    bedroom             INTEGER,
    bathroom            INTEGER,
    half_bath           INTEGER,
    num_units           INTEGER,
    total_rooms         INTEGER
);

CREATE TABLE dim_location (
    location_id         BIGINT          PRIMARY KEY,
    state_name          VARCHAR(100),
    county_name         VARCHAR(100),
    city_name           VARCHAR(100),
    zip_code            VARCHAR(10),
    neighborhood_name   VARCHAR(100),
    subdivision_name    VARCHAR(100),
    street_name         VARCHAR(200),
    mls_region          VARCHAR(100),
    mls_area            VARCHAR(100),
    market_name         VARCHAR(100),
    sub_market          VARCHAR(100)
);

CREATE TABLE dim_portfolio (
    portfolio_id        BIGINT          PRIMARY KEY,
    fund_name           VARCHAR(200),
    portfolio_name      VARCHAR(200),
    floor_number        VARCHAR(20),
    unit_id             VARCHAR(50),
    tenant_id           BIGINT,
    lease_id            BIGINT,
    brokerage_name      VARCHAR(200),
    listing_agent_id    BIGINT
);

CREATE TABLE dim_transaction_date (
    transaction_date_id BIGINT          PRIMARY KEY,
    close_date          DATE,
    list_date           DATE,
    close_year          INTEGER,
    close_month         INTEGER,
    close_quarter       VARCHAR(10)
);

CREATE TABLE real_estate_transaction_fact (
    record_id               BIGINT          PRIMARY KEY,
    property_id             BIGINT,
    location_id             BIGINT,
    portfolio_id            BIGINT,
    transaction_date_id     BIGINT,
    listing_status          VARCHAR(50),
    mls_status              VARCHAR(50),
    -- Measures
    sale_price              DECIMAL(14,2),
    list_price              DECIMAL(14,2),
    original_list_price     DECIMAL(14,2),
    price_per_sqft          DECIMAL(12,2),
    sale_price_per_sqft     DECIMAL(12,2),
    lot_size_sqft           DECIMAL(14,2),
    lot_size_acres          DECIMAL(12,4),
    building_sqft           DECIMAL(14,2),
    gross_sqft              DECIMAL(14,2),
    cap_rate                DECIMAL(8,4),
    noi                     DECIMAL(14,2),
    net_operating_income    DECIMAL(14,2),
    assessed_value          DECIMAL(14,2),
    appraised_value         DECIMAL(14,2),
    market_value            DECIMAL(14,2),
    days_on_market          INTEGER,
    dom                     INTEGER,
    gross_rent              DECIMAL(14,2),
    operating_expenses      DECIMAL(14,2),
    vacancy_rate            DECIMAL(8,4),
    occupancy_rate          DECIMAL(8,4),
    transactions_count      INTEGER,
    price_reduction_amount  DECIMAL(14,2),
    FOREIGN KEY (property_id)         REFERENCES dim_property(property_id),
    FOREIGN KEY (location_id)         REFERENCES dim_location(location_id),
    FOREIGN KEY (portfolio_id)        REFERENCES dim_portfolio(portfolio_id),
    FOREIGN KEY (transaction_date_id) REFERENCES dim_transaction_date(transaction_date_id)
);
