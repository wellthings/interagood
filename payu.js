// PayU payment gateway module (placeholder).
// Configure live keys in env vars: PAYU_KEY, PAYU_SALT, PAYU_MODE (test|live).
// With keys set this enables live processing; without them the endpoints return
// a 503 so callers know the gateway is not configured yet.

import crypto from 'node:crypto';

const PAYU_KEY = process.env.PAYU_KEY || '';
const PAYU_SALT = process.env.PAYU_SALT || '';
const PAYU_MODE = process.env.PAYU_MODE || 'test';
const PAYU_BASE = PAYU_MODE === 'live' ? 'https://secure.payu.in' : 'https://test.payu.in';

export const isPayuConfigured = () => Boolean(PAYU_KEY && PAYU_SALT);

const sha512 = (str) => crypto.createHash('sha512').update(str).digest('hex');

// PayU hash format for a normal transaction:
// sha512(key|txnid|amount|productinfo|firstname|email|udf1..udf5|salt)
export const makePayuHash = (params) =>
  sha512(
    [
      params.key || PAYU_KEY,
      params.txnid,
      params.amount,
      params.productinfo,
      params.firstname || '',
      params.email || '',
      params.udf1 || '',
      params.udf2 || '',
      params.udf3 || '',
      params.udf4 || '',
      params.udf5 || '',
      params.salt || PAYU_SALT,
    ].join('|'),
  );

// Verify the hash returned by PayU in the postback.
// PayU reverse hash: sha512(salt|status|||||udf1..udf5|||email|firstname|productinfo|amount|txnid|key)
export const verifyPayuHash = (postback, salt = PAYU_SALT) => {
  const {
    status = '', udf1 = '', udf2 = '', udf3 = '', udf4 = '', udf5 = '',
    email = '', firstname = '', productinfo = '', amount = '', txnid = '', key = PAYU_KEY,
  } = postback;
  const expected = sha512([salt, status, '', '', '', '', udf1, udf2, udf3, udf4, udf5, '', '', email, firstname, productinfo, amount, txnid, key].join('|'));
  return typeof postback.hash === 'string' && postback.hash.toLowerCase() === expected.toLowerCase();
};

// Build the form fields that must be POSTed to PayU's payment page.
export const buildPayuOrder = ({ txnid, amount, productinfo, firstname, email, phone, udf1, udf2, udf3, udf4, udf5, surl, furl }) => {
  const base = {
    key: PAYU_KEY,
    txnid: String(txnid),
    amount: String(amount),
    productinfo: String(productinfo),
    firstname: String(firstname || ''),
    email: String(email || ''),
    phone: String(phone || ''),
    surl: surl || `${PAYU_BASE}/postback/success`,
    furl: furl || `${PAYU_BASE}/postback/failure`,
    udf1: udf1 || '',
    udf2: udf2 || '',
    udf3: udf3 || '',
    udf4: udf4 || '',
    udf5: udf5 || '',
  };
  base.hash = makePayuHash(base);
  return { action: `${PAYU_BASE}/_payment`, method: 'POST', fields: base };
};

// Deep-link URL variant (used by mobile apps) - returns the redirect URL with hash.
export const buildPayuUrl = (params) => {
  const order = buildPayuOrder(params);
  const qs = new URLSearchParams(order.fields).toString();
  return `${order.action}?${qs}`;
};