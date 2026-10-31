# Interagood

Node.js (Express) REST API for Interagood with a Supabase PostgreSQL database.

## Database (Supabase)
Run the files in `supabase/migrations/` in order in the Supabase SQL Editor.

## Backend (local)
```bash
cp .env.example .env   # fill SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, JWT_SECRET, JWT_REFRESH_SECRET
npm install
npm run dev
```

## Deploy on Railway
1. Push this repo to GitHub.
2. Railway → New Project → Deploy from GitHub repo (root directory is the repo root).
3. Add variables: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `JWT_SECRET`, `JWT_REFRESH_SECRET` (optional: `CORS_ORIGIN`, `ONBOARDING_VIDEO_URL`).
4. Generate a public domain; health check is `/health`.

## API (all under `/api`)
Public: `GET check-availability`, `POST otp/send` (`{phone}`), `POST otp/verify` (`{phone, otp}` returns `otpToken`), `POST register` (`{role, phone, otpToken, termsAccepted: true, username, password}`; no email), `POST login`, `POST auth/refresh`, `GET categories/{partner|supplier}`, `GET age-options`, `GET media/onboarding-video` (redirects to Supabase Storage `media/onboarding/intro.mp4`, or `ONBOARDING_VIDEO_URL` if set).

Phone OTP: set `FAST2SMS_API_KEY` and `FAST2SMS_OTP_ID` (optional `OTP_TTL_MINUTES`, default 5) and run migrations `20261031_004_phone_otp.sql` and `20261031_005_drop_phone_otps.sql`. Fast2SMS generates, delivers (WhatsApp/SMS per your panel setup) and verifies the OTP via `/dev/otp/send|resend|verify`.
Bearer token required (token must belong to `:uuid`): `GET|DELETE users/:uuid`, `PATCH users/:uuid/{profile|business-profile|branding|status}`, `POST users/:uuid/{cancel-autopay|samples}`, `POST users/:uuid/upload?kind={profile|banner|toolbox|team|sample}` (raw image/video body, returns public URL), `DELETE users/:uuid/samples/:sampleId`.

Storage: the public bucket `media` (override with `STORAGE_BUCKET`) is created automatically on startup. Upload the onboarding video to `media/onboarding/intro.mp4`.

Supplier onboarding: video and terms are read from the private bucket `guid media` (`GUIDE_BUCKET`, `SUPPLIER_VIDEO_PATH`; terms file `instructions/Supplier/suppliert&c` is fixed in code and may be plain text or PDF) via `GET media/supplier-onboarding-video` and `GET content/supplier-terms`.

Partner/Supplier payment (Razorpay Subscriptions, partner Rs 109/month, supplier Rs 219/month, first charge at authorization; Razorpay Checkout shows the payment methods and sets up AutoPay on pay): set `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` (optional `RAZORPAY_PLAN_ID` for supplier and `RAZORPAY_PARTNER_PLAN_ID` for partner; otherwise the plans are found/created automatically). `POST users/:uuid/subscription` creates the subscription from the user's own phone/email, `POST users/:uuid/subscription/verify` checks the signature and activates the user. Point a Razorpay webhook to `POST /api/razorpay/webhook` with events `subscription.activated|charged|halted|cancelled|completed|paused`.
