// Throw-away probe: prove the sign-up mail really goes out over Gmail SMTP and
// lands in the recipient's own inbox (no in-app mailbox involved).
//
//   node _mail_send_probe.mjs                 -> sends to GMAIL_USER itself
//   node _mail_send_probe.mjs you@gmail.com   -> sends to any address you name
//
// Paste your own Gmail address to see the real "Let's create your account" mail.
import 'dotenv/config';
import { sendOTPEmail } from './config/mailer.js';

const to = process.argv[2] || process.env.GMAIL_USER;
const code = String(Math.floor(100000 + Math.random() * 900000));
const link = `http://localhost:5173/finish-signup?variant=create&email=${encodeURIComponent(to)}&otp=${code}`;

console.log(`SMTP user : ${process.env.GMAIL_USER}`);
console.log(`Recipient : ${to}`);

const info = await sendOTPEmail(to, code, "Let's create your account", link);
console.log('messageId :', info.messageId);
console.log('accepted  :', JSON.stringify(info.accepted));
console.log('rejected  :', JSON.stringify(info.rejected));
console.log('smtp      :', info.response);
