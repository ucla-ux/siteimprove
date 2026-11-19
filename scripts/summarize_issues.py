#!/usr/bin/env python3
"""
Summarize a flattened Siteimprove export into a short table to paste into Claude.

WHY THIS EXISTS
---------------
flatten_siteimprove.py gives one row per issue per page. On a real site that is
thousands of rows, too long to paste and mostly repetition: the same problem on
every page that uses one template. This groups the rows by issue and template
and keeps a page count, an occurrence count and a few example URLs, so a
prompt can be a few KB and still say where the work is.

USAGE
  python3 siteimprove/summarize_issues.py siteimprove/exports/flat.csv            # to the screen
  python3 siteimprove/summarize_issues.py siteimprove/exports/flat.csv | pbcopy   # to the clipboard (macOS)
  python3 siteimprove/summarize_issues.py flat.csv --examples 2 --min-pages 3

OPTIONS
  --examples N    example URLs to keep per group (default 3)
  --min-pages N   leave out groups seen on fewer than N pages (default 1)

Uses only the Python standard library. Prints a Markdown table to stdout.
"""

import argparse
import csv
import sys
from collections import defaultdict


def main():
    ap = argparse.ArgumentParser(description="Summarize a flattened Siteimprove export.")
    ap.add_argument("flat_csv")
    ap.add_argument("--examples", type=int, default=3)
    ap.add_argument("--min-pages", type=int, default=1)
    args = ap.parse_args()

    # One group per (issue, template). Keep the issue's own details once.
    groups = defaultdict(lambda: {"pages": set(), "occurrences": 0, "urls": []})
    issue_info = {}
    with open(args.flat_csv, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            key = (row["issue"], row["template"])
            g = groups[key]
            if row["url"] not in g["pages"]:
                g["pages"].add(row["url"])
                g["urls"].append(row["url"])
            try:
                g["occurrences"] += int(row["occurrences"] or 0)
            except ValueError:
                pass
            issue_info.setdefault(row["issue"], (row["conformance"], row["criteria"], row["issue_pages"]))

    if not groups:
        sys.exit(f"No rows found in {args.flat_csv}")

    # Biggest problems first: by the issue's total pages, then by this group's pages.
    def sort_key(item):
        (issue, template), g = item
        total = issue_info[issue][2]
        total = int(total) if str(total).isdigit() else 0
        return (-total, issue, -len(g["pages"]), template)

    # Per-issue exports carry no WCAG level or criteria. Leave those columns out
    # when every row is empty, so the table is shorter and the prompt is not
    # asked to sort by a level it cannot see.
    show_level = any(info[0] for info in issue_info.values())
    show_criteria = any(info[1].strip() for info in issue_info.values())
    header = ["Issue"] + (["Conformance"] if show_level else []) + \
             (["Success criteria"] if show_criteria else []) + \
             ["Template", "Pages", "Occurrences", "Example pages"]
    print("| " + " | ".join(header) + " |")
    print("|" + "---|" * len(header))
    shown = 0
    for (issue, template), g in sorted(groups.items(), key=sort_key):
        if len(g["pages"]) < args.min_pages:
            continue
        conformance, criteria, _ = issue_info[issue]
        examples = ", ".join(g["urls"][: args.examples])
        criteria = " ".join(criteria.split())
        cells = [issue] + ([conformance] if show_level else []) + \
                ([criteria] if show_criteria else []) + \
                [template, str(len(g["pages"])), str(g["occurrences"]), examples]
        print("| " + " | ".join(cells) + " |")
        shown += 1
    print(f"\n{shown} issue/template groups from {sum(len(g['pages']) for g in groups.values())} issue-page rows.",
          file=sys.stderr)


if __name__ == "__main__":
    main()
