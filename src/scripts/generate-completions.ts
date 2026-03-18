/**
 * Generate shell completion scripts from the registered operations list.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { buildRegistry } from "../operations/index.js";
import { globalInputFilter } from "../global-input.js";

/**
 * Generates shell completions from the operation registry.
 */
type OpInfo = {
  name: string;
  params: string[];
};

const GLOBAL_PARAMS = ["--logfile", "--output", "--verbose"];

async function getOperations(): Promise<OpInfo[]> {
  const logger = globalInputFilter({}).logger;
  const registry = await buildRegistry(logger, { includeSql: false });
  return registry.list().map((op) => ({
    name: op.name,
    params: op.parameters.parameters.map((p) => `--${p.name}`),
  }));
}

function buildBash(ops: OpInfo[]): string {
  const cases = ops
    .map(
      (op) =>
        `    ${op.name})\n      params="${GLOBAL_PARAMS.join(" ")} ${op.params.join(" ")}"\n      ;;\n`
    )
    .join("");

  return `# Bash completion for atscale-utils (generated)

_atscale_utils_complete() {
  local cur op params
  cur="\${COMP_WORDS[COMP_CWORD]}"
  op="\${COMP_WORDS[1]}"

  if [[ $COMP_CWORD -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "${ops.map((o) => o.name).join(" ")}" -- "$cur") )
    return 0
  fi

  case "$op" in
${cases}    *)
      params="${GLOBAL_PARAMS.join(" ")}"
      ;;
  esac

  COMPREPLY=( $(compgen -W "$params" -- "$cur") )
  return 0
}

complete -F _atscale_utils_complete atscale-utils
`;
}

function buildZsh(ops: OpInfo[]): string {
  const cases = ops
    .map((op) => {
      const params = [...GLOBAL_PARAMS, ...op.params].join(" ");
      return `  ${op.name})\n    _values 'params' ${params}\n    ;;\n`;
    })
    .join("");

  return `#compdef atscale-utils

_arguments -s \\
  '1:operation:->ops' \\
  '*::args:->args'

case $state in
  ops)
    _values 'operations' ${ops.map((o) => o.name).join(" ")}
    ;;
  args)
    case "$words[2]" in
${cases}    *)
      _values 'params' ${GLOBAL_PARAMS.join(" ")}
      ;;
    esac
    ;;
esac
`;
}

function buildFish(ops: OpInfo[]): string {
  const opList = ops.map((o) => o.name).join(" ");
  const opParamCompletes = ops
    .map((op) => {
      const params = [...GLOBAL_PARAMS, ...op.params].join(" ");
      return `complete -c atscale-utils -n '__fish_seen_subcommand_from ${op.name}' -a '${params}'`;
    })
    .join("\n");

  return `# Fish completion for atscale-utils (generated)

complete -c atscale-utils -n 'not __fish_seen_subcommand_from ${opList}' -a '${opList}'
${opParamCompletes}
`;
}

function writeFile(relativePath: string, contents: string): void {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const root = path.resolve(__dirname, "..", "..");
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents, "utf8");
}

const ops = await getOperations();
writeFile("scripts/resources/completions/atscale-utils.bash", buildBash(ops));
writeFile("scripts/resources/completions/atscale-utils.zsh", buildZsh(ops));
writeFile("scripts/resources/completions/atscale-utils.fish", buildFish(ops));
