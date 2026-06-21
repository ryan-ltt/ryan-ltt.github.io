"""
fetch-stores.py — one-time dev script to pull Toronto grocery store locations from Overpass API.
Queries for Metro, Walmart, No Frills, and FreshCo stores within Toronto's OSM relation boundary.
Outputs data/stores.json.

Usage:
    python fetch-stores.py

Requires: requests (pip install requests)
"""

import json
import os
import requests

OVERPASS_URL = "https://overpass-api.de/api/interpreter"

# Toronto OSM relation
TORONTO_RELATION = 324211

# Brand name aliases → canonical chain key. Keep in sync with fetch-prices.py CHAINS.
# NOTE: order matters — longer/more specific aliases are checked first below.
CHAIN_ALIASES = {
    # Metro Inc.
    "metro plus": "metro",
    "metro": "metro",
    "super c": "metro",          # Metro-owned banner
    "food basics": "foodbasics",
    "foodbasics": "foodbasics",
    # Walmart
    "walmart supercentre": "walmart",
    "walmart": "walmart",
    # Loblaw
    "no frills": "nofrills",
    "no-frills": "nofrills",
    "real canadian superstore": "rcss",
    "loblaws": "loblaws",
    "loblaw": "loblaws",
    "zehrs": "zehrs",
    "fortinos": "fortinos",
    "valu-mart": "valumart",
    "valu mart": "valumart",
    "your independent grocer": "independent",
    "independent": "independent",
    # Empire/Sobeys
    "freshco": "freshco",
    "fresh co": "freshco",
    "sobeys": "sobeys",
    "foodland": "foodland",
    "longo's": "longos",
    "longos": "longos",
    "farm boy": "farmboy",
    "farmboy": "farmboy",
    # Independent
    "highland farms": "highlandfarms",
}

CHAIN_DISPLAY = {
    "metro": "Metro",
    "foodbasics": "Food Basics",
    "walmart": "Walmart",
    "nofrills": "No Frills",
    "loblaws": "Loblaws",
    "rcss": "Real Canadian Superstore",
    "zehrs": "Zehrs",
    "fortinos": "Fortinos",
    "valumart": "Valu-mart",
    "independent": "Independent",
    "freshco": "FreshCo",
    "sobeys": "Sobeys",
    "foodland": "Foodland",
    "longos": "Longo's",
    "farmboy": "Farm Boy",
    "highlandfarms": "Highland Farms",
}

# Brand regex covering all supported banners (case-insensitive).
BRAND_REGEX = (
    "Metro|Food Basics|Walmart|No Frills|No-Frills|"
    "Real Canadian Superstore|Loblaws|Zehrs|Fortinos|Valu-?mart|Independent|"
    "FreshCo|Fresh Co|Sobeys|Foodland|Longo|Farm Boy|Highland Farms"
)

QUERY = f"""
[out:json][timeout:90];
area[boundary=administrative]["name"="Toronto"]->.toronto;
(
  node["shop"~"supermarket|grocery"]["brand"~"{BRAND_REGEX}",i](area.toronto);
  way["shop"~"supermarket|grocery"]["brand"~"{BRAND_REGEX}",i](area.toronto);
  node["shop"~"supermarket|grocery"]["name"~"{BRAND_REGEX}",i](area.toronto);
  way["shop"~"supermarket|grocery"]["name"~"{BRAND_REGEX}",i](area.toronto);
);
out center tags;
"""


def classify_chain(tags):
    brand = tags.get("brand", "").strip().lower()
    name = tags.get("name", "").strip().lower()
    for alias, key in CHAIN_ALIASES.items():
        if alias in brand or alias in name:
            return key
    return None


def build_address(tags):
    parts = []
    num = tags.get("addr:housenumber", "")
    street = tags.get("addr:street", "")
    city = tags.get("addr:city", "")
    if num and street:
        parts.append(f"{num} {street}")
    elif street:
        parts.append(street)
    if city:
        parts.append(city)
    return ", ".join(parts) if parts else tags.get("name", "")


def fetch_stores():
    print("Querying Overpass API for Toronto grocery stores...")
    resp = requests.post(
        OVERPASS_URL,
        data={"data": QUERY},
        timeout=120,
        headers={"User-Agent": "grocerypal/1.0 (ryan-ltt.github.io)"},
    )
    resp.raise_for_status()
    data = resp.json()
    print(f"  Got {len(data['elements'])} raw elements")

    stores = []
    seen_ids = set()

    for el in data["elements"]:
        tags = el.get("tags", {})
        chain = classify_chain(tags)
        if not chain:
            continue

        el_id = f"{el['type'][0]}{el['id']}"
        if el_id in seen_ids:
            continue
        seen_ids.add(el_id)

        # nodes have lat/lon directly; ways have a center
        if el["type"] == "node":
            lat, lon = el["lat"], el["lon"]
        elif "center" in el:
            lat, lon = el["center"]["lat"], el["center"]["lon"]
        else:
            continue

        stores.append({
            "id": el_id,
            "chain": chain,
            "name": CHAIN_DISPLAY[chain],
            "address": build_address(tags),
            "lat": round(lat, 6),
            "lon": round(lon, 6),
        })

    # Sort by chain then by id for stable output
    stores.sort(key=lambda s: (s["chain"], s["id"]))

    # Summary
    from collections import Counter
    counts = Counter(s["chain"] for s in stores)
    for chain, count in sorted(counts.items()):
        print(f"  {CHAIN_DISPLAY[chain]}: {count} stores")
    print(f"  Total: {len(stores)} stores")

    os.makedirs("data", exist_ok=True)
    out_path = os.path.join(os.path.dirname(__file__), "data", "stores.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump({"stores": stores}, f, indent=2, ensure_ascii=False)
    print(f"Written to {out_path}")


if __name__ == "__main__":
    fetch_stores()
