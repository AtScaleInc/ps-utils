-- Travel & Hospitality vertical DDL (3NF)

CREATE TABLE dim_property (
    property_id         BIGINT          PRIMARY KEY,
    brand_family        VARCHAR(100),
    chain_name          VARCHAR(100),
    brand_name          VARCHAR(100),
    property_name       VARCHAR(200),
    geo_region          VARCHAR(100),
    geo_country         VARCHAR(100),
    geo_state           VARCHAR(100),
    market_name         VARCHAR(100),
    sub_market          VARCHAR(100)
);

CREATE TABLE dim_room (
    room_id             BIGINT          PRIMARY KEY,
    property_id         BIGINT,
    room_type_code      VARCHAR(20),
    room_type_name      VARCHAR(100),
    room_category       VARCHAR(50),
    room_class          VARCHAR(50),
    room_number         VARCHAR(20),
    rate_code           VARCHAR(50),
    rate_plan_code      VARCHAR(50),
    FOREIGN KEY (property_id) REFERENCES dim_property(property_id)
);

CREATE TABLE dim_guest (
    guest_id            BIGINT          PRIMARY KEY,
    loyalty_id          BIGINT,
    loyalty_number      VARCHAR(50),
    loyalty_tier        VARCHAR(50),
    loyalty_status      VARCHAR(50),
    loyalty_program     VARCHAR(100)
);

CREATE TABLE dim_booking_channel (
    channel_id          BIGINT          PRIMARY KEY,
    booking_window      VARCHAR(50),
    alliance_name       VARCHAR(100),
    carrier_code        VARCHAR(10),
    hub_code            VARCHAR(10),
    route_code          VARCHAR(20),
    cabin_class         VARCHAR(50),
    fare_class          VARCHAR(10),
    booking_class       VARCHAR(10)
);

CREATE TABLE dim_stay_date (
    stay_date_id        BIGINT          PRIMARY KEY,
    check_in_date       DATE,
    arrival_date        DATE,
    check_out_date      DATE,
    departure_date      DATE,
    booking_date        DATE,
    stay_year           INTEGER,
    stay_month          INTEGER,
    stay_quarter        VARCHAR(10)
);

CREATE TABLE travel_reservation_fact (
    reservation_id          BIGINT          PRIMARY KEY,
    property_id             BIGINT,
    room_id                 BIGINT,
    guest_id                BIGINT,
    channel_id              BIGINT,
    stay_date_id            BIGINT,
    confirmation_number     VARCHAR(50),
    pnr                     VARCHAR(20),
    -- Measures
    daily_rate              DECIMAL(12,2),
    room_rate               DECIMAL(12,2),
    adr                     DECIMAL(12,2),
    average_daily_rate      DECIMAL(12,2),
    revpar                  DECIMAL(12,2),
    occupancy_rate          DECIMAL(8,4),
    occ_pct                 DECIMAL(8,4),
    length_of_stay          INTEGER,
    num_nights              INTEGER,
    room_nights             INTEGER,
    load_factor             DECIMAL(8,4),
    no_show_rate            DECIMAL(8,4),
    cancellation_rate       DECIMAL(8,4),
    room_revenue            DECIMAL(14,2),
    food_beverage_revenue   DECIMAL(14,2),
    total_revenue           DECIMAL(14,2),
    num_guests              INTEGER,
    points_earned           INTEGER,
    FOREIGN KEY (property_id)  REFERENCES dim_property(property_id),
    FOREIGN KEY (room_id)      REFERENCES dim_room(room_id),
    FOREIGN KEY (guest_id)     REFERENCES dim_guest(guest_id),
    FOREIGN KEY (channel_id)   REFERENCES dim_booking_channel(channel_id),
    FOREIGN KEY (stay_date_id) REFERENCES dim_stay_date(stay_date_id)
);
