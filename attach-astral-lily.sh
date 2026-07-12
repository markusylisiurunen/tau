#!/usr/bin/env bash
set -euo pipefail

remote_cwd=$(ssh astral-lily 'bash -s' <<'REMOTE'
set -euo pipefail

workspace_root=$HOME/workspace
mkdir -p "$workspace_root"
workspace=$(mktemp -d "$workspace_root/tau-XXXXX")
prepared=false
trap 'if [[ $prepared == false ]]; then rm -rf "$workspace"; fi' EXIT

printf 'Cloning Tau into %s\n' "$workspace" >&2
git clone https://github.com/markusylisiurunen/tau.git "$workspace" >&2

source "$HOME/.nvm/nvm.sh"
cd "$workspace"
npm ci >&2
(
  cd src/diff_tool/app
  npm ci >&2
)
npm run build >&2

prepared=true
printf '%s\n' "$workspace"
REMOTE
)

ws_host=$(ssh -G astral-lily 2>/dev/null | awk '$1 == "hostname" { print $2; exit }')
server_config=$(ssh astral-lily 'sed -n -e "s/^PORT=//p" -e "s/^AUTH_TOKEN=//p" ./start-tau-serve.sh')
remote_port=$(printf '%s\n' "$server_config" | sed -n '1p')
auth_token=$(printf '%s\n' "$server_config" | sed -n '2p')

if [[ ! $remote_port =~ ^[0-9]+$ || -z $auth_token || -z $ws_host ]]; then
  echo "Could not resolve the Tau server connection for astral-lily." >&2
  exit 1
fi

tau attach \
  --new \
  --cwd "$remote_cwd" \
  --auth-token "$auth_token" \
  "ws://${ws_host}:${remote_port}"
