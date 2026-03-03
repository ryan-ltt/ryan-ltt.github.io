#!/usr/bin/env python3
# update-shows.py
# Incremental updater: reads setlists.json, checks only recent year pages for
# new shows, fetches only those, then checks archive.org for new recordings,
# and writes back setlists.json + setlists-data.js.
#
# Usage:
#   python update-shows.py              # check current year + last year; recent recordings
#   python update-shows.py 25 26        # check specific year suffixes for new shows
#   python update-shows.py --dry-run    # report changes without writing files
#   python update-shows.py --all-recordings  # check archive.org for every show, not just recent

import urllib.request
import urllib.parse
import re
import json
import time
import sys
import os
from datetime import datetime

BASE = 'https://gybecc.neocities.org/gybecc/'
ARCHIVE_SEARCH = 'https://archive.org/advancedsearch.php'
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
JSON_PATH = os.path.join(SCRIPT_DIR, 'setlists.json')
DATA_PATH = os.path.join(SCRIPT_DIR, 'setlists-data.js')

# ─── Args ────────────────────────────────────────────────────────────────────
args = sys.argv[1:]
dry_run = '--dry-run' in args
all_recordings = '--all-recordings' in args
year_args = [a for a in args if re.match(r'^\d{2}$', a)]

def default_years():
    y = datetime.now().year
    return [str(y)[-2:], str(y - 1)[-2:]]

years_to_check = year_args if year_args else default_years()

# ─── HTTP helper ─────────────────────────────────────────────────────────────
def fetch(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, timeout=15) as r:
        return r.read().decode('utf-8', errors='replace')

# ─── Parsing helpers (shared with scrape-gybe.py) ────────────────────────────
def strip_tags(s):
    return re.sub(r'<[^>]+>', '', s).strip()

def normalize_date(d):
    parts = d.split('-')
    if len(parts[0]) == 2:
        y = int(parts[0])
        parts[0] = ('19' if y >= 90 else '20') + parts[0]
    return '-'.join(parts)

def extract_show_links(html):
    links, seen = [], set()
    for m in re.finditer(r'href="((\d{2,4}-\d{2}-\d{2})\.html)"', html):
        date = normalize_date(m.group(2))
        if date not in seen:
            seen.add(date)
            links.append({'url': BASE + m.group(1), 'date': date})
    return links

def parse_show(html, date):
    venue = ''
    for vm in re.finditer(r'BGCOLOR="#000000"[^>]*>([\s\S]*?)(?=</td)', html, re.I):
        text = re.sub(r'&[a-z#0-9]+;', ' ', vm.group(1))
        text = re.sub(r'\s+', ' ', strip_tags(text)).strip()
        tl = text.lower()
        if not text: continue
        if 'concert chronology' in tl or 'godspeed' in tl: continue
        if re.match(r'^\d{4}-\d{2}-\d{2}$', text): continue
        if re.match(r'^\d+:\d+$', text): continue
        if tl == 'setlist': continue
        venue = text
        break
    if not venue:
        tm = re.search(r'<title[^>]*>([^<]+)</title>', html, re.I)
        if tm:
            venue = tm.group(1).strip()

    songs = []
    for m in re.finditer(r'<li[^>]*>([\s\S]*?)(?=<li|</td|</tr|$)', html, re.I):
        raw = m.group(1)
        text = re.sub(r'\s+', ' ', strip_tags(raw)).strip()
        text = re.sub(r'\s*back\s*$', '', text, flags=re.I).strip()
        text = re.sub(r'&[a-z]+;', ' ', text).strip()
        text = re.sub(r'\s+', ' ', text).strip()
        text = re.sub(r'\s+note\s*:.*$', '', text, flags=re.I).strip()
        text = re.sub(r'\s*\[incomplete\].*$', '', text, flags=re.I).strip()
        if text and 1 < len(text) < 80:
            songs.append(text)
    if not songs:
        bm = re.search(r'<body[^>]*>([\s\S]*)</body>', html, re.I)
        if bm:
            for part in re.split(r'<br\s*/?>', bm.group(1), flags=re.I):
                text = re.sub(r'\s+', ' ', strip_tags(part)).strip()
                if text and 1 < len(text) < 120 and not text.startswith('['):
                    songs.append(text)

    return {'date': date, 'venue': venue, 'songs': songs, 'recordings': []}

# ─── Archive.org helpers ──────────────────────────────────────────────────────
def search_archive_recordings(date):
    """Search archive.org for GYBE live recordings on a specific date."""
    q = f'creator:"Godspeed You! Black Emperor" date:{date}'
    url = (f'{ARCHIVE_SEARCH}?q={urllib.parse.quote(q)}'
           f'&fl[]=identifier&fl[]=title&rows=20&output=json')
    try:
        data = fetch(url)
        results = json.loads(data)
        docs = results.get('response', {}).get('docs', [])
        return [
            {
                'id': doc['identifier'],
                'url': f'https://archive.org/details/{doc["identifier"]}',
                'title': doc.get('title', doc['identifier']),
            }
            for doc in docs
            if doc.get('identifier')
        ]
    except Exception as e:
        print(f'    archive.org error for {date}: {e}')
        return []

# ─── Main ────────────────────────────────────────────────────────────────────
def main():
    with open(JSON_PATH) as f:
        existing = json.load(f)
    show_by_date = {s['date']: s for s in existing}
    known_dates = set(show_by_date.keys())

    print(f'Loaded {len(existing)} existing shows.')
    print(f'Checking years: {", ".join(years_to_check)}' + ('  [dry run]' if dry_run else '') + '\n')

    # ── Step 1: New shows from gybecc ────────────────────────────────────────
    new_shows = []

    for yr in years_to_check:
        url = BASE + yr + '.html'
        print(f'Checking {url} ... ', end='', flush=True)
        try:
            html = fetch(url)
        except Exception as e:
            print(f'ERROR: {e}')
            continue

        links = extract_show_links(html)
        new_links = [l for l in links if l['date'] not in known_dates]
        print(f'{len(links)} shows, {len(new_links)} new')

        for link in new_links:
            date = link['date']
            print(f'  + {date} — fetching ... ', end='', flush=True)
            try:
                show_html = fetch(link['url'])
            except Exception as e:
                print(f'ERROR: {e}')
                continue
            show = parse_show(show_html, date)
            print(show['venue'] or '(no venue)')
            new_shows.append(show)
            known_dates.add(date)
            time.sleep(0.15)

    print()

    # ── Step 2: New recordings from archive.org ───────────────────────────────
    if all_recordings:
        shows_to_check = list(existing)
        print(f'Checking archive.org recordings for all {len(shows_to_check)} shows...\n')
    else:
        cutoff_year = datetime.now().year - 3
        shows_to_check = [
            s for s in existing
            if int(s['date'][:4]) >= cutoff_year or not s.get('recordings')
        ]
        print(f'Checking archive.org for {len(shows_to_check)} shows '
              f'(last 3 years + {sum(1 for s in existing if not s.get("recordings"))} with no recordings)')
        print('(use --all-recordings to check every show)\n')

    rec_updates = {}  # date → [new recordings to add]

    for show in shows_to_check:
        date = show['date']
        known_ids = {r['id'] for r in show.get('recordings', [])}
        new_recs = search_archive_recordings(date)
        truly_new = [r for r in new_recs if r['id'] not in known_ids]
        if truly_new:
            print(f'  {date}: {len(truly_new)} new recording(s):')
            for r in truly_new:
                print(f'    + [{r["id"]}]')
                print(f'      {r["title"]}')
            rec_updates[date] = truly_new
        time.sleep(0.1)

    print()

    # ── Summary ───────────────────────────────────────────────────────────────
    total_new_recs = sum(len(v) for v in rec_updates.values())

    if not new_shows and not rec_updates:
        print('Nothing new found. Everything is up to date.')
        return

    if new_shows:
        print(f'New shows ({len(new_shows)}):')
        for s in new_shows:
            print(f'  {s["date"]}  {s["venue"]}  ({len(s["songs"])} songs)')
    if rec_updates:
        print(f'New recordings: {total_new_recs} across {len(rec_updates)} show(s)')

    if dry_run:
        print('\n[dry run] No files written.')
        return

    # Apply recording updates to existing shows
    for date, new_recs in rec_updates.items():
        show_by_date[date].setdefault('recordings', []).extend(new_recs)

    merged = sorted(existing + new_shows, key=lambda s: s['date'])

    with open(JSON_PATH, 'w') as f:
        json.dump(merged, f, indent=2)
    print(f'\nWrote setlists.json ({len(merged)} shows)')

    with open(DATA_PATH, 'w') as f:
        f.write('const SETLISTS_DATA = ' + json.dumps(merged, indent=2) + ';\n')
    print(f'Wrote setlists-data.js')

    if new_shows:
        print('\nNote: new shows have empty recordings — any auto-discovered ones above were added.')

if __name__ == '__main__':
    main()
