use credential_provider_protocol::{
    ErrorKind, Granularity, Hello, ProviderErr, ProviderOk, ProviderResponse, Request, TokenResult,
    read_json_line, write_json_line,
};
use std::io::{self, BufReader};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let scenario = parse_scenario();

    if scenario == "version-mismatch" {
        write_json_line(&mut io::stdout(), &Hello { v: vec![2] })?;
        return Ok(());
    }

    write_json_line(&mut io::stdout(), &Hello::v1())?;

    let stdin = io::stdin();
    let mut reader = BufReader::new(stdin.lock());
    while let Some(request) = read_json_line::<Request>(&mut reader)? {
        let response = match scenario.as_str() {
            "not-found" => ProviderResponse::Err(ProviderErr {
                kind: ErrorKind::NotFound,
                message: None,
                caused_by: None,
            }),
            "refresh-success" => ProviderResponse::Ok(ProviderOk::refreshed(
                "refreshed-token",
                request
                    .refresh_token
                    .clone()
                    .unwrap_or_else(|| "opaque-refresh-token".into()),
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
