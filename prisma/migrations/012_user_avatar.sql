-- Profile photo URL, taken from the Google account picture at every Google sign-in so it stays
-- current. Null for accounts that never signed in with a provider that supplies one.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "avatar_url" TEXT;
