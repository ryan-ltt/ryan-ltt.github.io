"""
fetch-prices.py — scheduled scraper that pulls current weekly grocery flyer deals
from the Flipp aggregated flyer API for a set of Toronto/Ontario postal codes and
writes them to the Firestore `scraped_prices` collection (machine-scraped data,
kept separate from the community `flyer_prices` collection).

Modeled on fetch-stores.py (stdlib + requests, User-Agent header, chain-alias
mapping, summary print, batched output).

Usage:
    python fetch-prices.py --dry-run     # fetch + print summary, no DB write
    python fetch-prices.py               # fetch + write to Firestore

Env:
    GROCERYPAL_POSTAL_CODES   comma-list, default a few Toronto codes
    FIREBASE_SERVICE_ACCOUNT  service-account JSON (string) — required for DB write

Requires: requests, firebase-admin (pip install requests firebase-admin)

--- Per-chain fallback (investigate, don't build yet) -------------------------
If Flipp blocks/changes its endpoints, individual banners expose their own
flyer/product JSON:
  - Loblaw banners (No Frills, Loblaws, RCSS, Zehrs, Fortinos, Valu-mart,
    Independent) share the PC Express API (api.pcexpress.ca) — needs an
    x-apikey header and a store id; heavier anti-bot.
  - Walmart.ca exposes a flyer GraphQL/JSON endpoint; aggressive bot detection.
  - Metro.ca / Food Basics have a flyer JSON endpoint scoped by store.
Only implement if Flipp proves unreliable. Document findings here.
-------------------------------------------------------------------------------
"""

import argparse
import json
import os
import re
import sys
import time
from collections import Counter
from datetime import datetime, timedelta, timezone

import requests

# ── Flipp endpoints (reverse-engineered, verified live 2026-06) ───────────────
# Flyer list:  GET /flipp/flyers?postal_code=<P>&locale=en-ca   → {"flyers":[...]}
# Flyer items: GET /flipp/flyers/<id>?locale=en-ca              → {"items":[...]}
#   (the older /flyers/<id>/flyer_items path now 404s)
FLIPP_FLYERS_URL = "https://backflipp.wishabi.com/flipp/flyers"
FLIPP_FLYER_DETAIL_URL = "https://backflipp.wishabi.com/flipp/flyers/{flyer_id}"

USER_AGENT = "grocerypal/1.0 (ryan-ltt.github.io)"

DEFAULT_POSTAL_CODES = ["M5V2T6", "M4C1B5", "M9V4B3"]  # downtown, east, NW Toronto

REGION = "ontario"
REQUEST_SLEEP = 0.5  # polite delay between Flipp calls

# ── Chain config — SINGLE SOURCE OF TRUTH ─────────────────────────────────────
# parent → list of (chain_key, display_name, [flipp merchant name aliases])
# Adding/removing a chain is a one-line edit here. Merchant matching is done by
# lower-cased substring against the Flipp `merchant` field.
CHAINS = {
    "Loblaw": [
        ("nofrills",    "No Frills",                 ["no frills", "nofrills"]),
        ("loblaws",     "Loblaws",                   ["loblaws", "loblaw"]),
        ("rcss",        "Real Canadian Superstore",  ["real canadian superstore", "superstore"]),
        ("zehrs",       "Zehrs",                     ["zehrs"]),
        ("fortinos",    "Fortinos",                  ["fortinos"]),
        ("valumart",    "Valu-mart",                 ["valu-mart", "valu mart", "valumart"]),
        ("independent", "Independent",               ["independent", "your independent grocer"]),
    ],
    "Empire/Sobeys": [
        ("freshco",  "FreshCo",  ["freshco", "fresh co"]),
        ("sobeys",   "Sobeys",   ["sobeys"]),
        ("foodland", "Foodland", ["foodland"]),
        ("longos",   "Longo's",  ["longo's", "longos", "longo"]),
        ("farmboy",  "Farm Boy", ["farm boy", "farmboy"]),
    ],
    "Metro Inc.": [
        ("metro",      "Metro",       ["metro"]),
        ("foodbasics", "Food Basics", ["food basics", "foodbasics"]),
    ],
    "Walmart": [
        ("walmart", "Walmart", ["walmart"]),
    ],
    "Independent": [
        ("highlandfarms", "Highland Farms", ["highland farms", "highland farm"]),
    ],
}

# Flatten to lookup structures
CHAIN_DISPLAY = {}
MERCHANT_ALIASES = []  # list of (alias_substring, chain_key), longest-first
for _parent, _banners in CHAINS.items():
    for _key, _display, _aliases in _banners:
        CHAIN_DISPLAY[_key] = _display
        for _alias in _aliases:
            MERCHANT_ALIASES.append((_alias.lower(), _key))
# Longest alias first so "no frills" wins over a hypothetical shorter overlap
MERCHANT_ALIASES.sort(key=lambda x: -len(x[0]))


def classify_merchant(merchant_name):
    """Map a Flipp merchant name → our canonical chain key, or None if unsupported."""
    if not merchant_name:
        return None
    name = merchant_name.strip().lower()
    for alias, key in MERCHANT_ALIASES:
        if alias in name:
            return key
    return None


# ── Size parsing (ported from grocerypal.js extractTotalMl / extractTotalG) ───
def extract_total_ml(name):
    if not name:
        return None
    multi = re.search(r"(\d+)\s*x\s*(\d+(?:\.\d+)?)\s*ml", name, re.I)
    if multi:
        return int(multi.group(1)) * float(multi.group(2))
    single = re.search(r"(\d+(?:\.\d+)?)\s*(?:L|litre|liter)\b", name, re.I)
    if single:
        return float(single.group(1)) * 1000
    ml = re.search(r"(\d+(?:\.\d+)?)\s*ml", name, re.I)
    if ml:
        return float(ml.group(1))
    return None


def extract_total_g(name):
    if not name:
        return None
    kg = re.search(r"(\d+(?:\.\d+)?)\s*kg\b", name, re.I)
    if kg:
        return float(kg.group(1)) * 1000
    g = re.search(r"(\d+(?:\.\d+)?)\s*g\b", name, re.I)
    if g:
        return float(g.group(1))
    return None


def infer_unit(pre_text, post_text):
    """Infer 'lb'/'kg'/'each' from Flipp pre/post price text (e.g. '/lb', '/kg')."""
    blob = f"{pre_text or ''} {post_text or ''}".lower()
    if "/lb" in blob or "per lb" in blob or "lb" == blob.strip():
        return "lb"
    if "/kg" in blob or "per kg" in blob or "kg" == blob.strip():
        return "kg"
    return "each"


def parse_price(raw):
    """Parse a Flipp price (number or string like '$3.99' / '2/$5') to float, or None."""
    if raw is None:
        return None
    if isinstance(raw, (int, float)):
        return round(float(raw), 2)
    s = str(raw)
    # Handle "N/$M" multi-buy → per-unit price
    multi = re.search(r"(\d+)\s*/\s*\$?\s*(\d+(?:\.\d+)?)", s)
    if multi:
        n = int(multi.group(1))
        total = float(multi.group(2))
        if n > 0:
            return round(total / n, 2)
    m = re.search(r"(\d+(?:\.\d+)?)", s.replace(",", ""))
    if m:
        return round(float(m.group(1)), 2)
    return None


# ── Flipp fetch ───────────────────────────────────────────────────────────────
def http_get_json(url, params=None):
    resp = requests.get(
        url,
        params=params,
        timeout=60,
        headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
    )
    resp.raise_for_status()
    return resp.json()


def fetch_flyers(postal_code):
    """Fetch the list of active flyers for a postal code."""
    data = http_get_json(FLIPP_FLYERS_URL, params={"postal_code": postal_code, "locale": "en-ca"})
    # The endpoint historically returns either a bare list or {"flyers": [...]}.
    if isinstance(data, dict):
        return data.get("flyers", data.get("items", []))
    return data or []


def fetch_flyer_items(flyer_id):
    """Fetch the items for a single flyer (from the flyer-detail endpoint)."""
    url = FLIPP_FLYER_DETAIL_URL.format(flyer_id=flyer_id)
    data = http_get_json(url, params={"locale": "en-ca"})
    if isinstance(data, dict):
        return data.get("items", data.get("flyer_items", []))
    return data or []


def normalize_item(raw, chain, valid_from, valid_to, scraped_at):
    """Turn a raw Flipp flyer item into a scraped_prices document, or None to skip."""
    name = (raw.get("name") or raw.get("item_name") or "").strip()
    if not name or len(name) < 2:
        return None

    price = parse_price(raw.get("current_price"))
    if price is None:
        price = parse_price(raw.get("price"))
    if price is None or price <= 0:
        return None

    unit = infer_unit(raw.get("pre_price_text"), raw.get("post_price_text"))

    # Prefer the item's own validity dates (Flipp sets them per-item); fall back
    # to the flyer-level dates passed in.
    vf = _norm_date(raw.get("valid_from"), valid_from)
    vt = _norm_date(raw.get("valid_to"), valid_to)

    total_ml = extract_total_ml(name)
    total_g = extract_total_g(name)
    unit_price_ml = round(price / total_ml, 6) if total_ml else None
    unit_price_g = round(price / total_g, 6) if total_g else None

    return {
        "region": REGION,
        "chain": chain,
        "item_name": name,
        "barcode": None,
        "price": price,
        "unit": unit,
        "pack_count": 1,
        "total_ml": total_ml,
        "total_g": total_g,
        "unit_price_ml": unit_price_ml,
        "unit_price_g": unit_price_g,
        "valid_from": vf,
        "valid_to": vt,
        "source": "scraped",
        "scraped_at": scraped_at,
    }


def _norm_date(v, default):
    """Coerce a value to a YYYY-MM-DD string, or return default if unparseable."""
    if not v:
        return default
    s = str(v)[:10]
    try:
        datetime.strptime(s, "%Y-%m-%d")
        return s
    except ValueError:
        return default


def flyer_dates(flyer):
    """Extract valid_from / valid_to (YYYY-MM-DD) from a flyer, with sane defaults."""
    today = datetime.now(timezone.utc).date()
    vf = _norm_date(flyer.get("valid_from") or flyer.get("start_date"), today.isoformat())
    vt = _norm_date(flyer.get("valid_to") or flyer.get("end_date"), (today + timedelta(days=7)).isoformat())
    return vf, vt


def scrape(postal_codes):
    """Fetch + normalize all supported-chain items across the given postal codes.
    Returns a dict keyed by `chain:barcode|name` → lowest-price document (deduped)."""
    scraped_at = datetime.now(timezone.utc).isoformat()
    deals = {}
    seen_flyers = set()

    for postal in postal_codes:
        print(f"\nPostal {postal}: fetching flyers…")
        try:
            flyers = fetch_flyers(postal)
        except Exception as e:
            print(f"  ! flyer list fetch failed: {e}")
            continue
        print(f"  {len(flyers)} flyers")
        time.sleep(REQUEST_SLEEP)

        for flyer in flyers:
            merchant = flyer.get("merchant") or flyer.get("merchant_name") or flyer.get("name")
            chain = classify_merchant(merchant)
            if not chain:
                continue
            flyer_id = flyer.get("id") or flyer.get("flyer_id")
            if not flyer_id or flyer_id in seen_flyers:
                continue
            seen_flyers.add(flyer_id)

            vf, vt = flyer_dates(flyer)
            try:
                items = fetch_flyer_items(flyer_id)
            except Exception as e:
                print(f"  ! items fetch failed for flyer {flyer_id} ({merchant}): {e}")
                continue
            time.sleep(REQUEST_SLEEP)

            for raw in items:
                doc = normalize_item(raw, chain, vf, vt, scraped_at)
                if not doc:
                    continue
                key = f"{chain}:{doc['barcode'] or doc['item_name'].lower().strip()}"
                if key not in deals or doc["price"] < deals[key]["price"]:
                    deals[key] = doc

    return deals


def print_summary(deals):
    counts = Counter(d["chain"] for d in deals.values())
    print("\nPer-chain item counts:")
    for key in sorted(CHAIN_DISPLAY):
        c = counts.get(key, 0)
        flag = "" if c else "   (no items — Flipp may lack coverage in these postal codes)"
        print(f"  {CHAIN_DISPLAY[key]:<28} {c}{flag}")
    print(f"  {'Total':<28} {len(deals)}")


# ── Firestore write ───────────────────────────────────────────────────────────
def get_db():
    import firebase_admin
    from firebase_admin import credentials, firestore

    cred_json = os.environ.get("FIREBASE_SERVICE_ACCOUNT")
    if not cred_json:
        raise SystemExit("FIREBASE_SERVICE_ACCOUNT env var not set (required for DB write).")
    cred = credentials.Certificate(json.loads(cred_json))
    if not firebase_admin._apps:
        firebase_admin.initialize_app(cred)
    return firestore.client()


def write_to_firestore(deals):
    db = get_db()
    col = db.collection("scraped_prices")
    today = datetime.now(timezone.utc).date().isoformat()

    chains_in_run = sorted({d["chain"] for d in deals.values()})
    print(f"\nWriting {len(deals)} docs for chains: {', '.join(chains_in_run)}")

    # ── Idempotency: full-replace per chain being refreshed ──
    # Delete existing scraped_prices for the region+chains we're about to write.
    deleted = 0
    for chain in chains_in_run:
        old = col.where("region", "==", REGION).where("chain", "==", chain).stream()
        batch = db.batch()
        n = 0
        for doc in old:
            batch.delete(doc.reference)
            n += 1
            deleted += 1
            if n >= 450:
                batch.commit()
                batch = db.batch()
                n = 0
        if n:
            batch.commit()
    print(f"  Replaced (deleted) {deleted} existing docs for refreshed chains")

    # ── Belt-and-suspenders: delete any region docs already past valid_to ──
    expired = col.where("region", "==", REGION).where("valid_to", "<", today).stream()
    batch = db.batch()
    n = exp_count = 0
    for doc in expired:
        batch.delete(doc.reference)
        n += 1
        exp_count += 1
        if n >= 450:
            batch.commit()
            batch = db.batch()
            n = 0
    if n:
        batch.commit()
    if exp_count:
        print(f"  Cleaned up {exp_count} expired docs (valid_to < {today})")

    # ── Insert fresh docs, batched ≤500 ──
    written = 0
    batch = db.batch()
    n = 0
    for doc in deals.values():
        # ttl = valid_to + 7 days, as a Firestore timestamp (matches flyer-import.js)
        ttl_date = datetime.strptime(doc["valid_to"], "%Y-%m-%d").replace(tzinfo=timezone.utc) + timedelta(days=7)
        out = dict(doc)
        out["ttl"] = ttl_date
        batch.set(col.document(), out)
        n += 1
        written += 1
        if n >= 450:
            batch.commit()
            batch = db.batch()
            n = 0
    if n:
        batch.commit()
    print(f"  Wrote {written} docs to scraped_prices")


def main():
    parser = argparse.ArgumentParser(description="Scrape weekly grocery flyer deals from Flipp.")
    parser.add_argument("--dry-run", action="store_true",
                        help="fetch + print summary only; no Firestore write")
    args = parser.parse_args()

    postal_env = os.environ.get("GROCERYPAL_POSTAL_CODES", "")
    postal_codes = [p.strip().replace(" ", "") for p in postal_env.split(",") if p.strip()] \
        or DEFAULT_POSTAL_CODES

    print(f"Postal codes: {', '.join(postal_codes)}")
    deals = scrape(postal_codes)
    print_summary(deals)

    if not deals:
        print("\nNo deals scraped — aborting before any DB write.")
        sys.exit(1)

    if args.dry_run:
        print("\n--dry-run: skipping Firestore write.")
        return

    write_to_firestore(deals)
    print("\nDone.")


if __name__ == "__main__":
    main()
