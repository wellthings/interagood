-- 023 Storage: ensure user asset buckets are public and add RLS policies for
-- authenticated users to manage their own files (backend service-role uploads still work).
-- Buckets: media (profile photos + banners + samples), plus the role buckets.

-- Ensure the user media bucket is public (idempotent)
UPDATE storage.buckets SET public = true WHERE id = 'media';

-- Public read on the media bucket
DROP POLICY IF EXISTS "media public read" ON storage.objects;
CREATE POLICY "media public read" ON storage.objects
  FOR SELECT USING (bucket_id = 'media');

-- Authenticated users may insert / update / delete only their own files (owner = auth.uid())
DROP POLICY IF EXISTS "media auth insert own" ON storage.objects;
CREATE POLICY "media auth insert own" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'media' AND owner = auth.uid());

DROP POLICY IF EXISTS "media auth update own" ON storage.objects;
CREATE POLICY "media auth update own" ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'media' AND owner = auth.uid());

DROP POLICY IF EXISTS "media auth delete own" ON storage.objects;
CREATE POLICY "media auth delete own" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'media' AND owner = auth.uid());