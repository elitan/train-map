//! map: place search and railway lines from OpenStreetMap, cached in Postgres.

mod db;
mod jobs;
mod osm;
mod procedures;
pub mod types;

use crate::AppState;
use northstack::{Cron, Jobs, Rpc};

pub fn rpc() -> Rpc<AppState> {
    Rpc::new()
        .query("map.place", procedures::place)
        .query("map.railways", procedures::railways)
}

pub fn jobs() -> Jobs<AppState> {
    Jobs::new()
}

pub fn cron() -> Cron {
    Cron::new()
}
