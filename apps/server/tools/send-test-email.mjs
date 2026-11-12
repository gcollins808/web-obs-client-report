// Sends ONE test feedback email through Resend, to the WEBOBS_FEEDBACK_TO address in apps/server/.env. Run it only when the key is in.
//   node apps/server/tools/send-test-email.mjs --yes
// It refuses to run without --yes, refuses a second send (delete apps/server/.test-email-sent or pass --again), and never prints the key.
import fs from 'node:fs';
import path from 'node:path';
import { composeFeedbackEmail, readFeedback } from '../email.mjs';

const dir = path.resolve(import.meta.dirname, '..');
try { process.loadEnvFile(process.env.ENV_FILE || path.join(dir, '.env')); } catch { console.error('No apps/server/.env file found. Copy .env.example to apps/server/.env and fill it in.'); process.exit(2); }
const missing = ['RESEND_API_KEY', 'RESEND_FROM', 'WEBOBS_FEEDBACK_TO'].filter((k) => !(process.env[k] || '').trim());
if (missing.length) { console.error('Not sent. Missing in apps/server/.env: ' + missing.join(', ')); process.exit(2); }
if (!process.argv.includes('--yes')) { console.error('This sends one real email to the WEBOBS_FEEDBACK_TO address. Run again with --yes to send it.'); process.exit(2); }
const marker = path.join(dir, '.test-email-sent');
if (fs.existsSync(marker) && !process.argv.includes('--again')) { console.error('A test email was already sent from this folder. Pass --again to send another.'); process.exit(2); }

const report = {
  client: { name: 'TEST - Example Client', domain: 'example.test' }, meta: { reportId: 'test-email', source: { capturedAt: new Date().toISOString() } },
  modes: { guided: { tour: ['welcome', 'g-sample'], steps: [{ id: 'g-sample', kind: 'finding', findingId: 'sample', title: 'Sample finding: search-result snippets are left to chance', checkpoint: { id: 'cp-sample', options: ['This is what I expected', 'This surprises me', 'I would like to discuss this'] } }] } },
};
const fb = readFeedback(report, { answers: { 'cp-sample': 'This surprises me' }, comments: { sample: 'This is a test message from the report server setup. No action needed.' }, general: 'Test email only. It carries no client data.', name: 'Setup test' });
const mail = composeFeedbackEmail(report, fb);
const res = await fetch('https://api.resend.com/emails', {
  method: 'POST',
  headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
  body: JSON.stringify({ from: process.env.RESEND_FROM.trim(), to: [process.env.WEBOBS_FEEDBACK_TO.trim()], subject: '[TEST] ' + mail.subject, html: mail.html, text: mail.text }),
});
if (res.ok) { fs.writeFileSync(marker, new Date().toISOString()); console.log('Sent one test email (Resend status ' + res.status + ').'); }
else { console.error('Resend refused it (status ' + res.status + '). Check the key, and that RESEND_FROM is a verified sender.'); process.exit(1); }
