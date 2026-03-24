-- Government vertical DDL (3NF)

CREATE TABLE dim_agency (
    agency_id           BIGINT          PRIMARY KEY,
    agency_code         VARCHAR(20)     NOT NULL,
    agency_name         VARCHAR(100),
    bureau_code         VARCHAR(20),
    bureau_name         VARCHAR(100)
);

CREATE TABLE dim_program (
    program_id          BIGINT          PRIMARY KEY,
    program_code        VARCHAR(20)     NOT NULL,
    program_name        VARCHAR(200),
    activity_code       VARCHAR(20),
    activity_name       VARCHAR(200),
    project_code        VARCHAR(20),
    cfda_number         VARCHAR(20),
    budget_function     VARCHAR(50)
);

CREATE TABLE dim_fund (
    fund_id             BIGINT          PRIMARY KEY,
    fund_code           VARCHAR(20)     NOT NULL,
    fund_name           VARCHAR(100),
    fund_group          VARCHAR(50),
    fund_type           VARCHAR(50),
    subfund_code        VARCHAR(20),
    subfund_id          BIGINT,
    tas_code            VARCHAR(30),
    appropriation_code  VARCHAR(20)
);

CREATE TABLE dim_object_class (
    object_class_id     BIGINT          PRIMARY KEY,
    object_class_code   VARCHAR(20)     NOT NULL,
    object_class_name   VARCHAR(100),
    major_object_class  VARCHAR(50),
    minor_object_class  VARCHAR(50)
);

CREATE TABLE dim_geography (
    geography_id        BIGINT          PRIMARY KEY,
    state_code          VARCHAR(10),
    state_name          VARCHAR(100),
    county_name         VARCHAR(100),
    congressional_district VARCHAR(10),
    zip_code            VARCHAR(10)
);

CREATE TABLE dim_fiscal_calendar (
    fiscal_calendar_id  BIGINT          PRIMARY KEY,
    fiscal_year         INTEGER,
    fiscal_quarter      VARCHAR(10),
    fiscal_month        INTEGER,
    fiscal_week         INTEGER,
    fiscal_period       VARCHAR(20),
    accounting_period   VARCHAR(20),
    budget_date         DATE
);

CREATE TABLE government_budget_fact (
    record_id               BIGINT          PRIMARY KEY,
    agency_id               BIGINT,
    program_id              BIGINT,
    fund_id                 BIGINT,
    object_class_id         BIGINT,
    geography_id            BIGINT,
    fiscal_calendar_id      BIGINT,
    grant_id                BIGINT,
    -- Measures
    budget_authority        DECIMAL(18,2),
    obligation_amount       DECIMAL(18,2),
    outlay_amount           DECIMAL(18,2),
    enacted_amount          DECIMAL(18,2),
    apportioned_amount      DECIMAL(18,2),
    allotted_amount         DECIMAL(18,2),
    expenditure_amount      DECIMAL(18,2),
    unobligated_balance     DECIMAL(18,2),
    num_awards              INTEGER,
    num_transactions        INTEGER,
    FOREIGN KEY (agency_id)          REFERENCES dim_agency(agency_id),
    FOREIGN KEY (program_id)         REFERENCES dim_program(program_id),
    FOREIGN KEY (fund_id)            REFERENCES dim_fund(fund_id),
    FOREIGN KEY (object_class_id)    REFERENCES dim_object_class(object_class_id),
    FOREIGN KEY (geography_id)       REFERENCES dim_geography(geography_id),
    FOREIGN KEY (fiscal_calendar_id) REFERENCES dim_fiscal_calendar(fiscal_calendar_id)
);
