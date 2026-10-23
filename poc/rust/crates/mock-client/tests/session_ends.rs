//! What ends a provider session and what npm does about it (Phase 2, Session
//! lifecycle): the policy's table (`credentialProvider.sessionEnds`, generated
//! into `generated::SESSION_ENDS`) held against `ProviderSupervisor`, one case
//! for each cause. A case that is not in the table, or a cause of the table
//! without a case, fails the first test.

use credential_provider_protocol::{ProviderResponse, Request, generated};
use mock_client::{ExchangeError, Idle, ProviderSupervisor, Timeouts};
use std::cell::Cell;
use std::rc::Rc;
use std::time::Duration;

mod common;
use common::provider_command;

const REGISTRY: &str = "https://registry.example.test/";
/// Long enough for a provider that answers, short enough for the suite.
const SHORT: Duration = Duration::from_millis(400);
/// For a line or an exit that has to arrive: a wait that ends the moment it does.
const UNTIL_SEEN: Duration = Duration::from_secs(20);

fn get() -> Request {
    Request {
        interactive: Some(false),
        ..Request::get_install(REGISTRY, Some("@scope"), "pkg")
    }
}

fn timeouts() -> Timeouts {
    Timeouts {
        hello: Duration::from_secs(30),
        ..Timeouts::all(SHORT)
    }
}

/// A supervisor whose process for the n-th start runs `scenarios[n]` (the last
/// one after that), and the number of processes it started.
fn supervisor(scenarios: &[&'static str]) -> (ProviderSupervisor, Rc<Cell<usize>>) {
    let starts = Rc::new(Cell::new(0_usize));
    let counted = Rc::clone(&starts);
    let scenarios = scenarios.to_vec();
    let supervisor = ProviderSupervisor::new(
        move || {
            let at = counted.get();
            counted.set(at + 1);
            provider_command(scenarios[at.min(scenarios.len() - 1)])
        },
        timeouts(),
    )
    .named("npm-credential-provider-test");
    (supervisor, starts)
}

fn answered(result: &Result<ProviderResponse, ExchangeError>) -> bool {
    matches!(result, Ok(ProviderResponse::Ok(_)))
}

/// What happened for one cause: whether a request failed, and what the supervisor
/// held afterwards.
struct Observed {
    request_failed: Option<bool>,
    running: bool,
    kills: u32,
    next: &'static str,
}

/// Drives one cause with the scenario that causes it, then makes the next
/// request and says what it got.
fn drive(cause: &str) -> Observed {
    let (mut supervisor, starts) = match cause {
        "timeout" => supervisor(&["hang-get", "get-success"]),
        "exit-outstanding" => supervisor(&["exit-on-request", "get-success"]),
        "oversized-line" => supervisor(&["oversized-answer", "get-success"]),
        "malformed-message" => supervisor(&["both-ok-err", "get-success"]),
        "stray-line" => supervisor(&["extra-line", "get-success"]),
        "exit-idle" => supervisor(&["exit-after-answer", "get-success"]),
        "hello-failed" => supervisor(&["version-mismatch", "get-success"]),
        "error-answer" => supervisor(&["other-error"]),
        other => panic!("no case for the cause {other}: write one"),
    };
    let first = supervisor.request(&get());
    let request_failed = match cause {
        // no request is in flight when these happen: the first one is answered
        // and the provider misbehaves afterwards
        "stray-line" => {
            assert!(answered(&first), "{first:?}");
            assert_eq!(supervisor.watch_idle(UNTIL_SEEN), Idle::Stray);
            None
        }
        "exit-idle" => {
            assert!(answered(&first), "{first:?}");
            assert_eq!(supervisor.watch_idle(UNTIL_SEEN), Idle::Exited);
            None
        }
        "error-answer" => {
            assert!(matches!(first, Ok(ProviderResponse::Err(_))), "{first:?}");
            Some(true)
        }
        _ => {
            assert!(first.is_err(), "{cause}: {first:?}");
            Some(true)
        }
    };
    let running = supervisor.is_running();
    let kills = supervisor.kills();
    let started = starts.get();
    let second = supervisor.request(&get());
    let next = match second {
        Err(ExchangeError::Skipped) | Err(ExchangeError::NotRestarted) => "skipped",
        _ if starts.get() > started => "new-process",
        _ => "same-process",
    };
    Observed {
        request_failed,
        running,
        kills,
        next,
    }
}

#[test]
fn every_cause_does_what_the_policy_table_says() {
    let mut seen = Vec::new();
    for (cause, request, session, next, counts) in generated::SESSION_ENDS {
        seen.push(*cause);
        let observed = drive(cause);
        assert_eq!(
            observed
                .request_failed
                .map(|failed| if failed { "fails" } else { "none" }),
            Some(*request).filter(|request| *request != "none"),
            "{cause}: the request in flight"
        );
        assert_eq!(
            if observed.running {
                "continues"
            } else {
                "ends"
            },
            *session,
            "{cause}: the session"
        );
        assert_eq!(observed.next, *next, "{cause}: the next request");
        assert_eq!(
            observed.kills,
            u32::from(*counts),
            "{cause}: whether it counts"
        );
    }
    assert_eq!(seen.len(), 8, "a cause without a case: {seen:?}");
}

#[test]
fn a_stray_line_is_warned_about_by_name_and_fails_no_request() {
    let (mut supervisor, _) = supervisor(&["extra-line", "get-success"]);
    assert!(answered(&supervisor.request(&get())));

    assert_eq!(supervisor.watch_idle(UNTIL_SEEN), Idle::Stray);

    assert_eq!(supervisor.warnings().len(), 1);
    assert!(
        supervisor.warnings()[0].contains("npm-credential-provider-test"),
        "{:?}",
        supervisor.warnings()
    );
    // the command goes on: the next request is served by a new process
    assert!(answered(&supervisor.request(&get())));
}

#[test]
fn a_provider_that_exits_while_idle_is_no_failure_however_often() {
    let (mut supervisor, starts) = supervisor(&["exit-after-answer"]);
    for _ in 0..(generated::FAILED_SESSIONS_BEFORE_NO_RESTART + 3) {
        assert!(answered(&supervisor.request(&get())));
        assert_eq!(supervisor.watch_idle(UNTIL_SEEN), Idle::Exited);
    }
    assert_eq!(supervisor.kills(), 0);
    assert_eq!(
        starts.get(),
        (generated::FAILED_SESSIONS_BEFORE_NO_RESTART + 3) as usize
    );
    assert!(supervisor.warnings().is_empty());
}

#[test]
fn the_limit_counts_every_failing_cause_together() {
    // a process that exits with a request outstanding, then one that writes
    // a line over the limit: two failed sessions, whatever the causes
    let (mut supervisor, starts) =
        supervisor(&["exit-on-request", "oversized-answer", "get-success"]);
    assert!(supervisor.request(&get()).is_err());
    assert!(supervisor.request(&get()).is_err());
    assert_eq!(
        supervisor.kills(),
        generated::FAILED_SESSIONS_BEFORE_NO_RESTART
    );

    let error = supervisor.request(&get()).unwrap_err();

    assert!(matches!(error, ExchangeError::NotRestarted), "{error}");
    assert_eq!(starts.get(), 2, "the third process was never started");
}

#[test]
fn an_idle_exit_does_not_use_up_a_count_a_failure_needs() {
    let (mut supervisor, starts) = supervisor(&["exit-after-answer", "hang-get", "get-success"]);
    assert!(answered(&supervisor.request(&get())));
    assert_eq!(supervisor.watch_idle(UNTIL_SEEN), Idle::Exited);
    // one failure: still allowed another process
    assert!(supervisor.request(&get()).is_err());
    assert_eq!(supervisor.kills(), 1);
    assert!(answered(&supervisor.request(&get())));
    assert_eq!(starts.get(), 3);
}

#[test]
fn a_wrong_kind_in_an_answer_ends_the_session_and_counts() {
    // an `Ok` of another kind than the request's is a malformed message
    let (mut supervisor, starts) = supervisor(&["wrong-kind", "get-success"]);
    let error = supervisor.request(&get()).unwrap_err();
    assert!(error.to_string().contains("invalid message"), "{error}");
    assert!(!supervisor.is_running());
    assert_eq!(supervisor.kills(), 1);
    assert!(answered(&supervisor.request(&get())));
    assert_eq!(starts.get(), 2);
}

#[test]
fn a_skipped_provider_is_never_started_again() {
    for scenario in ["version-mismatch", "no-hello"] {
        let (mut supervisor, starts) = supervisor(&[scenario]);
        assert!(supervisor.request(&get()).is_err(), "{scenario}");
        for _ in 0..3 {
            let error = supervisor.request(&get()).unwrap_err();
            assert!(
                matches!(error, ExchangeError::Skipped),
                "{scenario}: {error}"
            );
        }
        assert_eq!((starts.get(), supervisor.kills()), (1, 0), "{scenario}");
    }
}

#[test]
fn a_provider_that_cannot_be_started_is_skipped_too() {
    let starts = Rc::new(Cell::new(0_u32));
    let counted = Rc::clone(&starts);
    let mut supervisor = ProviderSupervisor::new(
        move || {
            counted.set(counted.get() + 1);
            mock_client::ProviderCommand::new(
                std::process::Command::new("this-provider-does-not-exist"),
                Vec::new(),
            )
        },
        timeouts(),
    );
    assert!(supervisor.request(&get()).is_err());
    assert!(matches!(
        supervisor.request(&get()),
        Err(ExchangeError::Skipped)
    ));
    assert_eq!(starts.get(), 1);
}

#[test]
fn an_error_answer_leaves_the_session_for_the_next_request() {
    let (mut supervisor, starts) = supervisor(&["not-found"]);
    for _ in 0..5 {
        assert!(matches!(
            supervisor.request(&get()),
            Ok(ProviderResponse::Err(_))
        ));
    }
    assert_eq!((starts.get(), supervisor.kills()), (1, 0));
}
