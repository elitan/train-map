# Train Map

Trains running on the real railway lines of any place, on a 3D map.

Search a town, and you get a 4 × 4 km block of terrain with aerial photos draped over it. The real
railway lines from OpenStreetMap are laid on top as ballast, sleepers and rails that follow
embankments and cross bridges. Passenger and freight trains roll in from the edge of the map and
pass through. Click a train, or pick it from the list, to ride along.

Built on [northstack](https://github.com/elitan/northstack) (Rust + Postgres + React in one binary).
The rail and train code comes from [Hometown](https://github.com/elitan/hometown).

## Run it

You need Rust, Bun, `just` and Docker (or your own Postgres).

```bash
just dev
```

Then open http://localhost:5190. `?q=Göteborg` (or any place, or `lat, lon`) starts somewhere else.

## How it works

The server looks up the place (Nominatim) and its railway lines (Overpass, several mirrors raced),
and keeps every answer in Postgres (`osm_cache`). The first visit to a place waits on
OpenStreetMap, often 10–30 s; after that it loads at once. The browser loads elevation (Terrarium)
and aerial photo (Esri) tiles itself and builds the scene with three.js.

```
server/src/features/map/   map.place and map.railways, the OSM client, the cache
web/app/page.tsx           the page: search, train list, the map view
web/app/map/engine.ts      the 3D scene: terrain, railway, trains, following a train
web/app/map/rail.ts        track geometry and trains (from Hometown)
web/app/map/tiles.ts       elevation and aerial photo tiles
```

The framework guide is in [docs/northstack.md](docs/northstack.md); [AGENTS.md](AGENTS.md) has the
rules for coding agents.

## Running in production

`docker build -t train-map .` gives one small image; it needs `DATABASE_URL` (Postgres) and
should get `REQUEST_TIMEOUT_SECS=90`, since a first visit to a place can take longer than the
default 30 s. Migrations run on start.

## Data

Railways and places © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors.
Imagery © Esri, Maxar, Earthstar Geographics. Elevation: Mapzen Terrarium (AWS Open Data).
