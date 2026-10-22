#!/bin/bash
# Builds the OSRM MLD graph from the committed pbf into /data, unless the
# graph already in /data was built from this exact pbf (sha256 match).
set -eu

SRC=/src/seattle.osm.pbf
DATA=/data
STAMP="$DATA/.source.sha256"

want=$(sha256sum "$SRC" | cut -d' ' -f1)
have=$(cat "$STAMP" 2>/dev/null || true)

if [ "$want" = "$have" ] && [ -f "$DATA/seattle.osrm.mldgr" ]; then
  echo "osrm-prep: up to date (sha256 $want), skipping"
  exit 0
fi

echo "osrm-prep: building graph for sha256 $want"
rm -f "$STAMP"
work=$(mktemp -d "$DATA/.build.XXXXXX")
trap 'rm -rf "$work"' EXIT

cp "$SRC" "$work/seattle.osm.pbf"
cd "$work"
osrm-extract -p /opt/car.lua seattle.osm.pbf
osrm-partition seattle.osrm
osrm-customize seattle.osrm
rm -f seattle.osm.pbf

# Replace old graph files, then move new ones into place (same filesystem).
rm -f "$DATA"/seattle.osrm*
for f in seattle.osrm*; do mv "$f" "$DATA/$f"; done
echo "$want" > "$STAMP.tmp"
mv "$STAMP.tmp" "$STAMP"
echo "osrm-prep: done"
