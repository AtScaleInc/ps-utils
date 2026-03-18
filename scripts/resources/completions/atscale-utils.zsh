#compdef atscale-utils

_arguments -s \
  '1:operation:->ops' \
  '*::args:->args'

case $state in
  ops)
    _values 'operations' echo toggle extract-model-from-atscale generate-powerbi-from-namespace generate-tableau-from-namespace echo-connection-metadata python-hello-world generate-sml-from-connection generate-sml-from-ddl extract-model-from-sml generate-namespace-from-model execute-sql-on-connection
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
    _values 'params' --logfile --output --verbose --namespace-file --model-file --connection-file --target-file --target-folder --connection-name
    ;;
  generate-tableau-from-namespace)
    _values 'params' --logfile --output --verbose --namespace-file --model-file --connection-file --target-file --tableau-version --connection-name --target-file
    ;;
  echo-connection-metadata)
    _values 'params' --logfile --output --verbose --connection-file --connection-name --schema
    ;;
  python-hello-world)
    _values 'params' --logfile --output --verbose --name
    ;;
  generate-sml-from-connection)
    _values 'params' --logfile --output --verbose --connection-file --connection-name --model-name --output-dir --schema --catalog-name --pii-severity --sample-size
    ;;
  generate-sml-from-ddl)
    _values 'params' --logfile --output --verbose --ddl-file --model-name --output-dir --connection-name --catalog-name --pii-severity --schema --database --dialect
    ;;
  extract-model-from-sml)
    _values 'params' --logfile --output --verbose --sml-dir --model-name --connection-name --output-model-file
    ;;
  generate-namespace-from-model)
    _values 'params' --logfile --output --verbose --model-file --model-name --title --max-suggestions --min-score --output-file
    ;;
  execute-sql-on-connection)
    _values 'params' --logfile --output --verbose --sql-file --connection-file --connection-name --on-error --dry-run
    ;;
    *)
      _values 'params' --logfile --output --verbose
      ;;
    esac
    ;;
esac
