-- Generated deterministically from fingerprint_synthetic.yaml (ANSI dialect).
-- NO REAL IDENTIFIERS. Every key is synthetic; every name is structural.

CREATE TABLE dim_1 (
    l1_key     SMALLINT     NOT NULL,   -- root, 5 members
    l2_key     SMALLINT     NOT NULL,   -- 52 members
    l3_key     INTEGER      NOT NULL,   -- leaf, 42,000 members
    l3_label   VARCHAR(64),
    PRIMARY KEY (l3_key)
);

CREATE TABLE dim_2 (
    l1_key     SMALLINT     NOT NULL,   -- root, 6 members
    l2_key     SMALLINT     NOT NULL,   -- leaf, 1,200 members
    l2_label   VARCHAR(64),
    PRIMARY KEY (l2_key)
);

CREATE TABLE dim_3 (
    l1_key     SMALLINT     NOT NULL,   -- root year, 5 members
    l2_key     SMALLINT     NOT NULL,   -- month, 60 members
    l3_key     SMALLINT     NOT NULL,   -- day, 1,826 members
    PRIMARY KEY (l3_key)
);

CREATE TABLE fact_1 (
    dim_1_key  INTEGER,
    dim_2_key  SMALLINT,
    dim_3_key  SMALLINT,
    m1         DECIMAL(18,4),
    m2         BIGINT,
    FOREIGN KEY (dim_1_key) REFERENCES dim_1 (l3_key),
    FOREIGN KEY (dim_2_key) REFERENCES dim_2 (l2_key),
    FOREIGN KEY (dim_3_key) REFERENCES dim_3 (l3_key)
);
