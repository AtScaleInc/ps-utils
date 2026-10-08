CREATE TABLE geography (
  division INTEGER PRIMARY KEY
);

CREATE TABLE organization (
  division INTEGER PRIMARY KEY
);

CREATE TABLE fact_assignments (
  assignment_id INTEGER PRIMARY KEY,
  geographic_division_id INTEGER,
  organization_division_id INTEGER,
  assignment_count INTEGER,
  FOREIGN KEY (geographic_division_id) REFERENCES geography (division),
  FOREIGN KEY (organization_division_id) REFERENCES organization (division)
);
