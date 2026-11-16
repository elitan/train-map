CREATE TABLE osm_cache ( -- Answers from OpenStreetMap services (Nominatim, Overpass), so a place loads at once the second time.
    -- What was asked, e.g. "place:lund, sweden" or "railways:13.1458,55.6824,13.2282,55.7293".
    key        TEXT PRIMARY KEY NOT NULL,
    -- The answer, already in the shape the API returns.
    data       JSON NOT NULL,
    fetched_at TIMESTAMP NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f+00:00'))
);
