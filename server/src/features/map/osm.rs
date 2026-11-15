//! Calls to OpenStreetMap services: Nominatim (place search) and Overpass (railway lines).

use std::time::Duration;

use anyhow::{Context, bail};
use serde::Deserialize;
use tokio::task::JoinSet;

use super::types::{LatLon, Place, RailLine, RailwaysInput};

/// Overpass mirrors, asked all at once; the first good answer wins. The main server often
/// answers 502/504 when busy, so one slow or broken mirror doesn't hold the map up.
const OVERPASS: &[&str] = &[
    "https://overpass-api.de/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
];

#[derive(Deserialize)]
struct NominatimHit {
    lat: String,
    lon: String,
    display_name: String,
}

pub async fn geocode(http: &reqwest::Client, q: &str) -> anyhow::Result<Option<Place>> {
    let hits: Vec<NominatimHit> = http
        .get("https://nominatim.openstreetmap.org/search")
        .query(&[("format", "json"), ("limit", "1"), ("q", q)])
        .timeout(Duration::from_secs(15))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    let Some(hit) = hits.into_iter().next() else {
        return Ok(None);
    };
    let name = hit
        .display_name
        .split(',')
        .take(2)
        .collect::<Vec<_>>()
        .join(",");
    Ok(Some(Place {
        lat: hit.lat.parse().context("latitude")?,
        lon: hit.lon.parse().context("longitude")?,
        name,
    }))
}

#[derive(Deserialize)]
struct Overpass {
    elements: Vec<Way>,
}

#[derive(Deserialize)]
struct Way {
    #[serde(default)]
    tags: std::collections::HashMap<String, String>,
    #[serde(default)]
    geometry: Vec<LatLon>,
}

/// Railway lines (no yards, sidings or spurs) in the area.
pub async fn railways(http: &reqwest::Client, b: &RailwaysInput) -> anyhow::Result<Vec<RailLine>> {
    let query = format!(
        r#"[out:json][timeout:60];way["railway"~"^(rail|light_rail|narrow_gauge)$"]["service"!~"^(yard|siding|spur)$"]({},{},{},{});out tags geom;"#,
        b.s, b.w, b.n, b.e
    );
    let mut asks = JoinSet::new();
    for url in OVERPASS {
        let (http, query) = (http.clone(), query.clone());
        asks.spawn(async move {
            ask(&http, url, &query)
                .await
                .with_context(|| url.to_string())
        });
    }
    let mut errors = Vec::new();
    while let Some(res) = asks.join_next().await {
        match res? {
            Ok(ways) => return Ok(ways.into_iter().filter_map(rail_line).collect()),
            Err(e) => errors.push(format!("{e:#}")),
        }
    }
    bail!("no Overpass mirror answered: {}", errors.join("; "))
}

async fn ask(http: &reqwest::Client, url: &str, query: &str) -> anyhow::Result<Vec<Way>> {
    let res: Overpass = http
        .post(url)
        .form(&[("data", query)])
        .timeout(Duration::from_secs(75))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    Ok(res.elements)
}

fn rail_line(w: Way) -> Option<RailLine> {
    let flag = |k: &str, no: &[&str]| w.tags.get(k).is_some_and(|v| !no.contains(&v.as_str()));
    (w.geometry.len() > 1).then(|| RailLine {
        bridge: flag("bridge", &["no"]),
        tunnel: flag("tunnel", &["no", "building_passage"]),
        // ~1 cm is plenty, and keeps the cached JSON small
        pts: w
            .geometry
            .iter()
            .map(|p| LatLon {
                lat: round7(p.lat),
                lon: round7(p.lon),
            })
            .collect(),
    })
}

fn round7(v: f64) -> f64 {
    (v * 1e7).round() / 1e7
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flags_bridges_and_tunnels() {
        let way = |tags: &[(&str, &str)]| Way {
            tags: tags
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
            geometry: vec![
                LatLon {
                    lat: 55.0,
                    lon: 13.0,
                },
                LatLon {
                    lat: 55.001,
                    lon: 13.0,
                },
            ],
        };
        let l = rail_line(way(&[("bridge", "yes")])).unwrap();
        assert!(l.bridge && !l.tunnel);
        let l = rail_line(way(&[("bridge", "no"), ("tunnel", "building_passage")])).unwrap();
        assert!(!l.bridge && !l.tunnel);
        assert!(
            rail_line(Way {
                tags: Default::default(),
                geometry: vec![]
            })
            .is_none()
        );
    }
}
