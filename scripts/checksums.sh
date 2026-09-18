#!/bin/sh
# Write dist/checksums.txt over this repository's release assets.
#
# install.sh and install.ps1 verify the CLI archive against this file, looked
# up by basename, so these globs must match what package-release.sh emits.
set -eu
ROOT=$(CDPATH='' cd -- "$(dirname "$0")/.." && pwd)
cd "$ROOT"
FILES="dist/opencrew-cli_*.tar.gz dist/opencrew-cli_*.zip"
: > dist/checksums.txt
# shellcheck disable=SC2086
for file in $FILES; do
  [ -f "$file" ] || continue
  if command -v sha256sum >/dev/null 2>&1; then HASH=$(sha256sum "$file" | awk '{print $1}')
  else HASH=$(shasum -a 256 "$file" | awk '{print $1}'); fi
  printf '%s  %s\n' "$HASH" "$(basename "$file")" >> dist/checksums.txt
done
echo "wrote $(wc -l < dist/checksums.txt) checksum line(s)"
