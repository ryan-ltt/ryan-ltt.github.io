#!/usr/bin/env python3
# update-shows.py
# Incremental updater: reads setlists.json, checks only recent year pages for
# new shows, fetches only those, then checks archive.org for recordings uploaded
# recently (single query), and writes back setlists.json + setlists-data.js.
#
# Usage:
#   python update-shows.py              # check current year + last year; recordings from last run
#   python update-shows.py 25 26        # check specific year suffixes for new shows
#   python update-shows.py --dry-run    # report changes without writing files
#   python update-shows.py --all-recordings  # fetch all known GYBE recordings from archive.org

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
ARCHIVE_META = 'https://archive.org/metadata/'
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
JSON_PATH = os.path.join(SCRIPT_DIR, 'setlists.json')
DATA_PATH = os.path.join(SCRIPT_DIR, 'setlists-data.js')
LAST_RUN_PATH = os.path.join(SCRIPT_DIR, '.last-update')
LAST_UPDATE_JS = os.path.join(SCRIPT_DIR, 'last-update.js')

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
def fetch_archive_recordings(extra_filter='', rows=500):
    """Fetch GYBE recordings from archive.org, optionally filtered (e.g. by addeddate)."""
    q = 'creator:"Godspeed You! Black Emperor"'
    if extra_filter:
        q += f' {extra_filter}'
    url = (f'{ARCHIVE_SEARCH}?q={urllib.parse.quote(q)}'
           f'&fl[]=identifier&fl[]=title&fl[]=date&rows={rows}&output=json')
    try:
        data = fetch(url)
        results = json.loads(data)
        docs = results.get('response', {}).get('docs', [])
        recordings = []
        for doc in docs:
            identifier = doc.get('identifier', '')
            if not identifier:
                continue
            # archive.org date field is the concert date; may be YYYY, YYYY-MM, or YYYY-MM-DD
            raw_date = doc.get('date', '')
            concert_date = raw_date[:10] if len(raw_date) >= 10 else ''
            recordings.append({
                'id': identifier,
                'url': f'https://archive.org/details/{identifier}',
                'title': doc.get('title', identifier),
                'concert_date': concert_date,
            })
        return recordings
    except Exception as e:
        print(f'  archive.org fetch error: {e}')
        return []

def fetch_archive_setlist(identifier):
    """Extract a setlist from an archive.org item's track metadata."""
    try:
        data = fetch(ARCHIVE_META + identifier)
        meta = json.loads(data)
    except Exception as e:
        print(f'    metadata fetch error: {e}')
        return []

    # Prefer original audio files that have a title field, sorted by track number
    audio_formats = {'flac', 'shorten', 'vbr mp3', 'ogg vorbis', '24bit flac', 'mp3', 'wav'}
    tracks = []
    for f in meta.get('files', []):
        if f.get('format', '').lower() not in audio_formats:
            continue
        if f.get('source', '') == 'derivative':
            continue
        title = f.get('title', '').strip()
        if not title:
            continue
        try:
            num = int(str(f.get('track', '999')).split('/')[0])
        except ValueError:
            num = 999
        tracks.append((num, title))

    if tracks:
        tracks.sort()
        return [t[1] for t in tracks]

    # Fallback: parse setlist from description field
    desc = meta.get('metadata', {}).get('description', '')
    if isinstance(desc, list):
        desc = '\n'.join(desc)
    if desc:
        songs = []
        for line in re.split(r'[\n\r]+|<br\s*/?>', desc):
            line = re.sub(r'<[^>]+>', '', line)
            line = re.sub(r'^\d+[\.\)]\s*', '', line).strip()
            if line and 2 < len(line) < 80:
                songs.append(line)
        if songs:
            return songs

    return []

# ─── Main ────────────────────────────────────────────────────────────────────
def main():
    with open(JSON_PATH) as f:
        existing = json.load(f)
    show_by_date = {s['date']: s for s in existing}
    known_dates = set(show_by_date.keys())

    print(f'Loaded {len(existing)} existing shows.')
    print(f'Checking years: {", ".join(years_to_check)}' + ('  [dry run]' if dry_run else '') + '\n')

    # ── Step 1: New shows from gybecc ─────────────────────────────────────────
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

    # ── Step 1b: Retry gybecc for shows with pending setlists ────────────────
    # These are stubs created earlier from archive.org recordings before gybecc had the page.
    pending = [s for s in existing if s.get('setlist_pending')]
    resolved = {}  # date → {songs, venue}

    if pending:
        print(f'Retrying gybecc setlist for {len(pending)} pending show(s)...')
        for show in pending:
            date = show['date']
            # Construct gybecc URL: 2026-02-15 → BASE + 26-02-15.html
            gybecc_url = BASE + date[2:4] + date[4:] + '.html'
            print(f'  {date} ... ', end='', flush=True)
            try:
                show_html = fetch(gybecc_url)
                parsed = parse_show(show_html, date)
                if parsed['songs']:
                    resolved[date] = {'songs': parsed['songs'], 'venue': parsed['venue']}
                    print(f'filled ({len(parsed["songs"])} songs)')
                else:
                    print('still pending')
            except Exception as e:
                print(f'ERROR: {e}')
            time.sleep(0.15)
        print()

    # ── Step 2: New recordings from archive.org ───────────────────────────────
    if all_recordings:
        print('Fetching all GYBE recordings from archive.org (single query)...')
        archive_recs = fetch_archive_recordings()
    else:
        if os.path.exists(LAST_RUN_PATH):
            with open(LAST_RUN_PATH) as f:
                cutoff = f.read().strip()
        else:
            cutoff = '2026-03-01'
        print(f'Fetching GYBE recordings added to archive.org since {cutoff}...')
        archive_recs = fetch_archive_recordings(extra_filter=f'addeddate:[{cutoff} TO *]', rows=100)
    print(f'  {len(archive_recs)} recording(s) returned\n')

    all_known_ids = {
        r['id']
        for s in existing
        for r in s.get('recordings', [])
    }
    rec_updates = {}   # date → [new recordings for existing shows]
    new_stubs = {}     # date → stub show (show not on gybecc yet)

    for rec in archive_recs:
        date = rec['concert_date']
        if not date:
            continue
        if rec['id'] in all_known_ids:
            continue
        entry = {'id': rec['id'], 'url': rec['url'], 'title': rec['title']}

        if date in show_by_date or date in {s['date'] for s in new_shows}:
            rec_updates.setdefault(date, []).append(entry)
        elif date in new_stubs:
            new_stubs[date]['recordings'].append(entry)
        else:
            # Show not on gybecc yet — create a stub from the recording's track list
            print(f'  {date}: not on gybecc — fetching track list from [{rec["id"]}] ... ', end='', flush=True)
            songs = fetch_archive_setlist(rec['id'])
            print(f'{len(songs)} track(s)')
            new_stubs[date] = {
                'date': date,
                'venue': '',
                'songs': songs,
                'recordings': [entry],
                'setlist_pending': True,
            }
            time.sleep(0.1)

        all_known_ids.add(rec['id'])

    if new_stubs:
        print()

    for date, recs in sorted(rec_updates.items()):
        print(f'  {date}: {len(recs)} new recording(s):')
        for r in recs:
            print(f'    + [{r["id"]}]')
            print(f'      {r["title"]}')

    print()

    # ── Summary ───────────────────────────────────────────────────────────────
    total_new_recs = sum(len(v) for v in rec_updates.values())

    if not new_shows and not new_stubs and not rec_updates and not resolved:
        print('Nothing new found. Everything is up to date.')
        return

    if new_shows:
        print(f'New shows from gybecc ({len(new_shows)}):')
        for s in new_shows:
            print(f'  {s["date"]}  {s["venue"]}  ({len(s["songs"])} songs)')
    if new_stubs:
        print(f'New show stubs from archive.org ({len(new_stubs)}):')
        for s in new_stubs.values():
            print(f'  {s["date"]}  ({len(s["songs"])} tracks, setlist pending gybecc)')
    if rec_updates:
        print(f'New recordings: {total_new_recs} across {len(rec_updates)} show(s)')
    if resolved:
        print(f'Setlists filled in from gybecc: {len(resolved)} show(s)')

    if dry_run:
        print('\n[dry run] No files written.')
        return

    # Apply recording updates to existing shows
    for date, new_recs in rec_updates.items():
        target = show_by_date.get(date)
        if target:
            target.setdefault('recordings', []).extend(new_recs)

    # Apply resolved setlists to pending stubs
    for date, update in resolved.items():
        show = show_by_date[date]
        show['songs'] = update['songs']
        if update['venue']:
            show['venue'] = update['venue']
        show.pop('setlist_pending', None)

    merged = sorted(existing + new_shows + list(new_stubs.values()), key=lambda s: s['date'])

    with open(JSON_PATH, 'w') as f:
        json.dump(merged, f, indent=2)
    print(f'\nWrote setlists.json ({len(merged)} shows)')

    with open(DATA_PATH, 'w') as f:
        f.write('const SETLISTS_DATA = ' + json.dumps(merged, indent=2) + ';\n')
    print(f'Wrote setlists-data.js')

    today = datetime.now().strftime('%Y-%m-%d')
    with open(LAST_RUN_PATH, 'w') as f:
        f.write(today)
    with open(LAST_UPDATE_JS, 'w') as f:
        f.write(f'const LAST_UPDATED = {json.dumps(today)};\n')

if __name__ == '__main__':
    main()
