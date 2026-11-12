// Generates the synthetic fixtures, deterministically (no clock, no network, no randomness beyond a fixed seed).
//
//   node fixtures/make-synthetic.mjs
//
// Writes:
//   fixtures/site/_site-graph.json              a site capture manifest (browser audit ran, with data)
//   fixtures/site/_site-graph.browser-skipped.json   the same site with the browser audit skipped
//   fixtures/client-report.sample.json          an approved client report built from the first one by the project's own builder
//
// Everything is invented: the domain "example-shop.test" does not exist, and no text comes from a real site.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { build } from 'esbuild';
import { pathToFileURL, fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const DOMAIN = 'example-shop.test';
const ORIGIN = `https://${DOMAIN}`;

// ---- tiny deterministic generator -------------------------------------------------------------------------------
let seed = 20240101;
const rnd = () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));

// ---- invented pages: 1 home, 4 section hubs, 20 pages ------------------------------------------------------------
const SECTIONS = [
  { id: 'shop', label: 'Shop', pages: ['lorem-lamp', 'ipsum-chair', 'dolor-table', 'amet-shelf', 'consectetur-rug', 'adipiscing-vase'] },
  { id: 'journal', label: 'Journal', pages: ['sit-amet-notes', 'elit-sed-diary', 'tempor-guide', 'incididunt-story', 'labore-review'] },
  { id: 'help', label: 'Help', pages: ['dolore-shipping', 'magna-returns', 'aliqua-sizing', 'enim-care', 'minim-contact'] },
  { id: 'company', label: 'Company', pages: ['veniam-about', 'nostrud-team', 'exercitation-jobs', 'ullamco-press'] },
];
const WORDS = ['Lorem', 'Ipsum', 'Dolor', 'Amet', 'Elit', 'Tempor', 'Labore', 'Magna', 'Aliqua', 'Veniam'];

const nodes = [];
const edges = [];
const urlOf = (p) => (p === '/' ? `${ORIGIN}/` : `${ORIGIN}${p}`);
const idOf = (p) => (p === '/' ? 'home' : p.replace(/^\/|\/$/g, '').replace(/\//g, '-'));

function node(over) {
  const p = over.path;
  const wc = over.wordCount ?? int(120, 900);
  return {
    id: idOf(p), kind: 'page', health: 'healthy', title: `${WORDS[int(0, 9)]} ${WORDS[int(0, 9)]} | Example Shop`, url: urlOf(p), path: p,
    section: 'root', obsidianPath: `sites/${DOMAIN}/pages${p === '/' ? '/index' : p}.md`, statusCode: 200,
    responseTimeMs: int(120, 700), ttfbMs: int(60, 300), fetchDurationMs: int(150, 800), redirectHops: 0, flags: [], htmlBytes: int(18000, 90000),
    inSitemap: true, urlDepth: p === '/' ? 0 : p.split('/').filter(Boolean).length, clickDepth: 1, wordCount: wc, readingTimeMin: Math.max(1, Math.round(wc / 220)),
    metaDescription: 'Lorem ipsum dolor sit amet, a placeholder description for a made-up page.', canonical: urlOf(p), metaRobots: 'index,follow', lang: 'en',
    h1: ['Lorem ipsum heading'], h2Count: int(1, 5), schemaTypes: [], imagesCount: int(0, 6), localImagesCount: 0, imagesMissingAlt: 0, imagesEmptyAlt: 0,
    formsCount: 0, videosCount: 0, audioCount: 0, tablesCount: 0, codeBlocksCount: 0, transcriptsCount: 0,
    inlinksBody: 0, inlinksTotal: 0, outlinksBody: 0, outlinksTotal: 0, externalDomainsOut: 0, nofollowCount: 0, renderUsed: false,
    ...over,
  };
}

nodes.push(node({ path: '/', kind: 'home', health: 'home', title: 'Example Shop | Lorem ipsum furniture', clickDepth: 0, wordCount: 420, schemaTypes: ['Organization'] }));
for (const s of SECTIONS) {
  nodes.push(node({ path: `/${s.id}/`, kind: 'hub', health: 'hub', section: s.id, title: `${s.label} | Example Shop`, clickDepth: 1, wordCount: 260, h1: [s.label] }));
  for (const slug of s.pages) {
    nodes.push(node({ path: `/${s.id}/${slug}/`, section: s.id, clickDepth: 2, title: `${slug.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ')} | Example Shop`, h1: [slug.replace(/-/g, ' ')] }));
  }
}
const byPath = new Map(nodes.map((n) => [n.path, n]));
const get = (p) => byPath.get(p);

// Deliberate, invented problems so the audit has something to say.
get('/shop/amet-shelf/').health = 'orphan';       get('/shop/amet-shelf/').flags = ['orphan'];
get('/journal/labore-review/').health = 'orphan'; get('/journal/labore-review/').flags = ['orphan'];
get('/company/ullamco-press/').health = 'unlisted'; get('/company/ullamco-press/').inSitemap = false; get('/company/ullamco-press/').flags = ['unlisted'];
Object.assign(get('/help/aliqua-sizing/'), { health: 'redirect', statusCode: 301, redirectHops: 1, flags: ['redirect'], wordCount: 0 });
Object.assign(get('/help/enim-care/'), { health: 'broken', statusCode: 404, flags: ['broken'], wordCount: 0, title: '', h1: [] });
get('/shop/ipsum-chair/').metaDescription = '';
get('/shop/dolor-table/').metaDescription = '';
get('/journal/tempor-guide/').h1 = [];
get('/journal/incididunt-story/').title = 'Incididunt Story: a very long made-up title that keeps going well past the sixty character display limit | Example Shop';
get('/help/minim-contact/').wordCount = 90;
get('/shop/lorem-lamp/').imagesMissingAlt = 3;
get('/shop/adipiscing-vase/').imagesMissingAlt = 2;
get('/shop/consectetur-rug/').title = get('/shop/lorem-lamp/').title;

let edgeN = 0;
const addEdge = (source, target, kind, extra = {}) => { edges.push({ id: `e${String(++edgeN).padStart(4, '0')}`, source, target, kind, ...extra }); };
for (const s of SECTIONS) {
  addEdge('home', s.id, 'sitemap-hierarchy');
  addEdge('home', s.id, 'internal-chrome', { zone: 'chrome', anchor: s.label, count: 1 });
  for (const slug of s.pages) {
    const pid = `${s.id}-${slug}`;
    addEdge(s.id, pid, 'sitemap-hierarchy');
    if (pid === 'shop-amet-shelf' || pid === 'journal-labore-review') continue; // orphans: nothing links to them in the body
    addEdge(s.id, pid, 'internal-body', { zone: 'body', anchor: slug.replace(/-/g, ' '), count: 1 });
  }
}
const pagesOnly = nodes.filter((n) => n.kind === 'page' && n.health === 'healthy');
for (let i = 0; i < 26; i++) {
  const a = pick(pagesOnly), b = pick(pagesOnly);
  if (a.id === b.id) continue;
  addEdge(a.id, b.id, 'internal-body', { zone: 'body', anchor: `see ${b.h1[0] ?? 'more'}`, count: 1 });
}
// A body link to the redirecting and to the broken page, so the link-fix findings have sources.
addEdge('help-dolore-shipping', 'help-aliqua-sizing', 'internal-body', { zone: 'body', anchor: 'sizing', count: 1, targetUrl: urlOf('/help/aliqua-sizing/') });
addEdge('help-magna-returns', 'help-enim-care', 'internal-body', { zone: 'body', anchor: 'care', count: 1, targetUrl: urlOf('/help/enim-care/') });

// Two invented external domains.
for (const d of ['partner-one.test', 'partner-two.test']) {
  nodes.push({ ...node({ path: `/ext/${d}` }), id: `ext-${d}`, kind: 'external-domain', health: 'external', title: d, url: `https://${d}/`, path: '/', section: 'external', obsidianPath: '', statusCode: 0, inSitemap: false, clickDepth: null, urlDepth: 0, wordCount: 0, metaDescription: '', canonical: '', metaRobots: '', h1: [] });
}
addEdge('journal-sit-amet-notes', 'ext-partner-one.test', 'external', { targetUrl: 'https://partner-one.test/a', count: 1 });
addEdge('journal-tempor-guide', 'ext-partner-one.test', 'external', { targetUrl: 'https://partner-one.test/b', count: 1 });
addEdge('company-veniam-about', 'ext-partner-two.test', 'external', { targetUrl: 'https://partner-two.test/', count: 1 });

// Link counts from the edges.
const N = new Map(nodes.map((n) => [n.id, n]));
for (const e of edges) {
  const s = N.get(e.source), t = N.get(e.target);
  if (e.kind === 'sitemap-hierarchy') continue;
  s.outlinksTotal++; t.inlinksTotal++;
  if (e.kind === 'internal-body') { s.outlinksBody++; t.inlinksBody++; }
  if (e.kind === 'external') s.externalDomainsOut = new Set(edges.filter((x) => x.source === s.id && x.kind === 'external').map((x) => x.target)).size;
}

// ---- audit -------------------------------------------------------------------------------------------------------
const U = (id) => urlOf(N.get(id).path);
const target = (id, detail) => ({ url: U(id), ...(detail ? { detail } : {}) });
const finding = (id, category, tone, title, explanation, targets) => ({ id, category, tone, title, explanation, targets, targetCount: targets.length });
const findings = [
  finding('link-fix-broken', 'links', 'attention', 'Internal links to missing pages', 'These links lead to pages that return 404.', [{ url: U('help-enim-care'), sourceUrl: U('help-magna-returns'), detail: 'linked page returns 404' }]),
  finding('link-fix-redirect', 'links', 'review', 'Internal links that redirect', 'These links go through a redirect before they land.', [{ url: U('help-aliqua-sizing'), sourceUrl: U('help-dolore-shipping'), detail: 'redirects once (301)' }]),
  finding('orphan-page', 'structure', 'review', 'Pages nothing links to', 'No other page links to these pages in its body text.', [target('shop-amet-shelf'), target('journal-labore-review')]),
  finding('seo:missing-meta-description', 'metadata', 'attention', 'Missing meta description', 'These pages have no meta description.', [target('shop-ipsum-chair'), target('shop-dolor-table')]),
  finding('seo:missing-h1', 'metadata', 'attention', 'Missing H1', 'These pages have no top-level heading.', [target('journal-tempor-guide')]),
  finding('seo:title-too-long', 'metadata', 'review', 'Title too long', 'These titles are longer than search results usually show.', [target('journal-incididunt-story')]),
  finding('dup-title', 'duplicates', 'review', 'Duplicate titles', 'These pages share the same title.', [target('shop-lorem-lamp'), target('shop-consectetur-rug')]),
  finding('images-missing-alt', 'accessibility', 'attention', 'Images without alt text', 'These pages have images with no alternative text.', [target('shop-lorem-lamp', '3 images'), target('shop-adipiscing-vase', '2 images')]),
  finding('thin-content', 'content', 'review', 'Thin content', 'These pages have very little text.', [target('help-minim-contact')]),
  finding('unlisted-in-sitemap', 'indexing', 'review', 'Pages missing from the sitemap', 'These pages are reachable but not listed in the sitemap.', [target('company-ullamco-press')]),
  finding('slow-lab-lcp', 'performance', 'attention', 'Slow main content in lab test', 'The main content took longer than the slow-load threshold in a lab load.', [target('shop-lorem-lamp', 'LCP 3.4 s'), target('home', 'LCP 2.9 s')]),
];

const labPages = [
  { url: U('home'), error: null, lab: { lcpMs: 2900, cls: 0.04, domContentLoadedMs: 1100, loadMs: 2300, requests: 38, transferBytes: 1420000 } },
  { url: U('shop'), error: null, lab: { lcpMs: 2600, cls: 0.12, domContentLoadedMs: 1000, loadMs: 2100, requests: 41, transferBytes: 1650000 } },
  { url: U('shop-lorem-lamp'), error: null, lab: { lcpMs: 3400, cls: 0.02, domContentLoadedMs: 1300, loadMs: 2800, requests: 52, transferBytes: 2380000 } },
];

const issueCatalog = Object.fromEntries(findings.map((f) => [f.id, { category: f.category, tone: f.tone, title: f.title, explanation: f.explanation }]));

const pagesCrawled = nodes.filter((n) => n.kind !== 'external-domain').length;
const manifestFor = (browserOk) => ({
  schemaVersion: '1.3.0',
  captureStatus: 'complete',
  siteId: DOMAIN,
  domain: DOMAIN,
  brandName: 'Example Shop',
  origin: ORIGIN,
  capturedAt: '2024-01-15T10:00:00Z',
  elapsedSec: 42,
  stats: {
    pagesCrawled, sitemapsFound: 1, sitemapUrlsTotal: pagesCrawled - 1, internalEdges: edges.filter((e) => e.kind !== 'external').length,
    externalDomains: 2, externalEdges: edges.filter((e) => e.kind === 'external').length, localImagesDownloaded: 0,
    orphanPages: 2, unlistedPages: 1, brokenOrRedirectPages: 2, pagesWithSeoIssues: 6, avgResponseTimeMs: 410, medianResponseTimeMs: 390,
    avgFetchDurationMs: 480, auditFindings: findings.length, auditFindingItems: findings.reduce((a, f) => a + f.targets.length, 0),
  },
  siteIntel: {
    brandName: 'Example Shop', languages: ['en'], avgResponseTimeMs: 410, totalAssetsMb: 3.1,
    contacts: { emails: [], phones: [], socialProfiles: [] },
    techStack: {
      analyticsAndPixels: [], measurementIds: { ga4: [], gtm: [], googleAds: [] }, searchConsoleVerifiedMeta: false, bingVerifiedMeta: false,
      cmsOrFramework: ['Lorem CMS'], hostingAndCdn: ['Example CDN'], httpCompression: 'gzip', cacheControl: 'max-age=300',
      securityHeaders: { present: ['strict-transport-security'], missing: ['content-security-policy', 'x-content-type-options'] },
    },
    transport: { tls: { state: 'ok', verified: true, daysRemaining: 61, tlsVersion: 'TLSv1.3', issuer: 'Example Test CA' } },
    browserAudit: browserOk
      ? { state: 'ok', elapsedSec: 18, sampledUrls: labPages.map((p) => p.url), pages: labPages, findings: [findings.find((f) => f.id === 'slow-lab-lcp')] }
      : { state: 'skipped', detail: 'The browser audit was turned off for this capture.', pages: [], findings: [] },
  },
  audit: { version: 1, findings },
  issueCatalog,
  sitemaps: [{ url: `${ORIGIN}/sitemap.xml`, source: 'robots.txt', kind: 'urlset', url_count: pagesCrawled - 1, child_count: 0 }],
  sections: SECTIONS.map((s) => ({ id: s.id, label: s.label, pageCount: s.pages.length + 1 })),
  nodes: structuredClone(nodes),
  edges: structuredClone(edges),
});

const write = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n'); };
const siteFile = path.join(here, 'site', '_site-graph.json');
write(siteFile, manifestFor(true));
write(path.join(here, 'site', '_site-graph.browser-skipped.json'), manifestFor(false));

// ---- the client report, built by the project's own builder -------------------------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-fixtures-'));
const bundle = path.join(tmp, 'contract.mjs');
await build({ entryPoints: [path.join(root, 'packages', 'contract', 'tests', 'entry.ts')], bundle: true, platform: 'node', format: 'esm', outfile: bundle, logLevel: 'error' });
const L = await import(pathToFileURL(bundle).href);
const raw = fs.readFileSync(siteFile);
const m = JSON.parse(raw.toString('utf8'));
const sha = crypto.createHash('sha256').update(raw).digest('hex');
const w = L.buildDraft(m, sha, { presenter: 'Dana Example', preparedFor: 'Casey Sample' });
w.authoring.reviewState = 'approved';
w.authoring.reviewedBy = 'Dana Example';
w.brand.feedbackEmail = 'feedback@agency.example';
const sealed = await L.sealReport(L.buildClientReport(w, m, { createdAt: '2024-01-16T09:00:00Z' }), async (s) => crypto.createHash('sha256').update(s).digest('hex'));
const problems = L.validateClientReport(sealed, L.makeCtx(m));
fs.rmSync(tmp, { recursive: true, force: true });
if (problems.length) { console.error('the synthetic report does not validate:', problems.slice(0, 5)); process.exit(1); }
write(path.join(here, 'client-report.sample.json'), sealed);
console.log(`wrote fixtures/site/_site-graph.json (${nodes.length} nodes, ${edges.length} edges, ${findings.length} findings), the browser-skipped variant, and fixtures/client-report.sample.json`);
