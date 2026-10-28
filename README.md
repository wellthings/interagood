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
Public: `GET check-availability`, `POST register`, `POST login`, `POST auth/refresh`, `GET categories/{partner|supplier}`, `GET age-options`, `GET media/onboarding-video`.
Bearer token required (token must belong to `:uuid`): `GET|DELETE users/:uuid`, `PATCH users/:uuid/{profile|business-profile|status}`, `POST users/:uuid/{onboarding|cancel-autopay|samples}`, `DELETE users/:uuid/samples/:sampleId`.
