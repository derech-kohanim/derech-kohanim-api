-- Short-lived cache for Places (New) text-search results. Places content is cached more
-- conservatively than geocoding (see PLACES_CACHE_TTL_DAYS): the place_id is durable, the
-- rest is a performance cache refreshed within the permitted window.

CREATE TABLE "places_cache" (
  "query"      TEXT NOT NULL,
  "language"   TEXT NOT NULL,
  "results"    JSONB NOT NULL,
  "hits"       INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "places_cache_pkey" PRIMARY KEY ("query", "language")
);
