// Firebase Authentication — SMS OTP support.
// The frontend sends the phone-auth SMS itself via the Firebase Web SDK
// (works for every country in Firebase's SMS coverage) and posts the
// resulting ID token here. We validate that token server-side with the
// Identity Toolkit REST API (accounts:lookup) using the project's Web API
// key — no service-account file required.
import { parsePhoneNumberFromString } from 'libphonenumber-js';

const apiKey = (process.env.FIREBASE_API_KEY || '').trim();

export const isFirebaseSmsConfigured = Boolean(apiKey);

// Compare two phone numbers as E.164 (e.g. +923001234567 === +92 300 1234567)
export const sameE164 = (a, b) => {
  const pa = parsePhoneNumberFromString(String(a || '').trim());
  const pb = parsePhoneNumberFromString(String(b || '').trim());
  return Boolean(pa && pb && pa.number === pb.number);
};

// @param {string} idToken — Firebase ID token from the confirmed SMS code
// @returns {{ uid: string, phone: string }}
// @throws Error with a stable message consumed by firebaseSmsError()
export const verifyFirebaseIdToken = async (idToken) => {
  if (!isFirebaseSmsConfigured) throw new Error('FIREBASE_SMS_NOT_CONFIGURED');
  if (!idToken || typeof idToken !== 'string') throw new Error('MISSING_ID_TOKEN');

  const response = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idToken }),
    },
  );
  const result = await response.json().catch(() => ({}));
  const message = String(result?.error?.message || '');

  if (!response.ok || !Array.isArray(result?.users) || !result.users.length) {
    // INVALID_ID_TOKEN / TIMESENSITIVE / EXPIRED variants all mean the token can't be trusted
    if (message.includes('ID_TOKEN') || message.includes('TIMESENSITIVE')) throw new Error('INVALID_ID_TOKEN');
    if (message.includes('API_KEY') || message.includes('PROJECT_NOT_FOUND')) throw new Error('FIREBASE_SMS_NOT_CONFIGURED');
    if (message.includes('USER_NOT_FOUND')) throw new Error('MISSING_ID_TOKEN');
    throw new Error(message || 'FIREBASE_TOKEN_LOOKUP_FAILED');
  }

  const account = result.users[0];
  const phone = account?.phoneNumber || '';
  if (!phone) throw new Error('MISSING_PHONE');
  return { uid: account.localId, phone };
};

// Map internal firebase config errors to safe, user-readable messages
export const firebaseSmsError = (err) => {
  switch (err?.message) {
    case 'FIREBASE_SMS_NOT_CONFIGURED': return 'Firebase SMS is not configured on the server. Set FIREBASE_API_KEY.';
    case 'INVALID_ID_TOKEN': return 'The verification session expired or was already used. Please request a new code.';
    case 'MISSING_ID_TOKEN': return 'Verification session not found. Please request a new code.';
    case 'MISSING_PHONE': return 'This verification has no mobile number attached. Please request a new code.';
    default: return 'Could not verify the SMS code. Please try again.';
  }
};
