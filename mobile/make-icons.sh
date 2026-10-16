#!/bin/bash
# Resize the GuriKaabe icon masters into Android mipmaps.
#
# The masters in resources/ are cut from GuriKaabe-brandsheet.png by
# scripts/brandsheet-icons.py (needs Pillow). This step only resizes, with macOS `sips`, so a
# normal build needs nothing extra installed. Re-runnable.
set -e
cd "$(dirname "$0")"

RES="android/app/src/main/res"

for f in launcher-master.png launcher-round-master.png launcher-foreground-master.png play-store-icon-512.png; do
  [ -f "resources/$f" ] || { echo "missing resources/$f — run scripts/brandsheet-icons.py first"; exit 1; }
done

# density -> launcher px (adaptive foreground is 108dp, so it's larger at each density)
write_density() { # write_density <dir> <launcher_px> <foreground_px>
  local dir="$RES/mipmap-$1" launcher="$2" fg="$3"
  mkdir -p "$dir"
  sips -z "$launcher" "$launcher" resources/launcher-master.png --out "$dir/ic_launcher.png" >/dev/null
  sips -z "$launcher" "$launcher" resources/launcher-round-master.png --out "$dir/ic_launcher_round.png" >/dev/null
  sips -z "$fg" "$fg" resources/launcher-foreground-master.png --out "$dir/ic_launcher_foreground.png" >/dev/null
  echo "  $1: ${launcher}px launcher, ${fg}px foreground"
}

echo "Generating launcher icons…"
write_density mdpi     48 108
write_density hdpi     72 162
write_density xhdpi    96 216
write_density xxhdpi  144 324
write_density xxxhdpi 192 432

# The adaptive icon's background layer: the brand cream, so the house sits on the same tile
# as on the brand sheet whatever shape the launcher masks it to.
BG="$(tr -d '[:space:]' < resources/adaptive-background.txt 2>/dev/null || echo '#FDF1D4')"
cat > "$RES/values/ic_launcher_background.xml" <<XML
<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">$BG</color>
</resources>
XML

echo "Play listing icon: resources/play-store-icon-512.png (512x512, cut from the brand sheet)"
echo "Done."
