#!/usr/bin/env python3
"""
add_concert.py — scrape a setlist.fm page and add/update a concert card in post2.html

Usage:
    python add_concert.py <setlist.fm URL> [--notes "optional notes"]
    python add_concert.py <setlist.fm URL> --fill-template   # fills the placeholder template card
    python add_concert.py <setlist.fm URL> --no-openers      # skip scraping opening acts

Opening acts are read from the page's `relatedVenueSetlists` box (same venue, same
date), and each opener's own setlist is scraped when available.
"""

import sys
import re
import time
import argparse
from datetime import datetime
from urllib.parse import urljoin
from urllib.request import urlopen, Request
from html.parser import HTMLParser

USER_AGENT = "Mozilla/5.0 (compatible; concert-blog-scraper/1.0)"


def fetch_html(url: str, retries: int = 5) -> str:
    """Fetch a setlist.fm page, retrying through intermittent empty/202 bot-challenge
    responses. setlist.fm occasionally answers with HTTP 202 and an empty body; we
    retry with a growing delay and treat a too-short body as a failure."""
    last_err = None
    for attempt in range(retries):
        try:
            req = Request(url, headers={"User-Agent": USER_AGENT,
                                        "Accept-Language": "en-US,en;q=0.9"})
            with urlopen(req, timeout=25) as resp:
                html = resp.read().decode("utf-8", errors="replace")
            if len(html) > 1000:
                return html
            last_err = f"empty/short body (status {resp.status}, {len(html)} bytes)"
        except Exception as e:  # noqa: BLE001 — network errors are retried
            last_err = f"{type(e).__name__}: {e}"
        time.sleep(2 * (attempt + 1))
    raise RuntimeError(
        f"Could not fetch {url} after {retries} tries ({last_err}). "
        "setlist.fm may be serving a bot challenge — try again later."
    )


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

def scrape_setlist(url: str, with_openers: bool = False) -> dict:
    html = fetch_html(url)

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

    data = {
        "artist": parser.artist,
        "venue": parser.venue or "Unknown Venue",
        "city": parser.city or "",
        "date": parser.date,
        "songs": songs,
        "openers": [],
    }

    if with_openers:
        data["openers"] = scrape_openers(html, url)

    return data


# ── opener scraping ─────────────────────────────────────────────────────────--

def _related_block(html: str) -> str:
    """Return the HTML slice for the `relatedVenueSetlists` box (same venue, same
    date co-bills) — server-rendered on every setlist page — or '' if absent."""
    i = html.find("relatedVenueSetlists")
    if i < 0:
        return ""
    # the box lives in one contentBox row; cut at the next contentBox after it
    j = html.find("contentBox", i + len("relatedVenueSetlists"))
    return html[i:j] if j > 0 else html[i:i + 6000]


_RELATED_LI = re.compile(
    r'<li class="([^"]*setlistLink[^"]*)">.*?'
    r'href="([^"]+)"\s*title="View this (.+?) setlist"',
    re.DOTALL,
)


def scrape_openers(html: str, base_url: str) -> list:
    """Parse the same-venue/same-date co-bills from a setlist page's
    `relatedVenueSetlists` box. The headliner is the entry flagged
    `currentSetlist`; every other entry is treated as an opener/co-bill.

    Returns a list of {"name", "songs"}. Openers whose own setlist page can't be
    fetched (or has no songs) are returned name-only with an empty song list."""
    block = _related_block(html)
    if not block:
        return []

    openers = []
    for cls, href, name in _RELATED_LI.findall(block):
        if "currentSetlist" in cls:
            continue  # this is the headliner itself
        name = _unescape(name.strip())
        link = urljoin(base_url, href)
        songs = []
        try:
            songs = scrape_setlist(link, with_openers=False)["songs"]
        except Exception as e:  # noqa: BLE001 — missing/blocked opener page → name-only
            print(f"  (opener '{name}': no setlist — {e})")
        openers.append({"name": name, "songs": songs})
    return openers


def _unescape(s: str) -> str:
    return (s.replace("&amp;", "&").replace("&lt;", "<")
             .replace("&gt;", ">").replace("&#39;", "'").replace("&quot;", '"'))


# ── HTML builder ──────────────────────────────────────────────────────────────

def build_feat_tag(openers: list) -> str:
    """Faint `feat. A, B` tag for the collapsed header. '' when no openers."""
    if not openers:
        return ""
    names = ", ".join(o["name"] for o in openers)
    return f'\n                        <span class="concert-feat">feat. {names}</span>'


def build_openers_block(openers: list) -> str:
    """The expandable `.concert-openers` section placed above the headliner
    setlist. Each opener is collapsible; openers with no songs are name-only.
    Returns '' when there are no openers (card stays identical to before)."""
    if not openers:
        return ""

    opener_html = []
    for o in openers:
        if o["songs"]:
            song_lines = "\n".join(
                f'                            <span class="setlist-encore">{s}</span>'
                if kind == "__encore__" else
                f'                            <span class="setlist-song">{s}</span>'
                for kind, s in o["songs"]
            )
            opener_html.append(
                '                    <div class="opener">\n'
                '                        <div class="opener-head" onclick="toggleOpener(this)">\n'
                f'                            <span class="opener-name">{o["name"]}</span>\n'
                '                            <span class="opener-toggle">▼</span>\n'
                '                        </div>\n'
                '                        <div class="opener-setlist">\n'
                f'{song_lines}\n'
                '                        </div>\n'
                '                    </div>'
            )
        else:
            opener_html.append(
                '                    <div class="opener">\n'
                '                        <div class="opener-head opener-nosetlist">\n'
                f'                            <span class="opener-name">{o["name"]}</span>\n'
                '                        </div>\n'
                '                    </div>'
            )

    return ('                    <div class="concert-openers">\n'
            '                        <div class="openers-label">openers</div>\n'
            + "\n".join(opener_html) + '\n'
            '                    </div>\n')


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

    feat_html = build_feat_tag(data.get("openers", []))
    openers_html = build_openers_block(data.get("openers", []))

    return f"""
            <div class="concert-card">
                <div class="concert-header" onclick="toggleConcert(this)">
                    <div class="concert-header-left">
                        <span class="concert-artist">{data['artist']}</span>
                        <span class="concert-venue">{venue_str}</span>{feat_html}
                    </div>
                    <div class="concert-header-right">
                        <span class="concert-date">{data['date']}</span>
                        <span class="concert-toggle">▼</span>
                    </div>
                </div>
                <div class="concert-body">
{openers_html}                    <div class="concert-setlist">
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
    parser.add_argument("--no-openers", action="store_true",
                        help="Skip scraping opening acts from the same-venue/date box")
    args = parser.parse_args()

    print(f"Scraping {args.url} ...")
    data = scrape_setlist(args.url, with_openers=not args.no_openers)
    print(f"  Artist : {data['artist']}")
    print(f"  Venue  : {data['venue']}, {data['city']}")
    print(f"  Date   : {data['date']}")
    print(f"  Songs  : {len(data['songs'])} items")
    if data["openers"]:
        print(f"  Openers: {', '.join(o['name'] for o in data['openers'])}")

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
