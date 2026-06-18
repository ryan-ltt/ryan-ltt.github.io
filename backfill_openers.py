#!/usr/bin/env python3
"""
backfill_openers.py — one-time pass to add opening acts to every existing concert
card in blog/post2.html.

setlist.fm sits behind an AWS WAF JavaScript bot-challenge, so the plain-urllib
scraper in add_concert.py cannot load these pages in bulk (it gets HTTP 202 +
challenge body). Opener data is therefore gathered *outside* this script — via the
WebFetch tool, which renders the challenge — and supplied as a JSON file. This
script only injects that data into the cards, reusing add_concert.build_feat_tag /
build_openers_block so backfilled cards match ones produced by add_concert.py.

The openers JSON maps each show date to its opener list:

    {
      "2024-08-21": [
        {"name": "Geese", "songs": ["Islands of Men", "Space Race", ...]}
      ],
      "2023-09-15": [
        {"name": "Daneshevskaya", "songs": []}        // name-only (no setlist)
      ]
    }

A card whose date is absent from the JSON is left untouched and logged. The script
is idempotent: a card that already has a `.concert-openers` block is skipped, so it
is safe to re-run after adding more dates to the JSON.

Usage:
    python backfill_openers.py --openers openers.json [--blog-post blog/post2.html] [--dry-run]
"""

import re
import json
import argparse

import add_concert as ac


# A card runs from its opening tag up to (but not including) the next card's
# opening tag or the close of `.concerts-list`. `.concert-card` blocks are never
# nested, so this anchored span captures each whole card including notes.
CARD_RE = re.compile(
    r'<div class="concert-card">.*?'
    r'(?=\n\s*<div class="concert-card">|\n\s*</div>\n\s*</div>\n\n\s*<script>)',
    re.DOTALL,
)
ARTIST_RE = re.compile(r'<span class="concert-artist">(.*?)</span>', re.DOTALL)
VENUE_RE = re.compile(r'<span class="concert-venue">(.*?)</span>', re.DOTALL)
DATE_RE = re.compile(r'<span class="concert-date">(.*?)</span>', re.DOTALL)


def _text(s: str) -> str:
    """Strip tags / unescape so card text matches the plain values."""
    return ac._unescape(re.sub(r"<[^>]+>", "", s)).strip()


def load_openers(path: str) -> dict:
    """Read the openers JSON into {date: [{"name", "songs": [(kind, song), ...]}]}.

    The JSON stores songs as plain strings; convert each to the ("song", name)
    tuple shape build_openers_block expects. An "Encore" marker (case-insensitive)
    becomes a ("__encore__", "Encore") row so opener setlists can show encores too."""
    with open(path, encoding="utf-8") as f:
        raw = json.load(f)

    result = {}
    for date, openers in raw.items():
        normalized = []
        for o in openers:
            songs = []
            for s in o.get("songs", []):
                if s.strip().lower() in ("encore", "encore 1", "encore 2"):
                    songs.append(("__encore__", s))
                else:
                    songs.append(("song", s))
            normalized.append({"name": o["name"], "songs": songs})
        result[date] = normalized
    return result


def card_has_openers(card: str) -> bool:
    return "concert-openers" in card


def inject_openers(card: str, openers: list) -> str:
    """Insert the `feat.` tag into the header and the openers block at the top of
    the body, leaving everything else (setlist, notes) untouched."""
    feat = ac.build_feat_tag(openers).strip()
    card = card.replace(
        '</span>\n                    </div>\n                    <div class="concert-header-right">',
        f'</span>\n                        {feat}\n                    </div>\n'
        '                    <div class="concert-header-right">',
        1,
    )
    block = ac.build_openers_block(openers)
    card = card.replace(
        '<div class="concert-body">\n',
        f'<div class="concert-body">\n{block}',
        1,
    )
    return card


def main():
    p = argparse.ArgumentParser(description="Backfill opening acts into post2.html")
    p.add_argument("--openers", required=True,
                   help="JSON file mapping each show date to its opener list")
    p.add_argument("--blog-post", default="blog/post2.html")
    p.add_argument("--dry-run", action="store_true", help="Report only; don't write the file")
    args = p.parse_args()

    openers_by_date = load_openers(args.openers)
    print(f"Loaded openers for {len(openers_by_date)} dates.")

    with open(args.blog_post, "r", encoding="utf-8") as f:
        html = f.read()

    cards = list(CARD_RE.finditer(html))
    print(f"Found {len(cards)} concert cards.\n")

    updated = skipped_done = skipped_nodata = 0
    edits = []  # (start, end, new_text) — applied last-to-first to keep offsets valid

    for m in cards:
        card = m.group(0)
        if card_has_openers(card):
            skipped_done += 1
            continue

        artist = _text((ARTIST_RE.search(card) or [None, ""]).group(1))
        date = _text((DATE_RE.search(card) or [None, ""]).group(1))

        openers = openers_by_date.get(date)
        if not openers:
            print(f"• {artist} — {date}: no opener data — skipped")
            skipped_nodata += 1
            continue

        print(f"• {artist} — {date}: {', '.join(o['name'] for o in openers)}")
        edits.append((m.start(), m.end(), inject_openers(card, openers)))
        updated += 1

    for start, end, new_text in sorted(edits, reverse=True):
        html = html[:start] + new_text + html[end:]

    if args.dry_run:
        print("\n(dry run — file not written)")
    else:
        with open(args.blog_post, "w", encoding="utf-8") as f:
            f.write(html)

    print(f"\nDone. updated={updated}, already-had={skipped_done}, no-data={skipped_nodata}")


if __name__ == "__main__":
    main()
