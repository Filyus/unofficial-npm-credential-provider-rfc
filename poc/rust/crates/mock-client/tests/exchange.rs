use credential_provider_protocol::{Auth, ErrorKind, ProviderResponse, Request, RequestKind};
use mock_client::{
    ChainKind, ClientScenario, ProviderCommand, ProviderSession, run_exchange, run_provider_chain,
};

mod common;
use common::provider_command;

#[test]
fn one_session_serves_sequential_requests_from_one_process() {
    let mut session =
        ProviderSession::spawn(provider_command("session-counter")).expect("provider starts");
    let registry = "https://registry.example.test/";

    let first = session
        .request(&Request::get_install(
            registry,
            Some("@scope"),
            "api-client",
        ))
        .expect("first request");
    let second = session
        .request(&Request::get_install(registry, Some("@scope"), "ui"))
        .expect("second request");

    assert_eq!(bearer_token(&first), "token-1");
    assert_eq!(bearer_token(&second), "token-2");
    session
        .close()
        .expect("closing stdin ends the provider cleanly");
}

#[test]
fn provider_refuses_unknown_kind_and_keeps_serving() {
    let mut session =
        ProviderSession::spawn(provider_command("get-success")).expect("provider starts");
    let registry = "https://registry.example.test/";

    let refused = session
        .send_raw(&serde_json::json!({"v": 1, "kind": "store", "registry": registry}))
        .expect("provider answers instead of exiting");
    let ProviderResponse::Err(err) = refused else {
        panic!("unknown kind must be refused, got {refused:?}");
    };
    assert_eq!(err.kind, ErrorKind::OperationNotSupported);

    let served = session
        .request(&Request::get_install(registry, Some("@scope"), "pkg"))
        .expect("session survives the refusal");
    assert!(matches!(served, ProviderResponse::Ok(_)));
    session.close().expect("clean exit");
}

#[test]
fn provider_refuses_unknown_operation_instead_of_serving_it_as_read() {
    let mut session =
        ProviderSession::spawn(provider_command("get-success")).expect("provider starts");

    let refused = session
        .send_raw(&serde_json::json!({
            "v": 1,
            "kind": "get",
            "registry": "https://registry.example.test/",
            "operation": "transfer-ownership",
            "interactive": false
        }))
        .expect("provider answers instead of exiting");

    let ProviderResponse::Err(err) = refused else {
        panic!("unknown operation must be refused, got {refused:?}");
    };
    assert_eq!(err.kind, ErrorKind::OperationNotSupported);
    session.close().expect("clean exit");
}

#[test]
fn publish_request_carries_the_version() {
    let summary = run_exchange(provider_command("get-success"), ClientScenario::PublishGet)
        .expect("publish get succeeds");

    assert_eq!(summary.outcome, "ok");
}

fn bearer_token(response: &ProviderResponse) -> &str {
    let ProviderResponse::Ok(ok) = response else {
        panic!("expected Ok, got {response:?}");
    };
    assert_eq!(ok.kind, RequestKind::Get);
    match ok.auth.as_ref() {
        Some(Auth::Bearer { token }) => token.expose(),
        other => panic!("expected bearer auth, got {other:?}"),
    }
}

#[test]
fn client_and_provider_exchange_get_success() {
    let summary = run_exchange(provider_command("get-success"), ClientScenario::InstallGet)
        .expect("get-success exchange should pass");

    assert_eq!(summary.selected_version, 1);
    assert_eq!(summary.outcome, "ok");
}

#[test]
fn client_accepts_an_expiring_token() {
    let summary = run_exchange(
        provider_command("expiring-token"),
        ClientScenario::InstallGet,
    )
    .expect("expiring token is a valid get answer");

    assert_eq!(summary.outcome, "ok");
}

#[test]
fn client_and_provider_exchange_request_kind_successes() {
    for scenario in [
        ClientScenario::Login,
        ClientScenario::Logout,
        ClientScenario::Erase,
    ] {
        let summary = run_exchange(provider_command("request-kind-success"), scenario)
            .expect("request kind succeeds");

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
fn provider_chain_uses_second_provider_after_url_not_supported() {
    let summary = run_provider_chain(
        vec![
            provider_command("url-not-supported"),
            provider_command("get-success"),
        ],
        ClientScenario::InstallGet,
        ChainKind::Global,
    )
    .expect("second provider should satisfy request");

    assert_eq!(summary.provider_index, 1);
    assert_eq!(summary.outcome, "ok");
}

#[test]
fn provider_chain_moves_on_after_not_found() {
    let summary = run_provider_chain(
        vec![
            provider_command("not-found"),
            provider_command("get-success"),
        ],
        ClientScenario::InstallGet,
        ChainKind::PerRegistry,
    )
    .expect("not-found passes the request on, as in Cargo");

    assert_eq!(summary.provider_index, 1);
    assert_eq!(summary.outcome, "ok");
}

#[test]
fn provider_chain_fails_when_nobody_has_a_credential() {
    for kind in [ChainKind::Global, ChainKind::PerRegistry] {
        let error = run_provider_chain(
            vec![
                provider_command("url-not-supported"),
                provider_command("not-found"),
            ],
            ClientScenario::InstallGet,
            kind,
        )
        .expect_err("a not-found at the end fails without the legacy opt-in");

        assert!(error.to_string().contains("no provider had a credential"));
    }
}

#[test]
fn global_chain_that_declines_the_registry_leaves_it_without_a_provider() {
    let summary = run_provider_chain(
        vec![
            provider_command("url-not-supported"),
            provider_command("url-not-supported"),
        ],
        ClientScenario::InstallGet,
        ChainKind::Global,
    )
    .expect("an anonymous registry stays reachable with a global chain");

    assert_eq!(summary.outcome, "as-no-provider");
}

#[test]
fn per_registry_list_that_declines_the_registry_fails() {
    let error = run_provider_chain(
        vec![
            provider_command("url-not-supported"),
            provider_command("url-not-supported"),
        ],
        ClientScenario::InstallGet,
        ChainKind::PerRegistry,
    )
    .expect_err("the user tied this registry to a provider");

    assert!(error.to_string().contains("per-registry list"));
}

#[test]
fn client_reports_not_found_as_a_chain_signal() {
    let summary = run_exchange(provider_command("not-found"), ClientScenario::InstallGet)
        .expect("not-found is decided at the end of the chain");

    assert_eq!(summary.outcome, "try-next-provider-not-found");
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
fn provider_outside_its_hello_registries_is_not_asked() {
    let summary = run_exchange(
        provider_command("serves-elsewhere"),
        ClientScenario::InstallGet,
    )
    .expect("a provider that lists other registries is skipped");

    assert_eq!(summary.outcome, "try-next-provider");
}

#[test]
fn a_provider_started_without_the_sentinel_does_not_speak_the_protocol() {
    let ProviderCommand { mut program, .. } = provider_command("get-success");
    let output = program
        .args(["--scenario", "get-success"])
        .output()
        .expect("runs");
    assert_eq!(output.status.code(), Some(2));
    assert!(output.stdout.is_empty(), "no hello without the sentinel");
}

// A line that is not a request is answered with one `Err`, never `Ok`, and the
// session goes on (Phase 2, Session lifecycle). The reference providers in
// Node get the same treatment from tests/test_provider_hostile.py.

fn other_error(response: &ProviderResponse) -> &str {
    match response {
        ProviderResponse::Err(error) if error.kind == ErrorKind::Other => {
            error.message.as_deref().unwrap_or("")
        }
        other => panic!("expected an Err of kind other, got {other:?}"),
    }
}

fn still_serves(session: &mut ProviderSession) {
    let answer = session
        .request(&Request::get_install(
            "https://registry.example.test/",
            Some("@scope"),
            "after",
        ))
        .expect("the provider answers the next request");
    assert!(matches!(answer, ProviderResponse::Ok(_)), "{answer:?}");
}

#[test]
fn a_line_that_is_not_json_is_answered_with_an_error_and_the_session_goes_on() {
    let mut session =
        ProviderSession::spawn(provider_command("get-success")).expect("provider starts");
    for line in [
        &b"{not json\n"[..],
        b"[]\n",
        b"null\n",
        b"\xff\xfe\n",
        b"7\n",
    ] {
        session.write_raw(line).expect("written");
        let answer = session.read_answer().expect("one answer for the line");
        assert!(
            other_error(&answer).starts_with("malformed request"),
            "{line:?}"
        );
    }
    still_serves(&mut session);
    session.close().expect("clean exit");
}

#[test]
fn a_request_against_the_schema_is_answered_with_an_error_and_never_served() {
    let mut session =
        ProviderSession::spawn(provider_command("get-success")).expect("provider starts");
    for line in [
        // a get with no interactive, a scope without @, a publish with no version
        r#"{"v":1,"kind":"get","registry":"https://r.test/","operation":"read"}"#,
        r#"{"v":1,"kind":"get","registry":"https://r.test/","operation":"read","interactive":true,"scope":"acme"}"#,
        r#"{"v":1,"kind":"get","registry":"https://r.test/","operation":"publish","interactive":true}"#,
        r#"{"v":2,"kind":"get","registry":"https://r.test/","operation":"read","interactive":true}"#,
        r#"{"v":1,"kind":"get","registry":"https://r.test/","operation":"read","interactive":true,"retry":null}"#,
    ] {
        session
            .write_raw(format!("{line}\n").as_bytes())
            .expect("written");
        let answer = session.read_answer().expect("one answer for the line");
        assert!(
            other_error(&answer).starts_with("malformed request"),
            "{line}"
        );
    }
    still_serves(&mut session);
    session.close().expect("clean exit");
}

#[test]
fn a_line_over_the_limit_is_refused_whole_and_the_next_line_is_read() {
    let mut session =
        ProviderSession::spawn(provider_command("get-success")).expect("provider starts");
    // a request that would be served, with padding that takes it past 1 MiB
    let padding = "p".repeat(2 * 1024 * 1024);
    let line = format!(
        r#"{{"v":1,"kind":"get","registry":"https://r.test/","operation":"read","interactive":true,"padding":"{padding}"}}"#
    );
    session.write_raw(line.as_bytes()).expect("written");
    session.write_raw(b"\n").expect("written");
    let answer = session.read_answer().expect("one answer for the line");
    assert!(
        other_error(&answer).starts_with("a line over"),
        "{answer:?}"
    );
    still_serves(&mut session);
    session.close().expect("clean exit");
}

#[test]
fn blank_lines_are_skipped_and_get_no_answer() {
    let mut session =
        ProviderSession::spawn(provider_command("get-success")).expect("provider starts");
    session.write_raw(b"\n  \r\n\t\n").expect("written");
    // had a blank line been answered, this request would be given its answer
    still_serves(&mut session);
    session
        .close()
        .expect("clean exit, and nothing left unanswered");
}

#[test]
fn a_kind_no_version_knows_is_not_malformed_even_with_nothing_else() {
    let mut session =
        ProviderSession::spawn(provider_command("get-success")).expect("provider starts");
    session
        .write_raw(b"{\"v\":1,\"kind\":\"refresh\",\"registry\":\"x\"}\n")
        .expect("written");
    let answer = session.read_answer().expect("answered");
    assert!(
        matches!(&answer, ProviderResponse::Err(error) if error.kind == ErrorKind::OperationNotSupported),
        "{answer:?}"
    );
    still_serves(&mut session);
    session.close().expect("clean exit");
}

fn policy() -> serde_json::Value {
    let path =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../../spec/policy-v1.json");
    serde_json::from_str(&std::fs::read_to_string(path).expect("the policy is there"))
        .expect("the policy is JSON")
}

#[test]
fn an_unknown_error_kind_fails_the_get_like_other() {
    let error = run_exchange(
        provider_command("unknown-error-kind"),
        ClientScenario::InstallGet,
    )
    .expect_err("read as `other`, which stops the chain");

    assert_eq!(error.to_string(), "provider error: other");
}

#[test]
fn an_unknown_error_kind_does_not_move_a_chain_on() {
    // not read as url-not-supported or not-found: the next provider is not asked
    let error = run_provider_chain(
        vec![
            provider_command("unknown-error-kind"),
            provider_command("get-success"),
        ],
        ClientScenario::InstallGet,
        ChainKind::Global,
    )
    .expect_err("the chain stops at an `other`");

    assert!(error.to_string().contains("other"));
}

#[test]
fn an_unknown_cache_is_never_and_an_unknown_granularity_is_package() {
    use credential_provider_protocol::{CachePolicy, Granularity, generated};
    let mut session = ProviderSession::spawn(provider_command("unknown-cache-and-granularity"))
        .expect("provider starts");
    let response = session
        .request(&Request::get_install(
            "https://registry.example.test/",
            Some("@scope"),
            "pkg",
        ))
        .expect("an unknown value is a well-formed one");
    let ProviderResponse::Ok(ok) = response else {
        panic!("expected Ok, got {response:?}");
    };

    assert_eq!(ok.cache, Some(CachePolicy::Never));
    assert_eq!(ok.granularity, Some(Granularity::Package));
    let policy = policy();
    let mapping = &policy["forwardCompatibility"];
    assert_eq!(mapping["unknownCache"], generated::UNKNOWN_CACHE);
    assert_eq!(
        mapping["unknownGranularity"],
        generated::UNKNOWN_GRANULARITY
    );
    assert_eq!(
        serde_json::to_value(CachePolicy::Never).unwrap(),
        generated::UNKNOWN_CACHE
    );
    assert_eq!(
        serde_json::to_value(Granularity::Package).unwrap(),
        generated::UNKNOWN_GRANULARITY
    );
    session.close().expect("clean exit");
}

#[test]
fn an_unknown_auth_type_fails_the_request_as_other() {
    let error = run_exchange(
        provider_command("unknown-auth-type"),
        ClientScenario::InstallGet,
    )
    .expect_err("npm has nothing it can send");

    assert!(
        error
            .to_string()
            .contains("other: unknown auth.type digest")
    );
}

#[test]
fn a_global_chain_that_declined_a_listed_host_sends_no_stored_credential() {
    // the provider lists the `http:` form of the host asked about over `https:`:
    // npm sends it nothing, the chain is exhausted, and the request fails
    let error = run_provider_chain(
        vec![
            provider_command("url-not-supported"),
            provider_command("lists-other-form"),
        ],
        ClientScenario::InstallGet,
        ChainKind::Global,
    )
    .expect_err("a URL form a provider declined on a host its hello lists");

    let text = error.to_string();
    assert!(
        text.contains("lists http://registry.example.test/"),
        "{text}"
    );
    assert!(text.contains("no stored credential"), "{text}");
}

#[test]
fn a_global_chain_that_declined_an_unlisted_host_still_leaves_it_without_a_provider() {
    let summary = run_provider_chain(
        vec![
            provider_command("serves-elsewhere"),
            provider_command("url-not-supported"),
        ],
        ClientScenario::InstallGet,
        ChainKind::Global,
    )
    .expect("a host no hello lists falls back as before");

    assert_eq!(summary.outcome, "as-no-provider");
}
