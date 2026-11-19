#!/usr/bin/env python3
"""
Flatten a Siteimprove accessibility issues export into one row per issue per page.

WHY THIS EXISTS
---------------
Siteimprove's Issues export is hard to read with anything but Siteimprove. It
is UTF-16 and tab-separated despite the .csv name, it opens with seven lines of
filter settings, and the table is nested: each issue row is followed by its
page rows, indented eleven empty columns. Spreadsheets show garbage until it
is converted, and an AI assistant reading it raw spends its effort on the
format instead of the findings.

This writes a plain UTF-8 CSV with a `template` column, taken from the first
segment of each URL path. Grouping by template is the point: 500 flagged pages
usually turn out to be a handful of template bugs, and that is the list worth
working from.

EXPORTING
---------
Accessibility -> Issues, with the Pages column expanded, then export. The
export lists at most 500 pages per issue, and its `Created:` line is the date
of the crawl, not of the export.

Keep the export out of version control and out of the web root: its Page
Report column carries Siteimprove links with access tokens in them.

TWO EXPORT LAYOUTS
------------------
1. The combined table (Accessibility -> Issues, export the whole table): one file,
   every issue, each followed by its pages.
2. One file per issue (opened from a single issue's page): a short header with
   "Issue name:", then a Title / URL / Page Report / Occurrences table. These
   carry no conformance level or success criteria, so those columns stay empty.

Both work. Pass a single file, or a FOLDER of per-issue files to combine them.
Files that are neither (for example "Accessibility score breakdown") are
skipped with a note.

USAGE
  python3 scripts/flatten_siteimprove.py exports/Issues-Table.csv exports/flat.csv
  python3 scripts/flatten_siteimprove.py exports/per-issue-folder/ exports/flat.csv
"""

import csv
import io
import os
import sys
from urllib.parse import urlparse

# Positions of a page row's cells in the combined table, after the eleven
# empty issue columns.
TITLE, URL, OCCURRENCES = 11, 12, 14

COLUMNS = ["issue", "conformance", "criteria", "issue_pages",
           "template", "title", "url", "occurrences"]


def template_of(url):
    """The first part of the URL path, which usually names the page template.

    Pages that sit at the site root with a long hyphenated name, such as
    /spring-event-recap-2019/, are single pages, not a template. They are
    grouped as /(root pages)/ so they do not become hundreds of groups.
    """
    parts = [p for p in urlparse(url).path.split("/") if p]
    if not parts:
        return "/"
    if len(parts) == 1 and "-" in parts[0]:
        return "/(root pages)/"
    return f"/{parts[0]}/"


def read_rows(path):
    raw = open(path, "rb").read()
    text = raw.decode("utf-16") if raw[:2] in (b"\xff\xfe", b"\xfe\xff") else raw.decode("utf-8-sig")
    return list(csv.reader(io.StringIO(text), delimiter="\t"))


def combined_rows(rows):
    """The all-issues table: an issue row, then its indented page rows."""
    start = next((i for i, r in enumerate(rows) if r and r[0] == "Issues"), None)
    if start is None:
        return None
    head = rows[start]
    out = []
    issue = None
    for r in rows[start + 1:]:
        if r and r[0]:
            issue = dict(zip(head, r))
        elif issue and len(r) > URL and r[URL].startswith("http"):
            out.append([issue["Issues"].strip(), issue["Conformance"],
                        issue["Success criteria"], issue["Pages"],
                        template_of(r[URL]), r[TITLE], r[URL],
                        r[OCCURRENCES] if len(r) > OCCURRENCES else ""])
    return out


def per_issue_rows(rows):
    """One issue per file: 'Issue name:' header, then Title / URL / ... rows."""
    name = next((r[0].split(":", 1)[1].strip() for r in rows
                 if r and r[0].startswith("Issue name:")), None)
    start = next((i for i, r in enumerate(rows)
                  if len(r) >= 2 and r[0] == "Title" and r[1] == "URL"), None)
    if name is None or start is None:
        return None
    head = rows[start]
    pages = [r for r in rows[start + 1:] if len(r) >= 2 and r[1].startswith("http")]
    occ = head.index("Occurrences") if "Occurrences" in head else None
    return [[name, "", "", str(len(pages)), template_of(r[1]), r[0], r[1],
             r[occ] if occ is not None and len(r) > occ else ""] for r in pages]


def flatten_file(path):
    rows = read_rows(path)
    got = combined_rows(rows)
    return got if got is not None else per_issue_rows(rows)


def main(src, dst):
    if os.path.isdir(src):
        files = sorted(os.path.join(src, f) for f in os.listdir(src) if f.lower().endswith(".csv"))
    else:
        files = [src]
    written = 0
    with open(dst, "w", newline="", encoding="utf-8") as f:
        out = csv.writer(f)
        out.writerow(COLUMNS)
        for path in files:
            rows = flatten_file(path)
            if rows is None:
                print(f"skipped (not an issue export): {os.path.basename(path)}", file=sys.stderr)
                continue
            out.writerows(rows)
            written += len(rows)
    print(f"{written} rows -> {dst}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit("usage: flatten_siteimprove.py <export.csv or folder> <out.csv>")
    main(sys.argv[1], sys.argv[2])
