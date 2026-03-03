#!/usr/bin/env python3
# scrape-gybe.py
# Run with: python scrape-gybe.py > setlists.json
# Scrapes gybecc.neocities.org and outputs JSON of all shows with setlists.

import urllib.request
import re
import json
import time
import sys

BASE = 'https://gybecc.neocities.org/gybecc/'

YEAR_PAGES = [
    '95','96','97','98','99',
    '00','01','02','03',
    '10','11','12','13','14','15','16','17','18','19','20',
    '22','23','24','25','26',
]

def fetch(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, timeout=15) as r:
        return r.read().decode('utf-8', errors='replace')

def strip_tags(s):
    return re.sub(r'<[^>]+>', '', s).strip()

def normalize_date(d):
    parts = d.split('-')
    if len(parts[0]) == 2:
        y = int(parts[0])
        parts[0] = ('19' if y >= 90 else '20') + parts[0]
    return '-'.join(parts)

def extract_show_links(html):
    """Find all YYYY-MM-DD.html or YY-MM-DD.html links."""
    links = []
    seen = set()
    for m in re.finditer(r'href="((\d{2,4}-\d{2}-\d{2})\.html)"', html):
        href, date_raw = m.group(1), m.group(2)
        date = normalize_date(date_raw)
        if date not in seen:
            seen.add(date)
            links.append({'url': BASE + href, 'date': date})
    return links

def parse_show(html, date):
    # Venue: find the first BGCOLOR="#000000" cell whose stripped text looks like a venue.
    # Skip cells that are: the page title, a date (YYYY-MM-DD), a duration (HH:MM), or "setlist".
    venue = ''
    for vm in re.finditer(r'BGCOLOR="#000000"[^>]*>([\s\S]*?)(?=</td)', html, re.I):
        text = re.sub(r'&[a-z#0-9]+;', ' ', vm.group(1))  # decode entities first
        text = re.sub(r'\s+', ' ', strip_tags(text)).strip()
        tl = text.lower()
        if not text: continue
        if 'concert chronology' in tl: continue
        if 'godspeed' in tl: continue
        if re.match(r'^\d{4}-\d{2}-\d{2}$', text): continue   # date cell
        if re.match(r'^\d+:\d+$', text): continue              # duration cell
        if tl == 'setlist': continue
        venue = text
        break
    if not venue:
        tm = re.search(r'<title[^>]*>([^<]+)</title>', html, re.I)
        if tm:
            venue = tm.group(1).strip()

    songs = []

    # <li> items (old HTML 4 style, may lack closing tags)
    # Split on <li> and grab text until next tag block
    for m in re.finditer(r'<li[^>]*>([\s\S]*?)(?=<li|</td|</tr|$)', html, re.I):
        raw = m.group(1)
        text = re.sub(r'\s+', ' ', strip_tags(raw)).strip()
        # Strip trailing "back" link artifact
        text = re.sub(r'\s*back\s*$', '', text, flags=re.I).strip()
        # Strip HTML entities like &nbsp;
        text = re.sub(r'&[a-z]+;', ' ', text).strip()
        text = re.sub(r'\s+', ' ', text).strip()
        # Remove trailing "note : ..." annotations - keep just the song name
        text = re.sub(r'\s+note\s*:.*$', '', text, flags=re.I).strip()
        text = re.sub(r'\s*\[incomplete\].*$', '', text, flags=re.I).strip()
        if text and 1 < len(text) < 80:
            songs.append(text)

    # Fallback: <br>-separated lines in body
    if not songs:
        bm = re.search(r'<body[^>]*>([\s\S]*)</body>', html, re.I)
        if bm:
            parts = re.split(r'<br\s*/?>',  bm.group(1), flags=re.I)
            for part in parts:
                text = re.sub(r'\s+', ' ', strip_tags(part)).strip()
                if text and 1 < len(text) < 120 and not text.startswith('['):
                    songs.append(text)

    return {'date': date, 'venue': venue, 'songs': songs}

def main():
    all_shows = []
    seen_dates = set()

    for yr in YEAR_PAGES:
        url = BASE + yr + '.html'
        print(f'Year page: {url}', file=sys.stderr)
        try:
            html = fetch(url)
        except Exception as e:
            print(f'  ERROR: {e}', file=sys.stderr)
            continue

        links = extract_show_links(html)
        print(f'  {len(links)} shows found', file=sys.stderr)

        for link in links:
            date = link['date']
            if date in seen_dates:
                continue
            seen_dates.add(date)

            print(f'  Fetching {link["url"]}', file=sys.stderr)
            try:
                show_html = fetch(link['url'])
            except Exception as e:
                print(f'    ERROR: {e}', file=sys.stderr)
                continue

            show = parse_show(show_html, date)
            all_shows.append(show)
            time.sleep(0.15)  # be polite

    all_shows.sort(key=lambda s: s['date'])
    print(json.dumps(all_shows, indent=2))
    print(f'\nDone. {len(all_shows)} shows.', file=sys.stderr)

if __name__ == '__main__':
    main()
