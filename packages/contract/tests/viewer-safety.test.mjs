// Viewer safety checks, foreground and self-terminating. Synthetic data only. Run: node packages/contract/tests/viewer-safety.test.mjs
//  1. Static: no way for report text to become markup, script, a link or a style in the viewer source.
//  2. Helpers: safeHttpUrl / safeImageSrc refuse javascript:, data:, file:, svg, remote and odd addresses.
//  3. Render: a report full of '<img src=x onerror=...>' and 'javascript:alert(1)' renders only as text, with no link or image from it.
// The server's Content-Security-Policy allows inline script (one inlined file), so none of this may depend on the CSP.
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import { pathToFileURL, fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..', '..');
const src = path.join(root, 'apps', 'viewer', 'src'), contractSrc = path.join(root, 'packages', 'contract', 'src');
let failed = 0;
const check = (name, ok, detail = '') => { if (!ok) failed++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`); };

const files = [];
(function walk(d) { for (const n of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, n.name); if (n.isDirectory()) walk(p); else if (/\.(tsx?|html)$/.test(n.name)) files.push(p); } })(src);
for (const n of fs.readdirSync(contractSrc)) if (/.tsx?$/.test(n)) files.push(path.join(contractSrc, n));
files.push(path.join(src, '..', 'index.html'));
const code = (f) => fs.readFileSync(f, 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const rel = (f) => path.relative(root, f).split(path.sep).join('/');

console.log('static: no path from report text to markup or script');
{
  const sink = /dangerouslySetInnerHTML|\.innerHTML|\.outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function\(|createContextualFragment|srcdoc|\.setAttribute\(\s*['"](href|src|style|on\w+)/;
  const hits = files.filter((f) => sink.test(code(f))).map(rel);
  check('no dangerouslySetInnerHTML, innerHTML, outerHTML, insertAdjacentHTML, document.write, eval, new Function or setAttribute of href/src/style', hits.length === 0, hits.join(', '));
  const comp = files.filter((f) => /components[\\/].*\.tsx$/.test(f));
  const hrefs = comp.flatMap((f) => [...code(f).matchAll(/href=\{([^}]*)\}|href="([^"]*)"/g)].map((m) => `${rel(f)}: ${m[0]}`));
  check('the only href in the viewer is the feedback mailto link built from a checked address', hrefs.length === 1 && /href=\{fb\.mailto\}/.test(hrefs[0]), hrefs.join(' | '));
  const srcs = comp.flatMap((f) => [...code(f).matchAll(/\ssrc=\{([^}]*(?:\([^)]*\))?[^}]*)\}|\ssrc="([^"]*)"/g)].map((m) => ({ f: rel(f), expr: (m[1] ?? m[2]).trim() })));
  const allowed = new Set(['logo', 'shot', 'safeImageSrc(images.logo)']);
  check('every <img src> is a value that went through safeImageSrc', srcs.length >= 4 && srcs.every((s) => allowed.has(s.expr)), srcs.map((s) => `${s.f}: ${s.expr}`).join(' | '));
  const pv = code(path.join(src, 'components', 'PackageViewer.tsx')), sc = code(path.join(src, 'components', 'Scenes.tsx')), vw = code(path.join(src, 'components', 'Viewer.tsx'));
  check('PackageViewer, Scenes and Viewer each define those values with safeImageSrc',
    /const logo = r\.client\.logo \? safeImageSrc\(/.test(pv) && /const shot = f\?\.evidence \? safeImageSrc\(/.test(pv) && /const shot = safeImageSrc\(/.test(sc) && /const logo = safeImageSrc\(/.test(sc) && /logoDataUri=\{safeImageSrc\(/.test(vw));
  const styles = comp.flatMap((f) => [...code(f).matchAll(/\sstyle=\{([^}]*\}?)\}/g)].map((m) => `${rel(f)}: ${m[1]}`));
  const dynamicOk = (s) => /: style$|: \{ opacity: (veil|dim) |: \{ \['--dim' as string\]|animationDelay|width: '4\.5rem'/.test(s) || /^\S+: style$/.test(s);
  check('style attributes carry only hex-checked theme values, numbers or fixed text', styles.every(dynamicOk), styles.filter((s) => !dynamicOk(s)).join(' | '));
  check('theme colours are hex-checked before they reach a style, and a report theme cannot set the stage background', /THEME_HEX\.test\(r\.client\.accent\)/.test(pv) && /THEME_HEX\.test\(tone\.ink\)/.test(pv) && !/'--bg'/.test(pv));
  check('no script tag in the page source other than the module entry', (code(path.join(src, '..', 'index.html')).match(/<script/g) ?? []).length === 1);
}

console.log('helpers');
const out = path.join(here, '.build', 'viewer-safe.mjs');
await build({ entryPoints: [path.join(contractSrc, 'safe.ts')], bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'error' });
const S = await import(pathToFileURL(out).href);
{
  const bad = ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', ' javascript:alert(1)', 'java\tscript:alert(1)', 'data:text/html;base64,PGI+', 'file:///etc/passwd', 'vbscript:x', '//evil.example/', '/relative', 'https:evil.example', 'https://a.test/\njavascript:1', 'https://a.test/a b', 'https://u:p@a.test/', 'https://a.test\\@b.test', 5, null, undefined, {}];
  check('safeHttpUrl refuses every hostile address', bad.every((b) => S.safeHttpUrl(b) === undefined), bad.filter((b) => S.safeHttpUrl(b) !== undefined).join(' | '));
  check('safeHttpUrl keeps real http and https addresses', S.safeHttpUrl('https://example-shop.test/a?b=c#d') === 'https://example-shop.test/a?b=c#d' && S.safeHttpUrl('http://x.test/') === 'http://x.test/');
  const png = 'data:image/png;base64,iVBORw0KGgo=';
  const badImg = ['javascript:alert(1)', 'data:image/svg+xml;base64,PHN2Zz4=', 'data:text/html;base64,PGI+', 'https://evil.example/x.png', 'data:image/png,<svg onload=alert(1)>', 'data:image/png;base64,AAAA"><script>', ' ' + png, png + '\n', 7, null, undefined];
  check('safeImageSrc refuses non-images, svg, remote and malformed values', badImg.every((b) => S.safeImageSrc(b) === undefined), badImg.filter((b) => S.safeImageSrc(b) !== undefined).join(' | '));
  check('safeImageSrc keeps png, jpeg, webp and gif data images', [png, 'data:image/jpeg;base64,/9j/4AAQ', 'data:image/webp;base64,UklGRg==', 'data:image/gif;base64,R0lGODlh'].every((g) => S.safeImageSrc(g) === g));
}

console.log('render: a hostile report is shown as text only');
{
  const entry = path.join(here, '.build', 'viewer-entry.tsx');
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(entry, `import { renderToStaticMarkup } from 'react-dom/server';\nimport { PackageViewer } from ${JSON.stringify(path.join(src, 'components', 'PackageViewer.tsx').split(path.sep).join('/'))};\nexport const render = (report: any, step: number) => { (globalThis as any).location = { hash: '#step=' + step, search: '', pathname: '/' }; return renderToStaticMarkup(<PackageViewer report={report} />); };\n`);
  const o2 = path.join(here, '.build', 'viewer-render.mjs');
  await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', outfile: o2, logLevel: 'error', loader: { '.css': 'empty', '.png': 'dataurl', '.svg': 'dataurl' }, jsx: 'automatic', nodePaths: [path.join(root, 'node_modules')], banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" } });
  const { render } = await import(pathToFileURL(o2).href);

  const XSS = '<img src=x onerror=alert(1)>', JS = 'javascript:alert(1)';
  const r = JSON.parse(fs.readFileSync(path.join(here, '..', '..', '..', 'fixtures', 'client-report.sample.json'), 'utf8'));
  delete r.map; // no WebGL here; the map is not text
  r.client.name = XSS + ' Shop'; r.client.presenter = XSS; r.client.preparedFor = XSS; r.client.logo = 'logo'; r.client.accent = 'red;background:url(x)';
  r.client.theme = { accent: '#112233', dark: { bg: 'red;}body{display:none', ink: '#ffffff' } };
  r.assets = { logo: JS, shot: 'https://evil.example/pixel.png' };
  r.feedback = { to: 'a@b.co?bcc=evil@x.zz', subject: XSS };
  const f0 = r.findings[0];
  f0.title = XSS; f0.observed[0].text = XSS + ' ' + JS; f0.fix[0] = XSS; f0.verify = JS; f0.examples[0].url = JS; f0.evidence = { image: 'shot', caption: XSS };
  r.glossary[0].term = XSS; r.glossary[0].plain = JS;
  const steps = r.modes.guided.steps;
  steps.forEach((s) => { if (s.title) s.title = XSS; if (s.body) s.body = s.body.map(() => XSS + ' ' + JS); });
  const gs = steps.find((s) => s.kind === 'finding' && s.findingId === f0.id);
  gs.title = XSS; gs.beats.found[0].text = XSS; gs.beats.yourPart = JS; gs.beats.meaning.inPlain = XSS; gs.checkpoint.question = XSS; gs.checkpoint.options = [XSS, JS];
  const tour = r.modes.guided.tour;
  const pages = [];
  for (let i = 0; i < tour.length; i++) pages.push(render(r, i));
  const html = pages.join('\n');
  check('every step renders', pages.every((h) => h.length > 200) && pages.length === tour.length, `${pages.length} steps`);
  check('the markup in report text is escaped (shown as text)', html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  const tags = [...html.matchAll(/<([a-zA-Z][\w-]*)((?:\s+[^\s=>"']+(?:=(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*\/?>/g)].map((m) => ({ tag: m[1].toLowerCase(), attrs: [...m[2].matchAll(/\s+([^\s=>"']+)(?:=(?:"[^"]*"|'[^']*'|[^\s>]+))?/g)].map((x) => x[1].toLowerCase()) }));
  check('no tag was created from report text: no <img>, no event-handler attribute on any tag', html.length > 1000 && tags.length > 20 && !tags.some((t) => t.tag === 'img' || t.tag === 'script' || t.tag === 'iframe' || t.attrs.some((n) => n.startsWith('on'))), tags.filter((t) => t.tag === 'img' || t.attrs.some((n) => n.startsWith('on'))).map((t) => t.tag).join());
  check('no javascript: or data:text address in any attribute', !/\s(href|src|action|formaction|xlink:href)\s*=\s*"?\s*(javascript|data:text|vbscript|file)/i.test(html));
  check('the hostile logo and screenshot addresses produced no <img> at all', !/<img/i.test(html) && !html.includes('evil.example'));
  const links = [...html.matchAll(/<a\s[^>]*>/gi)].map((m) => m[0]);
  check('no link was created from report text (a bad feedback address gives no mailto either)', links.length === 0, links.join(' '));
  check('a non-hex accent or theme colour does not reach a style', !/style="[^"]*(red|url\(|display:none)/i.test(html));
  // a good report still shows its image and mailto
  const good = JSON.parse(fs.readFileSync(path.join(here, '..', '..', '..', 'fixtures', 'client-report.sample.json'), 'utf8')); delete good.map;
  good.client.logo = 'logo'; good.assets = { logo: 'data:image/png;base64,iVBORw0KGgo=' };
  const goodHtml = render(good, 0) + render(good, good.modes.guided.tour.length - 1);
  check('a real logo still shows, and a real feedback address still makes a mailto link', goodHtml.includes('<img src="data:image/png;base64,iVBORw0KGgo="') && /<a [^>]*href="mailto:feedback@agency\.example\?subject=/.test(goodHtml));
}

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall viewer safety checks passed');
process.exit(failed ? 1 : 0);
