#!/bin/bash
# The street map for all three apps: Somalia cut out of the Protomaps OpenStreetMap build,
# as ONE file, tiles/somalia.pmtiles, which Caddy serves with range requests. No tile vendor,
# no API key, no per-view cost. Run once (and again every few months for fresher streets):
#
#   ./scripts/fetch-map-tiles.sh            # on the server, from the repo root
#   ./scripts/fetch-map-tiles.sh 20261101   # a specific daily build
#
# Without the file the apps still work — pins, lines and distances on a plain grid.
# Data: © OpenStreetMap contributors (ODbL); the apps show the attribution.
set -euo pipefail
cd "$(dirname "$0")/.."

PMTILES_VERSION=1.31.2
# Somalia and Somaliland with a margin; matches SERVICE_AREA in backend/src/domain/geo.js.
BBOX=40.8,-1.9,51.6,12.3
# Vector tiles overzoom cleanly, so 15 is street level for every zoom the apps use.
MAXZOOM=15
OUT=tiles/somalia.pmtiles

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64)  ASSET=go-pmtiles_${PMTILES_VERSION}_Linux_x86_64.tar.gz ;;
  Linux-aarch64) ASSET=go-pmtiles_${PMTILES_VERSION}_Linux_arm64.tar.gz ;;
  Darwin-x86_64) ASSET=go-pmtiles-${PMTILES_VERSION}_Darwin_x86_64.zip ;;
  Darwin-arm64)  ASSET=go-pmtiles-${PMTILES_VERSION}_Darwin_arm64.zip ;;
  *) echo "unsupported platform $(uname -s)-$(uname -m)"; exit 1 ;;
esac

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

echo "── pmtiles CLI $PMTILES_VERSION ──"
curl -fsSL -o "$WORK/$ASSET" "https://github.com/protomaps/go-pmtiles/releases/download/v${PMTILES_VERSION}/${ASSET}"
case "$ASSET" in
  *.zip) unzip -q -o "$WORK/$ASSET" -d "$WORK" ;;
  *) tar -xzf "$WORK/$ASSET" -C "$WORK" ;;
esac

BUILD=${1:-}
if [ -z "$BUILD" ]; then
  # The newest daily build. Yesterday's is always complete; today's may still be uploading.
  BUILD=$(curl -fsSL https://build-metadata.protomaps.dev/builds.json \
    | grep -o '"key":"[0-9]\{8\}\.pmtiles"' | tail -2 | head -1 | grep -o '[0-9]\{8\}')
fi
echo "── extracting Somalia from build $BUILD (bbox $BBOX, z0-$MAXZOOM) ──"
mkdir -p tiles
"$WORK/pmtiles" extract "https://build.protomaps.com/${BUILD}.pmtiles" "$WORK/somalia.pmtiles" \
  --bbox="$BBOX" --maxzoom="$MAXZOOM"
# A summary only. Not piped through head: with pipefail, head closing the pipe early fails
# the script here — after the download, before the file is moved into place.
"$WORK/pmtiles" show "$WORK/somalia.pmtiles" > "$WORK/summary.txt" || true
sed -n '1,12p' "$WORK/summary.txt"
# Swap in atomically: Caddy may be serving the old file right now.
mv "$WORK/somalia.pmtiles" "$OUT.new" && mv "$OUT.new" "$OUT"
chmod 644 "$OUT"
echo "── done: $OUT ($(du -h "$OUT" | cut -f1)) — reload the apps ──"
