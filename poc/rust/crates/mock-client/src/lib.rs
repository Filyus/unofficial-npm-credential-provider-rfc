use credential_provider_protocol::{
    ErrorKind, Hello, ProtocolError, ProviderResponse, Request, RequestKind, negotiate,
    read_json_line, write_json_line,
};
use std::fmt;
use std::io::{BufReader, Read};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClientScenario {
    InstallGet,
    PublishGet,
    Login,
    Logout,
    Erase,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExchangeSummary {
    pub selected_version: u32,
    pub outcome: String,
    pub provider_index: usize,
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

/// One provider process for the lifetime of an npm command: spawned once,
/// asked any number of strictly sequential requests, ended by closing stdin.
/// Dropping a session without `close` kills the process.
pub struct ProviderSession {
    child: Child,
    stdin: Option<ChildStdin>,
    reader: BufReader<ChildStdout>,
    pub version: u32,
    pub capabilities: Vec<String>,
}

impl ProviderSession {
    pub fn spawn(mut command: Command) -> Result<Self, ExchangeError> {
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = command
            .spawn()
            .map_err(|error| ExchangeError::ProcessFailed(error.to_string()))?;
        let stdin = child
            .stdin
            .take()
            .ok_or(ExchangeError::MissingPipe("stdin"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or(ExchangeError::MissingPipe("stdout"))?;
        let mut session = Self {
            child,
            stdin: Some(stdin),
            reader: BufReader::new(stdout),
            version: 0,
            capabilities: Vec::new(),
        };

        let hello = read_json_line::<Hello>(&mut session.reader)?
            .ok_or_else(|| ExchangeError::Provider("provider exited before hello".into()))?;
        session.version = negotiate(&hello)?;
        session.capabilities = hello.capabilities.unwrap_or_default();
        Ok(session)
    }

    pub fn request(&mut self, request: &Request) -> Result<ProviderResponse, ExchangeError> {
        request.validate()?;
        let response = self.exchange(request)?;
        response.validate_for(&request.kind)?;
        Ok(response)
    }

    /// Sends a message that need not be a valid client request, to check how a
    /// provider treats input from a newer client. Not something npm would send.
    pub fn send_raw(
        &mut self,
        message: &serde_json::Value,
    ) -> Result<ProviderResponse, ExchangeError> {
        self.exchange(message)
    }

    fn exchange<T: serde::Serialize>(
        &mut self,
        message: &T,
    ) -> Result<ProviderResponse, ExchangeError> {
        let stdin = self
            .stdin
            .as_mut()
            .ok_or(ExchangeError::MissingPipe("stdin"))?;
        write_json_line(stdin, message)?;
        read_json_line::<ProviderResponse>(&mut self.reader)?
            .ok_or_else(|| ExchangeError::Provider("provider exited before response".into()))
    }

    /// Closes stdin, the end-of-session signal, and requires a clean exit.
    pub fn close(mut self) -> Result<(), ExchangeError> {
        drop(self.stdin.take());
        let mut stderr = String::new();
        if let Some(mut pipe) = self.child.stderr.take() {
            pipe.read_to_string(&mut stderr)
                .map_err(|error| ExchangeError::ProcessFailed(error.to_string()))?;
        }
        let status = self
            .child
            .wait()
            .map_err(|error| ExchangeError::ProcessFailed(error.to_string()))?;
        if !status.success() {
            return Err(ExchangeError::ProcessFailed(stderr));
        }
        Ok(())
    }
}

impl Drop for ProviderSession {
    fn drop(&mut self) {
        if matches!(self.child.try_wait(), Ok(None)) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

pub fn run_exchange(
    provider_command: Command,
    scenario: ClientScenario,
) -> Result<ExchangeSummary, ExchangeError> {
    let mut session = ProviderSession::spawn(provider_command)?;
    let request = request_for(scenario);
    let response = session.request(&request)?;
    let outcome = summarize(&response)?;
    let selected_version = session.version;
    session.close()?;

    Ok(ExchangeSummary {
        selected_version,
        outcome,
        provider_index: 0,
    })
}

pub fn run_provider_chain(
    provider_commands: Vec<Command>,
    scenario: ClientScenario,
) -> Result<ExchangeSummary, ExchangeError> {
    for (provider_index, provider_command) in provider_commands.into_iter().enumerate() {
        let mut summary = run_exchange(provider_command, scenario)?;
        if summary.outcome == "try-next-provider" {
            continue;
        }
        summary.provider_index = provider_index;
        return Ok(summary);
    }

    Err(ExchangeError::Provider(
        "all providers returned url-not-supported".into(),
    ))
}

fn request_for(scenario: ClientScenario) -> Request {
    let registry = "https://registry.example.test/";
    match scenario {
        ClientScenario::InstallGet => Request::get_install(registry, Some("@scope"), "package"),
        ClientScenario::PublishGet => {
            Request::get_publish(registry, Some("@scope"), "package", "1.2.3")
        }
        ClientScenario::Login => Request {
            interactive: Some(true),
            ..Request::bare(RequestKind::Login, registry)
        },
        ClientScenario::Logout => Request::bare(RequestKind::Logout, registry),
        ClientScenario::Erase => Request {
            scope: Some("@scope".into()),
            command: Some("install".into()),
            ..Request::bare(RequestKind::Erase, registry)
        },
    }
}

fn summarize(response: &ProviderResponse) -> Result<String, ExchangeError> {
    match response {
        ProviderResponse::Ok(ok) => {
            if matches!(
                ok.kind,
                RequestKind::Login | RequestKind::Logout | RequestKind::Erase
            ) {
                return Ok(kind_name(&ok.kind).into());
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

fn kind_name(kind: &RequestKind) -> &'static str {
    match kind {
        RequestKind::Login => "login",
        RequestKind::Logout => "logout",
        RequestKind::Get => "get",
        RequestKind::Erase => "erase",
        RequestKind::Unsupported => "unsupported",
    }
}
