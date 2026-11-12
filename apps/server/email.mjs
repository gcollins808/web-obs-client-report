// The feedback email, built on the server from the client's structured answers and the report itself.
// Plain HTML with inline styles (no images, no scripts), a readable text alternative, and nothing sensitive:
// no link, token, address or report path, only the client name, report id, step, answer and notes.
const NL = String.fromCharCode(10);

export const escapeHtml = (s) => String(s).split('&').join('&amp;').split('<').join('&lt;').split('>').join('&gt;').split('"').join('&quot;').split("'").join('&#39;');
const one = (s, max) => String(s ?? '').split('').filter((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127).join('').trim().slice(0, max);
const para = (s, max) => String(s ?? '').split(String.fromCharCode(13)).join('').split('').filter((c) => c === NL || (c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127)).join('').trim().slice(0, max);

/** What the client may send: an answer per finding (one of that step's own options), a note per finding, a general note and a name. */
export function readFeedback(report, body) {
  const steps = (report.modes?.guided?.steps ?? []).filter((s) => s.kind === 'finding');
  const tour = report.modes?.guided?.tour ?? [];
  const items = [];
  for (const st of steps) {
    const answer = body?.answers?.[st.checkpoint?.id];
    const note = para(body?.comments?.[st.findingId], 600);
    const okAnswer = typeof answer === 'string' && (st.checkpoint?.options ?? []).includes(answer) ? answer : '';
    if (!okAnswer && !note) continue;
    const at = tour.indexOf(st.id);
    items.push({ title: one(st.title, 200), step: at >= 0 ? `Step ${at + 1} of ${tour.length}` : 'From the list of other findings (not a tour step)', answer: okAnswer, note });
  }
  return { items, general: para(body?.general, 1500), name: one(body?.name, 120) };
}

export function composeFeedbackEmail(report, fb, now = new Date()) {
  const client = one(report.client?.name || 'the client', 120);
  const domain = one(report.client?.domain || '', 120);
  const rid = one(report.meta?.reportId || '', 80);
  const captured = one(report.meta?.source?.capturedAt || '', 10);
  const when = now.toUTCString().replace('GMT', 'UTC');
  const subject = `Feedback from ${client} on their website review`;
  const answered = fb.items.filter((i) => i.answer).length;

  const text = [
    `Feedback from ${client}${domain ? ` (${domain})` : ''} on their website review.`, '',
    `Received:   ${when}`,
    `Report:     ${rid}${captured ? `, captured ${captured}` : ''}`,
    `From:       ${fb.name || 'name not given'}`,
    `Answers:    ${answered} of ${(report.modes?.guided?.steps ?? []).filter((s) => s.kind === 'finding').length} findings`, '',
    ...fb.items.flatMap((i) => [`${i.step}: ${i.title}`, `  Answer: ${i.answer || 'no answer'}`, ...(i.note ? [`  Note: ${i.note.split(NL).join(NL + '        ')}`] : []), '']),
    ...(fb.general ? ['Anything else:', fb.general, ''] : []),
    '--', 'Sent through the report server. No link or login details are included.',
  ].join(NL);

  const row = (k, v) => `<tr><td style="padding:2px 12px 2px 0;color:#555;white-space:nowrap">${escapeHtml(k)}</td><td style="padding:2px 0">${escapeHtml(v)}</td></tr>`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:16px;background:#f4f5f8;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.5;color:#1b1f2a">
<div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;padding:20px">
<h1 style="font-size:20px;line-height:1.3;margin:0 0 4px">Feedback from ${escapeHtml(client)}</h1>
<p style="margin:0 0 14px;color:#555">on their website review${domain ? ` (${escapeHtml(domain)})` : ''}</p>
<table role="presentation" style="border-collapse:collapse;font-size:15px;margin-bottom:8px">${row('Received', when)}${row('Report', rid + (captured ? `, captured ${captured}` : ''))}${row('From', fb.name || 'name not given')}${row('Answers', `${answered} finding${answered === 1 ? '' : 's'} answered`)}</table>
${fb.items.map((i) => `<div style="border-top:1px solid #e3e5ec;padding:12px 0">
<div style="font-size:13px;color:#555">${escapeHtml(i.step)}</div>
<div style="font-weight:600">${escapeHtml(i.title)}</div>
<div style="margin-top:4px"><span style="display:inline-block;background:#eceaff;border-radius:999px;padding:2px 10px;font-size:14px">${escapeHtml(i.answer || 'no answer')}</span></div>
${i.note ? `<p style="margin:8px 0 0;white-space:pre-wrap">${escapeHtml(i.note)}</p>` : ''}</div>`).join('')}
${fb.general ? `<div style="border-top:1px solid #e3e5ec;padding:12px 0"><div style="font-size:13px;color:#555">Anything else</div><p style="margin:4px 0 0;white-space:pre-wrap">${escapeHtml(fb.general)}</p></div>` : ''}
<p style="border-top:1px solid #e3e5ec;margin:8px 0 0;padding-top:10px;font-size:12px;color:#777">Sent through the report server. No link or login details are included.</p>
</div></body></html>`;
  return { subject, text, html };
}
