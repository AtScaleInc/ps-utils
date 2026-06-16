-- Pharma vertical DDL (3NF)

CREATE TABLE dim_compound (
    compound_id         BIGINT          PRIMARY KEY,
    compound_code       VARCHAR(50),
    compound_name       VARCHAR(200),
    molecule_id         BIGINT,
    molecule_code       VARCHAR(50),
    ndc_code            VARCHAR(20),
    therapeutic_area    VARCHAR(100),
    ta_code             VARCHAR(20),
    mechanism_of_action VARCHAR(200),
    moa                 VARCHAR(200),
    moa_code            VARCHAR(50),
    drug_class          VARCHAR(100),
    atc_code            VARCHAR(20),
    formulation_code    VARCHAR(50),
    dosage_form         VARCHAR(100),
    formulation_name    VARCHAR(200)
);

CREATE TABLE dim_trial (
    trial_id            BIGINT          PRIMARY KEY,
    clinical_trial_id   BIGINT,
    study_id            BIGINT,
    protocol_id         VARCHAR(50),
    ind_number          VARCHAR(50),
    nda_number          VARCHAR(50),
    phase_name          VARCHAR(50),
    study_type          VARCHAR(100),
    trial_status        VARCHAR(50),
    cohort_id           BIGINT,
    arm_id              BIGINT,
    treatment_group     VARCHAR(100)
);

CREATE TABLE dim_investigator (
    investigator_id     BIGINT          PRIMARY KEY,
    pi_id               BIGINT,
    principal_investigator VARCHAR(200),
    manufacturing_site  VARCHAR(200),
    manufacturing_line  VARCHAR(100)
);

CREATE TABLE dim_regulatory (
    regulatory_id       BIGINT          PRIMARY KEY,
    regulatory_agency   VARCHAR(100),
    regulatory_pathway  VARCHAR(100),
    application_type    VARCHAR(50),
    approval_status     VARCHAR(50)
);

CREATE TABLE dim_study_date (
    study_date_id       BIGINT          PRIMARY KEY,
    study_start_date    DATE,
    data_cutoff_date    DATE,
    study_year          INTEGER,
    study_month         INTEGER,
    study_quarter       VARCHAR(10)
);

CREATE TABLE pharma_clinical_fact (
    record_id               BIGINT          PRIMARY KEY,
    compound_id             BIGINT,
    trial_id                BIGINT,
    investigator_id         BIGINT,
    regulatory_id           BIGINT,
    study_date_id           BIGINT,
    adverse_event_id        BIGINT,
    ae_code                 VARCHAR(20),
    lot_number              VARCHAR(50),
    batch_number_pharma     VARCHAR(50),
    -- Measures
    dosage                  DECIMAL(12,4),
    dose_amount             DECIMAL(12,4),
    dose_mg                 DECIMAL(12,4),
    enrollment_count        INTEGER,
    subject_count           INTEGER,
    patient_count           INTEGER,
    adverse_event_rate      DECIMAL(8,4),
    completion_rate         DECIMAL(8,4),
    response_rate           DECIMAL(8,4),
    drop_out_count          INTEGER,
    serious_ae_count        INTEGER,
    protocol_deviation_count INTEGER,
    FOREIGN KEY (compound_id)     REFERENCES dim_compound(compound_id),
    FOREIGN KEY (trial_id)        REFERENCES dim_trial(trial_id),
    FOREIGN KEY (investigator_id) REFERENCES dim_investigator(investigator_id),
    FOREIGN KEY (regulatory_id)   REFERENCES dim_regulatory(regulatory_id),
    FOREIGN KEY (study_date_id)   REFERENCES dim_study_date(study_date_id)
);
