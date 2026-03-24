-- Logistics vertical DDL (3NF)

CREATE TABLE dim_origin (
    origin_id           BIGINT          PRIMARY KEY,
    origin_country      VARCHAR(100),
    origin_state        VARCHAR(100),
    origin_city         VARCHAR(100),
    origin_zip          VARCHAR(10),
    origin_port         VARCHAR(20),
    origin_location     VARCHAR(100)
);

CREATE TABLE dim_destination (
    destination_id      BIGINT          PRIMARY KEY,
    dest_country        VARCHAR(100),
    dest_state          VARCHAR(100),
    dest_city           VARCHAR(100),
    dest_zip            VARCHAR(10),
    destination_port    VARCHAR(20),
    destination_location VARCHAR(100)
);

CREATE TABLE dim_carrier (
    carrier_id          BIGINT          PRIMARY KEY,
    carrier_code        VARCHAR(20),
    scac_code           VARCHAR(10),
    transport_mode      VARCHAR(50),
    service_level       VARCHAR(50),
    route_id            VARCHAR(50),
    lane_code           VARCHAR(50)
);

CREATE TABLE dim_warehouse (
    warehouse_id        BIGINT          PRIMARY KEY,
    warehouse_region    VARCHAR(100),
    warehouse_name      VARCHAR(200),
    dc_id               BIGINT,
    fulfillment_center_id BIGINT,
    warehouse_zone      VARCHAR(50),
    aisle_id            VARCHAR(20),
    dock_id             VARCHAR(20),
    dock_door           VARCHAR(20)
);

CREATE TABLE dim_ship_date (
    ship_date_id        BIGINT          PRIMARY KEY,
    ship_date           DATE,
    delivery_date       DATE,
    ship_year           INTEGER,
    ship_month          INTEGER,
    ship_quarter        VARCHAR(10)
);

CREATE TABLE logistics_shipment_fact (
    shipment_id             BIGINT          PRIMARY KEY,
    origin_id               BIGINT,
    destination_id          BIGINT,
    carrier_id              BIGINT,
    warehouse_id            BIGINT,
    ship_date_id            BIGINT,
    tracking_number         VARCHAR(100),
    bol_number              VARCHAR(50),
    container_id            VARCHAR(50),
    container_number        VARCHAR(50),
    freight_class           VARCHAR(20),
    nmfc_code               VARCHAR(20),
    load_id                 BIGINT,
    -- Measures
    transit_days            DECIMAL(8,2),
    transit_time            DECIMAL(8,2),
    freight_cost            DECIMAL(12,2),
    fuel_surcharge          DECIMAL(12,2),
    accessorial_charges     DECIMAL(12,2),
    total_charges           DECIMAL(12,2),
    weight_lbs              DECIMAL(12,4),
    volume_cuft             DECIMAL(12,4),
    pieces_count            INTEGER,
    units_shipped           INTEGER,
    on_time_delivery_rate   DECIMAL(8,4),
    fill_rate               DECIMAL(8,4),
    damage_claims_count     INTEGER,
    FOREIGN KEY (origin_id)      REFERENCES dim_origin(origin_id),
    FOREIGN KEY (destination_id) REFERENCES dim_destination(destination_id),
    FOREIGN KEY (carrier_id)     REFERENCES dim_carrier(carrier_id),
    FOREIGN KEY (warehouse_id)   REFERENCES dim_warehouse(warehouse_id),
    FOREIGN KEY (ship_date_id)   REFERENCES dim_ship_date(ship_date_id)
);
