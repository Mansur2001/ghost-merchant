#!/bin/bash
# Rasterize the GuriKaabe icon SVGs into Android mipmaps.
#
# Uses macOS qlmanage (no ImageMagick/librsvg dependency) then sips to resize. Re-runnable:
# edit resources/*.svg and run this again.
set -e
cd "$(dirname "$0")"

RES="android/app/src/main/res"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

render() { # render <svg> <out.png>
  qlmanage -t -s 1024 -o "$TMP" "$1" >/dev/null 2>&1
  mv "$TMP/$(basename "$1").png" "$2"
}

render resources/icon.svg "$TMP/base.png"
render resources/icon-foreground.svg "$TMP/fg.png"

# density -> launcher px (adaptive foreground is 108dp, so it's larger at each density)
write_density() { # write_density <dir> <launcher_px> <foreground_px>
  local dir="$RES/mipmap-$1" launcher="$2" fg="$3"
  mkdir -p "$dir"
  sips -z "$launcher" "$launcher" "$TMP/base.png" --out "$dir/ic_launcher.png" >/dev/null
  sips -z "$launcher" "$launcher" "$TMP/base.png" --out "$dir/ic_launcher_round.png" >/dev/null
  sips -z "$fg" "$fg" "$TMP/fg.png" --out "$dir/ic_launcher_foreground.png" >/dev/null
  echo "  $1: ${launcher}px launcher, ${fg}px foreground"
}

echo "Generating launcher icons…"
write_density mdpi     48 108
write_density hdpi     72 162
write_density xhdpi    96 216
write_density xxhdpi  144 324
write_density xxxhdpi 192 432

# The adaptive icon's background layer sits behind the foreground; black matches the app.
cat > "$RES/values/ic_launcher_background.xml" <<'XML'
<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">#000000</color>
</resources>
XML

# Play Console also wants a 512x512 PNG for the store listing.
sips -z 512 512 "$TMP/base.png" --out "resources/play-store-icon-512.png" >/dev/null
echo "Play listing icon: resources/play-store-icon-512.png (512x512)"
echo "Done."
