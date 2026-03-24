-- Human Resources vertical DDL (3NF)

CREATE TABLE dim_employee (
    employee_id         BIGINT          PRIMARY KEY,
    emp_id              BIGINT,
    badge_number        VARCHAR(50),
    hire_date           DATE,
    termination_date    DATE,
    last_day_worked     DATE,
    flsa_status         VARCHAR(20),
    union_code          VARCHAR(20),
    fte                 DECIMAL(5,2),
    fte_value           DECIMAL(5,2)
);

CREATE TABLE dim_organization (
    organization_id     BIGINT          PRIMARY KEY,
    company_name        VARCHAR(200),
    business_unit       VARCHAR(200),
    division_name       VARCHAR(200),
    department_name     VARCHAR(200),
    team_name           VARCHAR(100),
    cost_center         VARCHAR(50),
    cost_center_code    VARCHAR(20)
);

CREATE TABLE dim_job (
    job_id              BIGINT          PRIMARY KEY,
    job_code            VARCHAR(20),
    job_title           VARCHAR(200),
    job_family          VARCHAR(100),
    job_function        VARCHAR(100),
    job_family_group    VARCHAR(100),
    job_level           VARCHAR(50),
    pay_grade           VARCHAR(20),
    salary_band         VARCHAR(50),
    band_group          VARCHAR(50),
    band_name           VARCHAR(50),
    band_step           VARCHAR(20)
);

CREATE TABLE dim_location (
    location_id         BIGINT          PRIMARY KEY,
    work_region         VARCHAR(100),
    work_country        VARCHAR(100),
    work_state          VARCHAR(100),
    work_city           VARCHAR(100),
    location_name       VARCHAR(200)
);

CREATE TABLE dim_snapshot_date (
    snapshot_date_id    BIGINT          PRIMARY KEY,
    snapshot_date       DATE,
    snapshot_year       INTEGER,
    snapshot_month      INTEGER,
    snapshot_quarter    VARCHAR(10)
);

CREATE TABLE hr_workforce_fact (
    record_id               BIGINT          PRIMARY KEY,
    employee_id             BIGINT,
    organization_id         BIGINT,
    job_id                  BIGINT,
    location_id             BIGINT,
    snapshot_date_id        BIGINT,
    requisition_id          BIGINT,
    -- Measures
    base_salary             DECIMAL(14,2),
    bonus_amount            DECIMAL(14,2),
    equity_value            DECIMAL(14,2),
    benefits_cost           DECIMAL(14,2),
    total_compensation      DECIMAL(14,2),
    total_cash              DECIMAL(14,2),
    total_target_comp       DECIMAL(14,2),
    compa_ratio             DECIMAL(8,4),
    pay_equity_ratio        DECIMAL(8,4),
    headcount               INTEGER,
    turnover_rate           DECIMAL(8,4),
    attrition_rate          DECIMAL(8,4),
    performance_rating      DECIMAL(5,2),
    engagement_score        DECIMAL(5,2),
    overtime_hours          DECIMAL(10,2),
    training_hours          DECIMAL(10,2),
    time_to_fill            INTEGER,
    time_to_hire            INTEGER,
    new_hires_count         INTEGER,
    terminations_count      INTEGER,
    promotions_count        INTEGER,
    FOREIGN KEY (employee_id)     REFERENCES dim_employee(employee_id),
    FOREIGN KEY (organization_id) REFERENCES dim_organization(organization_id),
    FOREIGN KEY (job_id)          REFERENCES dim_job(job_id),
    FOREIGN KEY (location_id)     REFERENCES dim_location(location_id),
    FOREIGN KEY (snapshot_date_id) REFERENCES dim_snapshot_date(snapshot_date_id)
);
