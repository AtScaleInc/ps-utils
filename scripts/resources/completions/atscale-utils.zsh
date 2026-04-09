#compdef atscale-utils

_arguments -s \
  '1:operation:->ops' \
  '*::args:->args'

case $state in
  ops)
<<<<<<< HEAD
    _values 'operations' echo toggle extract-model-from-atscale generate-powerbi-from-namespace generate-tableau-from-namespace echo-connection-metadata python-hello-world generate-sml-from-connection generate-sml-from-ddl extract-model-from-sml generate-namespace-from-model generate-metrics-from-model execute-sql-on-connection extract-ddl-from-connection generate-excel-from-namespace extract-query-stats-from-atscale extract-queries-from-atscale execute-atscale-query-harness generate-atscale-install-yaml atscale-list-data-sources atscale-create-data-source atscale-list-repos atscale-create-repo atscale-list-deployments atscale-deploy-catalog atscale-list-model-errors generate-ddl-from-atscale
=======
    _values 'operations' echo toggle extract-model-from-atscale generate-powerbi-from-namespace generate-notebook-from-connection generate-tableau-from-namespace echo-connection-metadata python-hello-world generate-sml-from-connection generate-sml-from-ddl extract-model-from-sml generate-namespace-from-model generate-metrics-from-model execute-sql-on-connection extract-ddl-from-connection generate-excel-from-namespace extract-query-stats-from-atscale extract-queries-from-atscale execute-atscale-query-harness generate-atscale-install-yaml atscale-list-data-sources atscale-create-data-source atscale-list-repos atscale-create-repo atscale-list-deployments atscale-deploy-catalog atscale-list-model-errors
>>>>>>> 6e9f8fcad8339ad06daa0ae6a0a5df5fcecdb083
    ;;
  args)
    case "$words[2]" in
  echo)
    _values 'params' --logfile --output --verbose --message
    ;;
  toggle)
    _values 'params' --logfile --output --verbose --enabled
    ;;
  extract-model-from-atscale)
    _values 'params' --logfile --output --verbose --model --connection-file --connection-name --output-model-file
    ;;
  generate-powerbi-from-namespace)
    _values 'params' --logfile --output --verbose --namespace-file --model-file --connection-file --aliases-file --target-folder --connection-name
    ;;
  generate-notebook-from-connection)
    _values 'params' --logfile --output --verbose --namespace-file --model-file --connection-file --aliases-file --connection-name --target-file
    ;;
  generate-tableau-from-namespace)
    _values 'params' --logfile --output --verbose --namespace-file --model-file --connection-file --aliases-file --tableau-version --connection-name --target-file
    ;;
  echo-connection-metadata)
    _values 'params' --logfile --output --verbose --connection-file --connection-name --schema
    ;;
  python-hello-world)
    _values 'params' --logfile --output --verbose --name
    ;;
  generate-sml-from-connection)
    _values 'params' --logfile --output --verbose --connection-file --connection-name --model-name --output-dir --schema --catalog-name --pii-severity --sample-size --fact-tables --camel-case-files --camel-case-measures
    ;;
  generate-sml-from-ddl)
    _values 'params' --logfile --output --verbose --ddl-file --model-name --output-dir --connection-name --catalog-name --pii-severity --schema --database --dialect --fact-tables --camel-case-files --camel-case-measures
    ;;
  extract-model-from-sml)
    _values 'params' --logfile --output --verbose --sml-dir --model-name --connection-name --output-model-file
    ;;
  generate-namespace-from-model)
    _values 'params' --logfile --output --verbose --model-file --model-name --title --max-suggestions --min-score --output-file
    ;;
  generate-metrics-from-model)
    _values 'params' --logfile --output --verbose --model-file --model-name --max-suggestions --min-score --include-tuples --format --output-file
    ;;
  execute-sql-on-connection)
    _values 'params' --logfile --output --verbose --sql-file --connection-file --connection-name --on-error --dry-run
    ;;
  extract-ddl-from-connection)
    _values 'params' --logfile --output --verbose --connection-file --connection-name --schema --tables --output-file
    ;;
  generate-excel-from-namespace)
    _values 'params' --logfile --output --verbose --namespace-file --model-file --connection-file --aliases-file --connection-name --target-file
    ;;
  extract-query-stats-from-atscale)
    _values 'params' --logfile --output --verbose --connection-file --connection-name --model --output-dir --window-days --start-date --end-date --monthly --monthly-year --limit --num-queries
    ;;
  extract-queries-from-atscale)
    _values 'params' --logfile --output --verbose --connection-file --connection-name --models --days --output-dir --protocol --min-executions --db-schema
    ;;
  execute-atscale-query-harness)
    _values 'params' --logfile --output --verbose --connection-file --connection-name --query-file --ingest-file --task-file --protocol --concurrent-users --throttle-ms --run-id --output-dir --redact --duration-minutes
    ;;
  generate-atscale-install-yaml)
    _values 'params' --logfile --output --verbose --hostname --cert-file --key-file --license-key --output-file --enable-mcp --minimal
    ;;
  atscale-list-data-sources)
    _values 'params' --logfile --output --verbose --connection-file --atscale-connection-name --insecure
    ;;
  atscale-create-data-source)
    _values 'params' --logfile --output --verbose --connection-file --atscale-connection-name --new-connection-name --aggregate-schema --name --connection-id --access-users --aggregate-project-id --insecure
    ;;
  atscale-list-repos)
    _values 'params' --logfile --output --verbose --connection-file --atscale-connection-name --insecure
    ;;
  atscale-create-repo)
    _values 'params' --logfile --output --verbose --connection-file --atscale-connection-name --name --url --type --visible-branches-pattern --default-branch --insecure
    ;;
  atscale-list-deployments)
    _values 'params' --logfile --output --verbose --connection-file --atscale-connection-name --insecure
    ;;
  atscale-deploy-catalog)
    _values 'params' --logfile --output --verbose --connection-file --atscale-connection-name --sml-dir --repo-id --repo-name --project-name --tableau-servers --insecure
    ;;
  atscale-list-model-errors)
    _values 'params' --logfile --output --verbose --connection-file --atscale-connection-name --sml-dir --repo-name --repo-id --branch --model-name --insecure
    ;;
  generate-ddl-from-atscale)
    _values 'params' --logfile --output --verbose --connection-file --atscale-connection-name --data-source-name --database --schema --tables --output-file --insecure
    ;;
    *)
      _values 'params' --logfile --output --verbose
      ;;
    esac
    ;;
esac
