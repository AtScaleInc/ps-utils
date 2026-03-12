#compdef atscale-utils

_arguments -s \
  '1:operation:->ops' \
  '*::args:->args'

case $state in
  ops)
    _values 'operations' echo toggle extract-model-from-atscale generate-tableau-from-namespace echo-connection-metadata python-hello-world generate-sml-from-connection generate-sml-from-ddl extract-model-from-sml
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
    _values 'params' --logfile --output --verbose --ddl-file --model-name --output-dir --connection-name --catalog-name --pii-severity --schema
    ;;
  extract-model-from-sml)
    _values 'params' --logfile --output --verbose --sml-dir --model-name --connection-name --output-model-file
    ;;
    *)
      _values 'params' --logfile --output --verbose
      ;;
    esac
    ;;
esac
