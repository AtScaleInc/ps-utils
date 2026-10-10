-- Synthetic star schema for the DDL import tests.
USE DATABASE database_name;
CREATE SCHEMA IF NOT EXISTS sales;

CREATE OR REPLACE TABLE database_name.sales.dim_date (
  date_key     NUMBER(38,0) NOT NULL PRIMARY KEY,
  full_date    DATE,
  month_name   VARCHAR(20),
  quarter      NUMBER(1,0),
  calendar_year NUMBER(4,0)
);

CREATE TABLE sales.dim_product (
  product_key  INTEGER NOT NULL,
  product_name VARCHAR(200),
  category     VARCHAR(100),
  list_price   NUMBER(18,2),
  CONSTRAINT pk_product PRIMARY KEY (product_key)
);

/* customer has an inline reference */
CREATE TABLE sales."dim_customer" (
  "customer_key" BIGINT NOT NULL,
  "customer name" VARCHAR(200),
  region       VARCHAR(50) DEFAULT 'n/a',
  PRIMARY KEY ("customer_key")
);

CREATE TABLE sales.fact_sales (
  sale_id      NUMBER(38,0) IDENTITY(1,1) NOT NULL,
  date_key     NUMBER(38,0) NOT NULL,
  product_key  INTEGER NOT NULL REFERENCES sales.dim_product(product_key),
  cust_key     BIGINT,
  quantity     NUMBER(10,0),
  sales_amount NUMBER(18,2),
  discount     FLOAT,
  updated_at   TIMESTAMP_NTZ(9),
  CONSTRAINT fk_date FOREIGN KEY (date_key) REFERENCES sales.dim_date (date_key)
);

ALTER TABLE sales.fact_sales ADD CONSTRAINT fk_cust FOREIGN KEY (cust_key) REFERENCES sales.dim_customer (customer_key);

CREATE OR REPLACE VIEW sales.v_sales AS SELECT * FROM sales.fact_sales;
CREATE SEQUENCE sales.seq1;
