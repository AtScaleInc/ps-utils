# Bash completion for atscale-utils (generated)

_atscale_utils_complete() {
  local cur op params
  cur="${COMP_WORDS[COMP_CWORD]}"
  op="${COMP_WORDS[1]}"

  if [[ $COMP_CWORD -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "echo toggle extract-model-from-atscale generate-tableau-from-namespace echo-connection-metadata python-hello-world generate-sml-from-connection generate-sml-from-ddl extract-model-from-sml generate-namespace-from-model execute-sql-on-connection" -- "$cur") )
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
    generate-tableau-from-namespace)
      params="--logfile --output --verbose --namespace-file --model-file --connection-file --target-file --tableau-version --connection-name --target-file"
      ;;
    echo-connection-metadata)
      params="--logfile --output --verbose --connection-file --connection-name --schema"
      ;;
    python-hello-world)
      params="--logfile --output --verbose --name"
      ;;
    generate-sml-from-connection)
      params="--logfile --output --verbose --connection-file --connection-name --model-name --output-dir --schema --catalog-name --pii-severity --sample-size"
      ;;
    generate-sml-from-ddl)
      params="--logfile --output --verbose --ddl-file --model-name --output-dir --connection-name --catalog-name --pii-severity --schema"
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
    *)
      params="--logfile --output --verbose"
      ;;
  esac

  COMPREPLY=( $(compgen -W "$params" -- "$cur") )
  return 0
}

complete -F _atscale_utils_complete atscale-utils
