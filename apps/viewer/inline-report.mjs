// Inlines dist-report/index.html (script + css) into a single file: dist-report/report.html.
// The result opens from file://, from any static host, and doubles as the shell for exported client reports.
import fs from 'node:fs';
import path from 'node:path';

const dir = path.resolve(import.meta.dirname, '..', '..', 'dist-report');
let html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
const read = (href) => fs.readFileSync(path.join(dir, href.replace(/^\.?\//, '')), 'utf8');
html = html.replace(/<link rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/g, (_m, href) => `<style>${read(href)}</style>`);
html = html.replace(/<script type="module"[^>]*src="([^"]+)"[^>]*><\/script>/g, (_m, src) => {
  const js = read(src).replace(/<\/script/gi, '<\/script');
  return `<script type="module">${js}</script>`;
});
html = html.replace(/<link rel="modulepreload"[^>]*>/g, '');
const marker = '<!--WO_REPORT_DATA-->';
const at = html.lastIndexOf(marker);
if (at < 0 || !html.slice(Math.max(0, at - 80), at).includes('id="root"')) throw new Error('report.html lost the data marker after #root');
fs.writeFileSync(path.join(dir, 'report.html'), html);
console.log(`dist-report/report.html  ${(html.length / 1024 / 1024).toFixed(2)} MB`);
