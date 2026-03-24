-- Energy & Utilities vertical DDL (3NF)

CREATE TABLE dim_meter (
    meter_id            BIGINT          PRIMARY KEY,
    meter_number        VARCHAR(50),
    smart_meter_id      VARCHAR(50),
    meter_serial_number VARCHAR(50),
    service_point_id    VARCHAR(50),
    premise_id          BIGINT,
    utility_account     VARCHAR(50),
    read_type           VARCHAR(20),
    estimated_flag      BOOLEAN
);

CREATE TABLE dim_rate (
    rate_id             BIGINT          PRIMARY KEY,
    rate_class          VARCHAR(50),
    rate_schedule       VARCHAR(50),
    tariff_code         VARCHAR(20),
    service_type        VARCHAR(50),
    customer_class      VARCHAR(50),
    customer_segment    VARCHAR(50)
);

CREATE TABLE dim_grid (
    grid_id             BIGINT          PRIMARY KEY,
    balancing_authority VARCHAR(100),
    transmission_zone   VARCHAR(100),
    load_zone           VARCHAR(100),
    iso_id              VARCHAR(20),
    pricing_zone        VARCHAR(100),
    substation_id       VARCHAR(50),
    feeder_id           VARCHAR(50),
    transformer_id      VARCHAR(50),
    circuit_id          VARCHAR(50),
    lmp_node_id         VARCHAR(50),
    service_territory   VARCHAR(100),
    division_name       VARCHAR(100),
    district_name       VARCHAR(100)
);

CREATE TABLE dim_energy_source (
    energy_source_id    BIGINT          PRIMARY KEY,
    fuel_category       VARCHAR(50),
    fuel_type           VARCHAR(50),
    fuel_code           VARCHAR(20),
    energy_source       VARCHAR(50),
    technology_type     VARCHAR(50),
    plant_name          VARCHAR(100),
    unit_id             VARCHAR(50),
    capacity_mw         DECIMAL(18,4),
    capacity_kva        DECIMAL(18,4)
);

CREATE TABLE dim_interval_time (
    interval_time_id    BIGINT          PRIMARY KEY,
    interval_year       INTEGER,
    interval_month      INTEGER,
    interval_day        INTEGER,
    interval_hour       INTEGER,
    interval_start      TIMESTAMP,
    interval_end        TIMESTAMP
);

CREATE TABLE energy_interval_fact (
    record_id               BIGINT          PRIMARY KEY,
    meter_id                BIGINT,
    rate_id                 BIGINT,
    grid_id                 BIGINT,
    energy_source_id        BIGINT,
    interval_time_id        BIGINT,
    -- Measures
    consumption_kwh         DECIMAL(18,4),
    consumption_mwh         DECIMAL(18,4),
    demand_kw               DECIMAL(18,4),
    peak_demand_kw          DECIMAL(18,4),
    interval_kwh            DECIMAL(18,6),
    saidi                   DECIMAL(12,4),
    saifi                   DECIMAL(12,4),
    caidi                   DECIMAL(12,4),
    outage_count            INTEGER,
    lmp                     DECIMAL(12,6),
    net_generation_mwh      DECIMAL(18,4),
    fuel_consumed_mmbtu     DECIMAL(18,4),
    heat_rate               DECIMAL(12,4),
    revenue_amount          DECIMAL(18,2),
    cost_per_kwh            DECIMAL(10,6),
    restoration_time_min    DECIMAL(10,2),
    customers_affected      INTEGER,
    FOREIGN KEY (meter_id)          REFERENCES dim_meter(meter_id),
    FOREIGN KEY (rate_id)           REFERENCES dim_rate(rate_id),
    FOREIGN KEY (grid_id)           REFERENCES dim_grid(grid_id),
    FOREIGN KEY (energy_source_id)  REFERENCES dim_energy_source(energy_source_id),
    FOREIGN KEY (interval_time_id)  REFERENCES dim_interval_time(interval_time_id)
);
