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
3. Add variables: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `JWT_SECRET`, `JWT_REFRESH_SECRET` (optional: `CORS_ORIGIN`).
4. Generate a public domain; health check is `/health`.

## API (all under `/api`)
Public: `GET check-availability`, `POST otp/send` (`{phone}`), `POST otp/verify` (`{phone, otp}` returns `otpToken`), `POST register` (`{role, phone, otpToken, termsAccepted: true, username, password}`; no email), `POST login`, `POST auth/refresh`, `GET categories/{partner|supplier}`, `GET age-options`.

Phone OTP: set `FAST2SMS_API_KEY` and `FAST2SMS_OTP_ID` (optional `OTP_TTL_MINUTES`, default 5) and run migrations `20261031_004_phone_otp.sql` and `20261031_005_drop_phone_otps.sql`. Fast2SMS generates, delivers (WhatsApp/SMS per your panel setup) and verifies the OTP via `/dev/otp/send|resend|verify`.
Bearer token required (token must belong to `:uuid`): `GET|DELETE users/:uuid`, `PATCH users/:uuid/{profile|business-profile|branding}`, `PATCH users/:uuid/status` and `POST users/:uuid/samples` (these two and `upload?kind=sample` need an active subscription, otherwise `402`), `POST users/:uuid/{cancel-autopay}`, `POST users/:uuid/upload?kind={profile|banner|sample}` (raw image/video body, returns public URL), `DELETE users/:uuid/samples/:sampleId`, `PUT users/:uuid/samples/:sampleId/vote` (`{vote: 1|-1|0}` like / dislike / clear, returns `{likes, dislikes, my_vote}`; `GET users/:uuid` samples include `likes`, `dislikes`, `my_vote`; needs migration `20261031_009_sample_votes.sql`).

Storage: two buckets.
- `media` (public, `STORAGE_BUCKET`): user uploads via `POST users/:uuid/upload?kind=...` saved as `<folder>/<uuid>-<timestamp>.<ext>`: `profile` -> `user_media/profilephoto`, `banner` -> `user_media/banner`, `sample` -> `user_media/samples`.
- `admin_uploads` (private, `GUIDE_BUCKET`, admin-managed): under `instructions/`.

Onboarding video: `GET media/onboarding-video/:role` (`partner|supplier`) redirects to a signed URL of `instructions/<Partner|Supplier>/<role>.mp4`.

Admin documents (plain text or PDF): `GET content/:role/:doc` serves `instructions/common/terms&conditions` for `common/terms` (create-account terms), and `instructions/<Partner|Supplier>/<role><doc>` for role `partner|supplier` and doc `terms|policy|support` (e.g. `partnerterms`, `partnerpolicy`, `partnersupport`).

Partner profile: the partner questions are plain toggles (`has_tools` = has tools to work with, `has_team` + `team_members_count` = works with a team); there are no toolbox/team photos. Run migration `20261101_010_remove_images_business_card.sql` (drops `toolbox_image_url` / `team_image_url`, renames `has_toolbox` to `has_tools`).

Business cards (for the client app, any valid access token): `GET cards` (`role`, `category_id`, `q`, `lat`, `lng`, `limit`, `offset`; nearest first when `lat`/`lng` are sent), `GET cards/:id`, `GET cards/:id/samples` and `GET cards/:id/contact?action=call|chat|navigate`. Card JSON holds `business_name`, `username`, `profile_photo_url`, `banner_url`, `category_name`, `is_online`, `role`, `verified` and `distance_km` but never the phone number or coordinates; `contact` returns only the `tel:`, WhatsApp or Google Maps link for the tapped button. Only subscribed users with a business profile are listed.

Account: `POST users/:uuid/cancel-autopay` and `DELETE users/:uuid` both cancel the Razorpay subscription immediately, delete the user's files from the `media` bucket and delete the user row (samples cascade). Run migrations `20261031_006_sample_price.sql` (sample price tag: `price`, `price_unit`) and `20261031_007_sample_caption.sql` (sample `caption`; the sample name is `title`), then `20261031_008_fix_sample_columns.sql` (forces `caption` to varchar and `price` to numeric if the table already had those columns with other types).

Partner/Supplier payment (Razorpay Subscriptions, partner Rs 109/month, supplier Rs 219/month, first charge at authorization; Razorpay Checkout shows the payment methods and sets up AutoPay on pay): set `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` (optional `RAZORPAY_PLAN_ID` for supplier and `RAZORPAY_PARTNER_PLAN_ID` for partner; otherwise the plans are found/created automatically). `POST users/:uuid/subscription` creates the subscription from the user's own phone/email, `POST users/:uuid/subscription/verify` checks the signature and activates the user. Point a Razorpay webhook to `POST /api/razorpay/webhook` with events `subscription.activated|charged|halted|cancelled|completed|paused`.
