# Siteimprove and Alfa: from an accessibility report to a fix list

Download the accessibility issues from Siteimprove, shrink them to a short table, and ask Claude to turn that into a checklist grouped by area of work (code, design, content). Then use Alfa, Siteimprove's open-source rules engine, to re-check a page yourself.

Why group by template: 500 flagged pages usually turn out to be a handful of template bugs. A checklist built from the grouped table is much shorter than one built from a page list.

## Pick your path

| You have | Use | Needs |
|---|---|---|
| Only a browser and Claude | [Try it with no install](#try-it-with-no-install) | Nothing |
| Python 3 | [Convert and summarize](#2-convert-and-summarize) | Python 3.9+ |
| Node 22+ | [Alfa scan](#alfa-re-check-a-page-yourself) | Node, `npm install`, one browser download |

You do not need git. On GitHub, **Code → Download ZIP** gives you everything.

## Try it with no install

The `sample/` folder holds made-up data, safe to share.

1. Open [`sample/summary-sample.md`](sample/summary-sample.md). It is what the scripts produce from a Siteimprove export.
2. Paste it into a new Claude chat with the prompt in [step 3](#3-ask-claude-for-the-checklist).
3. Read the checklist. Ask: "Which three items remove the most flagged pages?"

---

## 1. Export from Siteimprove

In Siteimprove:

1. Open **Accessibility → Issues**.
2. Set the filters you want. A good start: Conformance **A** and **AA**, and Decisions **Occurrences without decisions**, so issues already ruled on stay out.
3. Expand the **Pages** column so each issue lists its pages.
4. Export the table as CSV. Menu names differ a little between Siteimprove accounts; see Siteimprove's help for the CSV download button.

Siteimprove offers two kinds of export, and the scripts read both:

- **The whole table** from Accessibility → Issues: one file with every issue.
- **One file per issue**, opened from an issue's own page: a separate file for each issue type. Save them all in one folder.

> **Tip: work one issue at a time.** Export a single issue, fix it, and move on to the next. A single issue gives a short list you can finish, and Claude's checklist stays focused on one problem. Save each export in its own file (the issue name is in the file name), then flatten the whole folder when you want the big picture, or just the one file when you are working on that issue. Start with the issue that flags the most pages.

Save the file or folder into `exports/` (create it). It is ignored by git.

Things to know about the file:

- It is named `.csv` but is **UTF-16 and tab-separated**, opens with a few lines of filter settings, and is nested: each issue row is followed by its page rows. Spreadsheets show garbage until it is converted.
- It lists **at most 500 pages per issue**.
- The `Created:` line at the top is the date of the **crawl**, not of the export. Siteimprove shows the site as it was at the last crawl, so some findings may already be fixed.
- The `Page Report` column holds Siteimprove links with access tokens in them. **Never commit or share the raw export.** The converter drops that column.

See the crawl date and site name (macOS and Linux):

```bash
iconv -f UTF-16 -t UTF-8 exports/Issues-Table.csv | head -3
```

## 2. Convert and summarize

Requires Python 3 only. Run these from this folder.

```bash
python3 scripts/flatten_siteimprove.py exports/Issues-Table.csv exports/flat.csv
python3 scripts/summarize_issues.py exports/flat.csv > exports/summary.md
```

If you exported one file per issue, point it at the folder instead:

```bash
python3 scripts/flatten_siteimprove.py exports/per-issue/ exports/flat.csv
```

Files that are not issue lists (such as "Accessibility score breakdown") are skipped with a note. Per-issue files carry no WCAG level or success criteria, so those two columns stay empty.

`flatten_siteimprove.py` writes a plain UTF-8 CSV with one row per issue per page, plus a `template` column from the first part of each URL path (`/person/`, `/news/`).

`summarize_issues.py` groups those rows by issue and template and prints a Markdown table: pages, occurrences, and a few example URLs.

Open `exports/summary.md` in any text editor, select all, copy, paste into Claude. Or copy straight to the clipboard:

| System | Add to the end of the second command |
|---|---|
| macOS | `\| pbcopy` |
| Windows (PowerShell or Command Prompt) | `\| clip` |
| Linux | `\| xclip -selection clipboard` |

A real site is usually too long for one prompt. A real export with about 1,800 issue-page rows gave 69 groups (14 KB); this keeps the 30 biggest and fits easily:

```bash
python3 scripts/summarize_issues.py exports/flat.csv --min-pages 3 --examples 2 > exports/summary.md
```

Try it first with the sample (made-up data):

```bash
python3 scripts/flatten_siteimprove.py sample/Issues-Table-sample.csv sample/flat-sample.csv
python3 scripts/summarize_issues.py sample/flat-sample.csv
```

Expected: `13 rows`, then `9 issue/template groups from 13 issue-page rows.`

## 3. Ask Claude for the checklist

Paste this into a new Claude chat, fill in the first line, then paste the table where shown:

```text
This is a Siteimprove accessibility export for <site name>, crawled on <crawl date>,
grouped by issue and page template. The crawl may be out of date, so some items
may already be fixed.

Make a checklist of things to fix:
1. Group items by area of work: code (theme or template change), content
   (page by page), or design. One person may cover more than one area, so
   treat these as kinds of work, not job titles. If an area has nothing, say
   "none".
2. Treat the same issue on several pages of one template as one code task,
   and say so.
3. Order each group by how many pages it affects, then by WCAG level (A before AA)
   if the table has a level column.
4. For each item give: what to change, which URL pattern or example page to check,
   and a one-line "done when" test.
5. If you cannot tell from the table whether an item is code or content, say so
   and name the page to open.
6. End with a short list of items to re-test first, because the crawl may be stale.

<paste the table here>
```

Useful follow-ups:

- "Turn the code items into GitHub issues, one per item, with a title and a done-when checklist."
- "Which three items remove the most flagged pages?"
- "Write the instructions for editors as a short plain-language list with no code."

Claude only sees the table, so check its suggestions against a real page before you act on them.

## 4. After fixing

- Re-check a fixed page with Lighthouse and Alfa (below). The companion Lighthouse repo covers turning its report into a fix list.
- Siteimprove updates on its next crawl. To clear a finding you have confirmed is fixed sooner, record a decision in Siteimprove rather than waiting.

---

## Alfa: re-check a page yourself

[Alfa](https://github.com/Siteimprove/alfa) is the MIT-licensed rule engine behind Siteimprove's checks (the `sia-r2`, `sia-r69` rule names). `alfa/alfa-scan.mjs` opens a page in headless Chromium, lets the CSS and scripts run, and prints every failure grouped by rule, with the WCAG criteria and a link to the rule's documentation.

Because the page is rendered, it sees contrast, links told apart by color alone, and text set in capitals by CSS, none of which a markup checker can see.

**Setup (once):**

```bash
cd alfa
npm install
npx playwright install chromium
```

**Run it on the bundled sample page** (19 planted defects):

```bash
node alfa-scan.mjs sample/sampler/broken.html
```

Expected: `22 failure(s) across 1 page(s), 1 needing a human decision`, 17 rules, exit code 1. Compare with [`alfa/expected/broken.txt`](alfa/expected/broken.txt). Output matches that file apart from the folder path.

```bash
node alfa-scan.mjs sample/sampler/fixed.html
```

Expected: `no failures`, exit code 0.

**Run it on a real page:**

```bash
node alfa-scan.mjs https://www.example.edu/
node alfa-scan.mjs PAGE --gaps          # only contrast, color-only links, all-caps text
node alfa-scan.mjs PAGE --json out.json
node alfa-scan.mjs --list-rules
```

Be polite to production servers: the script caps non-local runs at 8 pages with a pause between them. `localhost`, `*.test` and DDEV sites (`*.ddev.site`) count as local.

**What it cannot do:** decide (some rules end in `cantTell`, and a person settles those); find defects that have no rule (a `<div>` used as a button, alt text that repeats the headline); use the page (a menu that traps focus only after it opens); or cover a site (scan one page per template).

### Who catches what

Measured on the bundled sample page, 19 planted defects:

| Tool | Caught |
|---|---|
| Markup re-test | 9 |
| Alfa | 15 |
| Lighthouse | 10 scored, plus 2 unscored notes (score 59) |
| No tool at all | 2 |

Automated tools tell you where to look. They cannot tell you whether it is a problem, or whether your fix helped anyone.

### Alfa and Playwright: how they fit together

Playwright does not contain Alfa. They are two separate tools, and `alfa/alfa-scan.mjs` uses both.

| | Alfa | Playwright |
|---|---|---|
| What it is | Siteimprove's open-source rule engine (`sia-r2`, `sia-r69`...) | A browser automation tool from Microsoft |
| Its job | Decides what is wrong on a page | Loads the page, runs its CSS and scripts, clicks, types, presses Tab |
| On its own | Cannot open a page | Does not know what an accessibility failure is |
| Installed as | `@siteimprove/alfa-*` packages | The `playwright` package plus a browser |

A small adapter, `@siteimprove/alfa-playwright`, joins them: Playwright renders the page in real Chromium, and Alfa runs its rules on the result. See `alfa/package.json` for all five packages.

They answer different questions, so a build can use both:

| Tool | Question | Example |
|---|---|---|
| Alfa | Does this page break a known rule? | Contrast, a button with no name, missing alt text, links told apart by color alone |
| Playwright tests | Does the page behave correctly? | Can I Tab into the menu, open it, close it with Escape, and land back on the trigger? |

In the labs this repo is drawn from, scanners found 1 of 6 planted keyboard defects and Playwright keyboard tests found all 6. Alfa judges rules; it cannot judge behavior.

**A workable setup during a build**

1. **Locally, after each change:** `node alfa-scan.mjs <url>` on one page per template. It takes seconds per page.
2. **On every pull request:** run Alfa with a baseline so only new failures fail the build.
   ```bash
   node alfa-scan.mjs PAGE --update-baseline alfa-baseline.json   # accept today's failures, once
   node alfa-scan.mjs PAGE --baseline alfa-baseline.json          # fail only on new ones
   ```
3. **Playwright tests for behavior:** menus, dialogs, skip links and focus order.

**A limit to know:** `alfa-scan.mjs` scans a page in its initial state. A problem that appears only after something opens, such as a menu or dialog, is not seen. To catch it, a Playwright test would open the menu first and then run the Alfa audit. This script does not do that yet.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Spreadsheet shows garbage | Do not open the raw export; run the flatten script first |
| `python3: command not found` (Windows) | Use `py` instead of `python3` |
| `StopIteration` or no rows from a real export | Send the file or folder to the flatten script, not a copy saved from a spreadsheet; it needs Siteimprove's original UTF-16 file |
| Hundreds of groups in the summary | Use `--min-pages 3 --examples 2`. Pages at the site root with long hyphenated names are grouped as `/(root pages)/` |
| `npm install` fails | Check `node -v` is 22 or higher |
| `npm warn install-scripts … fsevents` | Safe to ignore. `fsevents` is an optional macOS helper that Alfa does not use |
| Alfa says it cannot launch a browser | Run `npx playwright install chromium` |
| Alfa output has odd characters | Color codes in some terminals; run with `NO_COLOR=1` before the command |

## Files

| File | What it does |
|---|---|
| `scripts/flatten_siteimprove.py` | Converts the export to a plain CSV, one row per issue per page, with a `template` column |
| `scripts/summarize_issues.py` | Groups that CSV by issue and template into a short table for Claude |
| `alfa/alfa-scan.mjs` | Runs Alfa's rules on a rendered page |
| `alfa/sample/` | A small page with planted defects, for trying Alfa |
| `alfa/expected/` | Reference output for the sample page |
| `sample/` | A made-up export in Siteimprove's format, plus the flattened and summarized outputs |
| `exports/` | Where you save real exports. Ignored by git |
