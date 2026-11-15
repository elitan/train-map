# Train Map

Trains running on the real railway lines of any place, on a 3D map built in the browser from open data.

Search a town, and you get a 4 × 4 km block of terrain with aerial photos draped over it. The real
railway lines are laid on top as ballast, sleepers and rails that follow embankments and cross
bridges. Passenger and freight trains roll in from the edge of the map and pass through. Click a
train (or pick it from the list) to ride along.

The rail and train code comes from [Hometown](https://github.com/elitan/hometown), a 3D map of any place.

## Run it

```bash
bun install
bun run dev
```

Then open http://localhost:5190. Add `?q=Göteborg` (or any place, or `lat,lon`) to the URL to start somewhere else.

## Data

Everything is fetched straight from the browser; there is no server.

| What | Source |
|---|---|
| Place search | [Nominatim](https://nominatim.openstreetmap.org) (OpenStreetMap) |
| Railway lines | [Overpass API](https://overpass-api.de) (OpenStreetMap), several mirrors raced. The default place is saved in `public/default.json` (`bun scripts/snapshot.ts "Lund, Sweden"`) so the first view loads at once. |
| Elevation | [Terrarium tiles](https://registry.opendata.aws/terrain-tiles/) (AWS Open Data, Mapzen) |
| Aerial photos | Esri World Imagery |

## Code

```
src/main.ts     scene, camera, loading a place, following a train
src/data.ts     place search, railways, elevation and imagery
src/rail.ts     track geometry and trains (from Hometown)
src/bridges.ts  bridge decks for rail bridges (from Hometown)
src/graph.ts    track graph the trains drive on (from Hometown)
src/geo.ts      local projection and helpers (from Hometown)
```
