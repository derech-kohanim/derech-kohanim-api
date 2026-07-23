-- Generated voice clips store their audio bytes and content type, so a real speech backend
-- can produce a clip once and every later request serves it (spec section 15.6).

ALTER TABLE "voice_clips" ADD COLUMN "audio" BYTEA;
ALTER TABLE "voice_clips" ADD COLUMN "content_type" TEXT;
