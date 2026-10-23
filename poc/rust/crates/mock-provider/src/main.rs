use credential_provider_protocol::{
    ErrorKind, Granularity, Hello, Operation, ProtocolError, ProviderErr, ProviderOk,
    ProviderResponse, Request, RequestKind, generated::SENTINEL_ARGUMENT, read_json_line,
    write_json_line,
};
use std::io::{self, BufReader, Write};

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
    } else if scenario == "lists-other-form" {
        // lists the `http:` form of the host the client asks about over `https:`
        write_json_line(
            &mut io::stdout(),
            &Hello {
                registries: Some(vec!["http://registry.example.test/".into()]),
                ..Hello::v1()
            },
        )?;
    } else if scenario == "bom-and-blank-lines" {
        // a byte order mark before the first line, a carriage return before
        // each newline, and blank lines between the messages: a client reads
        // all of that as the hello and the answers, and none as a stray line
        let mut stdout = io::stdout();
        stdout.write_all(b"\xEF\xBB\xBF{\"v\":[1]}\r\n\n  \r\n")?;
        stdout.flush()?;
    } else {
        write_json_line(&mut io::stdout(), &Hello::v1())?;
    }

    // a provider's diagnostics go to stderr, which npm logs
    if scenario == "stderr-note" {
        eprintln!("a note on stderr");
    }

    // says hello and then reads nothing: a client writing it a large request
    // blocks on the full pipe
    if scenario == "no-read" {
        hang();
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
            Ok(None) if scenario == "hang-on-close" => hang(),
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
        // answers, then exits: the end of a session that is no failure when it
        // comes while no request is outstanding
        if scenario == "exit-after-answer" {
            write_json_line(
                &mut io::stdout(),
                &ProviderResponse::Ok(ProviderOk::bearer("test-token", Granularity::Scope)),
            )?;
            return Ok(());
        }
        // reads a request and exits without answering it
        if scenario == "exit-on-request" {
            return Ok(());
        }
        // an answer over the line limit
        if scenario == "oversized-answer" {
            let mut stdout = io::stdout();
            stdout.write_all(&vec![b'x'; 2 * 1024 * 1024])?;
            stdout.write_all(b"\n")?;
            stdout.flush()?;
            continue;
        }
        // an `Ok` of another kind than the request's
        if scenario == "wrong-kind" {
            write_json_line(
                &mut io::stdout(),
                &ProviderResponse::Ok(ProviderOk::done(RequestKind::Login)),
            )?;
            continue;
        }
        // valid JSON of the wrong shape, with a string in it that stands for a
        // credential: what a client reports of the line must not quote it
        if scenario == "secret-in-wrong-field" {
            println!(r#"{{"Ok":{{"kind":"get","auth":"super-secret-token"}}}}"#);
            continue;
        }
        // answers, then blank lines, which are no stray lines
        if scenario == "bom-and-blank-lines" {
            let ok = ProviderResponse::Ok(ProviderOk::bearer("test-token", Granularity::Scope));
            let mut both = Vec::new();
            write_json_line(&mut both, &ok)?;
            both.extend_from_slice(b"\n \t\r\n");
            let mut stdout = io::stdout();
            stdout.write_all(&both)?;
            stdout.flush()?;
            continue;
        }
        // on the second request, writes a line nobody asked for and then the
        // answer: the client cannot tell the first from the answer and takes
        // it for one (the limit the specification states)
        if scenario == "stale-line-before-answer" && served == 2 {
            let mut both = Vec::new();
            write_json_line(
                &mut both,
                &ProviderResponse::Ok(ProviderOk::bearer("stale-token", Granularity::Scope)),
            )?;
            write_json_line(
                &mut both,
                &ProviderResponse::Ok(ProviderOk::bearer("real-token", Granularity::Scope)),
            )?;
            let mut stdout = io::stdout();
            stdout.write_all(&both)?;
            stdout.flush()?;
            continue;
        }
        // answers, and sends a second line nobody asked for, in one write
        if scenario == "extra-line" {
            let ok = ProviderResponse::Ok(ProviderOk::bearer("test-token", Granularity::Scope));
            let mut both = Vec::new();
            write_json_line(&mut both, &ok)?;
            write_json_line(&mut both, &ok)?;
            let mut stdout = io::stdout();
            stdout.write_all(&both)?;
            stdout.flush()?;
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
        // values of known fields that a newer provider may add: what npm reads
        // them as is the client's business
        if scenario == "unknown-error-kind" {
            println!(r#"{{"Err":{{"kind":"permission-denied"}}}}"#);
            continue;
        }
        if scenario == "unknown-cache-and-granularity" {
            println!(
                r#"{{"Ok":{{"kind":"get","auth":{{"type":"bearer","token":"test-token"}},"cache":"lease","granularity":"host"}}}}"#
            );
            continue;
        }
        if scenario == "unknown-auth-type" {
            println!(r#"{{"Ok":{{"kind":"get","auth":{{"type":"digest","realm":"r"}}}}}}"#);
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
