// Tiny static host for dist-report (the hosted-app deployment, locally). Serves any folder given as PORT/DIR.
// A real deployment is just these static files behind any web server; there is no backend.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const port = Number(process.env.PORT || 4176);
const dir = path.resolve(process.env.DIR || 'dist-report');
const reportsDir = path.resolve(process.env.PREVIEW_REPORTS_DIR || 'dev-volume/reports');
const types = { '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };
http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  let file = path.join(dir, decodeURIComponent(url.pathname));
  if (url.pathname === '/' ) file = path.join(dir, 'report.html');
  // Client reports written by the audit view's Publish audit: only exact random file names, from one folder. No listing.
  const m = /^[/]reports[/]([0-9a-f]{32}[.]json)$/.exec(url.pathname);
  if (m) file = path.join(reportsDir, m[1]);
  if (!(file.startsWith(dir) || file.startsWith(reportsDir + path.sep)) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}).listen(port, () => console.log(`Report app on http://localhost:${port}/  (serving ${dir})`));
