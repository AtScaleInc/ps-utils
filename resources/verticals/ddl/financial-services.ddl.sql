-- Financial Services vertical DDL (3NF)

CREATE TABLE dim_security (
    security_id         BIGINT          PRIMARY KEY,
    ticker_symbol       VARCHAR(20),
    ticker_code         VARCHAR(20),
    cusip               VARCHAR(15),
    isin                VARCHAR(15),
    sedol               VARCHAR(10),
    figi                VARCHAR(20),
    bloomberg_id        VARCHAR(20),
    lei_code            VARCHAR(25),
    ric_code            VARCHAR(20),
    asset_class         VARCHAR(100),
    asset_sub_class     VARCHAR(100),
    instrument_type     VARCHAR(100),
    security_type       VARCHAR(100),
    bond_type           VARCHAR(100)
);

CREATE TABLE dim_issuer (
    issuer_id           BIGINT          PRIMARY KEY,
    gics_sector         VARCHAR(100),
    gics_industry_group VARCHAR(100),
    gics_industry       VARCHAR(100),
    gics_sub_industry   VARCHAR(100),
    sic_division        VARCHAR(100),
    sic_major_group     VARCHAR(50),
    sic_industry_group  VARCHAR(50),
    sic_code            VARCHAR(10),
    exchange_code       VARCHAR(20),
    exchange_mic        VARCHAR(10),
    listing_region      VARCHAR(100),
    listing_country     VARCHAR(100),
    market_segment      VARCHAR(100),
    credit_rating       VARCHAR(10),
    rating_agency       VARCHAR(100)
);

CREATE TABLE dim_portfolio (
    portfolio_id        BIGINT          PRIMARY KEY,
    fund_id             BIGINT,
    strategy_id         BIGINT,
    firm_name           VARCHAR(200),
    division_name       VARCHAR(200),
    fund_family         VARCHAR(200),
    fund_name           VARCHAR(200),
    strategy_name       VARCHAR(200),
    sleeve_name         VARCHAR(200)
);

CREATE TABLE dim_price_date (
    price_date_id       BIGINT          PRIMARY KEY,
    price_date          DATE,
    price_year          INTEGER,
    price_month         INTEGER,
    price_quarter       VARCHAR(10)
);

CREATE TABLE financial_securities_fact (
    record_id               BIGINT          PRIMARY KEY,
    security_id             BIGINT,
    issuer_id               BIGINT,
    portfolio_id            BIGINT,
    price_date_id           BIGINT,
    -- Measures
    price_close             DECIMAL(18,6),
    price_open              DECIMAL(18,6),
    price_high              DECIMAL(18,6),
    price_low               DECIMAL(18,6),
    volume                  BIGINT,
    nav                     DECIMAL(18,6),
    aum                     DECIMAL(20,2),
    market_cap              DECIMAL(20,2),
    enterprise_value        DECIMAL(20,2),
    yield_to_maturity       DECIMAL(10,6),
    ytm                     DECIMAL(10,6),
    coupon_rate             DECIMAL(10,6),
    pe_ratio                DECIMAL(14,4),
    pb_ratio                DECIMAL(14,4),
    ps_ratio                DECIMAL(14,4),
    ev_ebitda               DECIMAL(14,4),
    dividend_yield          DECIMAL(10,6),
    sharpe_ratio            DECIMAL(10,6),
    information_ratio       DECIMAL(10,6),
    alpha                   DECIMAL(10,6),
    beta                    DECIMAL(10,6),
    volatility              DECIMAL(10,6),
    tracking_error          DECIMAL(10,6),
    FOREIGN KEY (security_id)   REFERENCES dim_security(security_id),
    FOREIGN KEY (issuer_id)     REFERENCES dim_issuer(issuer_id),
    FOREIGN KEY (portfolio_id)  REFERENCES dim_portfolio(portfolio_id),
    FOREIGN KEY (price_date_id) REFERENCES dim_price_date(price_date_id)
);
