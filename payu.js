// PayU payment gateway (India Hosted Checkout + Reverse Hash + verify_payment S2S).
import crypto from 'node:crypto';

const PAYU_KEY = (process.env.PAYU_MERCHANT_KEY || process.env.PAYU_KEY || '').trim();
const PAYU_SALT = (process.env.PAYU_MERCHANT_SALT || process.env.PAYU_SALT || '').trim();
const PAYU_MODE = (process.env.PAYU_MODE || 'test').trim().toLowerCase();
const PAYU_BASE = PAYU_MODE === 'live' ? 'https://secure.payu.in' : 'https://test.payu.in';
const PAYU_ENDPOINT = (process.env.PAYU_BASE_URL || `${PAYU_BASE}/_payment`).trim();
const PAYU_VERIFY_ENDPOINT =
  (process.env.PAYU_VERIFY_URL || '').trim() ||
  (PAYU_MODE === 'live'
    ? 'https://info.payu.in/merchant/postservice.php?form=2'
    : 'https://test.payu.in/merchant/postservice.php?form=2');

export const isPayuConfigured = () => Boolean(PAYU_KEY && PAYU_SALT);
export const getPayuConfigSummary = () => ({ configured: isPayuConfigured(), mode: PAYU_MODE });

const sha512 = (str) => crypto.createHash('sha512').update(str).digest('hex');

const safeEqualHex = (a, b) => {
  const x = Buffer.from(String(a || '').toLowerCase(), 'utf8');
  const y = Buffer.from(String(b || '').toLowerCase(), 'utf8');
  return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
};

// PayU Forward Hash:
// sha512(key|txnid|amount|productinfo|firstname|email|udf1|udf2|udf3|udf4|udf5||||||salt)
export const makePayuHash = (params) =>
  sha512(
    [
      params.key || PAYU_KEY,
      params.txnid || '',
      params.amount || '',
      params.productinfo || '',
      params.firstname || '',
      params.email || '',
      params.udf1 || '',
      params.udf2 || '',
      params.udf3 || '',
      params.udf4 || '',
      params.udf5 || '',
      '',
      '',
      '',
      '',
      '',
      params.salt || PAYU_SALT,
    ].join('|'),
  );

// PayU Reverse Hash (supports optional additionalCharges prefix):
// sha512([additionalCharges|]SALT|status||||||udf5|udf4|udf3|udf2|udf1|email|firstname|productinfo|amount|txnid|key)
export const verifyPayuHash = (postback, salt = PAYU_SALT) => {
  if (!postback || typeof postback.hash !== 'string' || !salt) return false;
  if (postback.key && String(postback.key).trim() !== PAYU_KEY) return false;
  const {
    status = '',
    udf1 = '',
    udf2 = '',
    udf3 = '',
    udf4 = '',
    udf5 = '',
    email = '',
    firstname = '',
    productinfo = '',
    amount = '',
    txnid = '',
    key = PAYU_KEY,
  } = postback;
  const addCharges = String(postback.additionalCharges ?? postback.additional_charges ?? '').trim();
  const baseParts = [
    salt,
    status,
    '',
    '',
    '',
    '',
    '',
    udf5,
    udf4,
    udf3,
    udf2,
    udf1,
    email,
    firstname,
    productinfo,
    amount,
    txnid,
    key,
  ];
  const parts = addCharges ? [addCharges, ...baseParts] : baseParts;
  const expected = sha512(parts.join('|'));
  return safeEqualHex(postback.hash, expected);
};

export const buildPayuOrder = ({
  txnid,
  amount,
  productinfo,
  firstname,
  email,
  phone,
  udf1,
  udf2,
  udf3,
  udf4,
  udf5,
  surl,
  furl,
}) => {
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
  return { action: PAYU_ENDPOINT, method: 'POST', fields: base };
};

export const buildPayuUrl = (params) => {
  const order = buildPayuOrder(params);
  const qs = new URLSearchParams(order.fields).toString();
  return `${order.action}?${qs}`;
};

// Server-to-Server transaction verification via PayU verify_payment API
// Hash: sha512(key|verify_payment|txnid|salt)
export const verifyPayuTransaction = async (txnid) => {
  if (!isPayuConfigured() || !txnid) return { conclusive: false, verified: false };
  const command = 'verify_payment';
  const var1 = String(txnid);
  const hash = sha512(`${PAYU_KEY}|${command}|${var1}|${PAYU_SALT}`);
  const body = new URLSearchParams({ key: PAYU_KEY, command, var1, hash });
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(PAYU_VERIFY_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return { conclusive: false, verified: false };
    const data = await res.json().catch(() => null);
    const details = data?.transaction_details?.[var1];
    if (!details || typeof details !== 'object') {
      return { conclusive: false, verified: false, raw: data };
    }
    const txStatus = String(details.status || '').toLowerCase();
    return {
      conclusive: true,
      verified: txStatus === 'success',
      status: txStatus,
      amount: details.amt ?? details.transaction_amount ?? null,
      mihpayid: details.mihpayid ? String(details.mihpayid) : null,
      mode: details.mode ? String(details.mode) : null,
      raw: details,
    };
  } catch (err) {
    console.warn('[payu verify_payment]', err?.message || err);
    return { conclusive: false, verified: false };
  }
};
