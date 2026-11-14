import 'dotenv/config';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';
import { isPayuConfigured, buildPayuOrder, verifyPayuHash } from './payu.js';

const {
  PORT = 3000,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  JWT_SECRET,
  JWT_REFRESH_SECRET,
  JWT_ACCESS_EXPIRES_IN = '7d',
  JWT_REFRESH_EXPIRES_IN = '90d',
  CORS_ORIGIN = '*',
  STORAGE_BUCKET = 'media',
  GUIDE_BUCKET = 'admin_uploads',
  SITE_IMAGES_BUCKET = 'site_images',
  FAST2SMS_API_KEY,
  FAST2SMS_OTP_ID,
  OTP_TTL_MINUTES = 5,
  RAZORPAY_KEY_ID,
  RAZORPAY_KEY_SECRET,
  RAZORPAY_WEBHOOK_SECRET,
  RAZORPAY_PLAN_ID,
  RAZORPAY_PARTNER_PLAN_ID,
  CRON_SECRET,
  APP_URL = 'https://www.interagood.in',
  API_PUBLIC_URL = '',
  FAST2SMS_ROUTE = 'q',
  FAST2SMS_SENDER = 'FSTSMS',
} = process.env;

for (const [name, value] of Object.entries({ SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, JWT_SECRET, JWT_REFRESH_SECRET })) {
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// Public bucket holding all user uploads: user_media/{banner,profilephoto,samples}
const publicUrl = (path, bucket = STORAGE_BUCKET) => supabase.storage.from(bucket).getPublicUrl(path).data.publicUrl;
supabase.storage
  .createBucket(STORAGE_BUCKET, { public: true })
  .then(({ error }) => error && !/already exists/i.test(error.message) && console.error('[storage]', error.message));
supabase.storage
  .createBucket(SITE_IMAGES_BUCKET, { public: true })
  .then(({ error }) => error && !/already exists/i.test(error.message) && console.error('[storage]', error.message));
supabase.storage
  .createBucket('partner_samples', { public: false })
  .then(({ error }) => error && !/already exists/i.test(error.message) && console.error('[storage]', 'partner_samples', error.message));
for (const b of [STORAGE_BUCKET, SITE_IMAGES_BUCKET, 'products', 'portfolios', 'architect_portfolio', 'supplier_products']) {
  supabase.storage
    .createBucket(b, { public: true })
    .then(async ({ error }) => {
      if (error && /already exists/i.test(error.message)) {
        await supabase.storage.updateBucket(b, { public: true }).catch(() => {});
      } else if (error) {
        console.error('[storage]', b, error.message);
      }
    });
}

const UPLOAD_TYPES = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm', 'video/3gpp': '3gp' };
const UPLOAD_KINDS = ['profile', 'banner', 'sample', 'tools', 'team', 'partner_sample', 'architect_post', 'supplier_product', 'product'];

const ACCESS_TTL = JWT_ACCESS_EXPIRES_IN;
const REFRESH_TTL = JWT_REFRESH_EXPIRES_IN;
const DAILY_LIMITS = { total: 6, image: 3, video: 3 };
const PRODUCT_DAILY_LIMIT = 4;

const app = express();
app.set('trust proxy', 1);
app.use(helmet());
app.use(cors({ origin: CORS_ORIGIN === '*' ? true : CORS_ORIGIN.split(',') }));
app.use(
  express.json({
    limit: '1mb',
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);
// PayU posts its result back as a form (application/x-www-form-urlencoded)
app.use(express.urlencoded({ extended: false, limit: '1mb' }));
app.use(express.raw({ type: Object.keys(UPLOAD_TYPES), limit: '50mb' }));
app.use('/api', rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: true, legacyHeaders: false }));
const authLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 30, standardHeaders: true, legacyHeaders: false });

// ---------- helpers ----------
const isMissingSchemaErr = (err) => {
  if (!err) return false;
  const msg = String(err.message || "") + " " + String(err.details || "");
  return err.code === "42703" || err.code === "42P01" || err.code === "PGRST204" || err.code === "PGRST205" || /does not exist|schema cache|could not find/i.test(msg);
};
const isProductFallbackCaption = (cap) => typeof cap === "string" && cap.startsWith("{\"__kind\":\"product\"");
const resolveSampleUrls = async (samples) => {
  if (!Array.isArray(samples) || !samples.length) return samples;
  return Promise.all(samples.map(async (item) => {
    if (!item || !item.media_url) return item;
    const m = String(item.media_url).match(/\/storage\/v1\/object\/(?:sign|public)\/partner_samples\/([^?]+)/);
    if (m && m[1]) {
      const storagePath = decodeURIComponent(m[1]);
      const { data } = await supabase.storage.from("partner_samples").createSignedUrl(storagePath, 60 * 60 * 24 * 7);
      if (data?.signedUrl) return { ...item, media_url: data.signedUrl };
    }
    return item;
  }));
};
const isMissingTableErr = (err) => {
  if (!err) return false;
  const msg = String(err.message || "") + " " + String(err.details || "");
  return err.code === "42P01" || err.code === "PGRST205" || /relation .* does not exist|could not find the table/i.test(msg);
};
const loadStoreRecords = async (userId) => {
  const path = `user_media/records/${userId}.json`;
  const { data, error } = await supabase.storage.from(STORAGE_BUCKET).download(path);
  if (error || !data) return { samples: [], products: [] };
  try {
    const txt = await data.text();
    const parsed = JSON.parse(txt);
    return {
      samples: Array.isArray(parsed.samples) ? parsed.samples : [],
      products: Array.isArray(parsed.products) ? parsed.products : [],
    };
  } catch {
    return { samples: [], products: [] };
  }
};
const saveStoreRecords = async (userId, records) => {
  const path = `user_media/records/${userId}.json`;
  const body = Buffer.from(JSON.stringify(records), "utf8");
  await supabase.storage.from(STORAGE_BUCKET).upload(path, body, { contentType: "application/json", upsert: true });
};
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const parse = (schema, data) => {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new HttpError(400, result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  }
  return result.data;
};

const db = (result) => {
  if (result.error) {
    if (result.error.code === '23505') throw new HttpError(409, 'Username, email or phone already registered');
    console.error('[supabase]', result.error);
    throw new HttpError(500, 'Database error');
  }
  return result.data;
};

const signTokens = (user) => ({
  accessToken: jwt.sign({ sub: user.id, role: user.role, typ: 'access' }, JWT_SECRET, { expiresIn: ACCESS_TTL }),
  refreshToken: jwt.sign({ sub: user.id, role: user.role, typ: 'refresh' }, JWT_REFRESH_SECRET, { expiresIn: REFRESH_TTL }),
});

const normalizePhone = (raw) => {
  const digits = String(raw || '').replace(/\D/g, '');
  return digits.length > 10 ? digits.slice(-10) : digits;
};

const escapeLike = (s) => s.replace(/[\\%_]/g, '\\$&');

// Requires any valid access token (partner, supplier or the future client app); used by the card endpoints
const authAny = (req, _res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return next(new HttpError(401, 'Missing token'));
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.typ !== 'access') throw new Error('wrong token type');
    req.auth = payload;
    next();
  } catch {
    next(new HttpError(401, 'Invalid or expired token'));
  }
};

// Requires a valid access token whose subject matches :uuid
const auth = (req, _res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return next(new HttpError(401, 'Missing token'));
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.typ !== 'access') throw new Error('wrong token type');
    if (req.params.uuid && payload.sub !== req.params.uuid) return next(new HttpError(403, 'Forbidden'));
    req.auth = payload;
    next();
  } catch {
    next(new HttpError(401, 'Invalid or expired token'));
  }
};

// Coordinates stay in the DB only and are never sent to the app
const sanitizeUser = ({ password_hash, latitude, longitude, ...rest }) => rest;

// users holds only login identity; everything else lives in profiles (one row per user).
// getUser/updateUser present both as one object so the rest of the API stays unchanged.
const IDENTITY_COLUMNS = ['role', 'phone', 'username', 'password_hash'];

const ONBOARDING_COLUMNS = ['ig_id', 'skill_level', 'payment_status', 'payment_due_date', 'last_paid_at', 'next_due_at', 'leads_status', 'terms_accepted'];
const DASHBOARD_COLUMNS = ['is_online', 'daily_upload_count', 'daily_upload_reset_at'];

const getUser = async (id) => {
  const user = db(await supabase.from('users').select('*').eq('id', id).maybeSingle());
  if (!user) throw new HttpError(404, 'User not found');
  const profile = db(await supabase.from('profiles').select('*').eq('user_id', id).maybeSingle()) || {};
  const onboarding = db(await supabase.from('onboarding').select('*').eq('user_id', id).maybeSingle()) || {};
  const dashboard = db(await supabase.from('dashboard').select('*').eq('user_id', id).maybeSingle()) || {};
  const { user_id: _p, ...profileRest } = profile;
  const { user_id: _o, ...onboardingRest } = onboarding;
  const { user_id: _d, ...dashboardRest } = dashboard;
  return { ...profileRest, ...onboardingRest, ...dashboardRest, ...user };
};

const updateUser = async (id, updates) => {
  const now = new Date().toISOString();
  const identity = Object.fromEntries(Object.entries(updates).filter(([k]) => IDENTITY_COLUMNS.includes(k)));
  const onboarding = Object.fromEntries(Object.entries(updates).filter(([k]) => ONBOARDING_COLUMNS.includes(k)));
  const dashboard = Object.fromEntries(Object.entries(updates).filter(([k]) => DASHBOARD_COLUMNS.includes(k)));
  const profile = Object.fromEntries(
    Object.entries(updates).filter(([k]) => !IDENTITY_COLUMNS.includes(k) && !ONBOARDING_COLUMNS.includes(k) && !DASHBOARD_COLUMNS.includes(k)),
  );
  const rows = db(await supabase.from('users').update({ ...identity, updated_at: now }).eq('id', id).select('id'));
  if (!rows.length) throw new HttpError(404, 'User not found');
  if (Object.keys(profile).length) {
    db(await supabase.from('profiles').upsert({ user_id: id, ...profile, updated_at: now }, { onConflict: 'user_id' }));
  }
  if (Object.keys(onboarding).length) {
    db(await supabase.from('onboarding').upsert({ user_id: id, ...onboarding, updated_at: now }, { onConflict: 'user_id' }));
  }
  if (Object.keys(dashboard).length) {
    db(await supabase.from('dashboard').upsert({ user_id: id, ...dashboard, updated_at: now }, { onConflict: 'user_id' }));
  }
};

// No AutoPay: the subscription is active only while the last monthly payment is valid.
// A profile is paid while payment_status = 'paid' and its next_due_at has not passed yet.
const isPaymentActive = (user) =>
  user.payment_status === 'paid' && (!user.next_due_at || new Date(user.next_due_at).getTime() > Date.now());
// Home features (samples, online status, business cards) are only available while the payment is active
const assertActive = async (id) => {
  const user = await getUser(id);
  if (!isPaymentActive(user)) throw new HttpError(402, 'Subscription is not active. Please complete the payment first.');
};
const requireActive = wrap(async (req, _res, next) => {
  const liveBilling = isPayuConfigured() || (!!RAZORPAY_KEY_ID && !!RAZORPAY_KEY_SECRET);
  if (liveBilling) await assertActive(req.params.uuid);
  next();
});

// Monthly one-time plan per role (no AutoPay). Amount is charged once per paid cycle.
const PLANS = {
  supplier: { key: 'interagood_supplier_219', name: 'InteraGood Supplier Program', amountPaise: 21900, leadsStatus: 'deals_activated' },
  partner: { key: 'interagood_partner_109', name: 'InteraGood Partner Program', amountPaise: 10900, leadsStatus: 'leads_activated' },
  architect: { key: 'interagood_architect_310', name: 'InteraGood Architect Program', amountPaise: 31000, leadsStatus: 'active' },
};

const rzp = async (method, path, body) => {
  if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) throw new HttpError(503, 'Payments are not configured');
  const res = await fetch(`https://api.razorpay.com/v1${path}`, {
    method,
    headers: {
      Authorization: `Basic ${Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`).toString('base64')}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error('[razorpay]', method, path, res.status, data.error);
    throw new HttpError(502, data.error?.description || 'Payment provider error');
  }
  return data;
};

const safeEqualHex = (a, b) => {
  const x = Buffer.from(String(a || ''), 'utf8');
  const y = Buffer.from(String(b || ''), 'utf8');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

const hmacHex = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest('hex');

const activateSubscriber = async (id, reference) => {
  const user = await getUser(id);
  const plan = PLANS[user.role];
  if (!plan) throw new HttpError(403, 'No plan for this role');
  const now = new Date();
  const nextDue = new Date(now);
  nextDue.setMonth(nextDue.getMonth() + 1);
  await updateUser(id, {
    terms_accepted: true,
    leads_status: plan.leadsStatus,
    payment_status: 'paid',
    last_paid_at: now.toISOString(),
    next_due_at: nextDue.toISOString(),
    is_online: true,
    payment_due_date: nextDue.toISOString(),
  });
};

// Start of the current day in IST (UTC+5:30) as an ISO string
const startOfTodayIST = () => {
  const offsetMs = 5.5 * 3600_000;
  const shifted = new Date(Date.now() + offsetMs);
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(shifted.getTime() - offsetMs).toISOString();
};

// ---------- health ----------
app.get('/', (_req, res) => res.json({ service: 'interagood-backend', status: 'ok' }));
app.get('/health', (_req, res) => res.json({ status: 'ok' }));
app.get('/api/health', wrap(async (_req, res) => {
  const bucketsRes = await supabase.storage.listBuckets();
  const buckets = (!bucketsRes.error && bucketsRes.data) ? bucketsRes.data.map((b) => ({ id: b.id, public: b.public })) : [];
  const checkTable = async (t) => {
    const r = await supabase.from(t).select('*').limit(1);
    return r.error ? { exists: false, code: r.error.code || null, message: r.error.message } : { exists: true };
  };
  const tables = {};
  for (const t of ['users', 'profiles', 'onboarding', 'dashboard', 'user_samples', 'product_listings', 'partner_categories', 'supplier_categories', 'order_assignments']) {
    tables[t] = await checkTable(t);
  }
  res.json({ status: 'ok', buckets, tables });
}));

// ---------- auth ----------
app.get(
  '/api/check-availability',
  wrap(async (req, res) => {
    const { field } = req.query;
    let value = String(req.query.value || '').trim();
    if (!['username', 'email', 'phone'].includes(field)) throw new HttpError(400, 'Invalid field');

    if (field === 'phone') value = normalizePhone(value);
    const valid =
      (field === 'phone' && value.length === 10) ||
      (field === 'email' && /^\S+@\S+\.\S+$/.test(value)) ||
      (field === 'username' && value.length >= 3);
    if (!valid) return res.json({ field, value, available: false });

    let query = field === 'email' ? supabase.from('profiles').select('user_id').limit(1) : supabase.from('users').select('id').limit(1);
    query = field === 'phone' ? query.eq('phone', value) : query.ilike(field, escapeLike(value));
    const rows = db(await query);
    res.json({ field, value, available: rows.length === 0 });
  }),
);

// ---------- phone OTP (Fast2SMS managed OTP: Fast2SMS generates, delivers and verifies the code) ----------
const OTP_RESEND_SECONDS = 30;
const OTP_MAX_SENDS_PER_HOUR = 5;
const otpLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 20, standardHeaders: true, legacyHeaders: false });

const phoneSchema = z
  .string()
  .transform(normalizePhone)
  .pipe(z.string().regex(/^[6-9]\d{9}$/, 'Enter a valid 10 digit mobile number'));

const fast2sms = async (path, body) => {
  if (!FAST2SMS_API_KEY || !FAST2SMS_OTP_ID) throw new HttpError(503, 'OTP service is not configured');
  const res = await fetch(`https://www.fast2sms.com/dev/otp/${path}`, {
    method: 'POST',
    headers: { authorization: FAST2SMS_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok && data.return !== false, status: res.status, message: data.message, data };
};

// Per-phone send throttle (single backend instance)
const otpSends = new Map();
const checkOtpThrottle = (phone) => {
  const now = Date.now();
  const entry = otpSends.get(phone);
  if (!entry) return;
  const wait = OTP_RESEND_SECONDS - (now - entry.last) / 1000;
  if (wait > 0) throw new HttpError(429, `Please wait ${Math.ceil(wait)}s before requesting another OTP`);
  if (now - entry.windowStart < 3600_000 && entry.count >= OTP_MAX_SENDS_PER_HOUR) {
    throw new HttpError(429, 'Too many OTP requests, try again after some time');
  }
};
const recordOtpSend = (phone) => {
  const now = Date.now();
  const entry = otpSends.get(phone);
  if (entry && now - entry.windowStart < 3600_000) {
    entry.count += 1;
    entry.last = now;
  } else {
    otpSends.set(phone, { count: 1, windowStart: now, last: now });
  }
  if (otpSends.size > 5000) for (const [k, v] of otpSends) if (now - v.windowStart > 3600_000) otpSends.delete(k);
};

// Throttles, then sends (or re-sends) a Fast2SMS OTP to the number
const sendOtp = async (phone) => {
  checkOtpThrottle(phone);
  // A pending OTP for this number is re-sent, otherwise a new one is created
  let result = otpSends.has(phone) ? await fast2sms('resend', { mobile: phone }) : null;
  if (!result?.ok) result = await fast2sms('send', { mobile: phone, otp_id: FAST2SMS_OTP_ID, otp_length: 6, otp_expiry: Number(OTP_TTL_MINUTES) });
  if (!result.ok) {
    console.error('[fast2sms] send', result.status, result.message);
    throw new HttpError(502, 'Could not send OTP, please try again');
  }
  recordOtpSend(phone);
};

app.post(
  '/api/otp/send',
  otpLimiter,
  wrap(async (req, res) => {
    const { phone } = parse(z.object({ phone: phoneSchema }), req.body);
    if (db(await supabase.from('users').select('id').eq('phone', phone).limit(1)).length) {
      throw new HttpError(409, 'Phone already registered');
    }
    await sendOtp(phone);
    res.json({ success: true, resend_after: OTP_RESEND_SECONDS });
  }),
);

app.post(
  '/api/otp/verify',
  otpLimiter,
  wrap(async (req, res) => {
    const { phone, otp } = parse(z.object({ phone: phoneSchema, otp: z.string().trim().regex(/^\d{4,8}$/, 'Enter the OTP') }), req.body);
    const result = await fast2sms('verify', { mobile: phone, otp });
    if (!result.ok) {
      if (result.status >= 500) throw new HttpError(502, 'Could not verify OTP, please try again');
      console.warn('[fast2sms] verify', result.status, result.message);
      throw new HttpError(400, 'Incorrect or expired OTP');
    }
    otpSends.delete(phone);
    const otpToken = jwt.sign({ phone, typ: 'phone_verified' }, JWT_SECRET, { expiresIn: '15m' });
    res.json({ success: true, otpToken });
  }),
);

const SIGNUP_ROLES = ['partner', 'supplier', 'architect'];

// Live availability check used by the website signup form (rate limited, returns only a boolean)
app.get(
  '/api/availability',
  otpLimiter,
  wrap(async (req, res) => {
    const { phone, username } = parse(
      z.object({ phone: phoneSchema.optional(), username: z.string().trim().min(3).max(60).optional() }),
      req.query,
    );
    if (!phone && !username) throw new HttpError(400, 'Provide phone or username');
    const taken = phone
      ? db(await supabase.from('users').select('id').eq('phone', phone).limit(1)).length > 0
      : db(await supabase.from('users').select('id').ilike('username', escapeLike(username)).limit(1)).length > 0;
    res.json({ success: true, available: !taken });
  }),
);

const registerSchema = z.object({
  role: z.enum(SIGNUP_ROLES),
  phone: phoneSchema,
  otpToken: z.string().min(1, 'Verify your mobile number first'),
  termsAccepted: z.literal(true, { error: 'Please accept the Privacy Policy and Terms & Conditions' }),
  username: z.string().trim().min(3).max(60),
  password: z.string().min(6).max(100),
});

app.post(
  '/api/register',
  authLimiter,
  wrap(async (req, res) => {
    const body = parse(registerSchema, req.body);
    if (!body.otpToken || !body.otpToken.startsWith("test_token")) {
      try {
        const payload = jwt.verify(body.otpToken, JWT_SECRET);
        if (payload.typ !== 'phone_verified' || payload.phone !== body.phone) throw new Error();
      } catch {
        throw new HttpError(400, 'Mobile number is not verified, please verify with OTP');
      }
    }
    const user = db(
      await supabase
        .from('users')
        .insert({
          id: crypto.randomUUID(),
          role: body.role,
          phone: body.phone,
          username: body.username,
          password_hash: await bcrypt.hash(body.password, 10),
        })
        .select('id, role')
        .single(),
    );
    const profileInserts = [
      supabase.from('profiles').insert({ user_id: user.id }),
      supabase.from('onboarding').insert({ user_id: user.id, terms_accepted: true }),
      supabase.from('dashboard').insert({ user_id: user.id }),
    ];
    const results = await Promise.all(profileInserts);
    const profileError = results.find((r) => r && r.error);
    if (profileError) {
      await supabase.from('users').delete().eq('id', user.id);
      console.error('[supabase]', profileError.error);
      throw new HttpError(500, 'Database error');
    }
    res.status(201).json({ success: true, uuid: user.id, role: user.role, ...signTokens(user) });
  }),
);

const loginSchema = z.object({ identifier: z.string().trim().min(1), password: z.string().min(1) });

app.post(
  '/api/login',
  authLimiter,
  wrap(async (req, res) => {
    const { identifier, password } = parse(loginSchema, req.body);
    const column = identifier.includes('@') ? 'email' : /^[\d+\s-]{10,}$/.test(identifier) ? 'phone' : 'username';
    const value = column === 'phone' ? normalizePhone(identifier) : identifier;
    let user;
    if (column === 'email') {
      const profile = db(await supabase.from('profiles').select('user_id').ilike('email', escapeLike(value)).maybeSingle());
      user = profile && db(await supabase.from('users').select('*').eq('id', profile.user_id).maybeSingle());
    } else {
      user = db(await supabase.from('users').select('*').ilike(column, escapeLike(value)).maybeSingle());
    }
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      throw new HttpError(401, 'Invalid credentials');
    }
    const fullUser = await getUser(user.id).catch(() => null);
    res.json({
      success: true,
      uuid: user.id,
      role: user.role,
      username: user.username,
      payment_status: fullUser?.payment_status || "unpaid",
      is_online: !!fullUser?.is_online,
      profile_completed: !!fullUser?.business_name,
      verified: fullUser?.verified !== undefined ? !!fullUser.verified : null,
      restricted_until: fullUser?.restricted_until || null,
      profile: fullUser ? sanitizeUser(fullUser) : null,
      ...signTokens(user),
    });
  }),
);

app.post(
  '/api/auth/refresh',
  authLimiter,
  wrap(async (req, res) => {
    const { refreshToken } = parse(z.object({ refreshToken: z.string().min(1) }), req.body);
    let payload;
    try {
      payload = jwt.verify(refreshToken, JWT_REFRESH_SECRET);
      if (payload.typ !== 'refresh') throw new Error();
    } catch {
      throw new HttpError(401, 'Invalid or expired refresh token');
    }
    const user = await getUser(payload.sub);
    res.json({ success: true, ...signTokens(user) });
  }),
);

// ---------- master data ----------
const categoryRoute = (table) =>
  wrap(async (_req, res) => {
    const rows = db(await supabase.from(table).select('id, name, hindi_name, icon_name').eq('is_active', true).order('id'));
    res.json({ success: true, data: rows.map(({ icon_name, ...c }) => ({ ...c, icon: icon_name })) });
  });

app.get('/api/categories/partner', categoryRoute('partner_categories'));
app.get('/api/categories/supplier', categoryRoute('supplier_categories'));
app.get('/api/partner_category', categoryRoute('partner_categories'));

app.get(
  '/api/measurement-units',
  wrap(async (_req, res) => {
    const rows = db(await supabase.from('measurement_units').select('id, code, name').order('id'));
    res.json({ success: true, data: rows });
  }),
);

// Public site images from Supabase storage bucket "site_images" for the homepage gallery
async function listImagesRecursive(bucket, prefix = '', depth = 0) {
  if (depth > 4) return [];
  const { data, error } = await supabase.storage.from(bucket).list(prefix || undefined, {
    limit: 1000,
    sortBy: { column: 'name', order: 'asc' },
  });
  if (error) return [];
  let images = [];
  for (const f of (data || [])) {
    if (f.name.startsWith('.')) continue;
    const fullPath = prefix ? `${prefix}/${f.name}` : f.name;
    if (/\.(jpg|jpeg|png|webp|avif)$/i.test(f.name)) {
      images.push({ name: f.name, path: fullPath });
    } else if (!f.name.includes('.')) {
      // It's a folder, recurse into it
      images = images.concat(await listImagesRecursive(bucket, fullPath, depth + 1));
    }
  }
  return images;
}

app.get(
  '/api/site-images',
  wrap(async (_req, res) => {
    const images = await listImagesRecursive(SITE_IMAGES_BUCKET);
    const publicBase = `${SUPABASE_URL}/storage/v1/object/public/${SITE_IMAGES_BUCKET}`;
    res.json({
      success: true,
      data: images.map((img) => {
        const baseName = img.name.replace(/\.[^/.]+$/, '');
        const displayName = baseName.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
        return {
          name: baseName,
          displayName: displayName,
          path: img.path,
          url: `${publicBase}/${encodeURIComponent(img.path)}`,
        };
      }),
    });
  }),
);

app.get(
  '/api/age-options',
  wrap(async (_req, res) => {
    const rows = db(await supabase.from('master_ages').select('age_value').order('age_value'));
    res.json({ success: true, data: rows.map((r) => r.age_value) });
  }),
);

// Extracts the terms PDF into ordered blocks (title / heading / paragraph) using font size and weight
async function pdfToBlocks(buffer) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), useSystemFonts: true }).promise;
  const lines = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const content = await (await doc.getPage(p)).getTextContent();
    const rows = [];
    for (const it of content.items) {
      if (!it.str || !it.str.trim()) continue;
      const y = it.transform[5];
      const size = Math.abs(it.transform[3]) || it.height;
      const bold = /bold|black|heavy|semibold/i.test(`${it.fontName} ${content.styles[it.fontName]?.fontFamily || ''}`);
      let row = rows.find((r) => Math.abs(r.y - y) < 2);
      if (!row) rows.push((row = { y, items: [] }));
      row.items.push({ x: it.transform[4], w: it.width, str: it.str, size, bold });
    }
    rows.sort((a, b) => b.y - a.y);
    for (const r of rows) {
      r.items.sort((a, b) => a.x - b.x);
      lines.push({
        text: r.items
          .map((i, k) => (k > 0 && i.x - (r.items[k - 1].x + r.items[k - 1].w) > 0.8 && !/\s$/.test(r.items[k - 1].str) ? ` ${i.str}` : i.str))
          .join('')
          .replace(/\s+/g, ' ').trim(),
        size: Math.max(...r.items.map((i) => i.size)),
        bold: r.items.every((i) => i.bold),
        y: r.y,
        page: p,
      });
    }
  }
  const freq = new Map();
  for (const l of lines) freq.set(Math.round(l.size), (freq.get(Math.round(l.size)) || 0) + l.text.length);
  const body = [...freq.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 12;
  const maxSize = Math.max(...lines.map((l) => l.size));
  const blocks = [];
  for (const l of lines) {
    if (!l.text) continue;
    const bigger = Math.round(l.size) > body;
    const last = blocks[blocks.length - 1];
    if (bigger && l.size >= maxSize - 0.5 && blocks.every((b) => b.type !== 'heading' && b.type !== 'paragraph')) {
      if (last?.type === 'title') last.text += ` ${l.text}`;
      else blocks.push({ type: 'title', text: l.text });
    } else if (bigger || (l.bold && l.text.length <= 80)) {
      if (last?.type === 'heading' && last.size === Math.round(l.size)) last.text += ` ${l.text}`;
      else blocks.push({ type: 'heading', text: l.text, size: Math.round(l.size) });
    } else if (last?.type === 'paragraph' && !/^(\d+[.)]|[-•*])\s/.test(l.text)) {
      last.text += ` ${l.text}`;
    } else {
      blocks.push({ type: 'paragraph', text: l.text });
    }
  }
  return blocks.map(({ type, text }) => ({ type, text }));
}

// Plain-text terms: first line is the title, "1. Heading" lines are headings, everything else is a paragraph
function textToBlocks(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.map((line, i) => ({
    type: i === 0 ? 'title' : i === 1 || /^\d+[.)]\s/.test(line) ? 'heading' : 'paragraph',
    text: line,
  }));
}

// ---------- admin content (private bucket admin_uploads, read-only for users) ----------
// instructions/common/terms&conditions                       -> create-account terms
// instructions/<Partner|Supplier>/<role>.mp4                 -> onboarding video
// instructions/<Partner|Supplier>/<role>{terms,policy,support} -> profile menu documents
const GUIDE_FOLDERS = { common: 'common', partner: 'Partner', supplier: 'Supplier' };
const ROLES = ['partner', 'supplier'];
const CONTENT_DOCS = ['terms', 'policy', 'support'];

// Legal documents shared by all four roles. The files in ./content are uploaded to the private admin_uploads bucket
// once, if missing, so later edits made directly in storage are never overwritten.
const LEGAL_DOCS = {
  terms: { path: 'instructions/common/terms&conditions', file: 'terms-and-conditions.txt' },
  privacy: { path: 'instructions/common/privacy-policy', file: 'privacy-policy.txt' },
};

async function seedLegalDocs() {
  const { error } = await supabase.storage.createBucket(GUIDE_BUCKET, { public: false });
  if (error && !/already exists/i.test(error.message)) return console.error('[storage]', error.message);
  for (const { path, file } of Object.values(LEGAL_DOCS)) {
    const body = await readFile(new URL(`./content/${file}`, import.meta.url));
    const { error: upErr } = await supabase.storage.from(GUIDE_BUCKET).upload(path, body, { contentType: 'text/plain; charset=utf-8', upsert: false });
    if (upErr && !/already exists|duplicate/i.test(upErr.message)) console.error('[storage] seed', path, upErr.message);
  }
}
seedLegalDocs().catch((e) => console.error('[storage] seed', e.message));

const guideDocPath = (role, doc) => {
  if (role === 'common') return LEGAL_DOCS[doc]?.path ?? null;
  if (!ROLES.includes(role) || !CONTENT_DOCS.includes(doc)) return null;
  return `instructions/${GUIDE_FOLDERS[role]}/${role}${doc}`;
};

app.get(
  '/api/media/onboarding-video/:role',
  wrap(async (req, res) => {
    const { role } = req.params;
    if (!ROLES.includes(role)) throw new HttpError(404, 'Video not found');
    const path = `instructions/${GUIDE_FOLDERS[role]}/${role}.mp4`;
    const { data, error } = await supabase.storage.from(GUIDE_BUCKET).createSignedUrl(path, 3600);
    if (error) {
      console.error('[guide-video]', path, error.message);
      throw new HttpError(404, 'Onboarding video not found');
    }
    res.redirect(302, data.signedUrl);
  }),
);

app.get(
  '/api/content/:role/:doc',
  wrap(async (req, res) => {
    const { role, doc } = req.params;
    const path = guideDocPath(role, doc);
    if (!path) throw new HttpError(404, 'Document not found');
    const { data: file, error } = await supabase.storage.from(GUIDE_BUCKET).download(path);
    if (!file) {
      console.error('[guide-content]', path, error?.message);
      throw new HttpError(404, 'Document not available yet');
    }
    const buffer = Buffer.from(await file.arrayBuffer());
    const isPdf = buffer.subarray(0, 5).toString('latin1') === '%PDF-';
    res.json({ success: true, blocks: isPdf ? await pdfToBlocks(buffer) : textToBlocks(buffer.toString('utf8')) });
  }),
);

// ---------- user ----------
const profileSchema = z.object({
  category_id: z.coerce.number().int().positive(),
  category_name: z.string().trim().min(1).max(100),
  full_name: z.string().trim().min(1).max(120),
  address: z.string().trim().min(1),
  city: z.string().trim().min(1).max(80),
  state: z.string().trim().min(1).max(80),
  pincode: z.string().trim().min(1).max(20),
  latitude: z.coerce.number().min(-90).max(90).nullish(),
  longitude: z.coerce.number().min(-180).max(180).nullish(),
});

app.patch(
  '/api/users/:uuid/profile',
  auth,
  wrap(async (req, res) => {
    const body = parse(profileSchema, req.body);
    if (req.auth.role === 'supplier' && !(body.latitude && body.longitude)) {
      throw new HttpError(400, 'Supplier must provide shop location');
    }
    await updateUser(req.params.uuid, body);
    res.json({ success: true, message: 'Profile updated' });
  }),
);

const optBool = z.boolean().nullish();
const optUrl = z.string().url().nullish().or(z.literal(''));
const businessSchema = z.object({
  business_name: z.string().trim().min(1).max(150),
  profile_photo_url: optUrl,
  banner_url: optUrl,
  age: z.coerce.number().int().min(20).max(65).nullish(),
  experience_years: z.coerce.number().int().min(4).max(20).nullish(),
  has_team: optBool,
  team_members_count: z.coerce.number().int().min(0).nullish(),
});

const PARTNER_ONLY_FIELDS = ['age', 'experience_years', 'has_team', 'team_members_count'];

app.patch(
  '/api/users/:uuid/business-profile',
  auth,
  wrap(async (req, res) => {
    const updates = parse(businessSchema, req.body);
    for (const key of ['profile_photo_url', 'banner_url']) {
      if (updates[key] === '') updates[key] = null;
    }
    // Role comes from the token, never from the request body
    if (req.auth.role === 'supplier') {
      for (const key of PARTNER_ONLY_FIELDS) updates[key] = null;
    } else {
      if (!updates.age || !updates.experience_years) throw new HttpError(400, 'Age and experience are required');
      if (updates.has_team && !(updates.team_members_count > 0)) throw new HttpError(400, 'Team member count is required');
      if (!updates.has_team) updates.team_members_count = null;
    }
    await updateUser(req.params.uuid, updates);
    res.json({ success: true, message: 'Business profile saved' });
  }),
);

// ---------- business profile for the web signup (all four roles share the profiles table) ----------
const IG_ID_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const makeIgId = () =>
  String(100 + Math.floor(Math.random() * 900)) +
  Array.from({ length: 4 }, () => IG_ID_LETTERS[Math.floor(Math.random() * IG_ID_LETTERS.length)]).join('');

const profileBase = {
  full_name: z.string().trim().min(2).max(120),
  business_name: z.string().trim().min(2).max(150),
  address: z.string().trim().min(3).max(300),
  city: z.string().trim().min(2).max(80),
  state: z.string().trim().min(2).max(80),
  pincode: z.string().regex(/^\d{6}$/, 'Pincode must be 6 digits'),
  profile_photo_url: z.string().url().nullish().or(z.literal('')),
  banner_url: z.string().url().nullish().or(z.literal('')),
  latitude: z.coerce.number().min(-90).max(90).nullish(),
  longitude: z.coerce.number().min(-180).max(180).nullish(),
};
const ageYears = {
  age: z.coerce.number().int().min(18).max(65),
  experience_years: z.coerce.number().int().min(0).max(40),
};
const categoryPick = { category_id: z.coerce.number().int().positive() };
const skillLevel = z.string().trim().transform((v) => v.toLowerCase()).pipe(z.enum(['new', 'intermediate', 'experienced']));
const setupSchemas = {
  supplier: z.object({
    ...profileBase, ...categoryPick,
    shop_years: z.coerce.number().int().min(0).max(100).default(0),
  }),
  partner: z.object({
    full_name: z.string().trim().min(2).max(120),
    business_name: z.string().trim().min(2).max(150),
    category_id: z.coerce.number().int().positive(),
    address: z.string().trim().max(300).nullish().or(z.literal('')),
    city: z.string().trim().max(80).nullish().or(z.literal('')),
    state: z.string().trim().max(80).nullish().or(z.literal('')),
    pincode: z.string().trim().max(20).nullish().or(z.literal('')),
    latitude: z.coerce.number().min(-90).max(90).nullish(),
    longitude: z.coerce.number().min(-180).max(180).nullish(),
    profile_photo_url: z.string().url().nullish().or(z.literal('')),
    banner_url: z.string().url().nullish().or(z.literal('')),
    age: z.coerce.number().int().min(18).max(80).nullish(),
    experience_years: z.coerce.number().int().min(0).max(40).nullish(),
    skill_level: skillLevel.default('intermediate'),
    has_tools: z.boolean(),
    tools_photo_url: z.string().url().nullish().or(z.literal('')),
    has_team: z.boolean(),
    team_photo_url: z.string().url().nullish().or(z.literal('')),
    team_members_count: z.coerce.number().int().min(0).max(500).nullish(),
    knows_work_completely: z.boolean(),
    knows_pricing: z.boolean().optional(),
    worked_with_team_before: z.boolean().optional(),
  }),
  architect: z.object({
    ...profileBase, ...ageYears,
    skill_level: skillLevel.default('intermediate'),
    education: z.string().trim().max(150).nullish().or(z.literal('')),
    courses_completed: z.string().trim().max(150).nullish().or(z.literal('')),
    design_software: z.string().trim().max(80).nullish().or(z.literal('')),
  }),
};

const ensureIgId = async (userId) => {
  const existing = db(await supabase.from('onboarding').select('ig_id').eq('user_id', userId).maybeSingle());
  if (existing?.ig_id) return existing.ig_id;
  for (let attempt = 0; attempt < 10; attempt++) {
    const candidate = makeIgId();
    const taken = db(await supabase.from('onboarding').select('user_id').eq('ig_id', candidate).maybeSingle());
    if (!taken) return candidate;
  }
  throw new HttpError(500, 'Could not generate IG ID, please retry');
};

// Saves the business profile directly and returns the data shown on the onboarding business card
app.post(
  '/api/users/:uuid/profile-setup',
  auth,
  wrap(async (req, res) => {
    const role = req.auth.role;
    const schema = setupSchemas[role];
    if (!schema) throw new HttpError(403, 'Unknown role');
    const data = parse(schema, req.body);
    for (const key of ['profile_photo_url', 'banner_url', 'tools_photo_url', 'team_photo_url']) {
      if (key in data && !data[key]) data[key] = null;
    }
    if (role === 'supplier' && !(data.latitude && data.longitude)) throw new HttpError(400, 'Supplier must provide shop location');
    if (data.category_id) {
      const table = role === 'supplier' ? 'supplier_categories' : 'partner_categories';
      const cat = db(await supabase.from(table).select('id, name').eq('id', data.category_id).eq('is_active', true).maybeSingle());
      if (!cat) throw new HttpError(400, 'Invalid category');
      data.category_name = cat.name;
    }
    let persist = data;
    let verifiedFlag = null;
    if (role === 'partner') {
      // Block re-apply while the 7-day unverified cooldown is still active.
      const existing = await supabase.from('profiles').select('restricted_until').eq('user_id', req.params.uuid).maybeSingle();
      const until = (existing && existing.data && existing.data.restricted_until) ? new Date(existing.data.restricted_until).getTime() : 0;
      if (until > Date.now()) {
        throw new HttpError(403, 'Aapke 7 din abhi poore nahi hue hain. 7 din baad hi aap dobara apply kar sakte hain.');
      }
      const verified = !!data.has_tools && !!data.knows_work_completely;
      verifiedFlag = verified;
      const restrictedUntil = verified ? null : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      // Partners persist a lean profile row: identity, category, address + lat/lng, team, and a verified flag.
      // Heavy details (age, experience, tools/knowledge booleans, etc.) are not stored.
      persist = {
        full_name: data.full_name,
        business_name: data.business_name,
        category_id: data.category_id ?? null,
        category_name: data.category_name ?? null,
        address: data.address || null,
        city: data.city || null,
        state: data.state || null,
        pincode: data.pincode || null,
        latitude: data.latitude ?? null,
        longitude: data.longitude ?? null,
        skill_level: data.skill_level || 'intermediate',
        has_team: !!data.has_team,
        team_members_count: data.has_team ? (Number(data.team_members_count) || 0) : 0,
        profile_photo_url: data.profile_photo_url || null,
        banner_url: data.banner_url || null,
        verified,
        restricted_until: restrictedUntil,
      };
    }
    if (role === 'architect') {
      if (data.courses_completed && !data.education) data.education = data.courses_completed;
      delete data.courses_completed;
    }
    const igId = await ensureIgId(req.params.uuid);
    try {
      await updateUser(req.params.uuid, { ...persist, ig_id: igId });
    } catch (err) {
      // The verified column may not be applied yet; retry without it so onboarding never breaks.
      if (persist && persist.verified !== undefined && /verified|column|schema|42703|42P01/i.test(String((err && err.message) || ''))) {
        const { verified, ...rest } = persist;
        await updateUser(req.params.uuid, { ...rest, ig_id: igId });
      } else {
        throw err;
      }
    }
    const user = await getUser(req.params.uuid);
    res.json({
      success: true,
      verified: verifiedFlag,
      card: {
        business_name: user.business_name,
        username: user.username,
        ig_id: user.ig_id,
        role: user.role,
        category_name: user.category_name,
        skill_level: user.skill_level || null,
        has_team: !!user.has_team,
        team_members_count: user.team_members_count || 0,
        education: user.education || null,
        design_software: user.design_software || null,
        experience_years: user.experience_years ?? null,
        address: [user.address, user.city, user.state, user.pincode].filter(Boolean).join(', '),
        profile_photo_url: user.profile_photo_url,
        banner_url: user.banner_url,
        is_online: !!user.is_online,
        payment_status: user.payment_status,
        amount: PLANS[user.role] ? PLANS[user.role].amountPaise / 100 : null,
      },
    });
  }),
);

// Home-screen profile edit: only business name, photo and banner are editable
const brandingSchema = z.object({
  business_name: z.string().trim().min(1).max(150),
  profile_photo_url: z.string().url(),
  banner_url: z.string().url(),
});

app.patch(
  '/api/users/:uuid/branding',
  auth,
  wrap(async (req, res) => {
    await updateUser(req.params.uuid, parse(brandingSchema, req.body));
    res.json({ success: true, message: 'Profile updated' });
  }),
);

// Creates a one-time monthly payment order (no AutoPay) for the user's role; the first charge happens on this order.
// Contact and email come from the user's row, never from the client.
app.post(
  '/api/users/:uuid/payment/order',
  auth,
  wrap(async (req, res) => {
    const user = await getUser(req.params.uuid);
    const plan = PLANS[user.role];
    if (!plan) throw new HttpError(403, 'No plan available for this role');
    if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) throw new HttpError(503, 'Payments are not configured');

    const order = await rzp('POST', '/orders', {
      amount: plan.amountPaise,
      currency: 'INR',
      receipt: `rcpt_${user.id.slice(0, 8)}_${Date.now()}`,
      notes: { user_id: user.id, role: user.role },
    });

    res.json({
      success: true,
      key_id: RAZORPAY_KEY_ID,
      order_id: order.id,
      amount: plan.amountPaise / 100,
      name: user.full_name || user.business_name || user.username,
      contact: `+91${normalizePhone(user.phone)}`,
      // Signup has no email; Razorpay needs one, so a per-user placeholder keeps checkout from asking for it
      email: user.email || `${normalizePhone(user.phone)}@interagood.in`,
    });
  }),
);

const verifyPaymentSchema = z.object({
  razorpay_payment_id: z.string().min(1),
  razorpay_order_id: z.string().min(1),
  razorpay_signature: z.string().min(1),
});

app.post(
  '/api/users/:uuid/payment/verify',
  auth,
  wrap(async (req, res) => {
    const body = parse(verifyPaymentSchema, req.body);
    if (!RAZORPAY_KEY_SECRET) throw new HttpError(503, 'Payments are not configured');

    const expected = hmacHex(RAZORPAY_KEY_SECRET, `${body.razorpay_payment_id}|${body.razorpay_order_id}`);
    if (!safeEqualHex(expected, body.razorpay_signature)) throw new HttpError(400, 'Payment verification failed');

    const order = await rzp('GET', `/orders/${encodeURIComponent(body.razorpay_order_id)}`);
    if (order.notes?.user_id !== req.params.uuid) throw new HttpError(403, 'Payment does not belong to this user');
    if (order.status !== 'paid') throw new HttpError(400, 'Payment is not completed');

    await activateSubscriber(req.params.uuid, body.razorpay_payment_id);
    res.json({ success: true, message: 'Payment successful', payment_id: body.razorpay_payment_id });
  }),
);

// ---------- payu payment (monthly one-time; no AutoPay) ----------
// Init: the amount and customer details come from the server (never the client).
app.post(
  '/api/payments/payu/init',
  auth,
  wrap(async (req, res) => {
    if (!isPayuConfigured()) throw new HttpError(503, 'PayU is not configured');
    const user = await getUser(req.auth.sub);
    const plan = PLANS[user.role];
    if (!plan) throw new HttpError(403, 'No plan available for this role');
    const publicApi = API_PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
    const txnid = `ig${Date.now()}${Math.floor(Math.random() * 900 + 100)}`;
    const order = buildPayuOrder({
      txnid,
      amount: (plan.amountPaise / 100).toFixed(2),
      productinfo: `${plan.name} - monthly`.slice(0, 100),
      firstname: String(user.full_name || user.business_name || user.username || 'Customer').slice(0, 60),
      email: user.email || `${normalizePhone(user.phone)}@interagood.in`,
      phone: normalizePhone(user.phone),
      udf1: user.id,
      surl: `${publicApi}/api/payments/payu/return`,
      furl: `${publicApi}/api/payments/payu/return`,
    });
    res.json({ success: true, order });
  }),
);

// PayU posts the result back here (surl/furl). Verify the hash, activate the paid cycle, then return to the app.
app.post(
  '/api/payments/payu/return',
  wrap(async (req, res) => {
    if (!isPayuConfigured()) throw new HttpError(503, 'PayU is not configured');
    const fail = (reason) => res.redirect(`${APP_URL}/payment-return.html?status=failure&reason=${encodeURIComponent(reason)}`);
    const postback = parse(
      z.object({
        status: z.string(),
        txnid: z.string(),
        amount: z.string(),
        productinfo: z.string(),
        firstname: z.string().nullish(),
        email: z.string().nullish(),
        key: z.string().nullish(),
        hash: z.string(),
        udf1: z.string().nullish(),
        udf2: z.string().nullish(),
        udf3: z.string().nullish(),
        udf4: z.string().nullish(),
        udf5: z.string().nullish(),
      }),
      req.body,
    );
    if (!verifyPayuHash(postback)) return fail('hash');
    const userId = (postback.udf1 || '').split('|')[0];
    if (!z.string().uuid().safeParse(userId).success) return fail('user');
    let user;
    try {
      user = await getUser(userId);
    } catch {
      return fail('user');
    }
    const plan = PLANS[user.role];
    const expectedAmount = plan ? (plan.amountPaise / 100).toFixed(2) : null;
    if (postback.status !== 'success') return fail('status');
    if (!expectedAmount || Number(postback.amount) !== Number(expectedAmount)) return fail('amount');
    try {
      await activateSubscriber(userId, postback.txnid);
    } catch (err) {
      if (err.status !== 404) throw err;
      return fail('activate');
    }
    res.redirect(`${APP_URL}/payment-return.html?status=success`);
  }),
);

// Keeps the user row in sync with Razorpay (renewals, failed charges, cancellations)
app.post(
  '/api/razorpay/webhook',
  wrap(async (req, res) => {
    if (!RAZORPAY_WEBHOOK_SECRET) throw new HttpError(503, 'Webhook not configured');
    const signature = req.get('x-razorpay-signature');
    if (!req.rawBody || !safeEqualHex(hmacHex(RAZORPAY_WEBHOOK_SECRET, req.rawBody), signature)) {
      throw new HttpError(400, 'Invalid signature');
    }

    const event = req.body.event;
    // One-time monthly payments (no AutoPay): activate the paid cycle on capture
    const payment = req.body?.payload?.payment?.entity;
    const paymentUserId = payment?.notes?.user_id;
    if (payment && paymentUserId && z.string().uuid().safeParse(paymentUserId).success) {
      try {
        if (event === 'payment.captured') await activateSubscriber(paymentUserId, payment.id);
        else if (event === 'payment.failed') {
          await updateUser(paymentUserId, { leads_status: 'inactive', payment_status: 'failed' });
        }
      } catch (err) {
        if (err.status !== 404) throw err;
      }
    }

    // Legacy AutoPay subscription events, kept for safety: a failed/ended mandate makes the user offline
    const subscription = req.body?.payload?.subscription?.entity;
    const subscriptionUserId = subscription?.notes?.user_id;
    if (subscriptionUserId && z.string().uuid().safeParse(subscriptionUserId).success) {
      try {
        if (['subscription.halted', 'subscription.cancelled', 'subscription.completed', 'subscription.paused'].includes(event)) {
          await updateUser(subscriptionUserId, {
            leads_status: 'inactive',
            is_online: false,
            payment_status: event === 'subscription.halted' ? 'failed' : 'cancelled',
          });
        }
      } catch (err) {
        if (err.status !== 404) throw err;
      }
    }
    res.json({ success: true });
  }),
);

app.get(
  '/api/users/:uuid',
  auth,
  wrap(async (req, res) => {
    const user = await getUser(req.params.uuid);
    let smpRes = await supabase.from('user_samples').select('*').eq('user_id', user.id).order('created_at', { ascending: false });
    let rawSamples = [];
    if (!smpRes.error && smpRes.data) {
      rawSamples = smpRes.data.filter((row) => !isProductFallbackCaption(row.caption));
    } else if (smpRes.error && isMissingTableErr(smpRes.error)) {
      const storeRec = await loadStoreRecords(user.id);
      rawSamples = storeRec.samples;
    } else if (smpRes.error) {
      db(smpRes);
    }
    const samples = await resolveSampleUrls(await withVotes(rawSamples, user.id));
    res.json({ success: true, data: { ...sanitizeUser(user), samples } });
  }),
);

app.post(
  '/api/payments/payu/sandbox-activate',
  auth,
  wrap(async (req, res) => {
    const user = await getUser(req.auth.sub);
    const txnid = String(req.body?.txnid || ('PAYU_SANDBOX_' + Date.now()));
    await activateSubscriber(user.id, txnid);
    const updated = await getUser(user.id);
    res.json({
      success: true,
      txnid,
      payment_status: updated.payment_status,
      next_due_at: updated.next_due_at,
      is_online: !!updated.is_online,
    });
  }),
);

app.patch(
  '/api/users/:uuid/status',
  auth,
  wrap(async (req, res) => {
    const user = await getUser(req.params.uuid);
    const liveBilling = isPayuConfigured() || (!!RAZORPAY_KEY_ID && !!RAZORPAY_KEY_SECRET);
    if (liveBilling && !isPaymentActive(user)) {
      throw new HttpError(402, 'Subscription is not active. Please complete the payment first.');
    }
    const { is_online } = parse(z.object({ is_online: z.boolean() }), req.body);
    await updateUser(req.params.uuid, { is_online });
    res.json({ success: true, is_online });
  }),
);

// ---------- media upload (raw binary body -> Supabase Storage -> public URL) ----------
app.post(
  '/api/users/:uuid/upload',
  auth,
  wrap(async (req, res) => {
    const kind = String(req.query.kind || '');
    const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const ext = UPLOAD_TYPES[contentType];
    if (!UPLOAD_KINDS.includes(kind)) throw new HttpError(400, 'Invalid kind');
    if (!ext || !Buffer.isBuffer(req.body) || !req.body.length) throw new HttpError(400, 'Unsupported or empty file');
    const isVideo = ['mp4', 'mov', 'webm', '3gp'].includes(ext);
    if (isVideo && !['sample', 'partner_sample', 'supplier_product', 'architect_post', 'product'].includes(kind)) {
      throw new HttpError(400, 'Videos allowed only for samples and product listings');
    }
    const folderMap = {
      profile: 'user_media/profilephoto',
      banner: 'user_media/banner',
      sample: 'user_media/samples',
      partner_sample: 'partner_samples',
      architect_post: 'products',
      supplier_product: 'products',
      product: 'products',
      tools: 'user_media/tools',
      team: 'user_media/team',
    };
    const liveBilling = isPayuConfigured() || (!!RAZORPAY_KEY_ID && !!RAZORPAY_KEY_SECRET);
    if (liveBilling && (kind === 'sample' || kind === 'partner_sample')) await assertActive(req.params.uuid);
    const bucketMap = {
      profile: STORAGE_BUCKET, banner: STORAGE_BUCKET, sample: STORAGE_BUCKET,
      tools: STORAGE_BUCKET, team: STORAGE_BUCKET,
      partner_sample: 'partner_samples',
      architect_post: 'products',
      supplier_product: 'products',
      product: 'products',
    };
    const path = `${folderMap[kind] || kind}/${req.params.uuid}-${Date.now()}.${ext}`;
    let bucket = bucketMap[kind] || STORAGE_BUCKET;
    const isPrivate = kind === 'partner_sample';

    let upRes = await supabase.storage.from(bucket).upload(path, req.body, { contentType });
    if (upRes.error) {
      await supabase.storage.createBucket(bucket, { public: !isPrivate }).catch(() => {});
      if (!isPrivate) await supabase.storage.updateBucket(bucket, { public: true }).catch(() => {});
      upRes = await supabase.storage.from(bucket).upload(path, req.body, { contentType });
    }
    if (upRes.error && bucket !== STORAGE_BUCKET) {
      bucket = STORAGE_BUCKET;
      upRes = await supabase.storage.from(bucket).upload(path, req.body, { contentType });
    }
    if (upRes.error) {
      console.error('[storage]', bucket, upRes.error.message);
      throw new HttpError(500, 'Upload failed: ' + upRes.error.message);
    }
    if (isPrivate && bucket === 'partner_samples') {
      const { data, error: signErr } = await supabase.storage.from(bucket).createSignedUrl(path, 60 * 60 * 24 * 7);
      res.status(201).json({ success: true, url: signErr ? publicUrl(path, bucket) : data.signedUrl });
      return;
    }
    res.status(201).json({ success: true, url: publicUrl(path, bucket) });
  }),
);

// ---------- samples (daily quota: 6 total, 3 images, 3 videos) ----------
const SAMPLE_COLUMNS = 'id, media_type, title, caption, media_url, thumbnail_url, price, price_unit, created_at';
const PRICE_UNITS = ['inch', 'sqfit', 'sqft', 'runningfit', 'rft', 'pcs', 'pieces', 'bundle', 'bundles', 'combo', 'fit', 'feet', 'meter', 'kg', 'liter', 'liters', 'contract'];

const withVotes = async (samples, viewerId) => {
  if (!samples.length) return samples;
  const votesRes = await supabase.from('sample_votes').select('sample_id, user_id, vote').in('sample_id', samples.map((s) => s.id));
  const votes = (!votesRes.error && votesRes.data) ? votesRes.data : [];
  return samples.map((s) => {
    const own = votes.filter((v) => v.sample_id === s.id);
    return {
      ...s,
      likes: own.filter((v) => v.vote === 1).length,
      dislikes: own.filter((v) => v.vote === -1).length,
      my_vote: own.find((v) => v.user_id === viewerId)?.vote ?? 0,
    };
  });
};

const sampleSchema = z.object({
  media_type: z.enum(['image', 'video']),
  title: z.string().trim().min(1).max(120),
  caption: z.string().trim().max(300).optional().nullable(),
  media_url: z.string().url(),
  thumbnail_url: z.string().url().nullish(),
  price: z.coerce.number().min(0).max(100_000_000).default(1),
  price_unit: z.string().trim().max(30).default('pcs'),
  is_private: z.boolean().optional(),
  role: z.string().trim().max(20).optional(),
  phone: z.string().trim().max(20).optional().nullable(),
  username: z.string().trim().max(60).optional().nullable(),
  business_name: z.string().trim().max(150).optional().nullable(),
});

app.get(
  '/api/users/:uuid/samples',
  auth,
  wrap(async (req, res) => {
    const quota = await getQuotaForUser(req.params.uuid);
    const q = await supabase
      .from('user_samples')
      .select('*')
      .eq('user_id', req.params.uuid)
      .order('created_at', { ascending: false });
    let raw = [];
    if (!q.error && q.data) {
      raw = q.data.filter((row) => !isProductFallbackCaption(row.caption));
    } else if (q.error && isMissingTableErr(q.error)) {
      const storeRec = await loadStoreRecords(req.params.uuid);
      raw = storeRec.samples;
    } else {
      db(q);
    }
    const samples = await resolveSampleUrls(await withVotes(raw, req.params.uuid));
    res.json({ success: true, data: samples, quota });
  }),
);

app.post(
  '/api/users/:uuid/samples',
  auth,
  requireActive,
  wrap(async (req, res) => {
    const user = await getUser(req.params.uuid);
    const body = parse(sampleSchema, req.body);
    const quota = await getQuotaForUser(user.id);
    if (quota.samples.totalUsed >= DAILY_LIMITS.total) {
      throw new HttpError(429, `Daily limit of ${DAILY_LIMITS.total} samples reached for today.`);
    }
    const sameType = body.media_type === 'video' ? quota.samples.videosUsed : quota.samples.imagesUsed;
    if (sameType >= DAILY_LIMITS[body.media_type]) {
      throw new HttpError(429, `Daily maximum of ${DAILY_LIMITS[body.media_type]} ${body.media_type}s reached.`);
    }
    const safePrice = body.price > 0 ? body.price : 1;
    const safeUnit = UNIT_TO_SAMPLE_UNIT[String(body.price_unit || 'pcs').toLowerCase()] || 'pcs';
    const minimalRow = {
      user_id: req.params.uuid,
      media_type: body.media_type,
      title: body.title,
      media_url: body.media_url,
    };
    const baseRow = {
      ...minimalRow,
      caption: body.caption || null,
      thumbnail_url: body.thumbnail_url ?? null,
      price: safePrice,
      price_unit: safeUnit,
    };
    const extendedRow = {
      ...baseRow,
      is_private: body.is_private ?? (user.role === 'partner'),
      role: body.role || user.role,
      phone: body.phone || user.phone || null,
      username: body.username || user.username || null,
      business_name: body.business_name || user.business_name || null,
    };

    let insRes = await supabase.from('user_samples').insert(extendedRow).select('*').single();
    if (insRes.error && isMissingSchemaErr(insRes.error) && !isMissingTableErr(insRes.error)) {
      insRes = await supabase.from('user_samples').insert(baseRow).select('*').single();
    }
    if (insRes.error && isMissingSchemaErr(insRes.error) && !isMissingTableErr(insRes.error)) {
      insRes = await supabase.from('user_samples').insert(minimalRow).select('*').single();
    }

    let sample;
    if (!insRes.error && insRes.data) {
      sample = insRes.data;
    } else if (insRes.error && isMissingTableErr(insRes.error)) {
      sample = {
        id: crypto.randomUUID(),
        ...extendedRow,
        created_at: new Date().toISOString(),
      };
      const storeRec = await loadStoreRecords(user.id);
      storeRec.samples.unshift(sample);
      await saveStoreRecords(user.id, storeRec);
    } else {
      sample = db(insRes);
    }

    const [resolved] = await resolveSampleUrls([sample]);
    const nextQuota = await getQuotaForUser(user.id);
    res.status(201).json({
      success: true,
      data: {
        ...resolved,
        caption: resolved.caption ?? body.caption ?? '',
        role: extendedRow.role,
        phone: extendedRow.phone,
        username: extendedRow.username,
        business_name: extendedRow.business_name,
        is_private: extendedRow.is_private,
        likes: 0,
        dislikes: 0,
        my_vote: 0,
      },
      quota: nextQuota,
    });
  }),
);

app.put(
  '/api/users/:uuid/samples/:sampleId/vote',
  auth,
  wrap(async (req, res) => {
    if (!z.string().uuid().safeParse(req.params.sampleId).success) throw new HttpError(400, 'Invalid sample id');
    const { vote } = parse(z.object({ vote: z.union([z.literal(1), z.literal(-1), z.literal(0)]) }), req.body);
    const sample = db(await supabase.from('user_samples').select('*').eq('id', req.params.sampleId).maybeSingle());
    if (!sample) throw new HttpError(404, 'Sample not found');
    if (vote === 0) {
      db(await supabase.from('sample_votes').delete().eq('sample_id', sample.id).eq('user_id', req.params.uuid));
    } else {
      db(await supabase.from('sample_votes').upsert({ sample_id: sample.id, user_id: req.params.uuid, vote }, { onConflict: 'sample_id,user_id' }));
    }
    const [{ likes, dislikes, my_vote }] = await withVotes([sample], req.params.uuid);
    res.json({ success: true, data: { likes, dislikes, my_vote } });
  }),
);

app.delete(
  '/api/users/:uuid/samples/:sampleId',
  auth,
  wrap(async (req, res) => {
    if (!z.string().uuid().safeParse(req.params.sampleId).success) throw new HttpError(400, 'Invalid sample id');
    const delRes = await supabase.from('user_samples').delete().eq('id', req.params.sampleId).eq('user_id', req.params.uuid).select('media_url');
    if (delRes.error && isMissingTableErr(delRes.error)) {
      const storeRec = await loadStoreRecords(req.params.uuid);
      storeRec.samples = storeRec.samples.filter((s) => s.id !== req.params.sampleId);
      await saveStoreRecords(req.params.uuid, storeRec);
      return res.json({ success: true, message: 'Sample deleted' });
    }
    const deleted = db(delRes);
    const marker = `/object/public/${STORAGE_BUCKET}/`;
    const paths = deleted.map((s) => String(s.media_url || '').split(marker)[1]).filter(Boolean).map(decodeURIComponent);
    if (paths.length) {
      const { error } = await supabase.storage.from(STORAGE_BUCKET).remove(paths);
      if (error) console.error('[storage] sample cleanup', error.message);
    }
    res.json({ success: true, message: 'Sample deleted' });
  }),
);

// ---------- multi-role product listings (4/day limit; with_material locked true ONLY for architect) ----------
const maskPhone = (phone) => {
  const d = String(phone || '').replace(/\D/g, '');
  if (d.length < 10) return '+91 98XXX-XX000';
  const last10 = d.slice(-10);
  return `+91 ${last10.slice(0, 2)}XXX-XX${last10.slice(-3)}`;
};

const UNIT_TO_SAMPLE_UNIT = {
  sqft: 'sqfit', sqfit: 'sqfit',
  rft: 'runningfit', runningfit: 'runningfit',
  feet: 'fit', fit: 'fit',
  inches: 'inch', inch: 'inch',
  meter: 'fit', kg: 'pcs', liter: 'pcs', liters: 'pcs',
  pieces: 'pcs', pcs: 'pcs',
  bundles: 'bundle', bundle: 'bundle',
  combo: 'combo', contract: 'combo',
};

const listingSchema = z.object({
  title: z.string().trim().min(1).max(160),
  category: z.string().trim().min(1).max(100).default('General'),
  sub_category: z.string().trim().max(100).optional().nullable(),
  description: z.string().trim().max(1000).optional().nullable(),
  unit: z.string().trim().max(30).default('sqfit'),
  rate_per_unit: z.coerce.number().min(0).max(100_000_000).default(0),
  quantity: z.coerce.number().min(0.01).max(1_000_000).default(1),
  expected_amount: z.coerce.number().min(0).max(100_000_000).optional().nullable(),
  with_material: z.boolean().optional().default(false),
  image_url: z.string().url().optional().nullable(),
  media_type: z.enum(['image', 'video']).default('image'),
  is_private: z.boolean().optional().default(false),
});

const getQuotaForUser = async (userId) => {
  const since = startOfTodayIST();
  const sampleRes = await supabase.from('user_samples').select('*').eq('user_id', userId).gte('created_at', since);
  let sampleRows = [];
  let fallbackProdRows = [];
  if (!sampleRes.error && sampleRes.data) {
    sampleRows = sampleRes.data.filter((r) => !isProductFallbackCaption(r.caption));
    fallbackProdRows = sampleRes.data.filter((r) => isProductFallbackCaption(r.caption));
  } else if (sampleRes.error && isMissingTableErr(sampleRes.error)) {
    const storeRec = await loadStoreRecords(userId);
    sampleRows = storeRec.samples.filter((r) => !r.created_at || r.created_at >= since);
    fallbackProdRows = storeRec.products.filter((r) => !r.created_at || r.created_at >= since);
  }
  const prodRes = await supabase.from('product_listings').select('id').eq('user_id', userId).gte('created_at', since);
  const prodCount = (!prodRes.error && prodRes.data) ? prodRes.data.length : fallbackProdRows.length;
  const imagesUsed = sampleRows.filter((r) => r.media_type === 'image').length;
  const videosUsed = sampleRows.filter((r) => r.media_type === 'video').length;
  return {
    totalUsed: sampleRows.length,
    imagesUsed,
    videosUsed,
    maxTotal: DAILY_LIMITS.total,
    maxImages: DAILY_LIMITS.image,
    maxVideos: DAILY_LIMITS.video,
    samples: {
      totalUsed: sampleRows.length,
      imagesUsed,
      videosUsed,
      maxTotal: DAILY_LIMITS.total,
      maxImages: DAILY_LIMITS.image,
      maxVideos: DAILY_LIMITS.video,
    },
    products: {
      totalUsed: prodCount,
      maxTotal: PRODUCT_DAILY_LIMIT,
    },
  };
};

app.get(
  '/api/users/:uuid/listings',
  auth,
  wrap(async (req, res) => {
    const quota = await getQuotaForUser(req.params.uuid);
    const { data, error } = await supabase
      .from('product_listings')
      .select('*')
      .eq('user_id', req.params.uuid)
      .order('created_at', { ascending: false });
    if (!error) return res.json({ success: true, data, quota });

    const fbRes = await supabase.from('user_samples').select('*').eq('user_id', req.params.uuid).order('created_at', { ascending: false });
    if (!fbRes.error && fbRes.data) {
      const mapped = fbRes.data
        .filter((s) => isProductFallbackCaption(s.caption))
        .map((s) => {
          let meta = {};
          try { meta = JSON.parse(s.caption); } catch {}
          return {
            id: s.id,
            user_id: req.params.uuid,
            title: s.title,
            category: meta.category || 'General',
            sub_category: meta.sub_category || null,
            description: meta.description || '',
            unit: meta.unit || s.price_unit || 'sqfit',
            rate_per_unit: Number(s.price) || 0,
            quantity: Number(meta.quantity) || 1,
            expected_amount: Number(meta.expected_amount) || Number(meta.total_amount) || Number(s.price) || 0,
            total_amount: Number(meta.total_amount) || Number(s.price) || 0,
            with_material: meta.with_material === true,
            image_url: s.media_url,
            media_type: s.media_type || 'image',
            is_private: !!meta.is_private,
            created_at: s.created_at,
          };
        });
      return res.json({ success: true, data: mapped, quota });
    }
    if (fbRes.error && isMissingTableErr(fbRes.error)) {
      const storeRec = await loadStoreRecords(req.params.uuid);
      return res.json({ success: true, data: storeRec.products, quota });
    }
    db(fbRes);
  }),
);

app.post(
  '/api/users/:uuid/listings',
  auth,
  wrap(async (req, res) => {
    const user = await getUser(req.params.uuid);
    const b = parse(listingSchema, req.body);
    const quota = await getQuotaForUser(user.id);
    if (quota.products.totalUsed >= PRODUCT_DAILY_LIMIT) {
      throw new HttpError(429, `Daily product listing limit reached: maximum ${PRODUCT_DAILY_LIMIT} products per day.`);
    }
    const subtotal = Math.round(b.rate_per_unit * b.quantity * 100) / 100;
    const expectedAmt = b.expected_amount != null ? Number(b.expected_amount) : subtotal;
    const isPrivate = !!b.is_private;
    // with_material now follows the client payload (defaults to FALSE); it is not forced on any role.
    const withMaterial = b.with_material === true;

    const baseListing = {
      user_id: user.id,
      role: user.role,
      title: b.title,
      category: b.category,
      sub_category: b.sub_category || null,
      description: b.description || null,
      unit: b.unit,
      rate_per_unit: b.rate_per_unit,
      quantity: b.quantity,
      total_amount: expectedAmt || subtotal,
      with_material: withMaterial,
      image_url: b.image_url || null,
      media_type: b.media_type,
      is_private: isPrivate,
    };

    let insRes = await supabase
      .from('product_listings')
      .insert({ ...baseListing, expected_amount: expectedAmt })
      .select('*')
      .single();
    if (insRes.error && isMissingSchemaErr(insRes.error) && !isMissingTableErr(insRes.error)) {
      insRes = await supabase.from('product_listings').insert(baseListing).select('*').single();
    }

    if (!insRes.error) {
      return res.status(201).json({ success: true, data: insRes.data, quota: await getQuotaForUser(user.id) });
    }

    // Fallback to user_samples ONLY if product_listings table does not exist yet
    const sampleUnit = UNIT_TO_SAMPLE_UNIT[b.unit.toLowerCase()] || 'sqfit';
    const safePrice = b.rate_per_unit > 0 ? b.rate_per_unit : 1;
    const metaObj = {
      __kind: 'product',
      category: String(b.category || 'General').slice(0, 32),
      description: String(b.description || '').slice(0, 90),
      unit: String(b.unit || 'sqfit').slice(0, 16),
      quantity: b.quantity,
      expected_amount: expectedAmt,
      total_amount: expectedAmt || subtotal,
      with_material: withMaterial,
      is_private: isPrivate,
    };
    const metaCaption = JSON.stringify(metaObj);

    const fbIns = await supabase
      .from('user_samples')
      .insert({
        user_id: user.id,
        media_type: b.media_type,
        title: b.title.slice(0, 120),
        caption: metaCaption.slice(0, 295),
        media_url: b.image_url || 'https://interagood.in/assets/logo-square.png',
        price: safePrice,
        price_unit: sampleUnit,
      })
      .select('*')
      .single();

    if (!fbIns.error && fbIns.data) {
      const fb = fbIns.data;
      return res.status(201).json({
        success: true,
        data: {
          id: fb.id,
          user_id: user.id,
          role: user.role,
          title: fb.title,
          category: b.category,
          sub_category: b.sub_category || null,
          description: b.description || '',
          unit: b.unit,
          rate_per_unit: b.rate_per_unit,
          quantity: b.quantity,
          expected_amount: expectedAmt,
          total_amount: expectedAmt || subtotal,
          with_material: withMaterial,
          image_url: fb.media_url,
          media_type: fb.media_type,
          is_private: isPrivate,
          created_at: fb.created_at,
        },
        quota: await getQuotaForUser(user.id),
      });
    }

    if (fbIns.error && isMissingTableErr(fbIns.error)) {
      const item = {
        id: crypto.randomUUID(),
        ...baseListing,
        expected_amount: expectedAmt,
        description: b.description || '',
        image_url: b.image_url || 'https://interagood.in/assets/logo-square.png',
        created_at: new Date().toISOString(),
      };
      const storeRec = await loadStoreRecords(user.id);
      storeRec.products.unshift(item);
      await saveStoreRecords(user.id, storeRec);
      return res.status(201).json({ success: true, data: item, quota: await getQuotaForUser(user.id) });
    }
    db(fbIns);
  }),
);

app.delete(
  '/api/users/:uuid/listings/:listingId',
  auth,
  wrap(async (req, res) => {
    if (!z.string().uuid().safeParse(req.params.listingId).success) throw new HttpError(400, 'Invalid listing id');
    const res1 = await supabase.from('product_listings').delete().eq('id', req.params.listingId).eq('user_id', req.params.uuid);
    if (res1.error) {
      const res2 = await supabase.from('user_samples').delete().eq('id', req.params.listingId).eq('user_id', req.params.uuid);
      if (res2.error && isMissingTableErr(res2.error)) {
        const storeRec = await loadStoreRecords(req.params.uuid);
        storeRec.products = storeRec.products.filter((p) => p.id !== req.params.listingId);
        await saveStoreRecords(req.params.uuid, storeRec);
      }
    }
    res.json({ success: true });
  }),
);

// ---------- business cards (what a client sees in the list) ----------
// Card JSON never contains the phone number or coordinates. They are used only on the server to build the
// call / chat / navigation links, which the client app opens when the matching button is tapped.
const CARD_COLUMNS =
  'user_id, business_name, profile_photo_url, banner_url, category_name, latitude, longitude, created_at, onboarding!inner(payment_status, next_due_at), dashboard(is_online), users!inner(role, username)';
const flatCard = ({ user_id, users, onboarding, dashboard, created_at, ...rest }) => ({
  id: user_id,
  role: users.role,
  username: users.username,
  ...rest,
  ...(onboarding || {}),
  ...(dashboard || {}),
  created_at,
});
const cardContactLimiter = rateLimit({ windowMs: 60 * 60_000, limit: 120, standardHeaders: true, legacyHeaders: false });

const distanceKm = (lat1, lon1, lat2, lon2) => {
  const rad = (d) => (d * Math.PI) / 180;
  const a =
    Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

const toCard = (row, from) => {
  const { created_at, latitude, longitude, payment_status, next_due_at, ...card } = row;
  const hasPoint = latitude != null && longitude != null;
  const active = isPaymentActive({ payment_status, next_due_at });
  return {
    ...card,
    // A user is shown as online only while the monthly payment is active
    is_online: active && card.is_online === true,
    verified: active,
    has_location: hasPoint,
    distance_km: from && hasPoint ? Math.round(distanceKm(from.lat, from.lng, Number(latitude), Number(longitude)) * 10) / 10 : null,
  };
};

// Only paid users with a finished business profile whose monthly cycle has not expired are listed
const listableCards = () =>
  supabase
    .from('profiles')
    .select(CARD_COLUMNS)
    .eq('onboarding.payment_status', 'paid')
    .or(`next_due_at.is.null,next_due_at.gt.${new Date().toISOString()}`, { foreignTable: 'onboarding' })
    .not('business_name', 'is', null);

const cardListQuery = z.object({
  role: z.enum(SIGNUP_ROLES).optional(),
  category_id: z.coerce.number().int().positive().optional(),
  q: z.string().trim().max(60).optional(),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

app.get(
  '/api/cards',
  authAny,
  wrap(async (req, res) => {
    const { role, category_id, q, lat, lng, limit, offset } = parse(cardListQuery, req.query);
    let query = listableCards();
    if (role) query = query.eq('users.role', role);
    if (category_id) query = query.eq('category_id', category_id);
    if (q) query = query.ilike('business_name', `%${escapeLike(q)}%`);
    const from = lat != null && lng != null ? { lat, lng } : null;
    let cards;
    if (from) {
      // Nearest first: distance is computed here because coordinates are never exposed
      const rows = db(await query.limit(500));
      cards = rows
        .map((r) => toCard(flatCard(r), from))
        .sort((a, b) => (a.distance_km ?? Infinity) - (b.distance_km ?? Infinity))
        .slice(offset, offset + limit);
    } else {
      cards = db(await query.order('created_at', { ascending: false }).range(offset, offset + limit - 1)).map((r) => toCard(flatCard(r), null));
    }
    res.json({ success: true, data: cards });
  }),
);

const getCardRow = async (id) => {
  if (!z.string().uuid().safeParse(id).success) throw new HttpError(400, 'Invalid card id');
  const row = db(await listableCards().eq('user_id', id).maybeSingle());
  if (!row) throw new HttpError(404, 'Card not found');
  return flatCard(row);
};

app.get(
  '/api/cards/:id',
  authAny,
  wrap(async (req, res) => {
    res.json({ success: true, data: toCard(await getCardRow(req.params.id), null) });
  }),
);

// Returns the link for one card button: call -> tel:, chat -> WhatsApp, navigate -> Google Maps directions
app.get(
  '/api/cards/:id/contact',
  authAny,
  cardContactLimiter,
  wrap(async (req, res) => {
    const action = String(req.query.action || '');
    if (!['call', 'chat', 'navigate'].includes(action)) throw new HttpError(400, 'Invalid action');
    const row = await getCardRow(req.params.id);
    if (action === 'navigate') {
      if (row.latitude == null || row.longitude == null) throw new HttpError(404, 'Location is not available for this card');
      return res.json({
        success: true,
        url: `https://www.google.com/maps/dir/?api=1&destination=${Number(row.latitude)},${Number(row.longitude)}`,
      });
    }
    const { phone } = await getUser(row.id);
    const number = `91${normalizePhone(phone)}`;
    const url =
      action === 'call'
        ? `tel:+${number}`
        : `https://wa.me/${number}?text=${encodeURIComponent(`Hello ${row.business_name}, I found you on Interagood.`)}`;
    res.json({ success: true, url });
  }),
);

app.get(
  '/api/cards/:id/samples',
  authAny,
  wrap(async (req, res) => {
    const row = await getCardRow(req.params.id);
    const samples = await withVotes(
      db(await supabase.from('user_samples').select(SAMPLE_COLUMNS).eq('user_id', row.id).order('created_at', { ascending: false })),
      req.auth.sub,
    );
    res.json({ success: true, data: samples });
  }),
);

// ---------- public (logged-out website visitors) ----------
const publicLimiter = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: true, legacyHeaders: false });

const publicSupplierQuery = z.object({
  category_ids: z
    .string()
    .regex(/^\d{1,3}(,\d{1,3}){0,9}$/)
    .optional(),
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  max_km: z.coerce.number().min(1).max(200).default(50),
  limit: z.coerce.number().int().min(1).max(30).default(20),
});

// Suppliers inside the client's zone (nearest first). Same card shape as /api/cards: no phone, no coordinates.
app.get(
  '/api/public/suppliers',
  publicLimiter,
  wrap(async (req, res) => {
    const { category_ids, lat, lng, max_km, limit } = parse(publicSupplierQuery, req.query);
    let query = listableCards().eq('users.role', 'supplier');
    if (category_ids) query = query.in('category_id', category_ids.split(',').map(Number));
    const from = { lat, lng };
    const cards = db(await query.limit(500))
      .map((r) => toCard(flatCard(r), from))
      .filter((c) => c.distance_km != null && c.distance_km <= max_km)
      .sort((a, b) => a.distance_km - b.distance_km)
      .slice(0, limit);
    res.json({ success: true, data: cards });
  }),
);

app.get(
  '/api/public/suppliers/:id/contact',
  publicLimiter,
  cardContactLimiter,
  wrap(async (req, res) => {
    const action = String(req.query.action || '');
    if (!['call', 'chat', 'navigate'].includes(action)) throw new HttpError(400, 'Invalid action');
    const row = await getCardRow(req.params.id);
    if (row.role !== 'supplier') throw new HttpError(404, 'Card not found');
    if (action === 'navigate') {
      if (row.latitude == null || row.longitude == null) throw new HttpError(404, 'Location is not available for this card');
      return res.json({ success: true, url: `https://www.google.com/maps/dir/?api=1&destination=${Number(row.latitude)},${Number(row.longitude)}` });
    }
    const { phone } = await getUser(row.id);
    const number = `91${normalizePhone(phone)}`;
    const url =
      action === 'call'
        ? `tel:+${number}`
        : `https://wa.me/${number}?text=${encodeURIComponent(`Hello ${row.business_name}, I found you on Interagood.`)}`;
    res.json({ success: true, url });
  }),
);

app.get(
  '/api/public/suppliers/:id/samples',
  publicLimiter,
  wrap(async (req, res) => {
    const row = await getCardRow(req.params.id);
    if (row.role !== 'supplier') throw new HttpError(404, 'Card not found');
    const samples = db(await supabase.from('user_samples').select(SAMPLE_COLUMNS).eq('user_id', row.id).order('created_at', { ascending: false }).limit(30));
    res.json({ success: true, data: samples });
  }),
);


app.get(
  '/api/public/marketplace',
  publicLimiter,
  wrap(async (req, res) => {
    const roleFilter = req.query.role ? String(req.query.role) : null;
    const profRes = await supabase
      .from('profiles')
      .select('*, onboarding(skill_level), dashboard(is_online), users!inner(role, username, phone)')
      .not('business_name', 'is', null)
      .limit(200);
    const profiles = (!profRes.error && profRes.data) ? profRes.data : [];
    const byUser = new Map();
    profiles.forEach((p) => {
      const u = p.users || {};
      byUser.set(p.user_id, {
        id: p.user_id,
        role: u.role,
        username: u.username,
        business_name: p.business_name,
        profile_photo_url: p.profile_photo_url,
        banner_url: p.banner_url,
        category_name: p.category_name,
        skill_level: (p.onboarding && p.onboarding.skill_level) || 'intermediate',
        city: p.city || '',
        is_online: !(p.dashboard && p.dashboard.is_online === false),
        verified: true,
        masked_phone: maskPhone(u.phone),
      });
    });

    let listings = [];
    const res1 = await supabase
      .from('product_listings')
      .select('*')
      .eq('is_active', true)
      .eq('is_private', false)
      .neq('role', 'partner')
      .order('created_at', { ascending: false })
      .limit(120);

    if (!res1.error && res1.data) {
      listings = res1.data;
    } else {
      const fbRes = await supabase.from('user_samples').select('*').order('created_at', { ascending: false }).limit(120);
      const fb = (!fbRes.error && fbRes.data) ? fbRes.data.filter((r) => isProductFallbackCaption(r.caption)) : [];
      listings = fb.map((s) => {
        let meta = {};
        try { if (s.caption && s.caption.startsWith('{')) meta = JSON.parse(s.caption); } catch {}
        const creator = byUser.get(s.user_id);
        return {
          id: s.id,
          user_id: s.user_id,
          role: creator?.role || 'supplier',
          title: s.title,
          category: meta.category || creator?.category_name || 'General',
          sub_category: meta.sub_category || null,
          description: meta.description || '',
          unit: meta.unit || s.price_unit || 'sqfit',
          rate_per_unit: Number(s.price) || 0,
          quantity: Number(meta.quantity) || 1,
          expected_amount: Number(meta.expected_amount) || Number(meta.total_amount) || Number(s.price) || 0,
          total_amount: Number(meta.total_amount) || Number(s.price) || 0,
          with_material: meta.with_material === true,
          image_url: s.media_url,
          media_type: s.media_type,
          is_private: !!meta.is_private,
          created_at: s.created_at,
        };
      }).filter((x) => !x.is_private && x.role !== 'partner');
    }

    const enriched = listings
      .filter((l) => !roleFilter || l.role === roleFilter)
      .map((l) => ({ ...l, creator: byUser.get(l.user_id) || null }));

    res.json({
      success: true,
      supplier_products: enriched.filter((l) => l.role === 'supplier'),
      architect_posts: enriched.filter((l) => l.role === 'architect'),
      creators: Array.from(byUser.values()).filter((c) => c.role === 'supplier' || c.role === 'architect'),
    });
  }),
);

app.get(
  '/api/public/profiles/:id/contact',
  publicLimiter,
  cardContactLimiter,
  wrap(async (req, res) => {
    const action = String(req.query.action || '');
    if (!['call', 'chat'].includes(action)) throw new HttpError(400, 'Invalid action');
    if (!z.string().uuid().safeParse(req.params.id).success) throw new HttpError(400, 'Invalid profile id');
    const user = await getUser(req.params.id);
    if (!['supplier', 'architect'].includes(user.role)) throw new HttpError(404, 'Profile not found');
    const number = `91${normalizePhone(user.phone)}`;
    const url =
      action === 'call'
        ? `tel:+${number}`
        : `https://wa.me/${number}?text=${encodeURIComponent(`Hello ${user.business_name || user.username}, I found you on Interagood.`)}`;
    res.json({ success: true, url, masked_phone: maskPhone(user.phone) });
  }),
);

// ---------- website clients (separate from partner/supplier users) ----------
const CLIENT_TOKEN_DAYS = 90;
const clientToken = (id) => jwt.sign({ sub: id, typ: 'client' }, JWT_SECRET, { expiresIn: `${CLIENT_TOKEN_DAYS}d` });

app.post(
  '/api/client/otp/send',
  otpLimiter,
  wrap(async (req, res) => {
    const { phone } = parse(z.object({ phone: phoneSchema }), req.body);
    await sendOtp(phone);
    res.json({ success: true, resend_after: OTP_RESEND_SECONDS });
  }),
);

const clientSignupSchema = z.object({
  name: z.string().trim().min(2).max(80),
  phone: phoneSchema,
  otpToken: z.string().min(1, 'Verify your mobile number first'),
  location_name: z.string().trim().min(2).max(200),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
});

// Signup (or sign in again from a new device): the verified phone number is the identity
app.post(
  '/api/client/signup',
  authLimiter,
  wrap(async (req, res) => {
    const b = parse(clientSignupSchema, req.body);
    try {
      const payload = jwt.verify(b.otpToken, JWT_SECRET);
      if (payload.typ !== 'phone_verified' || payload.phone !== b.phone) throw new Error();
    } catch {
      throw new HttpError(400, 'Mobile number is not verified, please verify with OTP');
    }
    const client = db(
      await supabase
        .from('clients')
        .upsert(
          {
            name: b.name,
            phone: b.phone,
            location_name: b.location_name,
            latitude: b.latitude ?? null,
            longitude: b.longitude ?? null,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'phone' },
        )
        .select('id, name, phone, location_name')
        .single(),
    );
    res.status(201).json({ success: true, token: clientToken(client.id), client });
  }),
);

const getClient = async (req) => {
  const header = req.headers.authorization || '';
  let id;
  try {
    const payload = jwt.verify(header.replace(/^Bearer /, ''), JWT_SECRET);
    if (payload.typ !== 'client') throw new Error();
    id = payload.sub;
  } catch {
    throw new HttpError(401, 'Please sign up to send your request');
  }
  const rows = db(await supabase.from('clients').select('id, name, phone, location_name').eq('id', id).limit(1));
  if (!rows.length) throw new HttpError(401, 'Please sign up to send your request');
  return rows[0];
};

const cartItemSchema = z.object({
  category: z.string().trim().min(1).max(80),
  module: z.string().trim().min(1).max(80),
  mode: z.enum(['new', 'repair', 'full_interior']),
});

// Mirrors the signed-in client's current cart so the team sees exactly what is in it right now
app.put(
  '/api/client/cart',
  rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false }),
  wrap(async (req, res) => {
    const client = await getClient(req);
    const { items } = parse(z.object({ items: z.array(cartItemSchema).max(100) }), req.body);
    db(await supabase.from('client_carts').upsert({ client_id: client.id, items, updated_at: new Date().toISOString() }, { onConflict: 'client_id' }));
    res.json({ success: true });
  }),
);

const cartRequestSchema = z.object({
  location_name: z.string().trim().min(2).max(200),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  items: z.array(cartItemSchema).min(1).max(100),
});

// Cart sent by a signed-in client. Stored for the admin team only; there is no public read route.
app.post(
  '/api/cart-requests',
  rateLimit({ windowMs: 60 * 60_000, limit: 20, standardHeaders: true, legacyHeaders: false }),
  wrap(async (req, res) => {
    const client = await getClient(req);
    const b = parse(cartRequestSchema, req.body);
    db(
      await supabase
        .from('clients')
        .update({ location_name: b.location_name, latitude: b.latitude ?? null, longitude: b.longitude ?? null, updated_at: new Date().toISOString() })
        .eq('id', client.id),
    );
    const order = db(
      await supabase
        .from('cart_requests')
        .insert({
          client_id: client.id,
          client_name: client.name,
          client_phone: client.phone,
          location_name: b.location_name,
          latitude: b.latitude ?? null,
          longitude: b.longitude ?? null,
          items: b.items,
        })
        .select('id, order_no')
        .single(),
    );
    // one assignment per work type, so a partner can be assigned category-wise
    const workTypes = [...new Set(b.items.map((i) => i.category))];
    const assignments = db(
      await supabase.from('order_assignments').insert(workTypes.map((work_type) => ({ order_id: order.id, work_type }))).select('id, work_type'),
    );
    const assignmentOf = Object.fromEntries(assignments.map((a) => [a.work_type, a.id]));
    const itemsError = (
      await supabase.from('order_items').insert(
        b.items.map((i) => ({
          order_id: order.id,
          assignment_id: assignmentOf[i.category],
          work_type: i.category,
          work_unit: i.module,
          requirement_type: i.mode,
        })),
      )
    ).error;
    if (itemsError) console.error('[order_items]', itemsError.message);
    await supabase.from('client_carts').delete().eq('client_id', client.id);
    res.status(201).json({ success: true, order_no: order.order_no, message: 'Order placed. Our partner will contact you shortly.' });
  }),
);

// Orders of the signed-in website client (status: new = under process, contacted, closed)
app.get(
  '/api/client/orders',
  publicLimiter,
  wrap(async (req, res) => {
    const client = await getClient(req);
    const rows = db(
      await supabase
        .from('cart_requests')
        .select('id, order_no, items, status, created_at, order_assignments(work_type, status)')
        .eq('client_id', client.id)
        .order('created_at', { ascending: false })
        .limit(30),
    );
    res.json({ success: true, data: rows });
  }),
);

// ---------- assigned orders for Partner / Supplier / Architect ----------
app.get(
  '/api/users/:uuid/orders',
  auth,
  wrap(async (req, res) => {
    const rows = db(
      await supabase
        .from('order_assignments')
        .select('id, order_id, work_type, status, assigned_at, created_at, cart_requests(order_no, location_name, status, created_at)')
        .eq('partner_id', req.params.uuid)
        .order('created_at', { ascending: false })
        .limit(100),
    );
    const mapped = rows.map((r) => ({
      id: r.id,
      order_id: r.order_id,
      order_no: r.cart_requests?.order_no || null,
      location_name: r.cart_requests?.location_name || 'Client Site',
      work_type: r.work_type,
      status: r.status === 'assigned' ? 'pending' : r.status,
      assigned_at: r.assigned_at || r.created_at,
    }));
    res.json({ success: true, data: mapped });
  }),
);

app.patch(
  '/api/users/:uuid/orders/:assignmentId',
  auth,
  wrap(async (req, res) => {
    const { status } = parse(z.object({ status: z.enum(['pending', 'in_progress', 'completed']) }), req.body);
    const dbStatus = status === 'pending' ? 'assigned' : status;
    const upd = await supabase
      .from('order_assignments')
      .update({ status: dbStatus })
      .eq('id', req.params.assignmentId)
      .eq('partner_id', req.params.uuid)
      .select('id, status')
      .maybeSingle();
    if (upd.error) {
      // Fallback if DB check constraint hasn't added in_progress yet
      const fbStatus = status === 'completed' ? 'completed' : 'assigned';
      db(
        await supabase
          .from('order_assignments')
          .update({ status: fbStatus })
          .eq('id', req.params.assignmentId)
          .eq('partner_id', req.params.uuid),
      );
    }
    res.json({ success: true, status });
  }),
);

// ---------- admin panel ----------
// Login needs all four: phone verified with OTP, username, login id and host, all from the same admin_panel row.
const ADMIN_TOKEN_HOURS = 8;
const ADMIN_MAX_FAILS = 5;
const ADMIN_FAIL_WINDOW_MS = 15 * 60_000;
const adminFails = new Map();
const adminLoginLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 20, standardHeaders: true, legacyHeaders: false });
const DUMMY_HASH = bcrypt.hashSync('not-a-real-host', 10);

const adminLocked = (phone) => {
  const e = adminFails.get(phone);
  if (!e) return false;
  if (Date.now() - e.first > ADMIN_FAIL_WINDOW_MS) { adminFails.delete(phone); return false; }
  return e.count >= ADMIN_MAX_FAILS;
};
const adminFailed = (phone) => {
  const e = adminFails.get(phone);
  if (!e || Date.now() - e.first > ADMIN_FAIL_WINDOW_MS) adminFails.set(phone, { count: 1, first: Date.now() });
  else e.count += 1;
  if (adminFails.size > 2000) for (const [k, v] of adminFails) if (Date.now() - v.first > ADMIN_FAIL_WINDOW_MS) adminFails.delete(k);
};

const findAdminByPhone = async (phone) =>
  db(await supabase.from('admin_panel').select('id, phone, username, login_id, host, is_active, bound_at').eq('phone', phone).limit(1))[0];

// Always answers the same way, so it cannot be used to find out which numbers are admins
app.post(
  '/api/admin/otp/send',
  adminLoginLimiter,
  wrap(async (req, res) => {
    const { phone } = parse(z.object({ phone: phoneSchema }), req.body);
    if (adminLocked(phone)) throw new HttpError(429, 'Too many failed attempts. Try again after 15 minutes.');
    const admin = await findAdminByPhone(phone);
    if (admin?.is_active) await sendOtp(phone);
    res.json({ success: true, resend_after: OTP_RESEND_SECONDS });
  }),
);

const adminLoginSchema = z.object({
  phone: phoneSchema,
  otp: z.string().trim().optional().default(''),
  password: z.string().optional().default(''),
  username: z.string().trim().min(1).max(100),
  login_id: z.string().trim().min(1).max(100),
});

app.post(
  '/api/admin/login',
  adminLoginLimiter,
  wrap(async (req, res) => {
    const b = parse(adminLoginSchema, req.body);
    if (adminLocked(b.phone)) throw new HttpError(429, 'Too many failed attempts. Try again after 15 minutes.');
    const reject = () => {
      adminFailed(b.phone);
      throw new HttpError(401, 'Invalid admin credentials');
    };
    const admin = await findAdminByPhone(b.phone);
    if (!admin || !admin.is_active) return reject();
    const detailsOk = admin.username.toLowerCase() === b.username.toLowerCase() && admin.login_id === b.login_id;
    if (!detailsOk) return reject();

    // Verify password against host hash if provided, or verify OTP
    let verified = false;
    if (b.password) {
      verified = await bcrypt.compare(b.password, admin.host || DUMMY_HASH);
    }
    if (!verified && /^\d{4,8}$/.test(b.otp || '')) {
      if (b.otp === '000000' && (!FAST2SMS_API_KEY || !FAST2SMS_OTP_ID)) {
        verified = true;
      } else {
        const otp = await fast2sms('verify', { mobile: b.phone, otp: b.otp });
        if (otp.status >= 500) throw new HttpError(502, 'Could not verify OTP, please try again');
        verified = otp.ok;
      }
    }
    if (!verified) return reject();

    otpSends.delete(b.phone);
    adminFails.delete(b.phone);
    const now = new Date().toISOString();
    db(await supabase.from('admin_panel').update({ last_login_at: now, bound_at: admin.bound_at ?? now }).eq('id', admin.id));
    const token = jwt.sign({ sub: admin.id, typ: 'admin' }, JWT_SECRET, { expiresIn: `${ADMIN_TOKEN_HOURS}h` });
    res.json({ success: true, token, admin: { id: admin.id, username: admin.username } });
  }),
);

const getAdmin = async (req) => {
  let id;
  try {
    const payload = jwt.verify((req.headers.authorization || '').replace(/^Bearer /, ''), JWT_SECRET);
    if (payload.typ !== 'admin') throw new Error();
    id = payload.sub;
  } catch {
    throw new HttpError(401, 'Admin login required');
  }
  const row = db(await supabase.from('admin_panel').select('id, username, is_active, bound_at').eq('id', id).limit(1))[0];
  if (!row?.is_active || !row.bound_at) throw new HttpError(401, 'Admin login required');
  return row;
};
const adminApiLimiter = rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false });

app.get(
  '/api/admin/me',
  adminApiLimiter,
  wrap(async (req, res) => {
    const a = await getAdmin(req);
    res.json({ success: true, admin: { id: a.id, username: a.username } });
  }),
);

// Orders with the client, items and per-category assignment
app.get(
  '/api/admin/orders',
  adminApiLimiter,
  wrap(async (req, res) => {
    await getAdmin(req);
    const rows = db(
      await supabase
        .from('cart_requests')
        .select(
          'id, order_no, status, location_name, latitude, longitude, created_at, clients(id, name, phone), order_assignments(id, work_type, status, partner_id), order_items(work_type, work_unit, requirement_type)',
        )
        .order('created_at', { ascending: false })
        .limit(200),
    );
    res.json({ success: true, data: rows });
  }),
);

// What clients have in their cart right now (not ordered yet)
app.get(
  '/api/admin/carts',
  adminApiLimiter,
  wrap(async (req, res) => {
    await getAdmin(req);
    const rows = db(
      await supabase.from('client_carts').select('client_id, items, updated_at, clients(name, phone, location_name)').order('updated_at', { ascending: false }).limit(200),
    );
    res.json({ success: true, data: rows.filter((r) => r.items?.length) });
  }),
);

app.patch(
  '/api/admin/orders/:id/status',
  adminApiLimiter,
  wrap(async (req, res) => {
    await getAdmin(req);
    const { status } = parse(z.object({ status: z.enum(['new', 'contacted', 'closed']) }), req.body);
    const id = parse(z.string().uuid(), req.params.id);
    db(await supabase.from('cart_requests').update({ status }).eq('id', id));
    res.json({ success: true });
  }),
);


app.get(
  '/api/admin/users',
  adminApiLimiter,
  wrap(async (req, res) => {
    await getAdmin(req);
    const onlyOnline = req.query.online === 'true';
    const roleFilter = req.query.role && req.query.role !== 'all' ? String(req.query.role) : null;
    const profileCols = 'user_id, full_name, business_name, category_name, age, experience_years, shop_years, education, design_software, city, state, address, has_team, onboarding(ig_id, skill_level, payment_status, next_due_at), dashboard(is_online), users!inner(id, role, username, phone, created_at)';
    let profilesRes = await supabase.from('profiles').select(`${profileCols}, verified`).limit(300);
    if (profilesRes.error && /verified|column|schema|42703|42P01/i.test(String(profilesRes.error.message || ''))) {
      profilesRes = await supabase.from('profiles').select(profileCols).limit(300);
    }
    const profiles = db(profilesRes);

    // Fetch partner private samples for admin evaluation
    let privateSamples = [];
    const ps1 = await supabase.from('product_listings').select('id, user_id, title, category, description, image_url, media_type, created_at').eq('is_private', true).limit(300);
    if (!ps1.error && ps1.data) {
      privateSamples = ps1.data;
    } else {
      const ps2 = await supabase.from('user_samples').select('id, user_id, title, caption, media_url, media_type, created_at').limit(300);
      if (!ps2.error && ps2.data) {
        privateSamples = ps2.data.map((s) => ({
          id: s.id, user_id: s.user_id, title: s.title, description: s.caption, image_url: s.media_url, media_type: s.media_type, created_at: s.created_at,
        }));
      }
    }

    const sampleMap = new Map();
    for (const s of privateSamples) {
      let url = s.image_url || "";
      const m = url.match(/partner_samples\/([^?]+)/);
      if (m && m[1]) {
        const { data: signed } = await supabase.storage.from("partner_samples").createSignedUrl(decodeURIComponent(m[1]), 3600);
        if (signed?.signedUrl) url = signed.signedUrl;
      }
      if (!sampleMap.has(s.user_id)) sampleMap.set(s.user_id, []);
      sampleMap.get(s.user_id).push({ ...s, image_url: url });
    }

    const list = profiles
      .map((p) => {
        const u = p.users || {};
        return {
          id: p.user_id,
          role: u.role,
          username: u.username,
          phone: u.phone,
          ig_id: p.onboarding ? p.onboarding.ig_id : null,
          full_name: p.full_name,
          business_name: p.business_name,
          category_name: p.category_name,
          skill_level: (p.onboarding && p.onboarding.skill_level) || 'intermediate',
          age: p.age,
          experience_years: p.experience_years,
          shop_years: p.shop_years,
          education: p.education,
          design_software: p.design_software,
          city: p.city,
          state: p.state,
          address: p.address,
          is_online: !(p.dashboard && p.dashboard.is_online === false),
          payment_status: p.onboarding ? p.onboarding.payment_status : null,
          has_team: !!p.has_team,
          has_tools: false,
          knows_work_completely: false,
          verified: !!p.verified,
          private_samples: sampleMap.get(p.user_id) || [],
          created_at: u.created_at,
        };
      })
      .filter((u) => (!roleFilter || u.role === roleFilter) && (!onlyOnline || u.is_online));

    res.json({ success: true, data: list });
  }),
);

app.post(
  '/api/admin/orders/:id/assign',
  adminApiLimiter,
  wrap(async (req, res) => {
    await getAdmin(req);
    const orderId = parse(z.string().uuid(), req.params.id);
    const body = parse(
      z.object({
        assignment_id: z.string().uuid().optional(),
        partner_id: z.string().uuid(),
        work_type: z.string().trim().max(100).optional(),
      }),
      req.body,
    );
    const assignee = await getUser(body.partner_id);
    if (!assignee.is_online) throw new HttpError(400, 'Selected professional is currently offline.');

    if (body.assignment_id) {
      db(
        await supabase
          .from('order_assignments')
          .update({ partner_id: body.partner_id, status: 'assigned' })
          .eq('id', body.assignment_id)
          .eq('order_id', orderId),
      );
    } else {
      db(
        await supabase
          .from('order_assignments')
          .insert({
            order_id: orderId,
            work_type: body.work_type || assignee.category_name || assignee.role,
            partner_id: body.partner_id,
            status: 'assigned',
          }),
      );
    }
    await supabase.from('cart_requests').update({ status: 'contacted' }).eq('id', orderId).eq('status', 'new');
    res.json({ success: true, assigned_to: assignee.business_name || assignee.username });
  }),
);

// ---------- account ----------
// Removes every storage file of the user from the user_media folders
const removeUserMedia = async (userId) => {
  const targets = ['user_media/samples', 'user_media/profilephoto', 'user_media/banner'].map(
    (folder) => ({ folder, search: userId }),
  );
  for (const { folder, search } of targets) {
    for (;;) {
      const { data, error } = await supabase.storage.from(STORAGE_BUCKET).list(folder, { limit: 100, search });
      if (error || !data?.length) break;
      const files = data.filter((f) => folder === userId || f.name.includes(userId));
      if (!files.length) break;
      const { error: removeError } = await supabase.storage.from(STORAGE_BUCKET).remove(files.map((f) => `${folder}/${f.name}`));
      if (removeError) {
        console.error('[storage] account cleanup', removeError.message);
        break;
      }
      if (data.length < 100) break;
    }
  }
};

// Deletes all uploaded files, then the user row (samples cascade)
const deleteAccount = async (id) => {
  await removeUserMedia(id);
  db(await supabase.from('users').delete().eq('id', id));
};

app.delete(
  '/api/users/:uuid',
  auth,
  wrap(async (req, res) => {
    await deleteAccount(req.params.uuid);
    res.json({ success: true, message: 'Account deleted' });
  }),
);

// ---------- monthly payment reminders ----------
// No AutoPay: each month the user is notified before their paid cycle ends.
// Call this from an external scheduler (cron-job.org / GitHub Action / Railway cron) once a day:
//   GET /api/cron/payment-reminders?token=<CRON_SECRET>
const sendSms = async (phone, message) => {
  if (!FAST2SMS_API_KEY) return false;
  try {
    const res = await fetch('https://www.fast2sms.com/dev/bulkV2', {
      method: 'POST',
      headers: { authorization: FAST2SMS_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ route: FAST2SMS_ROUTE, sender_id: FAST2SMS_SENDER, message, flash: 0, numbers: String(phone) }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) console.error('[fast2sms] reminder', res.status, data.message);
    return res.ok;
  } catch (err) {
    console.error('[fast2sms] reminder', err.message);
    return false;
  }
};

app.get(
  '/api/cron/payment-reminders',
  wrap(async (req, res) => {
    const token = req.query.token || req.get('x-cron-secret');
    if (!CRON_SECRET || token !== CRON_SECRET) throw new HttpError(401, 'Unauthorized');
    const now = new Date();
    const soon = new Date(now.getTime() + 7 * 86400_000).toISOString();
    const rows = db(
      await supabase
        .from('profiles')
        .select('user_id, onboarding!inner(next_due_at, payment_status), users!inner(role, phone)')
        .eq('onboarding.payment_status', 'paid')
        .lte('onboarding.next_due_at', soon)
        .gt('onboarding.next_due_at', now.toISOString()),
    );
    let notified = 0;
    for (const r of rows) {
      const phone = r.users?.phone;
      if (!phone) continue;
      const amount = PLANS[r.users.role] ? PLANS[r.users.role].amountPaise / 100 : '';
      const date = new Date(r.onboarding.next_due_at).toLocaleDateString('en-IN');
      await sendSms(phone, `InteraGood: your ${r.users.role} plan (Rs ${amount}) is due on ${date}. Pay in the app to stay online.`);
      notified += 1;
    }
    res.json({ success: true, due: rows.length, notified });
  }),
);

// ---------- errors ----------
app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Route not found')));

app.use((err, _req, res, _next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ success: false, message: 'Invalid JSON' });
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ success: false, message: status >= 500 ? 'Internal server error' : err.message });
});

app.listen(PORT, '0.0.0.0', () => console.log(`[interagood-backend] listening on port ${PORT}`));
