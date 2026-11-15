// Any other error while a page renders or loads data. "Try again" refetches.
import type { ErrorProps } from "northstack";

export default function ErrorPage({ error, retry }: ErrorProps) {
  return (
    <div className="panel state">
      <h2>Something went wrong</h2>
      <p className="error">{error.message}</p>
      <div className="row">
        <button onClick={retry}>Try again</button>
        <a href="/">Back to Lund</a>
      </div>
    </div>
  );
}
