// Unknown URLs, notFound(), and NOT_FOUND errors from the API (e.g. a place search with no match).
import { useSearchParams } from "northstack";

export default function NotFound() {
  const q = useSearchParams().get("q");
  return (
    <div className="panel state">
      <title>Not found · Train Map</title>
      <h2>Not found</h2>
      <p className="muted">{q ? `Couldn't find “${q}”. Try adding a region or country.` : "This page doesn't exist."}</p>
      <a href="/">Back to Lund</a>
    </div>
  );
}
