#!/usr/bin/env sh
set -eu

COMPLETION_DIR="$HOME/.config/fish/completions"
mkdir -p "$COMPLETION_DIR"

"$(dirname "$0")/../atscale-utils" --completion fish > "$COMPLETION_DIR/atscale-utils.fish"

echo "Installed fish completions to $COMPLETION_DIR/atscale-utils.fish"
