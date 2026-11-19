#!/usr/bin/env node
/**
 * Siteimprove Alfa accessibility scan, standalone.
 *
 * Alfa is the open-source rule engine behind Siteimprove's accessibility
 * checks (MIT, github.com/Siteimprove/alfa). This runs its ACT rules against
 * pages rendered by a real Chromium through Playwright, so the CSS cascade is
 * applied: contrast, links told apart by color alone, and text set in capitals
 * are visible to it, where a markup checker sees none of them.
 *
 * Adapted from tests/alfa/scan.mts in the ioes.ucla.edu theme. What changed:
 * nothing names a site, targets can be local files, and a baseline file turns
 * it into a regression gate for CI.
 *
 * Usage
 *   node alfa-scan.mjs sample/sampler/broken.html     a local file
 *   node alfa-scan.mjs http://localhost:8000/news/campus-garden/ a served page
 *   node alfa-scan.mjs --base http://localhost:8000 / /news/campus-garden/
 *   node alfa-scan.mjs PAGE --gaps                    only sia-r62, sia-r69, sia-r72
 *   node alfa-scan.mjs PAGE --rule r69 --rule r62     only these rules
 *   node alfa-scan.mjs PAGE --level aaa               default aa; levels stack
 *   node alfa-scan.mjs PAGE --viewport mobile         or desktop, or 390x844
 *   node alfa-scan.mjs PAGE --json out/alfa.json
 *   node alfa-scan.mjs PAGE --update-baseline alfa-baseline.json   accept today's failures
 *   node alfa-scan.mjs PAGE --baseline alfa-baseline.json          fail only on new ones
 *   node alfa-scan.mjs --list-rules                   every rule, its WCAG criteria, its docs
 *
 * Exits 1 when anything failed (or, with --baseline, anything new failed);
 * --no-fail always exits 0.
 *
 * Remote sites: anything that is not localhost, 127.0.0.1, *.localhost,
 * *.test or *.ddev.site (a local DDEV site) is treated as someone's production server. The run is capped at 8
 * pages with 1.5 s between them unless you raise --max-pages yourself. A page
 * scan is one navigation plus every image, script and font it loads, and
 * rate-limit jails count all of them.
 */

// Drop color codes when output is piped to a file or NO_COLOR is set, so
// saved output matches expected/ exactly.
if (process.env.NO_COLOR || !process.stdout.isTTY) {
  const log = console.log;
  console.log = (...a) => log(...a.map((x) => (typeof x === 'string' ? x.replace(/\x1b\[[0-9;]*m/g, '') : x)));
}

import { chromium } from 'playwright';
import { Audit, Outcome } from '@siteimprove/alfa-act';
import { Rules } from '@siteimprove/alfa-rules';
import { Criterion } from '@siteimprove/alfa-wcag';
import { Playwright } from '@siteimprove/alfa-playwright';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The three rules a markup-only checker cannot evaluate. */
const GAP_RULES = ['sia-r62', 'sia-r69', 'sia-r72'];

const REMOTE_PAGE_CAP = 8;
const REMOTE_DELAY_MS = 1500;

/**
 * Asking for AA means A and AA. Rules backed only by an AAA criterion (R66
 * enhanced contrast, R111 enhanced target size) otherwise bury the AA
 * findings. Rules with no criterion are Siteimprove best practices (R72
 * capitals, R53 heading structure) and are always kept.
 */
const LEVEL_RANK = { a: 1, aa: 2, aaa: 3 };

const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844 },
};

function usage(code = 0) {
  console.log(`Usage: node alfa-scan.mjs [options] <url | file | /path>...

  --base <origin>           Prefix for targets that start with "/"
  --gaps                    Only sia-r62, sia-r69, sia-r72 (need a rendered page)
  --rule <id>               Restrict to a rule, repeatable: "r69" or "sia-r69"
  --level <a|aa|aaa|all>    Conformance level, stacked (default aa)
  --viewport <v>            desktop | mobile | WxH (default desktop)
  --json <path>             Write the full report as JSON
  --baseline <path>         Known failures; report and fail only on new ones
  --update-baseline <path>  Write this run's failures as the baseline
  --max-pages <n>           Page cap for remote sites (default ${REMOTE_PAGE_CAP})
  --list-rules              Print every rule with its criteria and docs link
  --no-fail                 Always exit 0
  -v, --verbose             Passed and inapplicable counts per page
  -h, --help`);
  process.exit(code);
}

function parseArgs(argv) {
  const opts = {
    base: null, targets: [], rules: [], level: 'aa',
    viewport: VIEWPORTS.desktop, viewportName: 'desktop',
    json: null, baseline: null, updateBaseline: null,
    maxPages: null, listRules: false, failOnIssues: true, verbose: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) {
        console.error(`${arg} needs a value`);
        process.exit(2);
      }
      return argv[++i];
    };
    switch (arg) {
      case '-h': case '--help': usage(); break;
      case '--base': opts.base = next().replace(/\/+$/, ''); break;
      case '--gaps': opts.rules.push(...GAP_RULES); break;
      case '--rule': opts.rules.push(next()); break;
      case '--level': {
        const l = next().toLowerCase();
        if (l !== 'all' && !(l in LEVEL_RANK)) {
          console.error(`Unrecognized --level "${l}". Use a, aa, aaa or all.`);
          process.exit(2);
        }
        opts.level = l;
        break;
      }
      case '--viewport': {
        const v = next();
        const m = /^(\d+)x(\d+)$/.exec(v);
        if (v in VIEWPORTS) opts.viewport = VIEWPORTS[v];
        else if (m) opts.viewport = { width: Number(m[1]), height: Number(m[2]) };
        else {
          console.error(`Unrecognized --viewport "${v}". Use desktop, mobile or WxH.`);
          process.exit(2);
        }
        opts.viewportName = v;
        break;
      }
      case '--json': opts.json = next(); break;
      case '--baseline': opts.baseline = next(); break;
      case '--update-baseline': opts.updateBaseline = next(); break;
      case '--max-pages': opts.maxPages = Number(next()); break;
      case '--list-rules': opts.listRules = true; break;
      case '--no-fail': opts.failOnIssues = false; break;
      case '-v': case '--verbose': opts.verbose = true; break;
      default:
        if (arg.startsWith('-')) {
          console.error(`Unknown option ${arg}`);
          usage(2);
        }
        opts.targets.push(arg);
    }
  }
  opts.rules = opts.rules.map((r) => (r.startsWith('sia-') ? r : `sia-${r}`).toLowerCase());
  return opts;
}

/** A target on the command line becomes a URL: http(s) as is, "/x" on --base, else a file. */
function toUrl(target, base) {
  if (/^https?:\/\//.test(target) || target.startsWith('file:')) return target;
  if (target.startsWith('/') && base) return `${base}${target}`;
  if (existsSync(target)) return pathToFileURL(resolve(target)).href;
  console.error(`Not a URL, a /path with --base, or an existing file: ${target}`);
  process.exit(2);
}

function isRemote(url) {
  const u = new URL(url);
  if (u.protocol === 'file:') return false;
  const h = u.hostname;
  return !(h === 'localhost' || h === '127.0.0.1' || h === '[::1]' ||
           h.endsWith('.localhost') || h.endsWith('.test') || h.endsWith('.ddev.site'));
}

/** The page's identity in a baseline: its path, so local and CI hosts agree. */
function pageKey(url) {
  const u = new URL(url);
  return u.protocol === 'file:' ? u.pathname.split('/').slice(-2).join('/') : u.pathname;
}

const ruleId = (rule) => rule.uri.split('/').filter(Boolean).pop() ?? rule.uri;
const ruleDocs = (id) => `https://alfa.siteimprove.com/rules/${id}`;

function criterionLevels(criterion) {
  const levels = new Set();
  for (const branch of criterion.level) {
    levels.add(String(Array.isArray(branch) ? branch[0] : branch));
  }
  return [...levels];
}

function ruleRequirements(rule) {
  const out = [];
  for (const req of rule.requirements) {
    if (Criterion.isCriterion(req)) {
      out.push(`WCAG ${req.chapter} ${req.title} [${criterionLevels(req).join('/')}]`);
    } else {
      const slug = req.uri.split(/[/#]/).filter(Boolean).pop() ?? '';
      if (slug !== '') out.push(`${req.type} ${slug}`);
    }
  }
  return out;
}

function ruleLevel(rule) {
  let lowest = null;
  for (const req of rule.requirements) {
    if (!Criterion.isCriterion(req)) continue;
    for (const level of criterionLevels(req)) {
      const rank = LEVEL_RANK[level.toLowerCase()];
      if (rank !== undefined && (lowest === null || rank < lowest)) lowest = rank;
    }
  }
  return lowest;
}

function describeTarget(target) {
  let path = '';
  try {
    path = typeof target?.path === 'function' ? target.path() : '';
  } catch {
    path = '';
  }
  let markup = String(target);
  if (markup.startsWith('[object')) {
    // Some rules target a group of elements, not one node.
    markup = '(a group of elements; see the rule page)';
  }
  markup = markup.replace(/\s+/g, ' ').trim();
  return { path, markup: markup.length > 180 ? `${markup.slice(0, 177)}...` : markup };
}

async function auditPage(page, rules) {
  const handle = await page.evaluateHandle(() => window.document);
  const alfaPage = await Playwright.toPage(handle);
  const outcomes = await Audit.of(alfaPage, rules).evaluate();

  const failed = [];
  const cantTell = [];
  let passed = 0;
  let inapplicable = 0;

  for (const outcome of outcomes) {
    if (Outcome.isPassed(outcome)) { passed++; continue; }
    if (Outcome.isInapplicable(outcome)) { inapplicable++; continue; }

    const { path, markup } = describeTarget(outcome.target);
    const messages = [];
    if (Outcome.isFailed(outcome) && outcome.expectations !== undefined) {
      for (const [, result] of outcome.expectations.toArray()) {
        if (typeof result.isErr === 'function' && result.isErr()) {
          const message = result.getErr()?.message;
          if (message !== undefined) messages.push(message);
        }
      }
    } else if (outcome.diagnostic?.message !== undefined) {
      messages.push(outcome.diagnostic.message);
    }

    const issue = {
      rule: ruleId(outcome.rule),
      requirements: ruleRequirements(outcome.rule),
      path,
      markup,
      messages,
    };
    if (Outcome.isFailed(outcome)) failed.push(issue);
    else cantTell.push(issue);
  }
  return { failed, cantTell, passed, inapplicable };
}

const baselineKey = (url, issue) => `${pageKey(url)} ${issue.rule} ${issue.path || issue.markup}`;

function printReport(reports, opts, known) {
  let totalFailed = 0;
  let totalNew = 0;
  let totalCantTell = 0;

  for (const r of reports) {
    console.log(`\n\x1b[1m${r.url}\x1b[0m`);
    if (r.error !== undefined) {
      console.log(`  \x1b[31mERROR\x1b[0m ${r.error}`);
      continue;
    }
    totalFailed += r.failed.length;
    totalCantTell += r.cantTell.length;

    if (r.failed.length === 0) console.log('  \x1b[32mno failures\x1b[0m');

    // Group by rule, so a repeated component reads as one problem, not fifty.
    const byRule = new Map();
    for (const issue of r.failed) {
      issue.isNew = known === null || !known.has(baselineKey(r.url, issue));
      if (issue.isNew) totalNew++;
      byRule.set(issue.rule, [...(byRule.get(issue.rule) ?? []), issue]);
    }
    for (const [rule, issues] of [...byRule].sort((a, b) => a[0].localeCompare(b[0], 'en', { numeric: true }))) {
      const fresh = issues.filter((i) => i.isNew).length;
      const tag = known === null ? '' : fresh === 0 ? '  (all in baseline)' : `  (${fresh} new)`;
      const reqs = issues[0].requirements.join(', ');
      console.log(`  \x1b[31mFAILED\x1b[0m ${rule} (${issues.length})${tag}  ${reqs}`);
      if (issues[0].messages.length > 0) console.log(`         ${issues[0].messages[0]}`);
      for (const issue of issues.slice(0, 3)) console.log(`         · ${issue.markup}`);
      if (issues.length > 3) console.log(`         · ...and ${issues.length - 3} more`);
      console.log(`         ${ruleDocs(rule)}`);
    }
    if (r.cantTell.length > 0) {
      const rules = [...new Set(r.cantTell.map((i) => i.rule))].sort();
      console.log(`  \x1b[33mcantTell\x1b[0m ${r.cantTell.length} across ${rules.join(', ')}  (a person decides)`);
    }
    if (opts.verbose) console.log(`  passed ${r.passed}, inapplicable ${r.inapplicable}`);
  }

  console.log(`\n\x1b[1m${totalFailed} failure(s)\x1b[0m across ${reports.length} page(s), ` +
    `${totalCantTell} needing a human decision.`);
  if (known !== null) {
    console.log(`\x1b[1m${totalNew} new\x1b[0m since the baseline, ${totalFailed - totalNew} already known.`);
  }
  return { totalFailed, totalNew };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const allRules = [...Rules.values()];

  if (opts.listRules) {
    for (const rule of [...allRules].sort((a, b) => ruleId(a).localeCompare(ruleId(b), 'en', { numeric: true }))) {
      const reqs = ruleRequirements(rule);
      console.log(`${ruleId(rule).padEnd(9)} ${reqs.join('; ') || 'best practice'}\n          ${ruleDocs(ruleId(rule))}`);
    }
    return;
  }
  if (opts.targets.length === 0) usage(2);

  // An explicit --rule/--gaps selection wins over --level.
  let rules = allRules;
  if (opts.rules.length > 0) {
    rules = allRules.filter((r) => opts.rules.includes(ruleId(r).toLowerCase()));
    if (rules.length === 0) {
      console.error(`No rules matched ${opts.rules.join(', ')}. Try --list-rules.`);
      process.exit(2);
    }
  } else if (opts.level !== 'all') {
    rules = allRules.filter((r) => {
      const level = ruleLevel(r);
      return level === null || level <= LEVEL_RANK[opts.level];
    });
  }

  const urls = opts.targets.map((t) => toUrl(t, opts.base));
  const remote = urls.some(isRemote);
  const cap = opts.maxPages ?? REMOTE_PAGE_CAP;
  if (remote && urls.length > cap) {
    console.error(`Refusing to scan ${urls.length} pages on a remote site (cap ${cap}).\n` +
      'Scan a local or staging copy, or raise --max-pages knowing the site may ban you.');
    process.exit(2);
  }

  let known = null;
  if (opts.baseline !== null) {
    known = new Set(JSON.parse(await readFile(opts.baseline, 'utf8')).failures);
  }

  console.log(`Alfa ${rules.length}/${allRules.length} rule(s) · ` +
    `${opts.rules.length > 0 ? 'explicit rules' : `level ${opts.level}`} · ${urls.length} page(s) · ` +
    `${opts.viewportName} ${opts.viewport.width}x${opts.viewport.height}` +
    (remote ? `\n\x1b[33mRemote site: ${REMOTE_DELAY_MS} ms between pages.\x1b[0m` : ''));

  const reports = [];
  const browser = await chromium.launch({ headless: true });
  try {
    // A plain context with no device descriptor: device emulation changes
    // focus behavior and has no place in an accessibility scan.
    const context = await browser.newContext({ viewport: opts.viewport, ignoreHTTPSErrors: true });
    for (const [i, url] of urls.entries()) {
      const page = await context.newPage();
      try {
        const response = await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 });
        if (response !== null && !response.ok()) {
          reports.push({ url, failed: [], cantTell: [], passed: 0, inapplicable: 0, error: `HTTP ${response.status()}` });
          continue;
        }
        reports.push({ url, ...(await auditPage(page, rules)) });
      } catch (error) {
        reports.push({ url, failed: [], cantTell: [], passed: 0, inapplicable: 0,
          error: error instanceof Error ? error.message : String(error) });
      } finally {
        await page.close();
        if (remote && i < urls.length - 1) await new Promise((r) => setTimeout(r, REMOTE_DELAY_MS));
      }
    }
  } finally {
    await browser.close();
  }

  const { totalFailed, totalNew } = printReport(reports, opts, known);

  if (opts.json !== null) {
    const path = resolve(opts.json);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify({
      viewport: opts.viewport, rules: rules.map(ruleId), scannedAt: new Date().toISOString(), pages: reports,
    }, null, 2)}\n`);
    console.log(`Wrote ${path}`);
  }

  if (opts.updateBaseline !== null) {
    const failures = reports.flatMap((r) => r.failed.map((issue) => baselineKey(r.url, issue))).sort();
    const path = resolve(opts.updateBaseline);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify({
      note: 'Known Alfa failures. Each line is "<page path> <rule> <element>". Remove a line when you fix it.',
      updated: new Date().toISOString(),
      failures,
    }, null, 2)}\n`);
    console.log(`Wrote baseline ${path} (${failures.length} known failure(s))`);
  }

  const errors = reports.filter((r) => r.error !== undefined).length;
  const failing = known === null ? totalFailed : totalNew;
  if (opts.failOnIssues && (failing > 0 || errors > 0)) process.exitCode = 1;
}

await main();
