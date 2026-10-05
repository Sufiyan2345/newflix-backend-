import assert from 'node:assert/strict';
import { buildSignupLinkUrl } from './controllers/authController.js';

const url = buildSignupLinkUrl('user@example.com', '123456');
assert.ok(url.includes('/finish-signup?variant=create&email=user%40example.com&otp=123456'));
console.log('signup link url ok');
