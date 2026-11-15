// Shown while the place and its railways load (the first visit to a place asks OpenStreetMap,
// which can take half a minute; after that it comes from the cache).
export default function Loading() {
  return <div className="panel pill status">Finding the place and its railways…</div>;
}
