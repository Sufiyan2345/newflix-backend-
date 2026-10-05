// Throw-away preview: dumps the EXACT "Let's create your account" mail that
// backend/config/mailer.js hands to Gmail, with the inline (cid:) images turned
// into data URIs so a plain browser can show it. Open _mail_preview.html at a
// 501px viewport to compare it with the reference screenshots.
//
//   node _mail_preview.mjs [recipient@gmail.com]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import {
  renderSignupMailHtml,
  renderFinishSignupMailHtml,
  renderOtpMailHtml,
  renderResetPasswordMailHtml,
  renderPasswordUpdatedMailHtml,
} from './config/mailer.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const pub = path.resolve(here, '..', 'frontend', 'public');
const to = process.argv[2] || 'usercomputer3266@gmail.com';
const link = 'https://www.netflix.com/pk/signup';

const dataUri = (file) => `data:image/png;base64,${fs.readFileSync(path.join(pub, file)).toString('base64')}`;

// the four inline (cid:) images the mail travels with
const inline = (html) => html
  .replaceAll('cid:netflix-n', dataUri('Netflix.png'))
  .replaceAll('cid:netflix-shield', dataUri('unnamed.png'))
  .replaceAll('cid:netflix-block', dataUri('unnamed (1).png'))
  .replaceAll('cid:netflix-devices', dataUri('unnamed (2).png'));

const files = [
  ['_mail_preview.html', inline(renderSignupMailHtml(link, to))],
  ['_mail_preview_finish.html', inline(renderFinishSignupMailHtml(link, to))],
  ['_mail_preview_code.html', inline(renderOtpMailHtml('764040', `Confirm your account change with this code: 764040`, to))],
  ['_mail_preview_reset.html', inline(renderResetPasswordMailHtml(`${link}?reset=${encodeURIComponent(to)}&code=764040`, to, 'Sherkin'))],
  ['_mail_preview_updated.html', inline(renderPasswordUpdatedMailHtml(to, 'Smiles Davis'))],
];

for (const [name, html] of files) {
  const out = path.resolve(here, '..', name);
  fs.writeFileSync(out, html);
  console.log(`wrote ${out} (${html.length} chars, recipient ${to})`); 
  
}
