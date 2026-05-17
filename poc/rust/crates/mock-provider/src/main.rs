use credential_provider_protocol::{
    ErrorKind, Granularity, Hello, ProviderErr, ProviderOk, ProviderResponse, Request, RequestKind,
    TokenResult, read_json_line, write_json_line,
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
    while let Some(request) = read_json_line::<Request>(&mut reader)? {
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
                kind: RequestKind::Get,
                auth: Some(credential_provider_protocol::Auth::Bearer {
                    token: "test-token".into(),
                }),
                cache: Some(credential_provider_protocol::CachePolicy::Expires),
                expires_at: None,
                operation_independent: None,
                refresh_state: None,
                granularity: Some(Granularity::Scope),
                results: None,
            }),
            "refresh-success" => ProviderResponse::Ok(ProviderOk::refreshed(
                "refreshed-token",
                request
                    .refresh_state
                    .clone()
                    .unwrap_or_else(|| "opaque-provider-handle".into()),
            )),
            "batch-success" => {
                let packages = request.packages.clone().unwrap_or_default();
                let results = packages
                    .into_iter()
                    .map(|package| TokenResult {
                        auth: credential_provider_protocol::Auth::Bearer {
                            token: format!("token-for-{}", package.package),
                        },
                        granularity: Some(Granularity::Package),
                    })
                    .collect();
                ProviderResponse::Ok(ProviderOk::batch(results))
            }
            "batch-count-mismatch" => ProviderResponse::Ok(ProviderOk::batch(vec![TokenResult {
                auth: credential_provider_protocol::Auth::Bearer {
                    token: "only-one".into(),
                },
                granularity: Some(Granularity::Package),
            }])),
            "request-kind-success" => ProviderResponse::Ok(ProviderOk {
                kind: request.kind.clone(),
                auth: None,
                cache: None,
                expires_at: None,
                operation_independent: None,
                refresh_state: None,
                granularity: None,
                results: None,
            }),
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
