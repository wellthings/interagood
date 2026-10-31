import 'dotenv/config';
import crypto from 'node:crypto';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';

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
  ONBOARDING_VIDEO_URL,
  GUIDE_BUCKET = 'admin_uploads',
  SUPPLIER_VIDEO_PATH = 'instructions/Supplier/supplier.mp4',
  FAST2SMS_API_KEY,
  FAST2SMS_ROUTE = 'otp',
  FAST2SMS_WHATSAPP_MESSAGE_ID,
  FAST2SMS_WHATSAPP_PHONE_NUMBER_ID,
  OTP_TTL_MINUTES = 5,
  RAZORPAY_KEY_ID,
  RAZORPAY_KEY_SECRET,
  RAZORPAY_WEBHOOK_SECRET,
  RAZORPAY_PLAN_ID,
  RAZORPAY_PARTNER_PLAN_ID,
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

// Public bucket holding all user uploads and the onboarding video (onboarding/intro.mp4)
const publicUrl = (path, bucket = STORAGE_BUCKET) => supabase.storage.from(bucket).getPublicUrl(path).data.publicUrl;
supabase.storage
  .createBucket(STORAGE_BUCKET, { public: true })
  .then(({ error }) => error && !/already exists/i.test(error.message) && console.error('[storage]', error.message));

const UPLOAD_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'video/mp4': 'mp4', 'video/quicktime': 'mov' };
const UPLOAD_KINDS = ['profile', 'banner', 'toolbox', 'team', 'sample'];

const ACCESS_TTL = JWT_ACCESS_EXPIRES_IN;
const REFRESH_TTL = JWT_REFRESH_EXPIRES_IN;
const DAILY_LIMITS = { total: 6, image: 3, video: 3 };
const AUTOPAY_CANCEL_WARNING =
  'agar aap autopay cancel karte hain to aap interagood partner nahi rahenge na app intergood ue kar paayenge na aapko koi lead milegi';

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
app.use(express.raw({ type: Object.keys(UPLOAD_TYPES), limit: '50mb' }));
app.use('/api', rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: true, legacyHeaders: false }));
const authLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 30, standardHeaders: true, legacyHeaders: false });

// ---------- helpers ----------
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

const getUser = async (id) => {
  const user = db(await supabase.from('users').select('*').eq('id', id).maybeSingle());
  if (!user) throw new HttpError(404, 'User not found');
  return user;
};

const updateUser = async (id, updates) => {
  const rows = db(
    await supabase.from('users').update({ ...updates, updated_at: new Date().toISOString() }).eq('id', id).select('id'),
  );
  if (!rows.length) throw new HttpError(404, 'User not found');
};

// ---------- razorpay ----------
const PLANS = {
  supplier: { key: 'interagood_supplier_219', name: 'InteraGood Supplier Program', amountPaise: 21900, totalCount: 120, leadsStatus: 'deals_activated' },
  partner: { key: 'interagood_partner_109', name: 'InteraGood Partner Program', amountPaise: 10900, totalCount: 120, leadsStatus: 'leads_activated' },
};
const cachedPlanIds = { supplier: RAZORPAY_PLAN_ID || null, partner: RAZORPAY_PARTNER_PLAN_ID || null };

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

// Monthly plan per role: uses the env plan id if set, otherwise finds or creates it once
const getPlanId = async (role) => {
  if (cachedPlanIds[role]) return cachedPlanIds[role];
  const spec = PLANS[role];
  const list = await rzp('GET', '/plans?count=100');
  const existing = list.items?.find((p) => p.notes?.key === spec.key && p.item?.amount === spec.amountPaise);
  const plan =
    existing ||
    (await rzp('POST', '/plans', {
      period: 'monthly',
      interval: 1,
      item: {
        name: spec.name,
        description: `Official ${role} subscription for InteraGood platform`,
        amount: spec.amountPaise,
        currency: 'INR',
      },
      notes: { key: spec.key },
    }));
  cachedPlanIds[role] = plan.id;
  return plan.id;
};

const safeEqualHex = (a, b) => {
  const x = Buffer.from(String(a || ''), 'utf8');
  const y = Buffer.from(String(b || ''), 'utf8');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

const hmacHex = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest('hex');

const activateSubscriber = async (id, subscriptionId) => {
  const user = await getUser(id);
  const plan = PLANS[user.role];
  if (!plan) throw new HttpError(403, 'No plan for this role');
  await updateUser(id, {
    terms_accepted: true,
    is_autopay_active: true,
    autopay_mandate_id: subscriptionId,
    leads_status: plan.leadsStatus,
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

    let query = supabase.from('users').select('id').limit(1);
    query = field === 'phone' ? query.eq('phone', value) : query.ilike(field, escapeLike(value));
    const rows = db(await query);
    res.json({ field, value, available: rows.length === 0 });
  }),
);

// ---------- phone OTP (Fast2SMS) ----------
const OTP_RESEND_SECONDS = 30;
const OTP_MAX_SENDS_PER_HOUR = 5;
const OTP_MAX_ATTEMPTS = 5;
const otpLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 20, standardHeaders: true, legacyHeaders: false });

const phoneSchema = z
  .string()
  .transform(normalizePhone)
  .pipe(z.string().regex(/^[6-9]\d{9}$/, 'Enter a valid 10 digit mobile number'));

const otpHash = (phone, otp) => hmacHex(JWT_SECRET, `otp:${phone}:${otp}`);

// Sends the OTP on WhatsApp via an approved Fast2SMS template when message/phone ids are set, otherwise via the SMS "otp" route
const sendOtpSms = async (phone, otp) => {
  if (!FAST2SMS_API_KEY) throw new HttpError(503, 'OTP service is not configured');
  const useWhatsapp = FAST2SMS_WHATSAPP_MESSAGE_ID && FAST2SMS_WHATSAPP_PHONE_NUMBER_ID;
  const res = useWhatsapp
    ? await fetch(
        `https://www.fast2sms.com/dev/whatsapp?${new URLSearchParams({
          message_id: FAST2SMS_WHATSAPP_MESSAGE_ID,
          phone_number_id: FAST2SMS_WHATSAPP_PHONE_NUMBER_ID,
          numbers: phone,
          variables_values: otp,
        })}`,
        { headers: { authorization: FAST2SMS_API_KEY } },
      )
    : await fetch('https://www.fast2sms.com/dev/bulkV2', {
        method: 'POST',
        headers: { authorization: FAST2SMS_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ route: FAST2SMS_ROUTE, variables_values: otp, numbers: phone }),
      });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.return === false || data.status === false) {
    console.error('[fast2sms]', useWhatsapp ? 'whatsapp' : 'sms', res.status, data.message);
    throw new HttpError(502, 'Could not send OTP, please try again');
  }
};

app.post(
  '/api/otp/send',
  otpLimiter,
  wrap(async (req, res) => {
    const { phone } = parse(z.object({ phone: phoneSchema }), req.body);
    if (db(await supabase.from('users').select('id').eq('phone', phone).limit(1)).length) {
      throw new HttpError(409, 'Phone already registered');
    }

    const now = Date.now();
    const prev = db(await supabase.from('phone_otps').select('*').eq('phone', phone).maybeSingle());
    let sendCount = 1;
    let windowStart = new Date(now).toISOString();
    if (prev) {
      const wait = OTP_RESEND_SECONDS - (now - new Date(prev.last_sent_at).getTime()) / 1000;
      if (wait > 0) throw new HttpError(429, `Please wait ${Math.ceil(wait)}s before requesting another OTP`);
      if (now - new Date(prev.window_start).getTime() < 3600_000) {
        if (prev.send_count >= OTP_MAX_SENDS_PER_HOUR) throw new HttpError(429, 'Too many OTP requests, try again after some time');
        sendCount = prev.send_count + 1;
        windowStart = prev.window_start;
      }
    }

    const otp = String(crypto.randomInt(100000, 1000000));
    db(
      await supabase.from('phone_otps').upsert({
        phone,
        otp_hash: otpHash(phone, otp),
        expires_at: new Date(now + Number(OTP_TTL_MINUTES) * 60_000).toISOString(),
        attempts: 0,
        send_count: sendCount,
        window_start: windowStart,
        last_sent_at: new Date(now).toISOString(),
      }),
    );
    await sendOtpSms(phone, otp);
    res.json({ success: true, resend_after: OTP_RESEND_SECONDS });
  }),
);

app.post(
  '/api/otp/verify',
  otpLimiter,
  wrap(async (req, res) => {
    const { phone, otp } = parse(z.object({ phone: phoneSchema, otp: z.string().trim().regex(/^\d{6}$/, 'OTP must be 6 digits') }), req.body);
    const row = db(await supabase.from('phone_otps').select('*').eq('phone', phone).maybeSingle());
    if (!row || new Date(row.expires_at) < new Date()) throw new HttpError(400, 'OTP expired, please request a new one');
    if (row.attempts >= OTP_MAX_ATTEMPTS) throw new HttpError(429, 'Too many wrong attempts, request a new OTP');
    if (!safeEqualHex(otpHash(phone, otp), row.otp_hash)) {
      db(await supabase.from('phone_otps').update({ attempts: row.attempts + 1 }).eq('phone', phone));
      throw new HttpError(400, 'Incorrect OTP');
    }
    db(await supabase.from('phone_otps').delete().eq('phone', phone));
    const otpToken = jwt.sign({ phone, typ: 'phone_verified' }, JWT_SECRET, { expiresIn: '15m' });
    res.json({ success: true, otpToken });
  }),
);

const registerSchema = z.object({
  role: z.enum(['partner', 'supplier']),
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
    try {
      const payload = jwt.verify(body.otpToken, JWT_SECRET);
      if (payload.typ !== 'phone_verified' || payload.phone !== body.phone) throw new Error();
    } catch {
      throw new HttpError(400, 'Mobile number is not verified, please verify with OTP');
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
          terms_accepted: true,
          is_online: true,
        })
        .select('id, role')
        .single(),
    );
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
    const user = db(await supabase.from('users').select('*').ilike(column, escapeLike(value)).maybeSingle());
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      throw new HttpError(401, 'Invalid credentials');
    }
    res.json({ success: true, uuid: user.id, role: user.role, username: user.username, ...signTokens(user) });
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

app.get(
  '/api/age-options',
  wrap(async (_req, res) => {
    const rows = db(await supabase.from('master_ages').select('age_value').order('age_value'));
    res.json({ success: true, data: rows.map((r) => r.age_value) });
  }),
);

app.get('/api/media/onboarding-video', (_req, res) =>
  res.redirect(302, ONBOARDING_VIDEO_URL || publicUrl('onboarding/intro.mp4')),
);

// Supplier onboarding content from the private guide bucket
app.get(
  '/api/media/supplier-onboarding-video',
  wrap(async (_req, res) => {
    const { data, error } = await supabase.storage.from(GUIDE_BUCKET).createSignedUrl(SUPPLIER_VIDEO_PATH, 3600);
    if (error) {
      console.error('[guide-video]', error.message);
      throw new HttpError(404, 'Supplier onboarding video not found');
    }
    res.redirect(302, data.signedUrl);
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

// Storage paths are case-sensitive and the file extension may be omitted, so try the likely variants
const SUPPLIER_TERMS_PATH = 'instructions/Supplier/suppliert&c';
const termsPathCandidates = () => {
  const base = SUPPLIER_TERMS_PATH;
  const swapped = base.replace(/\/(supplier)\//i, (m, s) => (s === 'supplier' ? '/Supplier/' : '/supplier/'));
  return [...new Set([base, `${base}.pdf`, swapped, `${swapped}.pdf`])].filter((p) => !/\.pdf\.pdf$/i.test(p));
};

app.get(
  '/api/content/supplier-terms',
  wrap(async (_req, res) => {
    let file;
    for (const path of termsPathCandidates()) {
      const { data } = await supabase.storage.from(GUIDE_BUCKET).download(path);
      if (data) {
        file = data;
        break;
      }
    }
    if (!file) {
      console.error('[guide-terms] not found, tried:', termsPathCandidates().join(', '));
      throw new HttpError(404, 'Supplier terms not found');
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
  has_toolbox: optBool,
  toolbox_image_url: optUrl,
  has_team: optBool,
  team_members_count: z.coerce.number().int().min(0).nullish(),
  team_image_url: optUrl,
  knows_work_completely: optBool,
  knows_measurement_system: optBool,
  can_deal_with_customers: optBool,
  can_manage_quotation_workflow: optBool,
  knows_pricing: optBool,
});

const PARTNER_ONLY_FIELDS = [
  'age', 'experience_years', 'has_toolbox', 'toolbox_image_url', 'has_team', 'team_members_count',
  'team_image_url', 'knows_work_completely', 'knows_measurement_system', 'can_deal_with_customers',
  'can_manage_quotation_workflow', 'knows_pricing',
];

app.patch(
  '/api/users/:uuid/business-profile',
  auth,
  wrap(async (req, res) => {
    const updates = parse(businessSchema, req.body);
    for (const key of ['profile_photo_url', 'banner_url', 'toolbox_image_url', 'team_image_url']) {
      if (updates[key] === '') updates[key] = null;
    }
    // Role comes from the token, never from the request body
    if (req.auth.role === 'supplier') {
      for (const key of PARTNER_ONLY_FIELDS) updates[key] = null;
    } else {
      if (!updates.age || !updates.experience_years) throw new HttpError(400, 'Age and experience are required');
      if (updates.has_toolbox && !updates.toolbox_image_url) throw new HttpError(400, 'Toolbox image is required');
      if (updates.has_team && (!updates.team_image_url || !(updates.team_members_count > 0))) {
        throw new HttpError(400, 'Team image and member count are required');
      }
      if (!updates.has_toolbox) updates.toolbox_image_url = null;
      if (!updates.has_team) Object.assign(updates, { team_image_url: null, team_members_count: null });
    }
    await updateUser(req.params.uuid, updates);
    res.json({ success: true, message: 'Business profile saved' });
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

// Creates the monthly AutoPay subscription for the user's role (partner Rs 109, supplier Rs 219); the first charge happens at authorization.
// Contact and email come from the user's row, never from the client.
app.post(
  '/api/users/:uuid/subscription',
  auth,
  wrap(async (req, res) => {
    const user = await getUser(req.params.uuid);
    const plan = PLANS[user.role];
    if (!plan) throw new HttpError(403, 'No plan available for this role');
    if (user.is_autopay_active) throw new HttpError(409, 'AutoPay is already active');

    const subscription = await rzp('POST', '/subscriptions', {
      plan_id: await getPlanId(user.role),
      total_count: plan.totalCount,
      quantity: 1,
      customer_notify: 1,
      notes: { user_id: user.id },
    });

    res.json({
      success: true,
      key_id: RAZORPAY_KEY_ID,
      subscription_id: subscription.id,
      amount: plan.amountPaise / 100,
      name: user.full_name || user.business_name || user.username,
      contact: `+91${normalizePhone(user.phone)}`,
      email: user.email,
    });
  }),
);

const verifySubscriptionSchema = z.object({
  razorpay_payment_id: z.string().min(1),
  razorpay_subscription_id: z.string().min(1),
  razorpay_signature: z.string().min(1),
});

app.post(
  '/api/users/:uuid/subscription/verify',
  auth,
  wrap(async (req, res) => {
    const body = parse(verifySubscriptionSchema, req.body);
    if (!RAZORPAY_KEY_SECRET) throw new HttpError(503, 'Payments are not configured');

    const expected = hmacHex(RAZORPAY_KEY_SECRET, `${body.razorpay_payment_id}|${body.razorpay_subscription_id}`);
    if (!safeEqualHex(expected, body.razorpay_signature)) throw new HttpError(400, 'Payment verification failed');

    const subscription = await rzp('GET', `/subscriptions/${encodeURIComponent(body.razorpay_subscription_id)}`);
    if (subscription.notes?.user_id !== req.params.uuid) throw new HttpError(403, 'Subscription does not belong to this user');
    if (!['authenticated', 'active'].includes(subscription.status)) throw new HttpError(400, `Subscription is ${subscription.status}`);

    await activateSubscriber(req.params.uuid, subscription.id);
    res.json({ success: true, message: 'AutoPay activated', subscription_id: subscription.id });
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

    const subscription = req.body?.payload?.subscription?.entity;
    const userId = subscription?.notes?.user_id;
    if (userId && z.string().uuid().safeParse(userId).success) {
      const event = req.body.event;
      if (['subscription.activated', 'subscription.charged'].includes(event)) {
        await activateSubscriber(userId, subscription.id);
      } else if (['subscription.halted', 'subscription.cancelled', 'subscription.completed', 'subscription.paused'].includes(event)) {
        await updateUser(userId, { is_autopay_active: false, leads_status: 'inactive' });
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
    const samples = db(
      await supabase
        .from('user_samples')
        .select('id, media_type, title, media_url, thumbnail_url, created_at')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false }),
    );
    res.json({ success: true, data: { ...sanitizeUser(user), samples } });
  }),
);

app.patch(
  '/api/users/:uuid/status',
  auth,
  wrap(async (req, res) => {
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
    const ext = UPLOAD_TYPES[req.headers['content-type']?.split(';')[0]];
    if (!UPLOAD_KINDS.includes(kind)) throw new HttpError(400, 'Invalid kind');
    if (!ext || !Buffer.isBuffer(req.body) || !req.body.length) throw new HttpError(400, 'Unsupported or empty file');
    if ((ext === 'mp4' || ext === 'mov') && kind !== 'sample') throw new HttpError(400, 'Videos allowed only for samples');
    const permanentFolder = { profile: 'profile_photo', banner: 'banner' }[kind];
    const path = permanentFolder
      ? `user_media/media/${permanentFolder}/${req.params.uuid}-${Date.now()}.${ext}`
      : `${req.params.uuid}/${kind}-${Date.now()}.${ext}`;
    const { error } = await supabase.storage
      .from(STORAGE_BUCKET)
      .upload(path, req.body, { contentType: req.headers['content-type'].split(';')[0] });
    if (error) {
      console.error('[storage]', error.message);
      throw new HttpError(500, 'Upload failed');
    }
    res.status(201).json({ success: true, url: publicUrl(path) });
  }),
);

// ---------- samples (daily quota: 6 total, 3 images, 3 videos) ----------
const sampleSchema = z.object({
  media_type: z.enum(['image', 'video']),
  title: z.string().trim().max(120).optional(),
  media_url: z.string().url(),
  thumbnail_url: z.string().url().nullish(),
});

app.post(
  '/api/users/:uuid/samples',
  auth,
  wrap(async (req, res) => {
    const body = parse(sampleSchema, req.body);
    const today = db(
      await supabase
        .from('user_samples')
        .select('media_type')
        .eq('user_id', req.params.uuid)
        .gte('created_at', startOfTodayIST()),
    );
    if (today.length >= DAILY_LIMITS.total) {
      throw new HttpError(429, `Daily limit of ${DAILY_LIMITS.total} uploads reached for today.`);
    }
    const sameType = today.filter((s) => s.media_type === body.media_type).length;
    if (sameType >= DAILY_LIMITS[body.media_type]) {
      throw new HttpError(429, `Daily maximum of ${DAILY_LIMITS[body.media_type]} ${body.media_type}s reached.`);
    }
    const sample = db(
      await supabase
        .from('user_samples')
        .insert({
          user_id: req.params.uuid,
          media_type: body.media_type,
          title: body.title || 'Showcase Work',
          media_url: body.media_url,
          thumbnail_url: body.thumbnail_url ?? null,
        })
        .select('id, media_type, title, media_url, thumbnail_url, created_at')
        .single(),
    );
    res.status(201).json({ success: true, data: sample });
  }),
);

app.delete(
  '/api/users/:uuid/samples/:sampleId',
  auth,
  wrap(async (req, res) => {
    if (!z.string().uuid().safeParse(req.params.sampleId).success) throw new HttpError(400, 'Invalid sample id');
    db(await supabase.from('user_samples').delete().eq('id', req.params.sampleId).eq('user_id', req.params.uuid));
    res.json({ success: true, message: 'Sample deleted' });
  }),
);

// ---------- account ----------
app.post(
  '/api/users/:uuid/cancel-autopay',
  auth,
  wrap(async (req, res) => {
    const user = await getUser(req.params.uuid);
    if (user.autopay_mandate_id?.startsWith('sub_')) {
      await rzp('POST', `/subscriptions/${user.autopay_mandate_id}/cancel`, { cancel_at_cycle_end: 0 });
    }
    await updateUser(req.params.uuid, { is_autopay_active: false, leads_status: 'cancelled' });
    res.json({ success: true, warning: AUTOPAY_CANCEL_WARNING });
  }),
);

app.delete(
  '/api/users/:uuid',
  auth,
  wrap(async (req, res) => {
    db(await supabase.from('users').delete().eq('id', req.params.uuid));
    res.json({ success: true, message: 'Account deleted' });
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
