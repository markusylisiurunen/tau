#!/usr/bin/env bash
set -euo pipefail

SSH_HOST=${TAU_REMOTE_SSH_HOST:-astral-lily}
REMOTE_REPOSITORY=${TAU_REMOTE_REPOSITORY:-https://github.com/markusylisiurunen/tau.git}
WS_HOST=${TAU_REMOTE_WS_HOST:-$(ssh -G "$SSH_HOST" 2>/dev/null | awk '$1 == "hostname" { print $2; exit }')}
TAU_BIN=${TAU_BIN:-tau}

REMOTE_CWD=$(
  ssh "$SSH_HOST" 'bash -s' -- "$REMOTE_REPOSITORY" <<'REMOTE'
set -euo pipefail

repository=$1
workspace_root=$HOME/workspace
mkdir -p "$workspace_root"
workspace=$(mktemp -d "$workspace_root/tau-XXXXX")
prepared=false
trap 'if [[ $prepared == false ]]; then rm -rf "$workspace"; fi' EXIT

printf 'Cloning %s into %s\n' "$repository" "$workspace" >&2
git clone "$repository" "$workspace" >&2

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

server_config=$(ssh "$SSH_HOST" 'sed -n -e "s/^PORT=//p" -e "s/^AUTH_TOKEN=//p" ./start-tau-serve.sh')
REMOTE_PORT=$(printf '%s\n' "$server_config" | sed -n '1p')
AUTH_TOKEN=$(printf '%s\n' "$server_config" | sed -n '2p')

if [[ ! $REMOTE_PORT =~ ^[0-9]+$ || -z $AUTH_TOKEN || -z $WS_HOST ]]; then
  echo "Could not resolve the Tau server connection for $SSH_HOST." >&2
  exit 1
fi

"$TAU_BIN" attach \
  --new \
  --cwd "$REMOTE_CWD" \
  --auth-token "$AUTH_TOKEN" \
  "ws://${WS_HOST}:${REMOTE_PORT}"
