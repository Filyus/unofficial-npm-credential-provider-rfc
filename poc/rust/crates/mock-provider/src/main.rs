use credential_provider_protocol::{
    ErrorKind, Granularity, Hello, Operation, ProviderErr, ProviderOk, ProviderResponse, Request,
    RequestKind, read_json_line, write_json_line,
};
use std::io::{self, BufReader};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let scenario = parse_scenario();

    if scenario == "no-hello" {
        return Ok(());
    }

    if scenario == "version-mismatch" {
        write_json_line(
            &mut io::stdout(),
            &Hello {
                v: vec![2],
                capabilities: None,
            },
        )?;
        return Ok(());
    }

    write_json_line(&mut io::stdout(), &Hello::v1())?;

    let stdin = io::stdin();
    let mut reader = BufReader::new(stdin.lock());
    let mut served = 0_u32;
    while let Some(request) = read_json_line::<Request>(&mut reader)? {
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

fn parse_scenario() -> String {
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        if arg == "--scenario" {
            return args.next().unwrap_or_else(|| "get-success".into());
        }
    }
    "get-success".into()
}
