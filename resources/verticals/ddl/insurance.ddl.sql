-- Insurance vertical DDL (3NF)

CREATE TABLE dim_policy (
    policy_dim_id       BIGINT          PRIMARY KEY,
    policy_number       VARCHAR(50),
    coverage_type       VARCHAR(100),
    coverage_code       VARCHAR(20),
    policy_term         VARCHAR(50),
    policy_duration     INTEGER,
    policy_status       VARCHAR(50),
    naic_code           VARCHAR(20),
    carrier_code        VARCHAR(20),
    carrier_id          BIGINT
);

CREATE TABLE dim_risk (
    risk_id             BIGINT          PRIMARY KEY,
    risk_class          VARCHAR(100),
    risk_tier           VARCHAR(50),
    risk_score          DECIMAL(10,4),
    underwriter_id      BIGINT,
    underwriter_code    VARCHAR(20),
    state_code          VARCHAR(10),
    territory_code      VARCHAR(20),
    zip_code            VARCHAR(10),
    county_name         VARCHAR(100)
);

CREATE TABLE dim_claim (
    claim_dim_id        BIGINT          PRIMARY KEY,
    claim_number        VARCHAR(50),
    claim_type          VARCHAR(100),
    claim_status        VARCHAR(50),
    peril_code          VARCHAR(20),
    cause_of_loss       VARCHAR(200),
    adjuster_id         BIGINT,
    examiner_id         BIGINT,
    claimant_id         BIGINT
);

CREATE TABLE dim_distribution (
    distribution_id     BIGINT          PRIMARY KEY,
    channel_name        VARCHAR(100),
    agency_name         VARCHAR(200),
    agent_id            BIGINT,
    agent_name          VARCHAR(200)
);

CREATE TABLE dim_policy_date (
    policy_date_id      BIGINT          PRIMARY KEY,
    effective_date      DATE,
    expiration_date     DATE,
    loss_date           DATE,
    policy_year         INTEGER,
    policy_month        INTEGER,
    policy_quarter      VARCHAR(10)
);

CREATE TABLE insurance_policy_fact (
    record_id               BIGINT          PRIMARY KEY,
    policy_dim_id           BIGINT,
    risk_id                 BIGINT,
    claim_dim_id            BIGINT,
    distribution_id         BIGINT,
    policy_date_id          BIGINT,
    insured_id              BIGINT,
    -- Measures
    premium_amount          DECIMAL(14,2),
    written_premium         DECIMAL(14,2),
    earned_premium          DECIMAL(14,2),
    deductible_amount       DECIMAL(12,2),
    loss_ratio              DECIMAL(8,4),
    combined_ratio          DECIMAL(8,4),
    expense_ratio           DECIMAL(8,4),
    incurred_loss           DECIMAL(14,2),
    paid_loss               DECIMAL(14,2),
    case_reserve            DECIMAL(14,2),
    ibnr_reserve            DECIMAL(14,2),
    claim_count             INTEGER,
    open_claims_count       INTEGER,
    reinsurance_ceded       DECIMAL(14,2),
    FOREIGN KEY (policy_dim_id)   REFERENCES dim_policy(policy_dim_id),
    FOREIGN KEY (risk_id)         REFERENCES dim_risk(risk_id),
    FOREIGN KEY (claim_dim_id)    REFERENCES dim_claim(claim_dim_id),
    FOREIGN KEY (distribution_id) REFERENCES dim_distribution(distribution_id),
    FOREIGN KEY (policy_date_id)  REFERENCES dim_policy_date(policy_date_id)
);
