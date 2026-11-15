// "/": the train map. `?q=` is the place (a name or "lat, lon"), so a view can be shared.
import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, navigate, type PageProps, type Place, type RailLine } from "northstack";
import { railwayArea, TrainMap, type MapState } from "./map/engine";

const DEFAULT_PLACE = "Lund, Sweden";

export default function Home({ searchParams }: PageProps) {
  const q = searchParams.q?.trim() || DEFAULT_PLACE;
  const place = api.map.place.useQuery({ q });
  const rails = api.map.railways.useQuery(railwayArea(place.lat, place.lon));
  return (
    <>
      <title>{`${place.name} · Train Map`}</title>
      <MapView place={place} rails={rails} />
      <Search q={q} name={place.name} />
    </>
  );
}

function Search({ q, name }: { q: string; name: string }) {
  const [text, setText] = useState(q);
  useEffect(() => setText(q), [q]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (text.trim()) navigate("?q=" + encodeURIComponent(text.trim()));
  };
  return (
    <header className="panel top">
      <form onSubmit={submit}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Search a place…" aria-label="Place" />
      </form>
      <div className="muted place">{name}</div>
    </header>
  );
}

function MapView({ place, rails }: { place: Place; rails: RailLine[] }) {
  const el = useRef<HTMLDivElement>(null);
  const [map, setMap] = useState<TrainMap | null>(null);
  const [state, setState] = useState<MapState | null>(null);

  // one renderer for the life of the page; new places reuse it
  useEffect(() => {
    const m = new TrainMap(el.current!);
    const off = m.subscribe(setState);
    setMap(m);
    return () => { off(); m.dispose(); };
  }, []);
  useEffect(() => { map?.show(place.lat, place.lon, rails); }, [map, place, rails]);

  return (
    <>
      <div ref={el} className="view" />
      {state && (
        <>
          <aside className="panel side">
            <h2>On the map</h2>
            {state.trains.map((t) => (
              <button
                key={t.id}
                className={"train" + (t.id === state.following ? " on" : "")}
                onClick={() => map?.follow(t.id === state.following ? null : t.id)}
              >
                <span className={"dot" + (t.freight ? " freight" : "")} />
                {t.name}
                <small>{t.cars} cars</small>
              </button>
            ))}
            {!state.trains.length && !state.status && rails.length > 0 && <p className="muted">Next train is on its way…</p>}
            <p className="hint">Click a train to ride along. Drag to orbit, scroll to zoom.</p>
          </aside>
          {state.following !== null && state.speed !== null && (
            <div className="panel pill speed">
              {state.trains.find((t) => t.id === state.following)?.name} · {state.speed} km/h
            </div>
          )}
          {state.status && <div className="panel pill status">{state.status}</div>}
        </>
      )}
    </>
  );
}
