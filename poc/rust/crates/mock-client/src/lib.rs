use credential_provider_protocol::{
    Action, ErrorKind, Hello, PackageContext, ProtocolError, ProviderResponse, Request, negotiate,
    read_json_line, write_json_line,
};
use std::fmt;
use std::io::{BufReader, Write};
use std::process::{Command, Stdio};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClientScenario {
    InstallGet,
    Refresh,
    BatchInstall,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExchangeSummary {
    pub selected_version: u32,
    pub outcome: String,
}

#[derive(Debug)]
pub enum ExchangeError {
    Protocol(ProtocolError),
    Provider(String),
    MissingPipe(&'static str),
    ProcessFailed(String),
}

impl fmt::Display for ExchangeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Protocol(error) => write!(f, "{error}"),
            Self::Provider(message) => write!(f, "provider error: {message}"),
            Self::MissingPipe(pipe) => write!(f, "missing provider {pipe} pipe"),
            Self::ProcessFailed(message) => write!(f, "provider process failed: {message}"),
        }
    }
}

impl std::error::Error for ExchangeError {}

impl From<ProtocolError> for ExchangeError {
    fn from(value: ProtocolError) -> Self {
        Self::Protocol(value)
    }
}

pub fn run_exchange(
    mut provider_command: Command,
    scenario: ClientScenario,
) -> Result<ExchangeSummary, ExchangeError> {
    provider_command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = provider_command
        .spawn()
        .map_err(|error| ExchangeError::ProcessFailed(error.to_string()))?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or(ExchangeError::MissingPipe("stdin"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or(ExchangeError::MissingPipe("stdout"))?;
    let mut reader = BufReader::new(stdout);

    let hello = read_json_line::<Hello>(&mut reader)?
        .ok_or_else(|| ExchangeError::Provider("provider exited before hello".into()))?;
    let selected_version = negotiate(&hello)?;

    let request = request_for(scenario);
    request.validate()?;
    write_json_line(&mut stdin, &request)?;
    stdin
        .flush()
        .map_err(|error| ExchangeError::ProcessFailed(error.to_string()))?;
    drop(stdin);

    let response = read_json_line::<ProviderResponse>(&mut reader)?
        .ok_or_else(|| ExchangeError::Provider("provider exited before response".into()))?;
    response.validate_for(&request.action)?;
    let outcome = summarize(&request, &response)?;

    let output = child
        .wait_with_output()
        .map_err(|error| ExchangeError::ProcessFailed(error.to_string()))?;
    if !output.status.success() {
        return Err(ExchangeError::ProcessFailed(
            String::from_utf8_lossy(&output.stderr).into_owned(),
        ));
    }

    Ok(ExchangeSummary {
        selected_version,
        outcome,
    })
}

fn request_for(scenario: ClientScenario) -> Request {
    match scenario {
        ClientScenario::InstallGet => {
            Request::get_install("https://registry.example.test/", Some("@scope"), "package")
        }
        ClientScenario::Refresh => {
            Request::refresh("https://registry.example.test/", "opaque-refresh-token")
        }
        ClientScenario::BatchInstall => Request::get_batch(
            "https://registry.example.test/",
            vec![
                PackageContext {
                    scope: Some("@scope".into()),
                    package: "api-client".into(),
                },
                PackageContext {
                    scope: Some("@scope".into()),
                    package: "ui".into(),
                },
            ],
        ),
    }
}

fn summarize(request: &Request, response: &ProviderResponse) -> Result<String, ExchangeError> {
    match response {
        ProviderResponse::Ok(ok) => {
            if request.action == Action::GetBatch {
                let count = ok.results.as_ref().map_or(0, Vec::len);
                return Ok(format!("batch:{count}"));
            }
            Ok("ok".into())
        }
        ProviderResponse::Err(err) => match err.kind {
            ErrorKind::UrlNotSupported => Ok("try-next-provider".into()),
            ErrorKind::NotFound => Err(ExchangeError::Provider(
                "not-found fails closed without explicit legacy fallback".into(),
            )),
            ErrorKind::OperationNotSupported => {
                Err(ExchangeError::Provider("operation-not-supported".into()))
            }
            ErrorKind::Other => Err(ExchangeError::Provider(
                err.message.clone().unwrap_or_else(|| "other".into()),
            )),
        },
    }
}
