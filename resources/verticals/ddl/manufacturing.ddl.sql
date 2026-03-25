-- Manufacturing / Supply Chain vertical DDL (3NF)

CREATE TABLE dim_facility (
    facility_id         BIGINT          PRIMARY KEY,
    enterprise_name     VARCHAR(100),
    region_name         VARCHAR(100),
    plant_id            BIGINT,
    plant_code          VARCHAR(20),
    plant_name          VARCHAR(200),
    building_name       VARCHAR(100),
    work_center_id      BIGINT,
    work_center_code    VARCHAR(20),
    work_center_name    VARCHAR(100),
    machine_id          BIGINT,
    machine_code        VARCHAR(50),
    machine_name        VARCHAR(100)
);

CREATE TABLE dim_product (
    product_id          BIGINT          PRIMARY KEY,
    part_number         VARCHAR(50),
    part_id             BIGINT,
    item_number         VARCHAR(50),
    bom_id              BIGINT,
    component_name      VARCHAR(100),
    model_name          VARCHAR(100),
    product_line        VARCHAR(100),
    product_family      VARCHAR(100)
);

CREATE TABLE dim_supplier (
    supplier_id         BIGINT          PRIMARY KEY,
    supplier_category   VARCHAR(100),
    supplier_name       VARCHAR(200),
    supplier_site       VARCHAR(200),
    purchase_order_id   BIGINT,
    po_number           VARCHAR(50)
);

CREATE TABLE dim_cost_center (
    cost_center_id      BIGINT          PRIMARY KEY,
    company_name        VARCHAR(100),
    division_name       VARCHAR(100),
    department_name     VARCHAR(100),
    cost_center         VARCHAR(50)
);

CREATE TABLE dim_quality (
    quality_id          BIGINT          PRIMARY KEY,
    defect_category     VARCHAR(100),
    defect_code         VARCHAR(20),
    defect_name         VARCHAR(200),
    reject_reason       VARCHAR(200),
    scrap_code          VARCHAR(20)
);

CREATE TABLE dim_production_calendar (
    production_calendar_id BIGINT       PRIMARY KEY,
    production_year     INTEGER,
    production_quarter  VARCHAR(10),
    production_month    INTEGER,
    production_week     INTEGER,
    production_date     DATE,
    shift_id            VARCHAR(20),
    shift_code          VARCHAR(20),
    shift_name          VARCHAR(50)
);

CREATE TABLE manufacturing_production_fact (
    record_id               BIGINT          PRIMARY KEY,
    facility_id             BIGINT,
    product_id              BIGINT,
    supplier_id             BIGINT,
    cost_center_id          BIGINT,
    quality_id              BIGINT,
    production_calendar_id  BIGINT,
    work_order_id           BIGINT,
    batch_number            VARCHAR(50),
    lot_number              VARCHAR(50),
    -- Measures
    planned_qty             DECIMAL(14,4),
    actual_qty              DECIMAL(14,4),
    scrap_qty               DECIMAL(14,4),
    rework_qty              DECIMAL(14,4),
    oee                     DECIMAL(8,4),
    first_pass_yield        DECIMAL(8,4),
    scrap_rate              DECIMAL(8,4),
    otif                    DECIMAL(8,4),
    on_time_delivery        DECIMAL(8,4),
    downtime_minutes        DECIMAL(12,2),
    cycle_time_seconds      DECIMAL(12,4),
    material_cost           DECIMAL(14,2),
    labor_cost              DECIMAL(14,2),
    overhead_cost           DECIMAL(14,2),
    total_cost              DECIMAL(14,2),
    FOREIGN KEY (facility_id)            REFERENCES dim_facility(facility_id),
    FOREIGN KEY (product_id)             REFERENCES dim_product(product_id),
    FOREIGN KEY (supplier_id)            REFERENCES dim_supplier(supplier_id),
    FOREIGN KEY (cost_center_id)         REFERENCES dim_cost_center(cost_center_id),
    FOREIGN KEY (quality_id)             REFERENCES dim_quality(quality_id),
    FOREIGN KEY (production_calendar_id) REFERENCES dim_production_calendar(production_calendar_id)
);
