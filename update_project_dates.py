#!/usr/bin/env python3
"""Sync the "last updated" dates on the projects page with git history.

Each card in projects/index.html carries a data-path attribute naming the
directory that project lives in. For each one we take the date of the most
recent commit touching that directory and write it into the card's <time>
element. Cards without a data-path (external links) are left alone.

    python3 update_project_dates.py            # rewrite the dates
    python3 update_project_dates.py --check     # exit 1 if anything is stale

Run from anywhere; paths are resolved relative to this file.
"""

import argparse
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PAGE = ROOT / "projects" / "index.html"

# <a ... data-path="foo" ...> ... </a>
CARD_RE = re.compile(r'<a\b[^>]*\bdata-path="([^"]+)"[^>]*>.*?</a>', re.S)
# <time class="project-date" datetime="...">...</time>
TIME_RE = re.compile(
    r'(<time\b[^>]*\bclass="project-date"[^>]*\bdatetime=")[^"]*("[^>]*>)[^<]*(</time>)'
)


def last_commit_date(path):
    """Date (YYYY-MM-DD) of the newest commit touching path, or None."""
    result = subprocess.run(
        ["git", "-C", str(ROOT), "log", "-1", "--format=%ad", "--date=short", "--", path],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise SystemExit(f"git log failed for {path}: {result.stderr.strip()}")
    return result.stdout.strip() or None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check",
        action="store_true",
        help="report stale dates without writing; exit 1 if any are found",
    )
    args = parser.parse_args()

    html = PAGE.read_text()
    stale = []

    def update_card(match):
        path = match.group(1)
        if not (ROOT / path).is_dir():
            raise SystemExit(f"{PAGE.name}: data-path='{path}' is not a directory")

        date = last_commit_date(path)
        if date is None:
            print(f"  {path}: no commits yet, leaving as is")
            return match.group(0)

        card = match.group(0)
        if not TIME_RE.search(card):
            raise SystemExit(f"{PAGE.name}: card '{path}' has no <time class=\"project-date\">")

        updated = TIME_RE.sub(rf"\g<1>{date}\g<2>{date}\g<3>", card)
        if updated != card:
            old = TIME_RE.search(card).group(0)
            old_date = re.search(r'datetime="([^"]*)"', old).group(1)
            stale.append(f"  {path}: {old_date} -> {date}")
        return updated

    rewritten = CARD_RE.sub(update_card, html)

    if not stale:
        print("Project dates are up to date.")
        return 0

    print("Stale dates:" if args.check else "Updated dates:")
    print("\n".join(stale))

    if args.check:
        return 1

    PAGE.write_text(rewritten)
    return 0


if __name__ == "__main__":
    sys.exit(main())
