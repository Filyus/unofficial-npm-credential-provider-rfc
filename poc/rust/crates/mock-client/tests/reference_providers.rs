//! The Rust client against the reference providers in examples/providers:
//! for every transcript of their examples, the client starts the provider,
//! sends each recorded request through its own types and validation, and
//! requires the recorded answer, parsed and validated by its own types. The
//! Python model, this client and the Node providers are three
//! implementations of one protocol; here two of them talk to each other.
//!
//! examples/providers/scenario.js sets each scenario up (the fake vendor API,
//! the provider's configuration, the clock) and checks the store, the fake's
//! state and the presence answers once the session is over. Needs `node`.

use credential_provider_protocol::{Hello, ProviderResponse, Request};
use mock_client::{ProviderCommand, ProviderSession};
use serde::Deserialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

fn repository() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../..")
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Setup {
    provider: String,
    cwd: String,
    config_file: String,
    env: BTreeMap<String, Option<String>>,
}

fn transcripts() -> Vec<(String, PathBuf)> {
    let listed = Command::new("node")
        .arg(repository().join("examples/providers/scenario.js"))
        .output()
        .expect("node runs examples/providers/scenario.js");
    assert!(
        listed.status.success(),
        "{}",
        String::from_utf8_lossy(&listed.stderr)
    );
    String::from_utf8(listed.stdout)
        .unwrap()
        .lines()
        .map(|line| {
            let (name, path) = line.split_once(' ').unwrap();
            (name.to_string(), PathBuf::from(path))
        })
        .collect()
}

fn run(name: &str, transcript: &Path) {
    let label = format!(
        "{name}/{}",
        transcript.file_name().unwrap().to_string_lossy()
    );
    let mut helper = Command::new("node")
        .arg(repository().join("examples/providers/scenario.js"))
        .arg(name)
        .arg(transcript)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("node starts the scenario");
    let mut helper_in = helper.stdin.take().unwrap();
    let mut helper_out = BufReader::new(helper.stdout.take().unwrap());
    let mut first = String::new();
    helper_out.read_line(&mut first).unwrap();
    let setup: Setup = serde_json::from_str(&first).unwrap_or_else(|error| {
        let mut stderr = String::new();
        helper
            .stderr
            .take()
            .unwrap()
            .read_to_string(&mut stderr)
            .unwrap();
        panic!("{label}: no scenario ({error}): {stderr}")
    });

    // `node provider.js`, then the sentinel the client puts first
    let mut command = Command::new("node");
    command
        .arg(&setup.provider)
        .current_dir(&setup.cwd)
        .env_clear();
    for (key, value) in &setup.env {
        if let Some(value) = value {
            command.env(key, value);
        }
    }
    let mut session: Option<ProviderSession> = None;
    // what the providers wrote to stderr, which npm logs: the scenario checks
    // that no secret of its own is in it, as run.js does
    let mut stderr_of_providers = String::new();
    let mut provider = Some(ProviderCommand::new(
        command,
        vec!["--config".into(), setup.config_file.clone()],
    ));

    let text = std::fs::read_to_string(transcript).unwrap();
    let mut pending: Option<Request> = None;
    for (index, line) in text
        .lines()
        .filter(|line| !line.trim().is_empty())
        .enumerate()
    {
        let at = format!("{label} line {}", index + 1);
        let event: Value = serde_json::from_str(line).unwrap();
        let message = event.get("message").cloned();
        match (event["from"].as_str(), event.get("event")) {
            (Some("client"), Some(_)) => {
                let noted = session
                    .take()
                    .unwrap()
                    .close_with_stderr()
                    .unwrap_or_else(|error| panic!("{at}: {error}"));
                stderr_of_providers.push_str(&noted);
            }
            (Some("client"), None) => {
                let raw = message.unwrap();
                let request: Request = serde_json::from_value(raw.clone())
                    .unwrap_or_else(|error| panic!("{at}: {error}"));
                assert_eq!(
                    serde_json::to_value(&request).unwrap(),
                    raw,
                    "{at}: the request does not round-trip"
                );
                let live = session.as_ref().unwrap();
                assert!(
                    live.serves(&request.registry),
                    "{at}: hello leaves {} out",
                    request.registry
                );
                // the clock moves before the request is sent, not after
                writeln!(helper_in, "tick").unwrap();
                let mut ticked = String::new();
                helper_out.read_line(&mut ticked).unwrap();
                assert_eq!(
                    ticked.trim(),
                    "ticked",
                    "{at}: the scenario did not move its clock"
                );
                pending = Some(request);
            }
            (Some("provider"), _) if session.is_none() => {
                let started = ProviderSession::spawn(provider.take().unwrap())
                    .unwrap_or_else(|error| panic!("{at}: {error}"));
                let expected: Hello = serde_json::from_value(message.unwrap()).unwrap();
                assert_eq!(started.hello.as_ref(), Some(&expected), "{at}");
                session = Some(started);
            }
            (Some("provider"), _) => {
                let raw = message.unwrap();
                let request = pending.take().expect("an answer follows a request");
                let response = session
                    .as_mut()
                    .unwrap()
                    .request(&request)
                    .unwrap_or_else(|error| panic!("{at}: {error}"));
                let expected: ProviderResponse = serde_json::from_value(raw.clone()).unwrap();
                assert_eq!(response, expected, "{at}");
                assert_eq!(
                    serde_json::to_value(&response).unwrap(),
                    raw,
                    "{at}: the answer does not round-trip"
                );
            }
            other => panic!("{at}: unexpected event {other:?}"),
        }
    }

    writeln!(
        helper_in,
        "stderr {}",
        serde_json::to_string(&stderr_of_providers).unwrap()
    )
    .unwrap();
    drop(helper_in);
    let mut stderr = String::new();
    helper
        .stderr
        .take()
        .unwrap()
        .read_to_string(&mut stderr)
        .unwrap();
    let status = helper.wait().unwrap();
    assert!(status.success(), "{label}: {stderr}");
}

#[test]
fn the_rust_client_and_the_reference_providers_agree_on_every_transcript() {
    let all = transcripts();
    assert!(all.len() >= 30, "found {} transcripts", all.len());
    for (name, transcript) in &all {
        run(name, transcript);
    }
}
