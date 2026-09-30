-- Anonymised multi-schema, views-only DDL (Snowflake style).
-- Mirrors a real-world pattern: a fact view and snapshot hierarchy views in
-- separate schemas, each view declared with an explicit column list and a
-- bracketed body, selecting from base tables that are NOT in this file.

create or replace view ANALYTICS_DB.FACTS.VW_LEDGER( "Year", "Date", "Currency", "Account", "Cost_Center", "Amount" ) as (
  select l."YEAR" as "Year", l."CALDAY" as "Date", l."CURRENCY" as "Currency",
         l."ACCOUNT" as "Account", l."COSTCENTER" as "Cost_Center", l."VALUE" as "Global_Amount"
  from RAW_DB.LEDGER.TB_LEDGER l
) /* model.finance.VW_LEDGER */;

create or replace view ANALYTICS_DB.DIMS.VW_CALENDAR( "Date", "Month_in_Year", "Year" ) as (
  SELECT DATE AS "Date", MONTH_IN_YEAR AS "Month_in_Year", YEAR AS "Year" FROM ANALYTICS_DB.DIMS_BASE.TB_CALENDAR
);

create or replace view ANALYTICS_DB.HIER.VW_ACCOUNT_SNAP( "Account", "Hier_Name", "Snap_Date", "Account_Lvl_01", "Account_Lvl_02" ) as (
  select ACCOUNT as "Account", HIENM as "Hier_Name", SNAP_DATE as "Snap_Date", L1 as "Account_Lvl_01", L2 as "Account_Lvl_02"
  from ANALYTICS_DB.HIER_BASE.TB_ACCOUNT_SNAP
);

create or replace view ANALYTICS_DB.HIER.VW_COSTCENTER_SNAP( "Cost_Center", "Hier_Name", "Snap_Date" ) as (
  select COSTCENTER as "Cost_Center", HIENM as "Hier_Name", SNAP_DATE as "Snap_Date"
  from ANALYTICS_DB.HIER_BASE.TB_COSTCENTER_SNAP
);

-- Not referenced by the fact: no join should be inferred to it.
create or replace view ANALYTICS_DB.HIER.VW_REGION_SNAP( "Region", "Hier_Name", "Snap_Date" ) as (
  select REGION as "Region", HIENM as "Hier_Name", SNAP_DATE as "Snap_Date"
  from ANALYTICS_DB.HIER_BASE.TB_REGION_SNAP
);
