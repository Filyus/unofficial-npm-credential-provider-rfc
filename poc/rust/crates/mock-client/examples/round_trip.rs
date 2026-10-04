//! What a credential lookup costs on the wire, to weigh `get-batch` against
//! plain `get` in a session and against one process per lookup.
//!
//!     cargo build --release --manifest-path poc/rust/Cargo.toml -p mock-provider -p mock-client --examples
//!     poc/rust/target/release/examples/round_trip <path-to-release-mock-provider> [lookups] [rounds]
//!
//! Each round runs the three conditions in a rotated order and reports the
//! cost per lookup; the summary is the median with the min..max spread.

use credential_provider_protocol::{PackageContext, Request};
use mock_client::ProviderSession;
use std::process::Command;
use std::time::{Duration, Instant};

const REGISTRY: &str = "https://registry.example.test/";

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let provider = args
        .next()
        .ok_or("usage: round_trip <provider> [lookups] [rounds]")?;
    let lookups: usize = args.next().map_or(Ok(1000), |value| value.parse())?;
    let rounds: usize = args.next().map_or(Ok(7), |value| value.parse())?;
    let spawns = (lookups / 10).max(10);

    let mut session_gets = Vec::new();
    let mut one_batch = Vec::new();
    let mut spawn_per_lookup = Vec::new();
    for round in 0..rounds {
        for condition in (0..3).map(|offset| (round + offset) % 3) {
            match condition {
                0 => session_gets.push(per_lookup(session_get(&provider, lookups)?, lookups)),
                1 => one_batch.push(per_lookup(batch(&provider, lookups)?, lookups)),
                _ => spawn_per_lookup.push(per_lookup(spawn_each(&provider, spawns)?, spawns)),
            }
        }
    }

    println!("lookups={lookups} rounds={rounds} spawn-iterations={spawns}");
    report("get in one session", &mut session_gets);
    report("one get-batch", &mut one_batch);
    report("process per lookup", &mut spawn_per_lookup);
    Ok(())
}

fn command(provider: &str, scenario: &str) -> Command {
    let mut command = Command::new(provider);
    command.args(["--scenario", scenario]);
    command
}

fn packages(count: usize) -> Vec<PackageContext> {
    (0..count)
        .map(|index| PackageContext {
            scope: Some("@scope".into()),
            package: format!("pkg-{index}"),
        })
        .collect()
}

/// Spawn and hello are outside the timed span: this is the steady-state cost
/// of one more lookup in a session that already exists.
fn session_get(provider: &str, lookups: usize) -> Result<Duration, Box<dyn std::error::Error>> {
    let mut session = ProviderSession::spawn(command(provider, "get-success"))?;
    let requests: Vec<Request> = packages(lookups)
        .into_iter()
        .map(|package| Request::get_install(REGISTRY, package.scope.as_deref(), &package.package))
        .collect();
    let start = Instant::now();
    for request in &requests {
        session.request(request)?;
    }
    let elapsed = start.elapsed();
    session.close()?;
    Ok(elapsed)
}

fn batch(provider: &str, lookups: usize) -> Result<Duration, Box<dyn std::error::Error>> {
    let mut session = ProviderSession::spawn(command(provider, "batch-success"))?;
    let request = Request::get_batch(REGISTRY, packages(lookups));
    let start = Instant::now();
    session.request(&request)?;
    let elapsed = start.elapsed();
    session.close()?;
    Ok(elapsed)
}

/// The #850 and pnpm `tokenHelper` shape: a fresh process for every lookup,
/// timed from spawn to exit.
fn spawn_each(provider: &str, spawns: usize) -> Result<Duration, Box<dyn std::error::Error>> {
    let request = Request::get_install(REGISTRY, Some("@scope"), "pkg");
    let start = Instant::now();
    for _ in 0..spawns {
        let mut session = ProviderSession::spawn(command(provider, "get-success"))?;
        session.request(&request)?;
        session.close()?;
    }
    Ok(start.elapsed())
}

fn per_lookup(total: Duration, lookups: usize) -> f64 {
    total.as_secs_f64() * 1e6 / lookups as f64
}

fn report(label: &str, samples: &mut [f64]) {
    samples.sort_by(f64::total_cmp);
    let median = samples[samples.len() / 2];
    println!(
        "{label:>20}: median {median:>9.1} us/lookup  (min {:.1} .. max {:.1})",
        samples[0],
        samples[samples.len() - 1]
    );
}
