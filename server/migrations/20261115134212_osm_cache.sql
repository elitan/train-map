-- Answers from OpenStreetMap services (Nominatim, Overpass), kept so a place loads instantly
-- the second time and the public servers aren't asked again.
CREATE TABLE osm_cache (
    key        TEXT PRIMARY KEY,
    data       JSONB NOT NULL,
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE osm_cache IS 'Cached answers from OpenStreetMap services, by request.';
COMMENT ON COLUMN osm_cache.key IS 'What was asked, e.g. "place:lund, sweden" or "railways:13.1458,55.6824,13.2282,55.7293".';
COMMENT ON COLUMN osm_cache.data IS 'The answer, already in the shape the API returns.';
