#!/bin/sh
set -e
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
VENDOR="$DIR/../vendor"
for f in stb_image.h stb_image_write.h stb_image_resize2.h; do
	if [ ! -f "$VENDOR/$f" ]; then
		echo "fetching $f..."
		curl -sfL "https://raw.githubusercontent.com/nothings/stb/master/$f" -o "$VENDOR/$f"
	fi
done
cc -O2 -s -flto -o "$DIR/enhance_icons" "$DIR/enhance_icons.c" -lm
echo "built $DIR/enhance_icons"