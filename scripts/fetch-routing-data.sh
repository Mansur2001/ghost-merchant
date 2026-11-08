#!/bin/bash
# The routing engine for turn-by-turn navigation and road distances: the Somalia road network
# from OpenStreetMap (Geofabrik's daily extract), prepared for OSRM, then started and connected.
# No vendor, no key, no per-route cost. ~1.2 GB RAM for a minute while building; ~400 MB to run.
# Run on the server, from the repo root (again every month or two for newer roads):
#
#   ./scripts/fetch-routing-data.sh
#
# Data: © OpenStreetMap contributors (ODbL).
set -euo pipefail
cd "$(dirname "$0")/.."
FILES=${COMPOSE_FILES:--f docker-compose.yml -f docker-compose.prod.yml}
ENV_FILE=${ENV_FILE:-.env}
IMAGE=ghcr.io/project-osrm/osrm-backend:v5.27.1
mkdir -p routing
WORK=$(mktemp -d "$PWD/routing/build.XXXXXX")
trap 'rm -rf "$WORK"' EXIT

echo "── downloading the Somalia road network (OpenStreetMap, Geofabrik) ──"
curl -fsSL -o "$WORK/somalia-latest.osm.pbf" https://download.geofabrik.de/africa/somalia-latest.osm.pbf
ls -la "$WORK/somalia-latest.osm.pbf"

echo "── preparing it for routing (car profile) ──"
docker run --rm -v "$WORK:/data" "$IMAGE" osrm-extract -p /opt/car.lua /data/somalia-latest.osm.pbf > "$WORK/extract.log" 2>&1 \
  || { tail -20 "$WORK/extract.log"; exit 1; }
docker run --rm -v "$WORK:/data" "$IMAGE" osrm-partition /data/somalia-latest.osrm > /dev/null
docker run --rm -v "$WORK:/data" "$IMAGE" osrm-customize /data/somalia-latest.osrm > /dev/null

# Swap the new files in, then (re)start the engine on them.
rm -f routing/somalia-latest.osrm*
mv "$WORK"/somalia-latest.osrm* routing/
# shellcheck disable=SC2086
docker compose $FILES --profile routing up -d --force-recreate osrm

if ! grep -q '^ROUTING_URL=' "$ENV_FILE"; then
  printf '\n# Routing engine (scripts/fetch-routing-data.sh)\nROUTING_URL=http://osrm:5000\n' >> "$ENV_FILE"
  echo "── added ROUTING_URL to $ENV_FILE; restarting the backend ──"
  # shellcheck disable=SC2086
  docker compose $FILES up -d --force-recreate backend
fi
sleep 5
echo "── test route (stadium -> airport, Mogadishu) ──"
# shellcheck disable=SC2086
docker compose $FILES exec -T backend node -e "fetch('http://osrm:5000/route/v1/driving/45.3291,2.0478;45.3047,2.0144?overview=false').then(r=>r.json()).then(b=>console.log(b.code, Math.round(b.routes[0].distance)+' m'))"
echo "── done: turn-by-turn navigation is on ──"
