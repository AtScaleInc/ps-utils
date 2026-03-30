# Bash completion for atscale-utils (generated)

_atscale_utils_complete() {
  local cur op params
  cur="${COMP_WORDS[COMP_CWORD]}"
  op="${COMP_WORDS[1]}"

  if [[ $COMP_CWORD -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "echo toggle extract-model-from-atscale generate-powerbi-from-namespace generate-tableau-from-namespace echo-connection-metadata python-hello-world generate-sml-from-connection generate-sml-from-ddl extract-model-from-sml generate-namespace-from-model execute-sql-on-connection extract-ddl-from-connection generate-excel-from-namespace extract-query-stats-from-atscale extract-queries-from-atscale execute-atscale-query-harness generate-atscale-install-yaml atscale-list-data-sources atscale-create-data-source atscale-list-repos atscale-create-repo atscale-list-deployments atscale-deploy-repo atscale-list-model-errors" -- "$cur") )
    return 0
  fi

  case "$op" in
    echo)
      params="--logfile --output --verbose --message"
      ;;
    toggle)
      params="--logfile --output --verbose --enabled"
      ;;
    extract-model-from-atscale)
      params="--logfile --output --verbose --model --connection-file --connection-name --output-model-file"
      ;;
    generate-powerbi-from-namespace)
      params="--logfile --output --verbose --namespace-file --model-file --connection-file --aliases-file --target-folder --connection-name"
      ;;
    generate-tableau-from-namespace)
      params="--logfile --output --verbose --namespace-file --model-file --connection-file --aliases-file --tableau-version --connection-name --target-file"
      ;;
    echo-connection-metadata)
      params="--logfile --output --verbose --connection-file --connection-name --schema"
      ;;
    python-hello-world)
      params="--logfile --output --verbose --name"
      ;;
    generate-sml-from-connection)
      params="--logfile --output --verbose --connection-file --connection-name --model-name --output-dir --schema --catalog-name --pii-severity --sample-size --fact-tables --camel-case-files --camel-case-measures"
      ;;
    generate-sml-from-ddl)
      params="--logfile --output --verbose --ddl-file --model-name --output-dir --connection-name --catalog-name --pii-severity --schema --database --dialect --fact-tables --camel-case-files --camel-case-measures"
      ;;
    extract-model-from-sml)
      params="--logfile --output --verbose --sml-dir --model-name --connection-name --output-model-file"
      ;;
    generate-namespace-from-model)
      params="--logfile --output --verbose --model-file --model-name --title --max-suggestions --min-score --output-file"
      ;;
    execute-sql-on-connection)
      params="--logfile --output --verbose --sql-file --connection-file --connection-name --on-error --dry-run"
      ;;
    extract-ddl-from-connection)
      params="--logfile --output --verbose --connection-file --connection-name --schema --tables --output-file"
      ;;
    generate-excel-from-namespace)
      params="--logfile --output --verbose --namespace-file --model-file --connection-file --aliases-file --connection-name --target-file"
      ;;
    extract-query-stats-from-atscale)
      params="--logfile --output --verbose --connection-file --connection-name --model --output-dir --window-days --start-date --end-date --monthly --monthly-year --limit --num-queries"
      ;;
    extract-queries-from-atscale)
      params="--logfile --output --verbose --connection-file --connection-name --models --days --output-dir --protocol --min-executions --db-schema"
      ;;
    execute-atscale-query-harness)
      params="--logfile --output --verbose --connection-file --connection-name --query-file --ingest-file --task-file --protocol --concurrent-users --throttle-ms --run-id --output-dir --redact --duration-minutes"
      ;;
    generate-atscale-install-yaml)
      params="--logfile --output --verbose --hostname --cert-file --key-file --license-key --output-file --enable-mcp --minimal"
      ;;
    atscale-list-data-sources)
      params="--logfile --output --verbose --connection-file --atscale-connection-name --insecure"
      ;;
    atscale-create-data-source)
      params="--logfile --output --verbose --connection-file --atscale-connection-name --new-connection-name --aggregate-schema --name --connection-id --access-users --aggregate-project-id --insecure"
      ;;
    atscale-list-repos)
      params="--logfile --output --verbose --connection-file --atscale-connection-name --insecure"
      ;;
    atscale-create-repo)
      params="--logfile --output --verbose --connection-file --atscale-connection-name --name --url --type --visible-branches-pattern --default-branch --insecure"
      ;;
    atscale-list-deployments)
      params="--logfile --output --verbose --connection-file --atscale-connection-name --insecure"
      ;;
    atscale-deploy-repo)
      params="--logfile --output --verbose --connection-file --atscale-connection-name --sml-dir --repo-id --repo-name --project-name --project-id --tableau-servers --insecure"
      ;;
    atscale-list-model-errors)
      params="--logfile --output --verbose --connection-file --atscale-connection-name --sml-dir --repo-name --repo-id --branch --model-name --insecure"
      ;;
    *)
      params="--logfile --output --verbose"
      ;;
  esac

  COMPREPLY=( $(compgen -W "$params" -- "$cur") )
  return 0
}

complete -F _atscale_utils_complete atscale-utils
