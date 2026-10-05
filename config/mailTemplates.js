const displayName = (email) => {
  const value = String(email || '').split('@')[0].replace(/[._-]+/g, ' ').trim();
  return value ? value.replace(/\b\w/g, (letter) => letter.toUpperCase()) : 'there';
};

const defaultVerificationTime = () => new Intl.DateTimeFormat('en-US', {
  month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short', timeZone: 'Asia/Karachi',
}).format(new Date());

export const buildMailTemplates = ({ emailShell, escapeHtml, page, mailSrc, nLogo, featureRow }) => {
  const link = (href, text, color = '#4c6a8a') =>
    `<a href="${escapeHtml(href)}" style="color:${color};text-decoration:underline;">${text}</a>`;

  const footer = (recipient, mode = 'standard') => {
    const updated = mode === 'updated';
    const reset = mode === 'reset';
    const question = updated
      ? 'Questions? Call 1-844-505-2993'
      : 'Questions? Visit the ' + link(page('help-center'), 'Help Center');
    const company = updated
      ? '121 Arborlight Way, Los Gatos, CA 95032, U.S.A.'
      : reset
        ? 'Netflix International B.V., P.O. Box 1211, 1011 AA Amsterdam, Netherlands'
        : 'Netflix Pte. Ltd.';
    const communication = updated
      ? `<p style="margin:0 0 7px;">${link(page('account'), 'Communication Settings')}</p>`
      : '';
    const mailed = updated
      ? `This message was mailed to <strong>${escapeHtml(recipient)}</strong> by Newflix as part of your Newflix membership.`
      : `This message was mailed to <strong>${escapeHtml(recipient)}</strong> by Newflix.`;
    return `
      <div style="height:1px;line-height:1px;font-size:1px;border-top:1px solid #000000;margin:22px 0 18px;">&nbsp;</div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;">
        <tr>
          <td width="38" valign="top" style="width:38px;padding:0;vertical-align:top;">${nLogo(24)}</td>
          <td valign="top" style="padding:0;vertical-align:top;font-size:16px;line-height:1.45;">
            <p style="margin:0 0 4px;">${question}</p>
            <p style="margin:0;color:#5f6368;font-size:14px;">${company}</p>
          </td>
        </tr>
      </table>
      <div style="margin:16px 0 18px;font-size:14px;line-height:1.45;">
        ${communication}
        <p style="margin:0 0 7px;">${link(page('terms'), 'Terms of Use')}</p>
        <p style="margin:0 0 7px;">${link(page('privacy'), 'Privacy')}</p>
        <p style="margin:0;">${link(page('help-center'), 'Help Center')}</p>
      </div>
      <p style="margin:0;font-size:13px;line-height:1.55;color:#5f6368;">
        ${mailed}<br>
        SRC: ${escapeHtml(mailSrc)}
      </p>`;
  };

  const featureTable = () => `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;margin:20px 0 16px;border-collapse:collapse;">
      ${featureRow('shield', 'No password needed', 'Use this email address to securely sign in anywhere.', 16)}
      ${featureRow('block', 'Cancel anytime', 'Change or cancel your plan at any time.', 16)}
      ${featureRow('devices', 'Unlimited entertainment', 'Watch all you want, on all your devices, for one low price.', 0)}
    </table>`;

  const cta = (href, label, pill = false) => `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;margin:18px 0 0;border-collapse:collapse;">
      <tr>
        <td align="center" bgcolor="#e50914" style="width:100%;background:#e50914;border-radius:${pill ? '999px' : '4px'};">
          <a href="${escapeHtml(href)}" style="display:block;height:48px;line-height:48px;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:16px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:${pill ? '999px' : '4px'};">${label}</a>
        </td>
      </tr>
    </table>`;

  const accountMail = ({ variant = 'create', linkUrl, recipient }) => {
    const finish = variant === 'finish';
    const lead = finish
      ? "We're excited to have you! Tap the link below to finish signing up<br>and start watching today's hottest shows and movies. <strong>Plans<br>start at PKR250/month.</strong>"
      : "We're excited to have you! Tap the link below to create your<br>account and start watching today's hottest shows and<br>movies. <strong>Plans start at PKR250/month.</strong>";
    return emailShell(`
      <div style="margin:0 0 20px;">${nLogo(30)}</div>
      <h1 style="margin:0 0 20px;font-family:inherit;font-size:32px;line-height:1.2;font-weight:700;color:#000000;">${finish ? 'Finish signing up to start watching' : "Let's create your account"}</h1>
      <p style="margin:0 0 14px;font-size:16px;line-height:1.5;">Hey there,</p>
      <p style="margin:0 0 0;font-size:16px;line-height:1.5;">${lead}</p>
      ${cta(linkUrl, finish ? 'Finish Signing Up' : 'Create Your Account', !finish)}
      <p style="margin:14px 0 0;font-size:16px;line-height:1.5;">This link will expire in 15 minutes.</p>
      ${featureTable()}
      <p style="margin:0 0 14px;font-size:16px;line-height:1.5;">Didn't ask to create a Newflix account? ${link(page('contact'), 'Let us know', '#2436d8')}.</p>
      <p style="margin:0 0 0;font-size:16px;line-height:1.5;">The Newflix team</p>
      ${footer(recipient)}`);
  };

  const codeMail = ({ otp, subject, recipient, device = 'Web Browser', location = 'Sindh, Pakistan', time = defaultVerificationTime() }) => {
    const spacedCode = String(otp || '').split('').join(' ');
    const heading = String(subject || `Confirm your account change with this code: ${otp}`).replace(/\s*:\s*\d{6}\s*$/, ':');
    const infoRow = (label, value) => `<tr>
      <td style="padding:8px 0;color:#000000;font-size:14px;line-height:1.4;font-weight:700;vertical-align:top;">${label}</td>
      <td style="padding:8px 0;color:#000000;font-size:14px;line-height:1.4;vertical-align:top;">${escapeHtml(value)}</td>
    </tr>`;
    return emailShell(`
      <div style="margin:0 0 20px;">${nLogo(30)}</div>
      <h1 style="margin:0 0 20px;font-family:inherit;font-size:32px;line-height:1.2;font-weight:700;color:#000000;">${escapeHtml(heading)}</h1>
      <p style="margin:0 0 14px;font-size:16px;line-height:1.5;">Hi ${escapeHtml(displayName(recipient))},</p>
      <p style="margin:0 0 20px;font-size:16px;line-height:1.5;">We got a request to make a change to your account info. If this was you, enter this code to confirm. You'll have 10 minutes before this code expires.</p>
      <div style="margin:0 0 22px;font-size:24px;line-height:1.2;letter-spacing:6px;color:#000000;">${escapeHtml(spacedCode)}</div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;margin:0 0 18px;border:1px solid #d9d9d9;border-collapse:collapse;">
        ${infoRow('Device', device)}
        ${infoRow('Location', `${location} (This location may not be exact.)`)}
        ${infoRow('Time', time)}
      </table>
      <p style="margin:0 0 14px;font-size:16px;line-height:1.5;">If you didn't request this verification code, take a moment to ${link(page('contact'), 'secure your account now', '#2436d8')}.</p>
      <p style="margin:0 0 14px;font-size:16px;line-height:1.5;">Visit the ${link(page('help-center'), 'Help Center', '#2436d8')} for more info or ${link(page('contact'), 'contact us', '#2436d8')}.</p>
      <p style="margin:0 0 0;font-size:16px;line-height:1.5;">The Newflix team</p>
      ${footer(recipient)}`);
  };

  const resetMail = ({ linkUrl, recipient, name }) => emailShell(`
    <div style="margin:0 0 20px;">${nLogo(30)}</div>
    <h1 style="margin:0 0 20px;font-family:inherit;font-size:32px;line-height:1.2;font-weight:700;color:#000000;">Reset your password</h1>
    <p style="margin:0 0 14px;font-size:16px;line-height:1.5;">Hi ${escapeHtml(name || displayName(recipient))},</p>
    <p style="margin:0 0 0;font-size:16px;line-height:1.5;">Let's reset your password so you can get back to watching.</p>
    ${cta(linkUrl, 'Reset Password')}
    <p style="margin:18px 0 14px;font-size:16px;line-height:1.5;">If you did not ask to reset your password, you may wish to review your <u>account details</u> for any unusual activity.</p>
    <p style="margin:0 0 14px;font-size:16px;line-height:1.5;">We're here to help if you need it. Visit the ${link(page('help-center'), 'Help Center', '#2436d8')} for more info or ${link(page('contact'), 'contact us', '#2436d8')}.</p>
    <p style="margin:0 0 0;font-size:16px;line-height:1.5;">The Newflix team.</p>
    ${footer(recipient, 'reset')}`);

  const updatedMail = ({ recipient, name }) => emailShell(`
    <div style="margin:0 0 20px;">${nLogo(30)}</div>
    <h1 style="margin:0 0 20px;font-family:inherit;font-size:32px;line-height:1.2;font-weight:700;color:#000000;">Password updated!</h1>
    <p style="margin:0 0 14px;font-size:16px;line-height:1.5;">Hi ${escapeHtml(name || displayName(recipient))},</p>
    <p style="margin:0 0 18px;font-size:16px;line-height:1.5;">We've changed your password, as you asked. To view or change your account information, ${link(page('account'), 'visit your Account', '#2436d8')}.</p>
    <p style="margin:0 0 18px;font-size:16px;line-height:1.5;">If you did not ask to change your password we are here to help secure your account, just ${link(page('contact'), 'contact us', '#2436d8')}.</p>
    <p style="margin:0 0 0;font-size:16px;line-height:1.5;">The Newflix team</p>
    ${footer(recipient, 'updated')}`);

  return {
    renderSignupMailHtml: (args) => accountMail({ ...args, variant: args.variant || 'create' }),
    renderFinishSignupMailHtml: (args) => accountMail({ ...args, variant: 'finish' }),
    renderOtpMailHtml: codeMail,
    renderResetPasswordMailHtml: resetMail,
    renderPasswordUpdatedMailHtml: updatedMail,
  };
};

