#!/usr/bin/env python3
"""
add_concert.py — scrape a setlist.fm page and add/update a concert card in post2.html

Usage:
    python add_concert.py <setlist.fm URL> [--notes "optional notes"]
    python add_concert.py <setlist.fm URL> --fill-template   # fills the placeholder template card
"""

import sys
import re
import argparse
from datetime import datetime
from urllib.request import urlopen, Request
from html.parser import HTMLParser


# ── HTML parser ───────────────────────────────────────────────────────────────

class SetlistParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.artist = None
        self.venue = None
        self.city = None
        self.date = None
        self.songs = []
        self._current_section = "set"   # "set" | "encore"
        self._sections = []             # list of ("set"|"encore", [songs])

        # state flags
        self._in_headline_strong = False
        self._in_headline_span = False
        self._grab_artist = False
        self._grab_venue = False
        self._in_date_block = False
        self._in_month = False
        self._in_day = False
        self._in_year = False
        self._month = self._day = self._year = ""
        self._in_song_label = False
        self._depth_stack = []          # tag stack for nesting context

    # helpers
    def _has_class(self, attrs, *names):
        classes = dict(attrs).get("class", "")
        return all(n in classes.split() for n in names)

    def handle_starttag(self, tag, attrs):
        attr_dict = dict(attrs)
        classes = attr_dict.get("class", "").split()

        # ── date block ──
        if "dateBlock" in classes:
            self._in_date_block = True
        if self._in_date_block and tag == "span":
            if "month" in classes:
                self._in_month = True
            elif "day" in classes:
                self._in_day = True
            elif "year" in classes:
                self._in_year = True

        # ── headline: artist ──
        if "setlistHeadline" in classes:
            self._in_headline_strong = False
            self._in_headline_span = False
        if tag == "h1":
            self._in_headline_strong = True
        if self._in_headline_strong and tag == "strong":
            self._grab_artist = True
        if self._in_headline_strong and tag == "span":
            self._in_headline_span = True
            self._grab_artist = False
        if self._in_headline_span and tag == "a":
            self._grab_venue = True

        # ── songs ──
        if tag == "li" and "setlistParts" in classes:
            if "encore" in classes:
                # start a new encore section
                self._sections.append(("encore", []))
                self._current_section = "encore"
            elif "song" in classes:
                if not self._sections or self._sections[-1][0] != self._current_section:
                    self._sections.append((self._current_section, []))
        if tag == "a" and "songLabel" in classes:
            self._in_song_label = True

    def handle_endtag(self, tag):
        if tag == "div":
            if self._in_date_block:
                self._in_date_block = False
        if tag == "span":
            self._in_month = self._in_day = self._in_year = False
            if self._in_headline_span:
                self._in_headline_span = False
                self._grab_venue = False
        if tag == "strong":
            self._grab_artist = False
        if tag == "a":
            self._in_song_label = False
            self._grab_artist = False
            self._grab_venue = False

    def handle_data(self, data):
        data = data.strip()
        if not data:
            return

        if self._in_month:
            self._month = data
        elif self._in_day:
            self._day = data
        elif self._in_year:
            self._year = data
            # build ISO date once we have all three
            try:
                dt = datetime.strptime(f"{self._month} {self._day} {self._year}", "%b %d %Y")
                self.date = dt.strftime("%Y-%m-%d")
            except ValueError:
                self.date = f"{self._year}-??-??"

        if self._grab_artist and self.artist is None:
            self.artist = data

        if self._grab_venue and self.venue is None:
            # venue link text is "Venue Name, City, Country"
            parts = [p.strip() for p in data.split(",")]
            self.venue = parts[0] if parts else data
            self.city = ", ".join(parts[1:]) if len(parts) > 1 else ""

        if self._in_song_label:
            # add to current section
            if self._sections:
                self._sections[-1][1].append(data)
            else:
                self._sections.append((self._current_section, [data]))


# ── scraper ───────────────────────────────────────────────────────────────────

def scrape_setlist(url: str) -> dict:
    req = Request(url, headers={"User-Agent": "Mozilla/5.0 (compatible; concert-blog-scraper/1.0)"})
    with urlopen(req, timeout=15) as resp:
        html = resp.read().decode("utf-8", errors="replace")

    parser = SetlistParser()
    parser.feed(html)

    if not parser.artist:
        raise ValueError("Could not find artist name — the page structure may have changed.")
    if not parser.date:
        raise ValueError("Could not find date on the page.")

    # flatten sections into a song list, preserving encore labels
    songs = []
    for i, (section_type, song_list) in enumerate(parser._sections):
        if section_type == "encore" and song_list:
            songs.append(("__encore__", f"Encore {i}" if i > 1 else "Encore"))
        songs.extend(("song", s) for s in song_list)

    return {
        "artist": parser.artist,
        "venue": parser.venue or "Unknown Venue",
        "city": parser.city or "",
        "date": parser.date,
        "songs": songs,
    }


# ── HTML builder ──────────────────────────────────────────────────────────────

def build_card(data: dict, notes: str = "") -> str:
    venue_str = data["venue"]
    if data["city"]:
        venue_str += f" · {data['city']}"

    setlist_lines = []
    for kind, value in data["songs"]:
        if kind == "__encore__":
            setlist_lines.append(f'                        <span class="setlist-encore">{value}</span>')
        else:
            setlist_lines.append(f'                        <span class="setlist-song">{value}</span>')

    setlist_html = "\n".join(setlist_lines) if setlist_lines else \
        '                        <span class="setlist-song">(setlist unknown)</span>'

    notes_html = ""
    if notes:
        notes_html = f'\n                    <div class="concert-notes">{notes}</div>'

    return f"""
            <div class="concert-card">
                <div class="concert-header" onclick="toggleConcert(this)">
                    <div class="concert-header-left">
                        <span class="concert-artist">{data['artist']}</span>
                        <span class="concert-venue">{venue_str}</span>
                    </div>
                    <div class="concert-header-right">
                        <span class="concert-date">{data['date']}</span>
                        <span class="concert-toggle">▼</span>
                    </div>
                </div>
                <div class="concert-body">
                    <div class="concert-setlist">
{setlist_html}
                    </div>{notes_html}
                </div>
            </div>"""


# ── file patcher ──────────────────────────────────────────────────────────────

TEMPLATE_PATTERN = re.compile(
    r'\s*<!-- TEMPLATE:.*?-->\s*<div class="concert-card">.*?</div>\s*</div>',
    re.DOTALL
)

CONCERTS_LIST_CLOSE = '</div>\n\n        </div>'  # closing </div> of .concerts-list


def patch_html(html: str, new_card: str, fill_template: bool) -> str:
    if fill_template:
        # replace the placeholder template block with the real card
        if TEMPLATE_PATTERN.search(html):
            return TEMPLATE_PATTERN.sub(new_card, html, count=1)
        else:
            print("Warning: template placeholder not found — appending card instead.")

    # insert before the closing </div> of .concerts-list
    marker = '        </div>\n    </div>\n\n    <script>'
    if marker not in html:
        # fallback: just before </div> that closes .concerts-list
        marker = '\n        </div>\n\n        </div>'

    return html.replace(marker, new_card + "\n\n" + marker, 1)


# ── main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Add a concert card to post2.html from a setlist.fm URL.")
    parser.add_argument("url", help="setlist.fm URL to scrape")
    parser.add_argument("--notes", default="", help="Optional notes to add below the setlist")
    parser.add_argument("--fill-template", action="store_true",
                        help="Replace the placeholder template card instead of appending")
    parser.add_argument("--blog-post", default="blog/post2.html",
                        help="Path to the blog post HTML file (default: blog/post2.html)")
    args = parser.parse_args()

    print(f"Scraping {args.url} ...")
    data = scrape_setlist(args.url)
    print(f"  Artist : {data['artist']}")
    print(f"  Venue  : {data['venue']}, {data['city']}")
    print(f"  Date   : {data['date']}")
    print(f"  Songs  : {len(data['songs'])} items")

    card = build_card(data, notes=args.notes)

    with open(args.blog_post, "r", encoding="utf-8") as f:
        html = f.read()

    patched = patch_html(html, card, fill_template=args.fill_template)

    with open(args.blog_post, "w", encoding="utf-8") as f:
        f.write(patched)

    action = "Replaced template with" if args.fill_template else "Appended"
    print(f"\n{action} card for {data['artist']} ({data['date']}) in {args.blog_post}")


if __name__ == "__main__":
    main()
