#!/bin/sh
# Local npm commands reuse an exported token or the existing GitHub CLI login.
set -eu

if [ -z "${NODE_AUTH_TOKEN:-}" ]; then
    NODE_AUTH_TOKEN=$(gh auth token --hostname github.com)
fi
export NODE_AUTH_TOKEN

auth_config=$(mktemp "${TMPDIR:-/tmp}/pfire-npmrc.XXXXXX")
trap 'rm -f "$auth_config"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Preserve the user's other npm options without changing their config file.
user_config=${NPM_CONFIG_USERCONFIG:-${HOME}/.npmrc}
if [ -f "$user_config" ]; then
    cat "$user_config" > "$auth_config"
fi
printf '\n%s\n' '//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}' >> "$auth_config"
NPM_CONFIG_USERCONFIG="$auth_config" npm "$@"
