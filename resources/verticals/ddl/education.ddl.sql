-- Education vertical DDL (3NF)

CREATE TABLE dim_student (
    student_id          BIGINT          PRIMARY KEY,
    graduation_year     INTEGER,
    cohort_year         INTEGER,
    degree_type         VARCHAR(50),
    credential_type     VARCHAR(50)
);

CREATE TABLE dim_course (
    course_id           BIGINT          PRIMARY KEY,
    course_code         VARCHAR(20),
    course_name         VARCHAR(200),
    credit_hours        DECIMAL(6,2),
    section_id          BIGINT,
    class_id            BIGINT,
    section_name        VARCHAR(100),
    subject_area        VARCHAR(100),
    department_name     VARCHAR(200),
    instructor_id       BIGINT,
    teacher_id          BIGINT,
    faculty_id          BIGINT
);

CREATE TABLE dim_institution (
    institution_id      BIGINT          PRIMARY KEY,
    district_id         BIGINT,
    district_code       VARCHAR(20),
    district_name       VARCHAR(200),
    campus_id           BIGINT,
    school_id           BIGINT,
    campus_name         VARCHAR(200),
    grade_level         VARCHAR(20),
    grade_band          VARCHAR(20),
    state_code          VARCHAR(10),
    county_name         VARCHAR(100),
    city_name           VARCHAR(100)
);

CREATE TABLE dim_academic_calendar (
    academic_calendar_id BIGINT         PRIMARY KEY,
    academic_year       VARCHAR(20),
    school_year         VARCHAR(20),
    semester_name       VARCHAR(50),
    term_name           VARCHAR(50),
    week_number         INTEGER,
    calendar_date       DATE,
    enrollment_date     DATE
);

CREATE TABLE education_enrollment_fact (
    enrollment_id           BIGINT          PRIMARY KEY,
    student_id              BIGINT,
    course_id               BIGINT,
    institution_id          BIGINT,
    academic_calendar_id    BIGINT,
    -- Measures
    gpa                     DECIMAL(5,3),
    grade_point_average     DECIMAL(5,3),
    attendance_rate         DECIMAL(8,4),
    attendance_pct          DECIMAL(8,4),
    test_score              DECIMAL(10,2),
    assessment_score        DECIMAL(10,2),
    pass_rate               DECIMAL(8,4),
    completion_rate         DECIMAL(8,4),
    graduation_rate         DECIMAL(8,4),
    enrollment_count        INTEGER,
    headcount               INTEGER,
    absences_count          INTEGER,
    disciplinary_incidents  INTEGER,
    FOREIGN KEY (student_id)             REFERENCES dim_student(student_id),
    FOREIGN KEY (course_id)              REFERENCES dim_course(course_id),
    FOREIGN KEY (institution_id)         REFERENCES dim_institution(institution_id),
    FOREIGN KEY (academic_calendar_id)   REFERENCES dim_academic_calendar(academic_calendar_id)
);
