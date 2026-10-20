use credential_provider_protocol::{
    ErrorKind, Granularity, Hello, Operation, ProtocolError, ProviderResponse, Request,
    RequestKind, generated, generated::SENTINEL_ARGUMENT, negotiate, read_json_line,
    write_json_line,
};
use std::fmt;
use std::io::{BufReader, Read, Write};
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

/// What to start for a provider: the program, and the arguments configured for
/// it. npm puts the sentinel `--npm-credential-provider` between them, so a
/// provider can tell protocol mode from a standalone run.
pub struct ProviderCommand {
    pub program: Command,
    pub args: Vec<String>,
}

impl ProviderCommand {
    pub fn new(program: Command, args: Vec<String>) -> Self {
        Self { program, args }
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
    pub hello: Option<Hello>,
}

impl ProviderSession {
    pub fn spawn(provider: ProviderCommand) -> Result<Self, ExchangeError> {
        let ProviderCommand {
            program: mut command,
            args,
        } = provider;
        command
            .arg(SENTINEL_ARGUMENT)
            .args(args)
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
            hello: None,
        };

        let hello = read_json_line::<Hello>(&mut session.reader)?
            .ok_or_else(|| ExchangeError::Provider("provider exited before hello".into()))?;
        session.version = negotiate(&hello)?;
        session.capabilities = hello.capabilities.clone().unwrap_or_default();
        session.hello = Some(hello);
        Ok(session)
    }

    /// Whether the provider's hello leaves `registry` in; a registry it leaves
    /// out counts as `url-not-supported`, and the provider is sent nothing.
    pub fn serves(&self, registry: &str) -> bool {
        self.hello
            .as_ref()
            .is_none_or(|hello| hello.serves(registry))
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

    /// Writes bytes to the provider as they are, newline and all, and reads no
    /// answer: for a line that is not a request, or a blank one that gets none.
    pub fn write_raw(&mut self, bytes: &[u8]) -> Result<(), ExchangeError> {
        let stdin = self
            .stdin
            .as_mut()
            .ok_or(ExchangeError::MissingPipe("stdin"))?;
        stdin
            .write_all(bytes)
            .and_then(|()| stdin.flush())
            .map_err(|error| ExchangeError::ProcessFailed(error.to_string()))
    }

    /// Reads the provider's next answer, whatever it is an answer to.
    pub fn read_answer(&mut self) -> Result<ProviderResponse, ExchangeError> {
        read_json_line::<ProviderResponse>(&mut self.reader)?
            .ok_or_else(|| ExchangeError::Provider("provider exited before response".into()))
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
    /// A test harness waits to check the exit; npm need not wait for the
    /// provider at all, so a provider cannot count on work after this.
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
    provider_command: ProviderCommand,
    scenario: ClientScenario,
) -> Result<ExchangeSummary, ExchangeError> {
    let mut session = ProviderSession::spawn(provider_command)?;
    let request = request_for(scenario);
    if !session.serves(&request.registry) {
        let selected_version = session.version;
        session.close()?;
        return Ok(ExchangeSummary {
            selected_version,
            outcome: "try-next-provider".into(),
            provider_index: 0,
        });
    }
    let response = session.request(&request)?;
    let outcome = summarize(&request.kind, &response)?;
    let selected_version = session.version;
    session.close()?;

    Ok(ExchangeSummary {
        selected_version,
        outcome,
        provider_index: 0,
    })
}

/// Which list the providers came from: the unscoped global chain, or a
/// per-registry list, which the user tied to this registry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChainKind {
    Global,
    PerRegistry,
}

/// Tries providers in order, as Cargo does: `url-not-supported` and
/// `not-found` move on, anything else stops. A global chain that every
/// provider declined leaves the registry without a provider (outcome
/// `as-no-provider`: npm's behaviour today); a per-registry list that does the
/// same fails, and so does a chain in which someone answered `not-found`
/// (the legacy opt-in is the model's business, not this mock's).
pub fn run_provider_chain(
    provider_commands: Vec<ProviderCommand>,
    scenario: ClientScenario,
    kind: ChainKind,
) -> Result<ExchangeSummary, ExchangeError> {
    let mut not_found = false;
    let mut selected_version = 0;
    for (provider_index, provider_command) in provider_commands.into_iter().enumerate() {
        let mut summary = run_exchange(provider_command, scenario)?;
        selected_version = summary.selected_version;
        match summary.outcome.as_str() {
            "try-next-provider" => continue,
            "try-next-provider-not-found" => {
                not_found = true;
                continue;
            }
            _ => {}
        }
        summary.provider_index = provider_index;
        return Ok(summary);
    }

    if not_found {
        return Err(ExchangeError::Provider(
            "not-found: no provider had a credential, and there is no explicit legacy fallback"
                .into(),
        ));
    }
    match kind {
        ChainKind::Global => Ok(ExchangeSummary {
            selected_version,
            outcome: "as-no-provider".into(),
            provider_index: 0,
        }),
        ChainKind::PerRegistry => Err(ExchangeError::Provider(
            "no credential provider in the per-registry list could handle the registry".into(),
        )),
    }
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
            package: Some("package".into()),
            operation: Some(Operation::Read),
            granularity: Some(Granularity::Scope),
            command: Some("install".into()),
            ..Request::bare(RequestKind::Erase, registry)
        },
    }
}

fn summarize(request: &RequestKind, response: &ProviderResponse) -> Result<String, ExchangeError> {
    if let (RequestKind::Erase, ProviderResponse::Err(err)) = (request, response) {
        // the cache already dropped the credential; whatever the provider says
        // about forgetting it, the retry still goes out
        return Ok(erase_error_outcome(&err.kind).into());
    }
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
            ErrorKind::NotFound => Ok("try-next-provider-not-found".into()),
            ErrorKind::OperationNotSupported => {
                Err(ExchangeError::Provider("operation-not-supported".into()))
            }
            ErrorKind::Other => Err(ExchangeError::Provider(
                err.message.clone().unwrap_or_else(|| "other".into()),
            )),
        },
    }
}

fn erase_error_outcome(kind: &ErrorKind) -> &'static str {
    let name = match kind {
        ErrorKind::UrlNotSupported => "url-not-supported",
        ErrorKind::NotFound => "not-found",
        ErrorKind::OperationNotSupported => "operation-not-supported",
        ErrorKind::Other => "other",
    };
    generated::ERASE_ERROR_OUTCOMES
        .iter()
        .find(|(error, _)| *error == name)
        .map(|(_, outcome)| *outcome)
        .expect("the policy names an erase outcome for every error kind")
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

#[cfg(test)]
mod tests {
    use super::*;
    use credential_provider_protocol::ProviderErr;

    fn err(kind: ErrorKind) -> ProviderResponse {
        ProviderResponse::Err(ProviderErr {
            kind,
            message: Some("boom".into()),
            caused_by: None,
        })
    }

    #[test]
    fn an_error_answer_to_erase_still_lets_the_retry_go_out() {
        for (kind, outcome) in [
            (ErrorKind::UrlNotSupported, "ignore-and-retry"),
            (ErrorKind::NotFound, "ignore-and-retry"),
            (ErrorKind::OperationNotSupported, "ignore-and-retry"),
            (ErrorKind::Other, "warn-and-retry"),
        ] {
            assert_eq!(summarize(&RequestKind::Erase, &err(kind)).unwrap(), outcome);
        }
    }

    #[test]
    fn an_error_answer_to_get_keeps_failing() {
        assert!(summarize(&RequestKind::Get, &err(ErrorKind::Other)).is_err());
        assert!(summarize(&RequestKind::Get, &err(ErrorKind::OperationNotSupported)).is_err());
    }
}
