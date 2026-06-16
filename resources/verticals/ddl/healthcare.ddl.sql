-- Healthcare vertical DDL (3NF)

CREATE TABLE dim_facility (
    facility_id         BIGINT          PRIMARY KEY,
    health_system_name  VARCHAR(200),
    hospital_name       VARCHAR(200),
    department_name     VARCHAR(100),
    unit_name           VARCHAR(100),
    room_number         VARCHAR(20),
    bed_id              VARCHAR(20)
);

CREATE TABLE dim_diagnosis (
    diagnosis_id        BIGINT          PRIMARY KEY,
    icd10_code          VARCHAR(20),
    icd9_code           VARCHAR(20),
    diagnosis_code      VARCHAR(20),
    icd_chapter         VARCHAR(100),
    icd_block           VARCHAR(50),
    icd_category        VARCHAR(50),
    drg_code            VARCHAR(20),
    ms_drg              VARCHAR(20),
    apr_drg             VARCHAR(20),
    mdc_code            VARCHAR(10),
    drg_type            VARCHAR(50)
);

CREATE TABLE dim_procedure (
    procedure_id        BIGINT          PRIMARY KEY,
    cpt_code            VARCHAR(20),
    hcpcs_code          VARCHAR(20),
    procedure_code      VARCHAR(20),
    cpt_category        VARCHAR(100),
    cpt_section         VARCHAR(100)
);

CREATE TABLE dim_provider (
    provider_id         BIGINT          PRIMARY KEY,
    npi                 VARCHAR(20),
    npi_number          VARCHAR(20),
    provider_name       VARCHAR(200),
    specialty_name      VARCHAR(100),
    medical_group_name  VARCHAR(200),
    health_system_name  VARCHAR(200)
);

CREATE TABLE dim_payer (
    payer_id            BIGINT          PRIMARY KEY,
    payer_type          VARCHAR(50),
    payer_name          VARCHAR(200),
    plan_name           VARCHAR(200),
    member_id           BIGINT,
    beneficiary_id      BIGINT,
    subscriber_id       BIGINT
);

CREATE TABLE dim_service_date (
    service_date_id     BIGINT          PRIMARY KEY,
    admit_date          DATE,
    discharge_date      DATE,
    service_year        INTEGER,
    service_month       INTEGER,
    service_quarter     VARCHAR(10)
);

CREATE TABLE healthcare_encounter_fact (
    encounter_id            BIGINT          PRIMARY KEY,
    facility_id             BIGINT,
    diagnosis_id            BIGINT,
    procedure_id            BIGINT,
    provider_id             BIGINT,
    payer_id                BIGINT,
    service_date_id         BIGINT,
    mrn                     VARCHAR(50),
    visit_id                BIGINT,
    claim_id                BIGINT,
    admission_type          VARCHAR(50),
    admit_source            VARCHAR(50),
    discharge_disposition   VARCHAR(50),
    -- Measures
    length_of_stay          INTEGER,
    los                     INTEGER,
    total_charges           DECIMAL(14,2),
    total_payments          DECIMAL(14,2),
    allowed_amount          DECIMAL(14,2),
    paid_amount             DECIMAL(14,2),
    denial_amount           DECIMAL(14,2),
    pmpm                    DECIMAL(12,4),
    hcc_score               DECIMAL(10,4),
    risk_score              DECIMAL(10,4),
    readmission_flag        BOOLEAN,
    er_visits_count         INTEGER,
    procedure_count         INTEGER,
    FOREIGN KEY (facility_id)     REFERENCES dim_facility(facility_id),
    FOREIGN KEY (diagnosis_id)    REFERENCES dim_diagnosis(diagnosis_id),
    FOREIGN KEY (procedure_id)    REFERENCES dim_procedure(procedure_id),
    FOREIGN KEY (provider_id)     REFERENCES dim_provider(provider_id),
    FOREIGN KEY (payer_id)        REFERENCES dim_payer(payer_id),
    FOREIGN KEY (service_date_id) REFERENCES dim_service_date(service_date_id)
);
