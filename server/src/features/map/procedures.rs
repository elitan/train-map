//! RPC handlers for map.

use northstack::{Ctx, ErrorCode, RpcError, RpcResult};

use super::types::*;
use super::{db, osm};
use crate::AppState;

/// Largest area we load railways for, in degrees (about 10 × 10 km in Scandinavia).
const MAX_SPAN: f64 = 0.2;

/// Find a place by name (Nominatim) or parse coordinates.
pub async fn place(ctx: Ctx<AppState>, input: PlaceInput) -> RpcResult<Place> {
    let q = input.q.trim();
    northstack::ensure!(!q.is_empty(), "search for a place");
    if let Some(p) = parse_coords(q) {
        return Ok(p);
    }
    let key = format!("place:{}", q.to_lowercase());
    if let Some(p) = db::cached(&ctx.state.db, &key).await? {
        return Ok(p);
    }
    let found = osm::geocode(&ctx.state.http, q)
        .await
        .map_err(|e| RpcError::internal(format!("place search failed: {e:#}")))?;
    let p = found.ok_or_else(|| {
        RpcError::not_found(format!(
            "Couldn't find “{q}”. Try adding a region or country."
        ))
    })?;
    db::store(&ctx.state.db, &key, &p).await?;
    Ok(p)
}

/// Railway lines in an area (Overpass), cached per area.
pub async fn railways(ctx: Ctx<AppState>, input: RailwaysInput) -> RpcResult<Vec<RailLine>> {
    let RailwaysInput { s, w, n, e } = input;
    northstack::ensure!(
        (-90.0..=90.0).contains(&s) && (-90.0..=90.0).contains(&n) && s < n && w < e,
        "invalid area"
    );
    northstack::ensure!(n - s <= MAX_SPAN && e - w <= MAX_SPAN, "area too large");
    let key = railways_key(&input);
    if let Some(lines) = db::cached(&ctx.state.db, &key).await? {
        return Ok(lines);
    }
    // Fetch and cache in a task of its own: if the request is cut off (timeout, closed tab),
    // the answer still lands in the cache and the next visit gets it at once.
    let (http, pool) = (ctx.state.http.clone(), ctx.state.db.clone());
    let fetch = tokio::spawn(async move {
        let lines = osm::railways(&http, &input).await?;
        db::store(&pool, &key, &lines).await?;
        anyhow::Ok(lines)
    });
    let lines = fetch.await.map_err(RpcError::internal)?.map_err(|e| {
        // an upstream outage, not our bug: say so (the client retries INTERNAL errors)
        tracing::warn!(error = %format!("{e:#}"), "railways: Overpass failed");
        RpcError::new(
            ErrorCode::Internal,
            "The railway data servers are busy right now. Try again in a minute.",
        )
    })?;
    Ok(lines)
}

/// Cache key for an area, rounded to ~10 m so the same place always hits the same entry.
fn railways_key(b: &RailwaysInput) -> String {
    format!("railways:{:.4},{:.4},{:.4},{:.4}", b.w, b.s, b.e, b.n)
}

/// "55.705, 13.187" -> a place at those coordinates.
fn parse_coords(q: &str) -> Option<Place> {
    let (a, b) = q.split_once(',')?;
    let (lat, lon) = (a.trim().parse::<f64>().ok()?, b.trim().parse::<f64>().ok()?);
    ((-90.0..=90.0).contains(&lat) && (-180.0..=180.0).contains(&lon)).then(|| Place {
        lat,
        lon,
        name: format!("{lat:.4}, {lon:.4}"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn coords() {
        let p = parse_coords(" 55.7058, 13.1870 ").unwrap();
        assert_eq!((p.lat, p.lon), (55.7058, 13.187));
        assert_eq!(p.name, "55.7058, 13.1870");
        assert!(parse_coords("Lund, Sweden").is_none());
        assert!(parse_coords("95, 13").is_none());
    }

    #[test]
    fn key_rounds() {
        let a = RailwaysInput {
            s: 55.68241,
            w: 13.14581,
            n: 55.72931,
            e: 13.22819,
        };
        let b = RailwaysInput {
            s: 55.682412,
            w: 13.145812,
            n: 55.729309,
            e: 13.228191,
        };
        assert_eq!(railways_key(&a), railways_key(&b));
    }
}
