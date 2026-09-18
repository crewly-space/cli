#!/bin/sh
# Package this repository's release asset: the opencrew CLI binary.
#
# The server and the app ship from opencrew-server and are packaged there.
# install.sh fetches both assets and verifies each against its own release
# checksums.txt.
#
#   usage: package-release.sh <os> <arch> <opencrew-cli-binary>
set -eu

if [ "$#" -ne 3 ]; then
  echo "usage: package-release.sh <os> <arch> <opencrew-cli-binary>" >&2
  exit 2
fi
OS=$1
ARCH=$2
CLI=$3
ROOT=$(CDPATH='' cd -- "$(dirname "$0")/.." && pwd)
OUT="$ROOT/dist"
STAGE="$OUT/stage_${OS}_${ARCH}"
NAME="opencrew-cli_${OS}_${ARCH}"

[ -f "$CLI" ] || { echo "missing CLI artifact: $CLI" >&2; exit 1; }
rm -rf "$STAGE"
mkdir -p "$STAGE" "$OUT"

if [ "$OS" = "windows" ]; then
  cp "$CLI" "$STAGE/opencrew.exe"
  if command -v zip >/dev/null 2>&1; then
    (cd "$STAGE" && zip -qr "$OUT/$NAME.zip" ./*)
  elif command -v python3 >/dev/null 2>&1; then
    (cd "$STAGE" && python3 -m zipfile -c "$OUT/$NAME.zip" ./*)
  else
    echo "zip or python3 is required to package Windows" >&2
    exit 1
  fi
else
  cp "$CLI" "$STAGE/opencrew"
  chmod 0755 "$STAGE/opencrew"
  tar -C "$STAGE" -czf "$OUT/$NAME.tar.gz" .
fi

rm -rf "$STAGE"
echo "packaged $NAME"
