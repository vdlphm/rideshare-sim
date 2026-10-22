#!/usr/bin/env bash
# Re-clip the committed Seattle extract from a larger OSM file
# (e.g. Geofabrik's washington-latest.osm.pbf). Runs osmium in a throwaway container.
#
# Usage: infra/osrm/clip.sh /path/to/washington-latest.osm.pbf
set -euo pipefail

SRC="${1:?usage: $0 <source.osm.pbf>}"
BBOX="-122.42,47.57,-122.27,47.67" # lng/lat: west,south,east,north
OUT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_ABS="$(cd "$(dirname "$SRC")" && pwd)/$(basename "$SRC")"

docker run --rm \
  -v "$SRC_ABS:/in/source.osm.pbf:ro" \
  -v "$OUT_DIR:/out" \
  debian:bookworm-slim bash -c "
    apt-get update -qq >/dev/null &&
    apt-get install -y -qq osmium-tool >/dev/null 2>&1 &&
    osmium extract --overwrite -b $BBOX /in/source.osm.pbf -o /out/seattle.osm.pbf &&
    osmium fileinfo /out/seattle.osm.pbf
  "
