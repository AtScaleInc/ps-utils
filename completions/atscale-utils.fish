# Fish completion for atscale-utils (generated)

complete -c atscale-utils -n 'not __fish_seen_subcommand_from echo toggle extract-model-from-atscale generate-tableau-from-namespace echo-connection-metadata python-hello-world generate-sml-from-connection generate-sml-from-ddl extract-model-from-sml generate-namespace-from-model execute-sql-on-connection' -a 'echo toggle extract-model-from-atscale generate-tableau-from-namespace echo-connection-metadata python-hello-world generate-sml-from-connection generate-sml-from-ddl extract-model-from-sml generate-namespace-from-model execute-sql-on-connection'
complete -c atscale-utils -n '__fish_seen_subcommand_from echo' -a '--logfile --output --verbose --message'
complete -c atscale-utils -n '__fish_seen_subcommand_from toggle' -a '--logfile --output --verbose --enabled'
complete -c atscale-utils -n '__fish_seen_subcommand_from extract-model-from-atscale' -a '--logfile --output --verbose --model --connection-file --connection-name --output-model-file'
complete -c atscale-utils -n '__fish_seen_subcommand_from generate-tableau-from-namespace' -a '--logfile --output --verbose --namespace-file --model-file --connection-file --target-file --tableau-version --connection-name --target-file'
complete -c atscale-utils -n '__fish_seen_subcommand_from echo-connection-metadata' -a '--logfile --output --verbose --connection-file --connection-name --schema'
complete -c atscale-utils -n '__fish_seen_subcommand_from python-hello-world' -a '--logfile --output --verbose --name'
complete -c atscale-utils -n '__fish_seen_subcommand_from generate-sml-from-connection' -a '--logfile --output --verbose --connection-file --connection-name --model-name --output-dir --schema --catalog-name --pii-severity --sample-size'
complete -c atscale-utils -n '__fish_seen_subcommand_from generate-sml-from-ddl' -a '--logfile --output --verbose --ddl-file --model-name --output-dir --connection-name --catalog-name --pii-severity --schema'
complete -c atscale-utils -n '__fish_seen_subcommand_from extract-model-from-sml' -a '--logfile --output --verbose --sml-dir --model-name --connection-name --output-model-file'
complete -c atscale-utils -n '__fish_seen_subcommand_from generate-namespace-from-model' -a '--logfile --output --verbose --model-file --model-name --title --max-suggestions --min-score --output-file'
complete -c atscale-utils -n '__fish_seen_subcommand_from execute-sql-on-connection' -a '--logfile --output --verbose --sql-file --connection-file --connection-name --on-error --dry-run'
