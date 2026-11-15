//! Types shared with the frontend.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LatLon {
    pub lat: f64,
    pub lon: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PlaceInput {
    /// A place name ("Lund, Sweden") or coordinates ("55.705, 13.187").
    pub q: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Place {
    pub lat: f64,
    pub lon: f64,
    /// Short display name, e.g. "Lund, Lunds kommun".
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RailwaysInput {
    /// Area to load: south, west, north, east (degrees).
    pub s: f64,
    pub w: f64,
    pub n: f64,
    pub e: f64,
}

/// One railway way from OpenStreetMap (a stretch of track between junctions or tag changes).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RailLine {
    pub pts: Vec<LatLon>,
    pub bridge: bool,
    pub tunnel: bool,
}
