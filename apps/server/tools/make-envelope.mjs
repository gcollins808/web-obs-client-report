// Builds the one-request body for a report that carries its own look: { "styles_<hash>": styles, "data_<hash>": report }.
//   node apps/server/tools/make-envelope.mjs <report.json> <styles.json> > body.json
// The styles are checked with the same function the upload and the server use; nothing is sent. The publish buttons and the Studio do this for you;
// this is for someone sending by hand (for example with curl).
import fs from 'node:fs';
import { validateStyles } from '../../viewer/brand/styles.mjs';
import { makeEnvelope } from '../../viewer/brand/styles-hash.mjs';

const [reportFile, stylesFile] = process.argv.slice(2);
if (!reportFile || !stylesFile) { console.error('Usage: node make-envelope.mjs <report.json> <styles.json> > body.json'); process.exit(2); }
let report, styles;
try { report = JSON.parse(fs.readFileSync(reportFile, 'utf8')); styles = JSON.parse(fs.readFileSync(stylesFile, 'utf8').replace(/^﻿/, '')); } catch { console.error('One of the files cannot be read as JSON.'); process.exit(1); }
const v = validateStyles(styles);
if (!v.ok) { console.error('The styles are not valid: ' + v.errors.join(' ')); process.exit(1); }
if (report && typeof report === 'object' && 'styles' in report) delete report.styles;
process.stdout.write(JSON.stringify(makeEnvelope(report, styles)));
