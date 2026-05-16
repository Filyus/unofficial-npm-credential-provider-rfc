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
fn client_and_provider_exchange_action_successes() {
    for scenario in [
        ClientScenario::Login,
        ClientScenario::Logout,
        ClientScenario::Erase,
    ] {
        let summary = run_exchange(provider_command("action-kind-success"), scenario)
            .expect("action succeeds");

        assert_eq!(summary.selected_version, 1);
        assert!(["login", "logout", "erase"].contains(&summary.outcome.as_str()));
    }
}

#[test]
fn client_tries_next_on_url_not_supported() {
    let summary = run_exchange(
        provider_command("url-not-supported"),
        ClientScenario::InstallGet,
    )
    .expect("url-not-supported is a chain signal");

    assert_eq!(summary.outcome, "try-next-provider");
}

#[test]
fn client_fails_closed_on_not_found() {
    let error = run_exchange(provider_command("not-found"), ClientScenario::InstallGet)
        .expect_err("not-found should fail closed");

    assert!(error.to_string().contains("not-found fails closed"));
}

#[test]
fn client_fails_on_operation_not_supported_for_get() {
    let error = run_exchange(
        provider_command("operation-not-supported"),
        ClientScenario::InstallGet,
    )
    .expect_err("operation-not-supported should fail for get");

    assert!(error.to_string().contains("operation-not-supported"));
}

#[test]
fn client_fails_on_other_error() {
    let error = run_exchange(provider_command("other-error"), ClientScenario::InstallGet)
        .expect_err("other error should fail");

    assert!(error.to_string().contains("provider failed"));
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

#[test]
fn client_rejects_invalid_json_response() {
    let error = run_exchange(provider_command("invalid-json"), ClientScenario::InstallGet)
        .expect_err("invalid JSON should fail");

    assert!(error.to_string().contains("json error"));
}

#[test]
fn client_rejects_missing_hello() {
    let error = run_exchange(provider_command("no-hello"), ClientScenario::InstallGet)
        .expect_err("missing hello should fail");

    assert!(error.to_string().contains("provider exited before hello"));
}

#[test]
fn client_rejects_both_ok_and_err() {
    let error = run_exchange(provider_command("both-ok-err"), ClientScenario::InstallGet)
        .expect_err("both Ok and Err should fail");

    assert!(error.to_string().contains("json error"));
}

#[test]
fn client_rejects_malformed_auth() {
    let error = run_exchange(
        provider_command("malformed-auth"),
        ClientScenario::InstallGet,
    )
    .expect_err("malformed auth should fail");

    assert!(error.to_string().contains("json error"));
}

#[test]
fn client_rejects_missing_expiration() {
    let error = run_exchange(
        provider_command("expires-missing-expiration"),
        ClientScenario::InstallGet,
    )
    .expect_err("cache=expires without expiresAt should fail");

    assert!(
        error
            .to_string()
            .contains("cache=expires requires expiresAt")
    );
}

#[test]
fn client_rejects_batch_result_count_mismatch() {
    let error = run_exchange(
        provider_command("batch-count-mismatch"),
        ClientScenario::BatchInstall,
    )
    .expect_err("batch result count mismatch should fail");

    assert!(error.to_string().contains("batch result count mismatch"));
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
