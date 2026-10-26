#!/bin/sh
set -eu

if [ "$#" -eq 0 ]; then
  set -- bun
elif [ "${1#-}" != "$1" ] || ! command -v "$1" >/dev/null 2>&1 || { [ -f "$1" ] && [ ! -x "$1" ]; }; then
  set -- bun "$@"
fi

exec "$@"
