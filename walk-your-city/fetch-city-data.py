#!/usr/bin/env python3
"""
Fetch walkable street data from Overpass API for Toronto, Vancouver, and Montreal.
Outputs one JSON file per city to ./data/<city>.json.

Usage:
    python fetch-city-data.py
    python fetch-city-data.py --cities toronto vancouver

Ways are split at intersections (nodes shared by differently-named ways) so each
segment represents one walkable block. Cross-street from/to labels are derived
from the names of ways that share the split-point nodes.
"""

import json
import math
import re
import time
import argparse
from collections import defaultdict
from datetime import datetime, timezone
from urllib import request
from urllib.parse import urlencode

OVERPASS_URL = "https://overpass-api.de/api/interpreter"

WALKABLE_TYPES = {
    "footway", "path", "pedestrian", "living_street",
    "residential", "unclassified", "service", "track",
    "steps", "bridleway", "cycleway", "tertiary", "secondary", "primary"
}

EXCLUDE_TYPES = {
    "motorway", "motorway_link", "trunk", "trunk_link",
    "primary_link", "secondary_link", "tertiary_link"
}

CITIES = {
    "toronto": {
        "relation_id": 324211,
        "center": [43.6532, -79.3832],
        "zoom": 12,
    },
    "vancouver": {
        "relation_id": 1852574,
        "center": [49.2827, -123.1207],
        "zoom": 12,
    },
    "montreal": {
        "relation_id": 1634158,
        "center": [45.5017, -73.5673],
        "zoom": 12,
    },
}

NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"

GEO_PRECISION = 5   # ~1m
MIN_LENGTH_M = 10   # low threshold — coordinate rounding can shorten segments slightly


# ---------------------------------------------------------------------------
# Geometry helpers
# ---------------------------------------------------------------------------

def haversine(lat1, lon1, lat2, lon2):
    R = 6371000.0
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlam = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlam / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


def way_length(geometry):
    total = 0.0
    for i in range(len(geometry) - 1):
        total += haversine(geometry[i][0], geometry[i][1], geometry[i + 1][0], geometry[i + 1][1])
    return round(total, 1)


def midpoint(geometry):
    lats = [p[0] for p in geometry]
    lons = [p[1] for p in geometry]
    return (sum(lats) / len(lats), sum(lons) / len(lons))


def bearing(geometry):
    if len(geometry) < 2:
        return 0.0
    lat1, lon1 = math.radians(geometry[0][0]), math.radians(geometry[0][1])
    lat2, lon2 = math.radians(geometry[-1][0]), math.radians(geometry[-1][1])
    dlon = lon2 - lon1
    x = math.sin(dlon) * math.cos(lat2)
    y = math.cos(lat1) * math.sin(lat2) - math.sin(lat1) * math.cos(lat2) * math.cos(dlon)
    return math.degrees(math.atan2(x, y)) % 180


def bearing_diff(b1, b2):
    diff = abs(b1 - b2) % 180
    return min(diff, 180 - diff)


# ---------------------------------------------------------------------------
# Overpass
# ---------------------------------------------------------------------------

def fetch_overpass(query):
    payload = urlencode({"data": query}).encode("utf-8")
    req = request.Request(
        OVERPASS_URL,
        data=payload,
        headers={
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": "walk-your-city/1.0 (ryan-ltt.github.io)",
        },
    )
    with request.urlopen(req, timeout=240) as resp:
        return json.loads(resp.read().decode("utf-8"))


def overpass_ways_query(relation_id):
    area_id = relation_id + 3600000000
    return f"""
[out:json][timeout:240];
area({area_id})->.searchArea;
way["highway"](area.searchArea)->.ways;
.ways out body geom;
"""


# ---------------------------------------------------------------------------
# Intersection splitting
# ---------------------------------------------------------------------------

def split_ways_at_intersections(raw_ways):
    """
    Split each way at every node that is shared with a differently-named way.
    Returns a flat list of sub-ways. Each sub-way carries `_node_ids` (list of
    OSM node IDs) and `_split_node_names` mapping node_id -> set(cross names).
    """

    # 1. Build node_id -> set of way names that pass through it
    node_to_names: dict[int, set] = defaultdict(set)
    for w in raw_ways:
        for nid in w["_node_ids"]:
            node_to_names[nid].add(w["name"])

    # 2. For each way, find interior indices where a split should happen
    #    (node shared by a way with a DIFFERENT name)
    result = []
    sub_id_counter = defaultdict(int)

    for w in raw_ways:
        node_ids = w["_node_ids"]
        coords   = w["_coords"]   # parallel list, same length
        name     = w["name"]

        # Find split points: interior nodes (not first/last) that have cross-streets
        split_indices = set()
        for i, nid in enumerate(node_ids):
            if i == 0 or i == len(node_ids) - 1:
                continue
            others = node_to_names[nid] - {name}
            if others:
                split_indices.add(i)

        # Build segments by splitting at those indices
        seg_starts = [0] + sorted(split_indices)
        seg_ends   = sorted(split_indices) + [len(node_ids) - 1]

        for start, end in zip(seg_starts, seg_ends):
            seg_node_ids = node_ids[start:end + 1]
            seg_coords   = coords[start:end + 1]

            if len(seg_coords) < 2:
                continue

            # Cross-street names at endpoints
            from_names = sorted(node_to_names[seg_node_ids[0]]  - {name})[:2]
            to_names   = sorted(node_to_names[seg_node_ids[-1]] - {name})[:2]

            sub_id_counter[w["id"]] += 1
            seg_id = f"{w['id']}_{sub_id_counter[w['id']]}" if sub_id_counter[w["id"]] > 1 or split_indices else w["id"]

            result.append({
                "id": seg_id,
                "name": w["name"],
                "highway": w["highway"],
                "geometry": seg_coords,
                "length_m": way_length(seg_coords),
                "from": from_names[0] if from_names else "",
                "to":   to_names[0]   if to_names   else "",
            })

    return result


# ---------------------------------------------------------------------------
# Dual-carriageway collapse
# ---------------------------------------------------------------------------

def collapse_dual_carriageways(ways):
    named_by_name: dict[str, list] = defaultdict(list)
    for w in ways:
        key = re.sub(r"\s+", " ", w["name"].strip().lower())
        named_by_name[key].append(w)

    way_to_group: dict[str, str] = {}
    groups = []

    for norm_name, group_ways in named_by_name.items():
        if len(group_ways) < 2:
            continue

        collapse_pairs = []
        for i in range(len(group_ways)):
            for j in range(i + 1, len(group_ways)):
                wa, wb = group_ways[i], group_ways[j]
                mid_a = midpoint(wa["geometry"])
                mid_b = midpoint(wb["geometry"])
                dist = haversine(mid_a[0], mid_a[1], mid_b[0], mid_b[1])
                if dist > 80:
                    continue
                if bearing_diff(bearing(wa["geometry"]), bearing(wb["geometry"])) > 30:
                    continue
                collapse_pairs.append((i, j))

        if not collapse_pairs:
            continue

        parent = list(range(len(group_ways)))

        def find(x):
            while parent[x] != x:
                parent[x] = parent[parent[x]]
                x = parent[x]
            return x

        def union(x, y):
            parent[find(x)] = find(y)

        for i, j in collapse_pairs:
            union(i, j)

        comps: dict[int, list] = defaultdict(list)
        for idx in range(len(group_ways)):
            comps[find(idx)].append(idx)

        existing_ids = {g["groupId"] for g in groups}
        for comp_members in comps.values():
            if len(comp_members) < 2:
                continue
            member_ways = [group_ways[k] for k in comp_members]
            base_id = "g_" + re.sub(r"[^a-z0-9]+", "_", norm_name).strip("_")
            suffix, candidate = 1, base_id
            while candidate in existing_ids:
                candidate = f"{base_id}_{suffix}"
                suffix += 1
            existing_ids.add(candidate)
            group_id = candidate

            groups.append({
                "groupId": group_id,
                "name": member_ways[0]["name"],
                "wayIds": [w["id"] for w in member_ways],
                "totalLength_m": round(sum(w["length_m"] for w in member_ways), 1),
                "geometry": [w["geometry"] for w in member_ways],
            })
            for w in member_ways:
                way_to_group[w["id"]] = group_id

    for w in ways:
        gid = way_to_group.get(w["id"])
        if gid:
            w["groupId"] = gid

    return ways, groups


# ---------------------------------------------------------------------------
# Main city processor
# ---------------------------------------------------------------------------

def process_city(city_key):
    cfg = CITIES[city_key]
    print(f"\n=== {city_key.upper()} ===")

    print("  Fetching highway ways...")
    raw = fetch_overpass(overpass_ways_query(cfg["relation_id"]))
    elements = raw.get("elements", [])
    print(f"  Raw elements from Overpass: {len(elements)}")

    # Parse all walkable named ways, keeping full node ID list
    raw_ways = []
    for el in elements:
        if el.get("type") != "way":
            continue
        tags = el.get("tags", {})
        highway = tags.get("highway", "")
        if highway in EXCLUDE_TYPES or highway not in WALKABLE_TYPES:
            continue
        name = tags.get("name", "")
        if not name:
            continue

        node_ids = el.get("nodes", [])
        geo_nodes = el.get("geometry", [])

        # geometry list from Overpass may be shorter than nodes if some nodes are missing
        # coords and node_ids must align; skip if they don't
        coords = [
            [round(nd["lat"], GEO_PRECISION), round(nd["lon"], GEO_PRECISION)]
            for nd in geo_nodes
            if "lat" in nd
        ]
        if len(coords) != len(node_ids):
            # Fallback: use coords only, no splitting possible
            node_ids = list(range(len(coords)))  # synthetic IDs, won't match anything

        if len(coords) < 2:
            continue

        raw_ways.append({
            "id": f"way/{el['id']}",
            "name": name,
            "highway": highway,
            "_node_ids": node_ids,
            "_coords": coords,
        })

    print(f"  Walkable named ways (before split): {len(raw_ways)}")

    # Split at intersections → block-level segments
    print("  Splitting at intersections...")
    ways = split_ways_at_intersections(raw_ways)

    # Drop very short segments
    ways = [w for w in ways if w["length_m"] >= MIN_LENGTH_M]
    print(f"  Segments after split + length filter (>={MIN_LENGTH_M}m): {len(ways)}")

    # Dual-carriageway collapse
    ways, groups = collapse_dual_carriageways(ways)
    print(f"  Dual-carriageway groups: {len(groups)}")

    result = {
        "city": city_key,
        "displayName": CITIES[city_key].get("displayName", city_key.replace("_", " ").title()),
        "center": cfg["center"],
        "zoom": cfg["zoom"],
        "fetchedAt": datetime.now(timezone.utc).isoformat(),
        "ways": ways,
        "groups": groups,
    }

    out_path = f"data/{city_key}.json"
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(result, f, separators=(",", ":"))

    size_kb = len(json.dumps(result)) / 1024
    print(f"  Written to {out_path} ({size_kb:.0f} KB)")
    return result


def lookup_city(query):
    """
    Search Nominatim for a city by name and return a config dict with
    relation_id, center, and zoom. Prompts the user to pick if multiple
    admin-level relations are returned.
    """
    params = urlencode({
        "q": query,
        "format": "jsonv2",
        "limit": 10,
        "featuretype": "city",
        "addressdetails": 0,
    })
    url = f"{NOMINATIM_URL}?{params}"
    req = request.Request(url, headers={"User-Agent": "walk-your-city/1.0 (ryan-ltt.github.io)"})
    with request.urlopen(req, timeout=30) as resp:
        results = json.loads(resp.read().decode("utf-8"))

    # Keep only relations (OSM administrative boundaries)
    relations = [r for r in results if r.get("osm_type") == "relation"]
    if not relations:
        # Fall back to all results if no relations found
        relations = results
    if not relations:
        raise ValueError(f"No results found for '{query}'")

    if len(relations) == 1:
        chosen = relations[0]
    else:
        print(f"\n  Multiple results for '{query}':")
        for i, r in enumerate(relations):
            print(f"    [{i}] {r.get('display_name', '?')}  (relation/{r['osm_id']})")
        while True:
            try:
                idx = int(input("  Choose number: ").strip())
                if 0 <= idx < len(relations):
                    chosen = relations[idx]
                    break
            except (ValueError, KeyboardInterrupt):
                pass
            print("  Invalid choice, try again.")

    lat = float(chosen["lat"])
    lon = float(chosen["lon"])
    relation_id = int(chosen["osm_id"])
    display_name = chosen.get("display_name", query).split(",")[0].strip()
    print(f"  Found: {chosen.get('display_name', '?')}  (relation/{relation_id})")

    return display_name, {
        "relation_id": relation_id,
        "center": [round(lat, 4), round(lon, 4)],
        "zoom": 12,
    }


def main():
    parser = argparse.ArgumentParser(description="Fetch OSM walkable street data.")
    parser.add_argument("--cities", nargs="+", choices=list(CITIES.keys()), default=None,
                        help="Re-fetch one or more already-known cities.")
    parser.add_argument("--add", nargs="+", metavar="CITY_NAME",
                        help="Look up new cities by name via Nominatim and fetch them.")
    args = parser.parse_args()

    to_fetch = []

    if args.add:
        for query in args.add:
            print(f"\nLooking up '{query}' on Nominatim...")
            display_name, cfg = lookup_city(query)
            key = re.sub(r"[^a-z0-9]+", "_", display_name.lower()).strip("_")
            if key in CITIES:
                print(f"  '{key}' already in CITIES dict, re-using existing config.")
            else:
                CITIES[key] = cfg
                print(f"  Added as key '{key}' (relation/{cfg['relation_id']})")
                print(f"  NOTE: add this to the CITIES dict in the script and the")
                print(f"        city dropdown in index.html to make it permanent:")
                print(f'    "{key}": {json.dumps(cfg)},')
            to_fetch.append(key)
            time.sleep(1)  # be polite to Nominatim

    if args.cities:
        to_fetch += [c for c in args.cities if c not in to_fetch]

    if not to_fetch:
        to_fetch = list(CITIES.keys())

    for i, city in enumerate(to_fetch):
        if i > 0:
            print("  Waiting 5s between requests...")
            time.sleep(5)
        process_city(city)

    print("\nDone.")


if __name__ == "__main__":
    main()
