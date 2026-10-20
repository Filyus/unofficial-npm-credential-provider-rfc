//! The Phase 2 timeouts (`spec/policy-v1.json`, `credentialProvider`): a provider
//! that does not answer within the limit for its request kind is killed, the
//! request fails, and the session is over. Tests use a limit scaled down to a
//! fraction of a second; one test pins the real constants to the policy.

use credential_provider_protocol::{
    Granularity, Operation, ProviderResponse, Request, RequestKind, generated,
};
use mock_client::{
    ChainKind, ClientScenario, ExchangeError, ProviderCommand, ProviderSession, ProviderSupervisor,
    Timeouts, run_exchange_with, run_provider_chain_with,
};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

const REGISTRY: &str = "https://registry.example.test/";
/// Long enough for a provider that answers, short enough for the suite.
const SHORT: Duration = Duration::from_millis(400);

fn mock_provider_exe() -> PathBuf {
    static EXE: OnceLock<PathBuf> = OnceLock::new();
    EXE.get_or_init(|| {
        // run the binary itself: killing a `cargo run` would leave the provider
        // behind, holding its exe
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../Cargo.toml");
        let status = Command::new(std::env::var("CARGO").unwrap_or_else(|_| "cargo".into()))
            .args(["build", "--quiet", "-p", "mock-provider", "--manifest-path"])
            .arg(manifest)
            .stdout(Stdio::null())
            .status()
            .expect("cargo runs");
        assert!(status.success(), "mock-provider builds");
        // target/debug/deps/<this test> -> target/debug
        let profile_dir = std::env::current_exe()
            .unwrap()
            .parent()
            .and_then(|deps| deps.parent())
            .unwrap()
            .to_path_buf();
        profile_dir.join(format!("mock-provider{}", std::env::consts::EXE_SUFFIX))
    })
    .clone()
}

fn provider_command(scenario: &str) -> ProviderCommand {
    ProviderCommand::new(
        Command::new(mock_provider_exe()),
        vec!["--scenario".into(), scenario.into()],
    )
}

fn timed_out(error: &ExchangeError) -> bool {
    matches!(error, ExchangeError::TimedOut { .. })
}

fn get(interactive: bool) -> Request {
    Request {
        interactive: Some(interactive),
        ..Request::get_install(REGISTRY, Some("@scope"), "pkg")
    }
}

fn login() -> Request {
    Request {
        interactive: Some(true),
        ..Request::bare(RequestKind::Login, REGISTRY)
    }
}

#[test]
fn the_limits_are_the_policys() {
    let policy: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../../spec/policy-v1.json"
        ))
        .expect("the policy is in the repository"),
    )
    .unwrap();
    let seconds = &policy["credentialProvider"]["timeoutSeconds"];
    let limits = Timeouts::policy();
    for (key, limit) in [
        ("hello", limits.hello),
        ("get", limits.get),
        ("getInteractive", limits.get_interactive),
        ("erase", limits.erase),
        ("login", limits.login),
        ("logout", limits.logout),
    ] {
        assert_eq!(Some(limit.as_secs()), seconds[key].as_u64(), "{key}");
    }
    assert_eq!(
        seconds.as_object().unwrap().len(),
        6,
        "a kind without a test"
    );
    assert_eq!(Timeouts::default(), limits);
    assert_eq!(
        Some(u64::from(generated::TIMEOUT_KILLS_BEFORE_NO_RESTART)),
        policy["credentialProvider"]["timeoutKillsBeforeNoRestart"].as_u64()
    );
}

#[test]
fn each_request_kind_gets_its_own_limit() {
    let t = Timeouts {
        hello: Duration::from_secs(1),
        get: Duration::from_secs(2),
        get_interactive: Duration::from_secs(3),
        erase: Duration::from_secs(4),
        login: Duration::from_secs(5),
        logout: Duration::from_secs(6),
    };
    let secs = |kind, interactive| t.for_request(&kind, interactive).as_secs();
    assert_eq!(secs(RequestKind::Get, false), 2);
    assert_eq!(secs(RequestKind::Get, true), 3);
    assert_eq!(secs(RequestKind::Erase, false), 4);
    assert_eq!(secs(RequestKind::Login, true), 5);
    assert_eq!(secs(RequestKind::Logout, false), 6);
    // a kind with no budget of its own is bounded like a get
    assert_eq!(secs(RequestKind::Unsupported, false), 2);
}

#[test]
fn a_provider_that_never_says_hello_is_killed() {
    let started = Instant::now();
    let error = ProviderSession::spawn_with(provider_command("hang-hello"), Timeouts::all(SHORT))
        .err()
        .expect("no hello within the limit");
    assert!(timed_out(&error), "{error}");
    assert!(started.elapsed() < Duration::from_secs(10));
}

#[test]
fn a_hang_in_each_request_kind_is_killed_at_its_own_limit() {
    // every kind but the one that hangs is answered at once, so each case
    // pins the limit of exactly one kind
    let cases: [(&str, Request); 5] = [
        ("hang-get", get(false)),
        ("hang-get-interactive", get(true)),
        (
            "hang-erase",
            Request {
                scope: Some("@scope".into()),
                package: Some("pkg".into()),
                operation: Some(Operation::Read),
                granularity: Some(Granularity::Scope),
                command: Some("install".into()),
                ..Request::bare(RequestKind::Erase, REGISTRY)
            },
        ),
        ("hang-login", login()),
        ("hang-logout", Request::bare(RequestKind::Logout, REGISTRY)),
    ];
    for (scenario, request) in cases {
        let mut session =
            ProviderSession::spawn_with(provider_command(scenario), Timeouts::all(SHORT))
                .expect("provider says hello");
        let error = session.request(&request).expect_err(scenario);
        assert!(timed_out(&error), "{scenario}: {error}");
        assert!(session.killed(), "{scenario}");
    }
}

#[test]
fn the_limit_is_per_kind_not_one_for_all() {
    // only `get` is short: a hung login must outlast it
    let timeouts = Timeouts {
        get: Duration::from_millis(200),
        login: Duration::from_secs(60),
        ..Timeouts::all(Duration::from_secs(60))
    };
    let mut session = ProviderSession::spawn_with(provider_command("hang-get"), timeouts)
        .expect("provider says hello");
    // a login the provider answers is not cut short by the get limit
    assert!(matches!(
        session.request(&login()).expect("login answered"),
        ProviderResponse::Ok(_)
    ));
    let error = session.request(&get(false)).expect_err("get hangs");
    assert!(timed_out(&error), "{error}");
}

#[test]
fn after_a_timeout_the_requests_queued_behind_it_fail() {
    let mut session =
        ProviderSession::spawn_with(provider_command("hang-get"), Timeouts::all(SHORT))
            .expect("provider says hello");
    assert!(timed_out(&session.request(&get(false)).unwrap_err()));
    // the same session, whatever the kind: the provider is gone
    for request in [get(false), login()] {
        assert!(matches!(
            session.request(&request),
            Err(ExchangeError::SessionEnded)
        ));
    }
    session.close().expect("a killed session closes quietly");
}

#[test]
fn an_exchange_and_a_chain_fail_on_a_timeout() {
    let error = run_exchange_with(
        provider_command("hang-get"),
        ClientScenario::InstallGet,
        Timeouts::all(SHORT),
    )
    .expect_err("the request fails");
    assert!(timed_out(&error), "{error}");

    // the chain stops: the next provider is not asked
    let error = run_provider_chain_with(
        vec![
            provider_command("hang-get"),
            provider_command("get-success"),
        ],
        ClientScenario::InstallGet,
        ChainKind::Global,
        Timeouts::all(SHORT),
    )
    .expect_err("the chain fails");
    assert!(timed_out(&error), "{error}");
}

#[test]
fn a_provider_killed_twice_is_not_started_again_and_a_fast_one_is_never_killed() {
    let starts = std::rc::Rc::new(std::cell::Cell::new(0_u32));
    let counted = starts.clone();
    let mut supervisor = ProviderSupervisor::new(
        move || {
            counted.set(counted.get() + 1);
            provider_command("hang-get")
        },
        Timeouts::all(SHORT),
    );
    // each request starts a new session and is killed
    for kills in 1..=generated::TIMEOUT_KILLS_BEFORE_NO_RESTART {
        let error = supervisor.request(&get(false)).unwrap_err();
        assert!(timed_out(&error), "{error}");
        assert_eq!(supervisor.kills(), kills);
    }
    let error = supervisor.request(&get(false)).unwrap_err();
    assert!(matches!(error, ExchangeError::NotRestarted), "{error}");
    assert_eq!(starts.get(), generated::TIMEOUT_KILLS_BEFORE_NO_RESTART);

    // a provider that answers keeps its one session
    let mut supervisor =
        ProviderSupervisor::new(|| provider_command("get-success"), Timeouts::all(SHORT));
    for _ in 0..3 {
        assert!(supervisor.request(&get(false)).is_ok());
    }
    assert_eq!(supervisor.kills(), 0);
}

#[test]
fn a_hello_timeout_counts_toward_the_kills() {
    let mut supervisor =
        ProviderSupervisor::new(|| provider_command("hang-hello"), Timeouts::all(SHORT));
    for _ in 0..generated::TIMEOUT_KILLS_BEFORE_NO_RESTART {
        assert!(timed_out(&supervisor.request(&get(false)).unwrap_err()));
    }
    assert!(matches!(
        supervisor.request(&get(false)),
        Err(ExchangeError::NotRestarted)
    ));
}
