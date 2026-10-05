import { parsePhoneNumberFromString } from 'libphonenumber-js';

const provider = (process.env.SMS_PROVIDER || 'beem').trim().toLowerCase();
const beemApiKey = (process.env.BEEM_API_KEY || '').trim();
const beemSecretKey = (process.env.BEEM_SECRET_KEY || '').trim();
const beemSenderId = (process.env.BEEM_SENDER_ID || '').trim();
const wasenderApiKey = (process.env.WASENDER_API_KEY || '').trim();
const wasenderApiUrl = (process.env.WASENDER_API_URL || 'https://www.wasenderapi.com/api/send-message').trim();
const vonageApiKey = (process.env.VONAGE_API_KEY || '').trim();
const vonageApiSecret = (process.env.VONAGE_API_SECRET || '').trim();
const vonageFrom = (process.env.VONAGE_FROM || 'Newflix').trim().slice(0, 11);

export const normalizePhone = (value) => {
  const raw = String(value || '').trim().replace(/[\s()-]/g, '');
  const parsed = parsePhoneNumberFromString(raw, 'PK');
  return parsed?.isValid() ? parsed.number : null;
};

export const isSmsConfigured = provider === 'beem'
  ? Boolean(beemApiKey && beemSecretKey && beemSenderId)
  : provider === 'wasender'
    ? Boolean(wasenderApiKey)
    : provider === 'vonage'
      ? Boolean(vonageApiKey && vonageApiSecret && vonageFrom)
      : false;

const sendBeemSms = async (to, text) => {
  const response = await fetch('https://apisms.beem.africa/v1/send', {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`${beemApiKey}:${beemSecretKey}`).toString('base64')}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      source_addr: beemSenderId,
      schedule_time: '',
      encoding: 0,
      message: text,
      recipients: [{ recipient_id: 1, dest_addr: to.replace(/^\+/, '') }],
    }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || Number(result?.code) !== 100) {
    throw new Error(result?.message || `Beem Africa SMS delivery failed (${response.status}).`);
  }
  return result;
};

const sendWasenderMessage = async (to, text) => {
  const response = await fetch(wasenderApiUrl, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${wasenderApiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ to, text }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result?.success !== true) {
    throw new Error(result?.message || result?.error || `WasenderAPI delivery failed (${response.status}).`);
  }
  return result;
};

const sendVonageSms = async (to, text) => {
  const body = new URLSearchParams({
    api_key: vonageApiKey,
    api_secret: vonageApiSecret,
    from: vonageFrom,
    to,
    text,
  });
  const response = await fetch('https://rest.nexmo.com/sms/json', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const result = await response.json();
  const message = result?.messages?.[0];
  if (!response.ok || !message || message.status !== '0') {
    throw new Error(message?.['error-text'] || 'Vonage SMS delivery failed.');
  }
  return result;
};

export const sendOTPSMS = async (to, otp) => {
  if (!isSmsConfigured) {
    const required = provider === 'beem'
      ? 'BEEM_API_KEY, BEEM_SECRET_KEY and BEEM_SENDER_ID'
      : provider === 'wasender'
        ? 'WASENDER_API_KEY'
        : provider === 'vonage'
          ? 'VONAGE_API_KEY and VONAGE_API_SECRET'
          : 'a supported SMS_PROVIDER (beem, wasender or vonage)';
    throw new Error(`SMS OTP is not configured. Set ${required} in backend/.env.`);
  }

  const text = `Your Newflix verification code is ${otp}. It expires in 10 minutes. Never share this code.`;
  if (provider === 'beem') return sendBeemSms(to, text);
  if (provider === 'wasender') return sendWasenderMessage(to, text);
  if (provider === 'vonage') return sendVonageSms(to, text);
  throw new Error(`Unsupported SMS_PROVIDER: ${provider}`);
};
