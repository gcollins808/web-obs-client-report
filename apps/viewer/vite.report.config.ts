import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import fs from 'node:fs';
import { loadBrand, describe } from './brand/load-brand.mjs';

// Repository root (this file lives in apps/viewer).
const root = path.resolve(__dirname, '..', '..');

// Shown in the Studio header and the viewer's help card, so you can tell which build you are looking at.
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const builtAt = new Date().toISOString().slice(0, 16).replace('T', ' ');

// The agency brand (apps/viewer/brand/brand.json, or WEBOBS_BRAND_DIR). Without one, or with one that does not pass, the build keeps the
// current look and prints why. WEBOBS_BRAND_STRICT=1 turns an invalid brand into a build failure. See apps/viewer/brand/README.md.
const brand = loadBrand(process.env.WEBOBS_BRAND_DIR ? path.resolve(process.env.WEBOBS_BRAND_DIR) : path.join(__dirname, 'brand'));
for (const line of describe(brand)) console.log(line);
const BUILD_STAMP = `report app v${version} · built ${builtAt} UTC${brand.used === 'brand' ? ` · brand: ${brand.brand!.name}` : ''}`;
const brandPlugin = {
  name: 'webobs-brand',
  transformIndexHtml: {
    order: 'pre' as const,
    handler(html: string) {
      // A dedicated place right after the title where the report server puts a report's styles (apps/server/styles-inject.mjs).
      const withMarker = (h: string) => h.replace('</title>', () => '</title><!--wo-brand-->');
      if (brand.used !== 'brand' || !brand.page) return withMarker(html);
      return withMarker(html.replace(/<title>[^<]*<\/title>/, () => `<title>${brand.page!.titleText}</title>`)).replace('</head>', () => `<style id="brand-tokens">${brand.css}</style>\n</head>`);
    },
  },
};

// Builds the hosted Report app (admin + client viewer) from apps/viewer. `npm run build` then inlines the
// output into one self-contained HTML file, which is both the hosted app and the shell for exported reports.
export default defineConfig({
  root: __dirname,
  // Settings come from the repository's .env files (see .env.example). Only the WEBOBS_FEEDBACK_* values are baked into
  // the app at build time (visible to anyone who opens it). Anything else, such as WEBOBS_PUBLISH_TARGET, is never put in the page.
  envDir: root,
  envPrefix: ['VITE_', 'WEBOBS_FEEDBACK_'],
  define: {
    __BUILD_STAMP__: JSON.stringify(BUILD_STAMP),
    // Only presentation text and one colour reach the page (never the supplemental keys, the source or file paths). null = built-in look.
    __WEBOBS_BRAND__: JSON.stringify(brand.used === 'brand' ? brand.page : null),
  },
  plugins: [react(), brandPlugin],
  base: './',
  server: { port: 5176, fs: { allow: [root] } },
  preview: { port: 4176 },
  build: { target: 'es2022', outDir: path.join(root, 'dist-report'), emptyOutDir: true, assetsInlineLimit: 100_000_000, cssCodeSplit: false },
});
