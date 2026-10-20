use credential_provider_protocol::{
    ErrorKind, Granularity, Hello, Operation, ProtocolError, ProviderErr, ProviderOk,
    ProviderResponse, Request, RequestKind, generated::SENTINEL_ARGUMENT, read_json_line,
    write_json_line,
};
use std::io::{self, BufReader};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    // npm starts a provider with the sentinel first; anything else is a person
    // running the program, who gets its standalone mode, not the protocol
    if std::env::args().nth(1).as_deref() != Some(SENTINEL_ARGUMENT) {
        eprintln!("mock-provider: run by npm with {SENTINEL_ARGUMENT}; no standalone mode");
        std::process::exit(2);
    }
    let scenario = parse_scenario();

    if scenario == "no-hello" {
        return Ok(());
    }

    // `hang-<what>` never answers `<what>`, and serves everything else:
    // hello, get, get-interactive, erase, login, logout
    if scenario == "hang-hello" {
        hang();
    }

    if scenario == "version-mismatch" {
        write_json_line(
            &mut io::stdout(),
            &Hello {
                v: vec![2],
                capabilities: None,
                registries: None,
            },
        )?;
        return Ok(());
    }

    if scenario == "serves-elsewhere" {
        write_json_line(
            &mut io::stdout(),
            &Hello {
                registries: Some(vec!["https://other.example.test/".into()]),
                ..Hello::v1()
            },
        )?;
    } else {
        write_json_line(&mut io::stdout(), &Hello::v1())?;
    }

    let stdin = io::stdin();
    let mut reader = BufReader::new(stdin.lock());
    let mut served = 0_u32;
    loop {
        // A line that is not a request (not UTF-8 JSON, not an object, over the
        // size limit, against the schema) is answered with one `Err`, the line is
        // not echoed (a login carries a token), and the session goes on: Phase 2,
        // Session lifecycle.
        let request = match read_json_line::<Request>(&mut reader) {
            Ok(Some(request)) => request,
            Ok(None) => break,
            Err(ProtocolError::Io(error)) => return Err(error.into()),
            Err(ProtocolError::LineTooLong { limit }) => {
                refuse(format!("a line over {limit} bytes was rejected whole"))?;
                continue;
            }
            Err(_) => {
                refuse("malformed request: not UTF-8 JSON that is a request".into())?;
                continue;
            }
        };
        if let Err(problem) = request.validate_received() {
            refuse(format!("malformed request: {problem}"))?;
            continue;
        }
        served += 1;
        // A kind or operation this provider does not know comes from a newer
        // client; the answer is a structured refusal, never a crash or a guess.
        // An unknown operation in particular must not be served as a read.
        if request.kind == RequestKind::Unsupported
            || request.operation == Some(Operation::Unsupported)
        {
            write_json_line(
                &mut io::stdout(),
                &ProviderResponse::Err(ProviderErr {
                    kind: ErrorKind::OperationNotSupported,
                    message: None,
                    caused_by: None,
                }),
            )?;
            continue;
        }
        if let Some(what) = scenario.strip_prefix("hang-") {
            let asked = match (&request.kind, request.interactive) {
                (RequestKind::Get, Some(true)) => "get-interactive",
                (RequestKind::Get, _) => "get",
                (RequestKind::Login, _) => "login",
                (RequestKind::Logout, _) => "logout",
                (RequestKind::Erase, _) => "erase",
                (RequestKind::Unsupported, _) => "",
            };
            if what == asked {
                hang();
            }
            let response = match request.kind {
                RequestKind::Get => ProviderOk::bearer("test-token", Granularity::Scope),
                _ => ProviderOk::done(request.kind.clone()),
            };
            write_json_line(&mut io::stdout(), &ProviderResponse::Ok(response))?;
            continue;
        }
        if scenario == "invalid-json" {
            println!("{{not-json}}");
            continue;
        }
        if scenario == "both-ok-err" {
            println!(r#"{{"Ok":{{"kind":"login"}},"Err":{{"kind":"other"}}}}"#);
            continue;
        }
        if scenario == "malformed-auth" {
            println!(r#"{{"Ok":{{"kind":"get","auth":{{"type":"bearer"}}}}}}"#);
            continue;
        }

        let response = match scenario.as_str() {
            "not-found" => ProviderResponse::Err(ProviderErr {
                kind: ErrorKind::NotFound,
                message: None,
                caused_by: None,
            }),
            "url-not-supported" => ProviderResponse::Err(ProviderErr {
                kind: ErrorKind::UrlNotSupported,
                message: None,
                caused_by: None,
            }),
            "operation-not-supported" => ProviderResponse::Err(ProviderErr {
                kind: ErrorKind::OperationNotSupported,
                message: None,
                caused_by: None,
            }),
            "other-error" => ProviderResponse::Err(ProviderErr {
                kind: ErrorKind::Other,
                message: Some("provider failed".into()),
                caused_by: Some(vec!["test scenario".into()]),
            }),
            "expires-missing-expiration" => ProviderResponse::Ok(ProviderOk {
                expires_at: None,
                ..ProviderOk::expiring("test-token", 0)
            }),
            "expiring-token" => {
                ProviderResponse::Ok(ProviderOk::expiring("short-lived-token", 1_893_456_000))
            }
            "request-kind-success" => ProviderResponse::Ok(ProviderOk::done(request.kind.clone())),
            "session-counter" => ProviderResponse::Ok(ProviderOk::bearer(
                format!("token-{served}"),
                Granularity::Package,
            )),
            _ => ProviderResponse::Ok(ProviderOk::bearer("test-token", Granularity::Scope)),
        };
        write_json_line(&mut io::stdout(), &response)?;
    }

    Ok(())
}

/// Waits for the client to kill it.
fn hang() -> ! {
    loop {
        std::thread::sleep(std::time::Duration::from_secs(3600));
    }
}

fn parse_scenario() -> String {
    let mut args = std::env::args().skip(2);
    while let Some(arg) = args.next() {
        if arg == "--scenario" {
            return args.next().unwrap_or_else(|| "get-success".into());
        }
    }
    "get-success".into()
}

/// The one answer a line that is not a request gets.
fn refuse(message: String) -> Result<(), Box<dyn std::error::Error>> {
    write_json_line(
        &mut io::stdout(),
        &ProviderResponse::Err(ProviderErr {
            kind: ErrorKind::Other,
            message: Some(message),
            caused_by: None,
        }),
    )?;
    Ok(())
}
