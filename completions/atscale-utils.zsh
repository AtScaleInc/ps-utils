#compdef atscale-utils

_arguments -s \
  '1:operation:->ops' \
  '*::args:->args'

case $state in
  ops)
    _values 'operations' echo toggle extract-atscale-model generate-tableau-from-namespace echo-connection-metadata python-hello-world
    ;;
  args)
    case "$words[2]" in
  echo)
    _values 'params' --logfile --output --verbose --message
    ;;
  toggle)
    _values 'params' --logfile --output --verbose --enabled
    ;;
  extract-atscale-model)
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
    *)
      _values 'params' --logfile --output --verbose
      ;;
    esac
    ;;
esac
