#!/bin/bash
# SessionStart hook: put the Node version this repo declares on PATH, then
# install workspace dependencies.
#
# Why it exists: `packages/engine` runs on Node's native type stripping with
# zero dependencies, so it needs the Node in `.nvmrc`, not whatever the image
# happens to ship. Everything else is an npm workspace, and the `@4wc/*`
# cross-package imports only resolve once `npm install` has linked them --
# without it `npm test` fails with ERR_MODULE_NOT_FOUND and esbuild is missing.
#
# Runs in Claude Code on the web only. Local checkouts get the version from
# `.nvmrc` through their own version manager.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

repo_root="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
cd "$repo_root"

want="$(tr -cd '0-9' < .nvmrc)"
have="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"

node_bin=""
if [ "$have" -ge "$want" ]; then
  node_bin="$(dirname "$(command -v node)")"
elif [ -x "/opt/node${want}/bin/node" ]; then
  # Pre-baked in the image: no download needed.
  node_bin="/opt/node${want}/bin"
else
  export NVM_DIR="${NVM_DIR:-/opt/nvm}"
  [ -s "$NVM_DIR/nvm.sh" ] || export NVM_DIR="$HOME/.nvm"
  if [ -s "$NVM_DIR/nvm.sh" ]; then
    # shellcheck disable=SC1091
    . "$NVM_DIR/nvm.sh"
    nvm install "$want" >/dev/null      # no-op once the version is on disk
    nvm use "$want" >/dev/null
    node_bin="$(dirname "$(command -v node)")"
  fi
fi

if [ -n "$node_bin" ]; then
  export PATH="$node_bin:$PATH"
  # Persist for the rest of the session, not just this script.
  if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
    echo "export PATH=\"$node_bin:\$PATH\"" >> "$CLAUDE_ENV_FILE"
  fi
else
  echo "session-start: could not provide Node ${want}; continuing on $(node -v)" >&2
fi

echo "session-start: node $(node -v), npm $(npm -v)"

# npm install, not ci: the container image is cached after this hook, and
# install reuses what is already in node_modules.
npm install --no-audit --no-fund
