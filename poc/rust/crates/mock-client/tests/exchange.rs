use mock_client::{ClientScenario, run_exchange};
use std::path::PathBuf;
use std::process::Command;

#[test]
fn client_and_provider_exchange_get_success() {
    let summary = run_exchange(provider_command("get-success"), ClientScenario::InstallGet)
        .expect("get-success exchange should pass");

    assert_eq!(summary.selected_version, 1);
    assert_eq!(summary.outcome, "ok");
}

#[test]
fn client_and_provider_exchange_refresh_success() {
    let summary = run_exchange(provider_command("refresh-success"), ClientScenario::Refresh)
        .expect("refresh exchange should pass");

    assert_eq!(summary.selected_version, 1);
    assert_eq!(summary.outcome, "ok");
}

#[test]
fn client_and_provider_exchange_batch_success() {
    let summary = run_exchange(
        provider_command("batch-success"),
        ClientScenario::BatchInstall,
    )
    .expect("batch exchange should pass");

    assert_eq!(summary.selected_version, 1);
    assert_eq!(summary.outcome, "batch:2");
}

#[test]
fn client_fails_closed_on_not_found() {
    let error = run_exchange(provider_command("not-found"), ClientScenario::InstallGet)
        .expect_err("not-found should fail closed");

    assert!(error.to_string().contains("not-found fails closed"));
}

#[test]
fn client_fails_closed_on_version_mismatch() {
    let error = run_exchange(
        provider_command("version-mismatch"),
        ClientScenario::InstallGet,
    )
    .expect_err("version mismatch should fail closed");

    assert!(error.to_string().contains("no compatible protocol version"));
}

fn provider_command(scenario: &str) -> Command {
    let mut command = Command::new(std::env::var("CARGO").unwrap_or_else(|_| "cargo".into()));
    command
        .arg("run")
        .arg("--quiet")
        .arg("--manifest-path")
        .arg(workspace_manifest())
        .arg("-p")
        .arg("mock-provider")
        .arg("--")
        .arg("--scenario")
        .arg(scenario);
    command
}

fn workspace_manifest() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join("Cargo.toml")
}
