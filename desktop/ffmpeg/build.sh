#!/usr/bin/env bash
# Builds the patched ffmpeg (see Dockerfile) and puts it where the app and
# electron-builder look for it: vendor/ffmpeg-gnutls.exe.
#
# Needs Docker. Runs from Git Bash or WSL; the first build takes a while,
# later ones reuse every layer above the one that changed.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
vendor="$here/../vendor"
mkdir -p "$vendor"

docker build --output "type=local,dest=$here/out" "$here"

# The previous binary is kept beside the new one, so going back is a rename.
if [ -f "$vendor/ffmpeg-gnutls.exe" ] && [ ! -f "$vendor/ffmpeg-gnutls.previous.exe" ]; then
  mv "$vendor/ffmpeg-gnutls.exe" "$vendor/ffmpeg-gnutls.previous.exe"
fi
cp "$here/out/ffmpeg-gnutls.exe" "$vendor/ffmpeg-gnutls.exe"
rm -rf "$here/out"
echo "vendor/ffmpeg-gnutls.exe updated"
