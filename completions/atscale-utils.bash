# Bash completion for atscale-utils (generated)

_atscale_utils_complete() {
  local cur op params
  cur="${COMP_WORDS[COMP_CWORD]}"
  op="${COMP_WORDS[1]}"

  if [[ $COMP_CWORD -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "echo toggle extract-atscale-model generate-tableau-from-namespace echo-connection-metadata" -- "$cur") )
    return 0
  fi

  case "$op" in
    echo)
      params="--logfile --output --verbose --message"
      ;;
    toggle)
      params="--logfile --output --verbose --enabled"
      ;;
    extract-atscale-model)
      params="--logfile --output --verbose --model --connection-file --connection-name --output-model-file"
      ;;
    generate-tableau-from-namespace)
      params="--logfile --output --verbose --namespace --model-file --connection-file --target-file --tableau-version --target-file"
      ;;
    echo-connection-metadata)
      params="--logfile --output --verbose --connection-file --connection-name --schema"
      ;;
    *)
      params="--logfile --output --verbose"
      ;;
  esac

  COMPREPLY=( $(compgen -W "$params" -- "$cur") )
  return 0
}

complete -F _atscale_utils_complete atscale-utils
