import nodemailer from 'nodemailer';
import { buildMailTemplates } from './mailTemplates.js';

const normalizeGmailValue = (value) => (value || '').replace(/\s+/g, '').trim();

const gmailUser = normalizeGmailValue(process.env.GMAIL_USER);
const gmailAppPassword = normalizeGmailValue(process.env.GMAIL_APP_PASSWORD);

const hasValidGmailConfig = Boolean(
  gmailUser &&
  gmailAppPassword &&
  gmailUser.includes('@') &&
  gmailAppPassword.length >= 10
);

const escapeHtml = (value) => String(value || '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const transporter = hasValidGmailConfig
  ? nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 587,
      secure: false,
      requireTLS: true,
      auth: {
        user: gmailUser,
        pass: gmailAppPassword,
      },
    })
  : null;

/* ---------- The mail frame ----------
   netflix.com's sign-up mail is a plain WHITE page holding ONE 501px column
   (457px of content after the 26/22/40px padding). No grey band, no rule under
   the logo, no band above the footer — the only line in the whole mail is the
   black rule that opens the footer. Type scale: 32px/1.2 headline, 16px body,
   18px feature rows, 48px red pill button, 25px icons with a 19px gutter.
   These are the measurements the reference screenshots were matched against. */
const CLIENT_URL = (process.env.CLIENT_URL || 'http://localhost:5173').replace(/\/$/, '');
const FROM_NAME = process.env.EMAIL_FROM_NAME || 'Newflix';

const page = (slug) => `${CLIENT_URL}/p/${slug}`;

// The reference's footer "SRC" breadcrumb (same value the in-app mail view used).
const MAIL_SRC = '6B63EE39D_697E7E3S:usdc-4091-8719-0fbie-c8499bc_an_PK_EVO';

const MAIL_IMAGE = {
  logo: { file: 'Netflix.png' },          // 116×209 red "N"
  shield: { file: 'unnamed.png' },        // "No password needed"
  block: { file: 'unnamed (1).png' },     // "Cancel anytime"
  devices: { file: 'unnamed (2).png' },   // "Unlimited entertainment"
};

const mailImageUrl = (key) => `${CLIENT_URL}/${encodeURIComponent(MAIL_IMAGE[key].file)}`;

// Netflix's red "N", drawn `width` px wide (30px in the body, 24px in the footer).
const nLogo = (width) => {
  const height = Math.round((width * 209) / 116);
  return `<img src="${mailImageUrl('logo')}" width="${width}" height="${height}" alt="Netflix" style="display:block;width:${width}px;height:${height}px;border:0;outline:none;text-decoration:none;">`;
};

const featureIcon = (key) => `<img src="${mailImageUrl(key)}" width="25" height="25" alt="" style="display:block;width:25px;height:25px;margin:2px 0 0;border:0;outline:none;">`;

// One row of the 3-point list: 25px icon + 19px gutter = 44px first column.
const featureRow = (icon, title, copy, gapBottom) => `
            <tr>
              <td width="44" valign="top" style="width:44px;padding:0;vertical-align:top;">${featureIcon(icon)}</td>
              <td valign="top" style="padding:0 0 ${gapBottom}px;font-size:18px;line-height:1.5;vertical-align:top;">
                <span style="display:block;font-weight:700;">${title}</span>
                <span style="display:block;">${copy}</span>
              </td>
            </tr>`;

const emailShell = (content) => `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta name="color-scheme" content="light only">
    <meta name="supported-color-schemes" content="light only">
    <title>${FROM_NAME}</title>
  </head>
  <body style="margin:0;padding:0;background:#ffffff;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;background:#ffffff;">
      <tr>
        <td align="center" style="padding:0;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:501px;margin:0 auto;background:#ffffff;">
            <tr>
              <td style="padding:26px 22px 40px;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:16px;line-height:1.5;color:#000000;">${content}</td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

const {
  renderSignupMailHtml: renderSignupTemplate,
  renderFinishSignupMailHtml: renderFinishTemplate,
  renderOtpMailHtml: renderOtpTemplate,
  renderResetPasswordMailHtml: renderResetTemplate,
  renderPasswordUpdatedMailHtml: renderPasswordUpdatedTemplate,
} = buildMailTemplates({
  emailShell,
  escapeHtml,
  page,
  mailSrc: MAIL_SRC,
  nLogo,
  featureRow,
});

// Renderers are kept exported so previews and tests can inspect the exact Gmail HTML.
export const renderSignupMailHtml = (linkUrl, recipient, variant = 'create') =>
  renderSignupTemplate({ variant, linkUrl, recipient });
export const renderFinishSignupMailHtml = (linkUrl, recipient) =>
  renderFinishTemplate({ linkUrl, recipient });
export const renderOtpMailHtml = (otp, subject, recipient = 'usercomputer3266@gmail.com') =>
  renderOtpTemplate({ otp, subject, recipient });
export const renderResetPasswordMailHtml = (linkUrl, recipient, name = '') =>
  renderResetTemplate({ linkUrl, recipient, name });
export const renderPasswordUpdatedMailHtml = (recipient, name = '') =>
  renderPasswordUpdatedTemplate({ recipient, name });

const ensureTransport = async () => {
  if (!transporter) {
    throw new Error(
      'Gmail SMTP is not configured. Set GMAIL_USER and GMAIL_APP_PASSWORD in backend/.env using a real Google App Password (2FA required). Remove any spaces from the app password.'
    );
  }
  try {
    await transporter.verify();
  } catch (verifyErr) {
    throw new Error(`Gmail SMTP verification failed: ${verifyErr.message}`);
  }
};

const sendMail = async ({ to, subject, html, text }) => {
  await ensureTransport();
  return transporter.sendMail({
    from: `"${FROM_NAME}" <${gmailUser}>`,
    replyTo: gmailUser,
    to,
    subject,
    html,
    text,
    headers: {
      'X-Auto-Response-Suppress': 'All',
      'X-Priority': '3',
      Importance: 'normal',
    },
  });
};

const accountText = ({ variant, linkUrl }) => `${variant === 'finish' ? 'Finish signing up to start watching' : "Let's create your account"}\n\nHey there,\n\nWe're excited to have you! Tap the link below to continue signing up and start watching today's hottest shows and movies. Plans start at PKR250/month.\n\n${linkUrl}\n\nThis link will expire in 15 minutes.`;

export const sendVerificationCodeEmail = async (to, otp, subject = `Confirm your account change with this code: ${otp}`) =>
  sendMail({
    to,
    subject,
    html: renderOtpTemplate({ otp, subject, recipient: to }),
    text: `${subject}\n\nYour verification code is ${otp}.\n\nThis code expires in 10 minutes.`,
  });

export const sendSignupLinkEmail = async (to, linkUrl, variant = 'create') =>
  sendMail({
    to,
    subject: variant === 'finish' ? 'Finish signing up to start watching' : "Let's create your account",
    html: renderSignupTemplate({ variant, linkUrl, recipient: to }),
    text: `${accountText({ variant, linkUrl })}\n\nThis message was mailed to ${to} by Newflix.\nSRC: ${MAIL_SRC}`,
  });

export const sendFinishSignupEmail = async (to, linkUrl) => sendSignupLinkEmail(to, linkUrl, 'finish');

export const sendPasswordResetEmail = async (to, linkUrl, name = '') =>
  sendMail({
    to,
    subject: 'Reset your password',
    html: renderResetTemplate({ linkUrl, recipient: to, name }),
    text: `Reset your password\n\nHi ${name || to},\n\nUse this secure link to reset your password:\n${linkUrl}\n\nThis link expires in 10 minutes.`,
  });

export const sendPasswordUpdatedEmail = async (to, name = '') =>
  sendMail({
    to,
    subject: 'Password updated!',
    html: renderPasswordUpdatedTemplate({ recipient: to, name }),
    text: `Password updated!\n\nYour password has been changed. If you did not make this change, contact us immediately.`,
  });

// Backwards-compatible entry point used by older auth callers.
export const sendOTPEmail = async (to, otp, subject = `Confirm your account change with this code: ${otp}`, linkUrl = null) => {
  if (linkUrl && /reset/i.test(subject)) return sendPasswordResetEmail(to, linkUrl);
  if (linkUrl) return sendSignupLinkEmail(to, linkUrl, 'create');
  return sendVerificationCodeEmail(to, otp, subject);
};

// ---------- Branded transactional email (shared shell) ----------
const brandShell = (title, accentText, innerHtml) => emailShell(`
  <h1 style="margin:0 0 20px;font-size:28px;line-height:1.2;color:#111;">${title}</h1>
  <p style="color:#555;font-size:14px;line-height:1.6;">${accentText}</p>
  ${innerHtml}`);

const detailRow = (label, value) => `
  <tr>
    <td style="padding:9px 0;color:#B3B3B3;font-size:13px;border-bottom:1px solid #2a2a2a;">${label}</td>
    <td style="padding:9px 0;color:#fff;font-size:13px;font-weight:bold;text-align:right;border-bottom:1px solid #2a2a2a;">${value}</td>
  </tr>`;

const recordBox = (recordId) => `
  <div style="margin:22px 0;text-align:center;">
    <div style="display:inline-block;background:#000;border:1px solid #333;border-radius:6px;padding:12px 26px;">
      <span style="color:#B3B3B3;font-size:11px;letter-spacing:1px;">PAYMENT RECORD ID</span><br/>
      <span style="color:#fff;font-size:22px;font-weight:900;letter-spacing:3px;">${recordId}</span>
    </div>
  </div>`;

const sendBrandedEmail = async (to, subject, innerHtml) => {
  if (!transporter) {
    throw new Error('Gmail SMTP is not configured. Set GMAIL_USER and GMAIL_APP_PASSWORD in backend/.env.');
  }
  return transporter.sendMail({
    from: `"${FROM_NAME}" <${gmailUser}>`,
    to,
    subject,
    html: brandShell(subject.split('|')[0].trim(), '', innerHtml),
  });
};

// "Payment successful — your membership has started"
export const sendPaymentSuccessEmail = async (to, payment) => {
  const money = `${Number(payment.amount).toLocaleString()} ${payment.currency}`;
  const inner = `
    ${recordBox(payment.recordId)}
    <table style="width:100%;border-collapse:collapse;margin-top:6px;">
      ${detailRow('Plan', `${payment.plan}${payment.planQuality ? ` (${payment.planQuality})` : ''}`)}
      ${detailRow('Amount', `${money} / month`)}
      ${payment.cardLast4 ? detailRow('Payment method', `${payment.cardBrand} •••• ${payment.cardLast4}`) : ''}
      ${detailRow('Date', new Date(payment.createdAt || Date.now()).toLocaleString())}
      ${detailRow('Status', '<span style="color:#4ade80;">PAID</span>')}
    </table>
    <div style="margin:26px 0;text-align:center;">
      <a href="${(process.env.CLIENT_URL || 'http://localhost:5173').replace(/\/$/, '')}/profiles"
         style="display:inline-block;background:#E50914;color:#fff;text-decoration:none;font-weight:bold;padding:14px 28px;border-radius:6px;">Start Watching</a>
    </div>
    <p style="color:#777;font-size:12px;line-height:1.6;">
      This is a demo environment — no real charge was made. Keep this email for your records; you'll need the Record ID for any support requests.
    </p>`;
  return sendBrandedEmail(to, 'Payment successful — your Newflix membership has started', inner);
};

// "Your refund has been processed"
export const sendRefundEmail = async (to, payment) => {
  const money = `${Number(payment.amount).toLocaleString()} ${payment.currency}`;
  const inner = `
    ${recordBox(payment.recordId)}
    <table style="width:100%;border-collapse:collapse;margin-top:6px;">
      ${detailRow('Plan', payment.plan)}
      ${detailRow('Refund amount', money)}
      ${payment.cardLast4 ? detailRow('Refunded to', `${payment.cardBrand} •••• ${payment.cardLast4}`) : ''}
      ${detailRow('Date', new Date().toLocaleString())}
      ${detailRow('Status', '<span style="color:#94a3b8;">REFUNDED</span>')}
    </table>
    <p style="color:#B3B3B3;font-size:14px;line-height:1.6;margin-top:20px;">
      Your refund has been processed and should appear on your statement within <strong style="color:#fff;">3–5 business days</strong>, depending on your bank.
    </p>
    <p style="color:#777;font-size:12px;line-height:1.6;">
      This is a demo environment — no real money was charged or refunded. Questions? Contact us from the Help Center.
    </p>`;
  return sendBrandedEmail(to, 'Refund processed — your Newflix payment has been refunded', inner);
};

export default transporter;
