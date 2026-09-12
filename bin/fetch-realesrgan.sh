#!/bin/sh
# Fetch the Real-ESRGAN ncnn Vulkan engine + models (optional, needs a Vulkan GPU).
# Installs into vendor/realesrgan so aiUpscale works. Enable aiUpscale in config.json.
set -e
DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
VENDOR="$DIR/vendor/realesrgan"
URL="https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesrgan-ncnn-vulkan-20220424-ubuntu.zip"
[ -x "$VENDOR/realesrgan-ncnn-vulkan" ] && { echo "already installed at $VENDOR"; exit 0; }
mkdir -p "$VENDOR"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
echo "downloading $URL"
curl -fL "$URL" -o "$TMP/realesrgan.zip"
unzip -o -q "$TMP/realesrgan.zip" -d "$VENDOR"
echo "installed to $VENDOR"