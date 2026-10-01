"""Every property the SML reference documents, per object kind.

Source: semanticdatalayer/SML sml-reference/ (vendored verbatim in
reference/ps-utils/resources/sml-reference, pinned 63e1dcb, spec v1.8).
tests/test_analyze.py parses those docs and fails if a documented property is
missing here, so a spec refresh can't silently shrink what Analyze reports.

Kinds are the "# <Noun> Properties" sections plus the nested objects the docs
describe under "Supported properties" lists and the mermaid class diagrams.
"""

from __future__ import annotations

SPEC: dict[str, tuple[str, list[str]]] = {
    # kind: (doc file(s), "|"-separated, properties)
    "catalog": ("catalog.md", ["unique_name", "object_type", "label", "version", "hidden_models",
                               "aggressive_agg_promotion", "build_speculative_aggs", "dataset_properties", "description"]),
    "dataset_properties": ("catalog.md|model.md", ["allow_aggregates", "allow_local_aggs", "allow_peer_aggs", "allow_preferred_aggs",
                                          "create_hinted_aggregate"]),
    "connection": ("connection.md", ["unique_name", "object_type", "label", "as_connection", "database", "schema"]),
    "dataset": ("dataset.md", ["unique_name", "object_type", "label", "connection_id", "sql", "dialects", "table", "columns",
                               "description", "incremental", "immutable", "qds_materialization", "alternate"]),
    "alternate": ("dataset.md", ["type", "connection_id", "table", "sql"]),
    "dialect": ("dataset.md", ["dialect", "sql"]),
    "column": ("dataset.md", ["name", "data_type", "sql", "dialects", "map", "parent_column", "description"]),
    "map": ("dataset.md", ["field_terminator", "key_terminator", "key_type", "value_type", "is_prefixed"]),
    "incremental": ("dataset.md", ["column", "grace_period"]),
    "dimension": ("dimension.md", ["unique_name", "object_type", "label", "description", "type", "is_degenerate",
                                   "hierarchies", "level_attributes", "relationships", "calculation_groups"]),
    "dimension_relationship": ("dimension.md", ["unique_name", "from", "to", "type", "role_play", "m2m"]),
    "relationship_from": ("dimension.md", ["dataset", "join_columns", "hierarchy", "level"]),
    "relationship_to": ("dimension.md", ["dimension", "level", "row_security"]),
    "calculation_group": ("dimension.md", ["unique_name", "label", "calculated_members", "description", "is_hidden",
                                           "folder", "precedence"]),
    "calculated_member": ("dimension.md", ["unique_name", "description", "template", "is_hidden", "expression", "format",
                                           "use_input_metric_format"]),
    "hierarchy": ("dimension.md", ["unique_name", "label", "description", "folder", "filter_empty", "default_member", "levels"]),
    "default_member": ("dimension.md", ["expression", "apply_only_when_in_query"]),
    "level": ("dimension.md", ["unique_name", "secondary_attributes", "aliases", "metrics", "parallel_periods", "is_hidden"]),
    "secondary_attribute": ("dimension.md", ["unique_name", "label", "description", "folder", "is_hidden",
                                             "contains_unique_names", "dataset", "name_column", "key_columns", "sort_column",
                                             "allowed_calcs_for_dma", "exclude_from_dim_agg", "is_aggregatable",
                                             "exclude_from_fact_agg", "custom_empty_member", "is_excel_pivot_table_property",
                                             "is_user_defined_property", "format"]),
    "alias": ("dimension.md", ["unique_name", "label", "description", "folder", "format", "dataset", "name_column",
                               "sort_column", "is_hidden", "exclude_from_dim_agg", "is_aggregatable", "exclude_from_fact_agg",
                               "custom_empty_member", "is_excel_pivot_table_property", "is_user_defined_property"]),
    "metrical_attribute": ("dimension.md", ["unique_name", "label", "description", "folder", "format", "dataset", "column",
                                            "calculation_method", "is_hidden", "exclude_from_dim_agg", "is_aggregatable",
                                            "exclude_from_fact_agg", "custom_empty_member", "unrelated_dimensions_handling",
                                            "allowed_calcs_for_dma"]),
    "parallel_period": ("dimension.md", ["level", "key_columns"]),
    "level_attribute": ("dimension.md", ["unique_name", "label", "dataset", "name_column", "key_columns",
                                         "constraint_translation_rank", "shared_degenerate_columns", "description",
                                         "is_hidden", "is_unique_key", "contains_unique_names", "exclude_from_dim_agg",
                                         "is_aggregatable", "exclude_from_fact_agg", "sort_column", "allowed_calcs_for_dma",
                                         "time_unit", "custom_empty_member", "folder"]),
    "shared_degenerate_column": ("dimension.md", ["dataset", "name_column", "sort_column", "key_columns", "is_unique_key"]),
    "custom_empty_member": ("dimension.md", ["key", "name", "sort_name"]),
    "metric": ("metric.md", ["unique_name", "object_type", "label", "calculation_method", "dataset", "column", "description",
                             "semi_additive", "compression", "named_quantiles", "custom_quantiles", "format",
                             "unrelated_dimensions_handling", "is_hidden"]),
    "semi_additive": ("metric.md", ["position", "relationships", "degenerate_dimensions"]),
    "degenerate_dimension_ref": ("metric.md", ["name", "level"]),
    "calculation": ("calculation.md", ["unique_name", "object_type", "label", "expression", "description", "format",
                                       "is_hidden", "mdx_aggregation_function",
                                       "mdx_aggregate_function"]),  # heading vs class-diagram spelling
    "model": ("model.md", ["unique_name", "object_type", "label", "relationships", "metrics", "description", "dimensions",
                           "perspectives", "drillthroughs", "aggregates", "partitions", "dataset_properties", "overrides",
                           "include_default_drillthrough"]),
    "model_relationship": ("model.md", ["unique_name", "from", "to", "role_play", "type", "constraint_translation"]),
    "model_relationship_from": ("model.md", ["dataset", "join_columns", "columns"]),
    "constraint_translation": ("model.md", ["level", "from_columns"]),
    "metric_reference": ("model.md|composite-model.md", ["unique_name", "folder"]),
    "perspective": ("model.md", ["unique_name", "metrics", "dimensions"]),
    "perspective_dimension": ("model.md", ["name", "hierarchies", "secondary_attributes", "relationships_path"]),
    "perspective_hierarchy": ("model.md", ["name", "level", "levels"]),
    "drillthrough": ("model.md", ["unique_name", "metrics", "notes", "attributes"]),
    "drillthrough_attribute": ("model.md", ["name", "dimension", "relationships_path"]),
    "aggregate": ("model.md|composite-model.md", ["unique_name", "label", "caching", "metrics", "attributes"]),
    "aggregate_attribute": ("model.md|composite-model.md", ["name", "dimension", "row_security", "partition", "distribution", "partition_rank",
                                         "distribution_rank", "relationships_path"]),
    "partition": ("model.md", ["unique_name", "dimension", "attribute", "type"]),
    "override": ("model.md", ["query_name"]),
    "composite_model": ("composite-model.md", ["unique_name", "object_type", "label", "description", "models", "metrics",
                                               "aggregates"]),
    "row_security": ("row-security.md", ["unique_name", "object_type", "label", "dataset", "filter_key_column", "ids_column",
                                         "id_type", "scope", "description", "use_filter_key", "secure_totals"]),
    "package": ("package.md", ["version", "packages"]),
    "package_entry": ("package.md", ["name", "url", "branch", "version"]),
}

#: Keys the engine accepts that no reference page documents (UPSTREAM.md "Known documentation gaps").
KNOWN_UNDOCUMENTED = {"visualize_in_bi_tool"}


def keys(kind: str) -> list[str]:
    return SPEC[kind][1]
