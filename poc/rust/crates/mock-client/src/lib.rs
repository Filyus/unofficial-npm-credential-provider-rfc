use credential_provider_protocol::{
    ErrorKind, Granularity, Hello, Operation, ProtocolError, ProviderResponse, Request,
    RequestKind, generated, generated::SENTINEL_ARGUMENT, negotiate, read_json_line,
    write_json_line,
};
use std::fmt;
use std::io::{BufReader, Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::thread;
use std::time::{Duration, Instant};

/// The time a provider gets to answer, per kind of wait. The default is the
/// policy's (`spec/policy-v1.json`, `credentialProvider.timeoutSeconds`, through
/// the generated constants); a test builds a smaller one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Timeouts {
    pub hello: Duration,
    pub get: Duration,
    pub get_interactive: Duration,
    pub erase: Duration,
    pub login: Duration,
    pub logout: Duration,
}

impl Timeouts {
    /// The limits of the policy.
    pub const fn policy() -> Self {
        Self {
            hello: Duration::from_secs(generated::HELLO_TIMEOUT_SECONDS),
            get: Duration::from_secs(generated::GET_TIMEOUT_SECONDS),
            get_interactive: Duration::from_secs(generated::GET_INTERACTIVE_TIMEOUT_SECONDS),
            erase: Duration::from_secs(generated::ERASE_TIMEOUT_SECONDS),
            login: Duration::from_secs(generated::LOGIN_TIMEOUT_SECONDS),
            logout: Duration::from_secs(generated::LOGOUT_TIMEOUT_SECONDS),
        }
    }

    /// The same limit for every kind: for a test that wants a hang to end fast.
    pub const fn all(limit: Duration) -> Self {
        Self {
            hello: limit,
            get: limit,
            get_interactive: limit,
            erase: limit,
            login: limit,
            logout: limit,
        }
    }

    /// The budget for a request: an interactive `get` may wait for the user and
    /// gets the `login` budget. A kind with no budget of its own gets the
    /// `get` one, as in the Python model.
    pub fn for_request(&self, kind: &RequestKind, interactive: bool) -> Duration {
        match kind {
            RequestKind::Get if interactive => self.get_interactive,
            RequestKind::Login => self.login,
            RequestKind::Logout => self.logout,
            RequestKind::Erase => self.erase,
            RequestKind::Get | RequestKind::Unsupported => self.get,
        }
    }
}

impl Default for Timeouts {
    fn default() -> Self {
        Self::policy()
    }
}

type Line = Result<Option<serde_json::Value>, ProtocolError>;

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
    /// The provider did not answer within the limit for `waiting_for` and was
    /// killed; the session is over.
    TimedOut {
        waiting_for: String,
        limit: Duration,
    },
    /// An earlier timeout killed this session's provider: the request fails.
    SessionEnded,
    /// The provider was killed for a timeout `TIMEOUT_KILLS_BEFORE_NO_RESTART`
    /// times in this command, so it is not started again.
    NotRestarted,
}

impl fmt::Display for ExchangeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Protocol(error) => write!(f, "{error}"),
            Self::Provider(message) => write!(f, "provider error: {message}"),
            Self::MissingPipe(pipe) => write!(f, "missing provider {pipe} pipe"),
            Self::ProcessFailed(message) => write!(f, "provider process failed: {message}"),
            Self::TimedOut { waiting_for, limit } => write!(
                f,
                "provider killed: no answer to {waiting_for} within {}s",
                limit.as_secs_f64()
            ),
            Self::SessionEnded => write!(f, "provider session ended by a timeout"),
            Self::NotRestarted => write!(
                f,
                "provider killed for a timeout {} times; not started again",
                generated::TIMEOUT_KILLS_BEFORE_NO_RESTART
            ),
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
/// Dropping a session without `close` kills the process. A provider that does
/// not answer within its limit (`Timeouts`) is killed, that request fails, and so
/// does every later one on the session.
pub struct ProviderSession {
    child: Child,
    stdin: Option<ChildStdin>,
    lines: Receiver<Line>,
    timeouts: Timeouts,
    killed: bool,
    pub version: u32,
    pub capabilities: Vec<String>,
    pub hello: Option<Hello>,
}

impl ProviderSession {
    pub fn spawn(provider: ProviderCommand) -> Result<Self, ExchangeError> {
        Self::spawn_with(provider, Timeouts::policy())
    }

    pub fn spawn_with(
        provider: ProviderCommand,
        timeouts: Timeouts,
    ) -> Result<Self, ExchangeError> {
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
        // a thread reads the provider's lines so a wait can end at a deadline;
        // killing the provider closes its stdout, which ends the thread
        let (sender, lines) = mpsc::channel::<Line>();
        thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                let line = read_json_line::<serde_json::Value>(&mut reader);
                let last = matches!(line, Ok(None) | Err(ProtocolError::Io(_)));
                if sender.send(line).is_err() || last {
                    break;
                }
            }
        });
        let mut session = Self {
            child,
            stdin: Some(stdin),
            lines,
            timeouts,
            killed: false,
            version: 0,
            capabilities: Vec::new(),
            hello: None,
        };

        let limit = timeouts.hello;
        let hello = session
            .next_line::<Hello>(limit, "hello")
            .map_err(|error| match error {
                ExchangeError::Provider(_) => {
                    ExchangeError::Provider("provider exited before hello".into())
                }
                other => other,
            })?;
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
        let limit = self
            .timeouts
            .for_request(&request.kind, request.interactive == Some(true));
        let response = self.exchange(request, limit, kind_name(&request.kind))?;
        response.validate_for(&request.kind)?;
        Ok(response)
    }

    /// Sends a message that need not be a valid client request, to check how a
    /// provider treats input from a newer client. Not something npm would send.
    pub fn send_raw(
        &mut self,
        message: &serde_json::Value,
    ) -> Result<ProviderResponse, ExchangeError> {
        let kind = message
            .get("kind")
            .and_then(|kind| serde_json::from_value::<RequestKind>(kind.clone()).ok())
            .unwrap_or(RequestKind::Unsupported);
        let interactive = message.get("interactive") == Some(&serde_json::Value::Bool(true));
        let limit = self.timeouts.for_request(&kind, interactive);
        self.exchange(message, limit, "a raw message")
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
        let limit = self.timeouts.get;
        self.next_line(limit, "an answer")
    }

    /// Whether a timeout has killed this session's provider.
    pub fn killed(&self) -> bool {
        self.killed
    }

    fn exchange<T: serde::Serialize>(
        &mut self,
        message: &T,
        limit: Duration,
        waiting_for: &str,
    ) -> Result<ProviderResponse, ExchangeError> {
        if self.killed {
            return Err(ExchangeError::SessionEnded);
        }
        let stdin = self
            .stdin
            .as_mut()
            .ok_or(ExchangeError::MissingPipe("stdin"))?;
        write_json_line(stdin, message)?;
        self.next_line(limit, waiting_for)
    }

    /// The provider's next line, or the end of it: past `limit` it is killed.
    fn next_line<T: serde::de::DeserializeOwned>(
        &mut self,
        limit: Duration,
        waiting_for: &str,
    ) -> Result<T, ExchangeError> {
        if self.killed {
            return Err(ExchangeError::SessionEnded);
        }
        let deadline = Instant::now() + limit;
        let exited = || ExchangeError::Provider(format!("provider exited before {waiting_for}"));
        match self
            .lines
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
        {
            Ok(line) => {
                let value = line?.ok_or_else(exited)?;
                Ok(serde_json::from_value(value).map_err(ProtocolError::Json)?)
            }
            Err(RecvTimeoutError::Timeout) => {
                self.kill();
                Err(ExchangeError::TimedOut {
                    waiting_for: waiting_for.into(),
                    limit,
                })
            }
            Err(RecvTimeoutError::Disconnected) => Err(exited()),
        }
    }

    fn kill(&mut self) {
        self.killed = true;
        drop(self.stdin.take());
        let _ = self.child.kill();
        let _ = self.child.wait();
    }

    /// Closes stdin, the end-of-session signal, and requires a clean exit.
    /// A test harness waits to check the exit; npm need not wait for the
    /// provider at all, so a provider cannot count on work after this.
    pub fn close(mut self) -> Result<(), ExchangeError> {
        if self.killed {
            return Ok(());
        }
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
    run_exchange_with(provider_command, scenario, Timeouts::policy())
}

pub fn run_exchange_with(
    provider_command: ProviderCommand,
    scenario: ClientScenario,
    timeouts: Timeouts,
) -> Result<ExchangeSummary, ExchangeError> {
    let mut session = ProviderSession::spawn_with(provider_command, timeouts)?;
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

/// One provider across an npm command: starts a session when a request needs
/// one, and counts the kills a timeout caused. A timeout fails the request, the
/// requests queued behind it on that session, and ends the session; the next
/// request starts a new one, until the provider has been killed
/// `TIMEOUT_KILLS_BEFORE_NO_RESTART` times, at hello or during a request.
/// Nothing is cached here, so what a cache keeps across a kill is the caller's.
pub struct ProviderSupervisor {
    start: Box<dyn FnMut() -> ProviderCommand>,
    timeouts: Timeouts,
    session: Option<ProviderSession>,
    kills: u32,
}

impl ProviderSupervisor {
    pub fn new(start: impl FnMut() -> ProviderCommand + 'static, timeouts: Timeouts) -> Self {
        Self {
            start: Box::new(start),
            timeouts,
            session: None,
            kills: 0,
        }
    }

    pub fn kills(&self) -> u32 {
        self.kills
    }

    pub fn request(&mut self, request: &Request) -> Result<ProviderResponse, ExchangeError> {
        if self.session.is_none() {
            if self.kills >= generated::TIMEOUT_KILLS_BEFORE_NO_RESTART {
                return Err(ExchangeError::NotRestarted);
            }
            match ProviderSession::spawn_with((self.start)(), self.timeouts) {
                Ok(session) => self.session = Some(session),
                Err(error) => return Err(self.note(error)),
            }
        }
        let session = self.session.as_mut().expect("a session was just ensured");
        session.request(request).map_err(|error| self.note(error))
    }

    fn note(&mut self, error: ExchangeError) -> ExchangeError {
        if matches!(error, ExchangeError::TimedOut { .. }) {
            self.kills += 1;
            self.session = None;
        }
        error
    }
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
    run_provider_chain_with(provider_commands, scenario, kind, Timeouts::policy())
}

pub fn run_provider_chain_with(
    provider_commands: Vec<ProviderCommand>,
    scenario: ClientScenario,
    kind: ChainKind,
    timeouts: Timeouts,
) -> Result<ExchangeSummary, ExchangeError> {
    let mut not_found = false;
    let mut selected_version = 0;
    for (provider_index, provider_command) in provider_commands.into_iter().enumerate() {
        let mut summary = run_exchange_with(provider_command, scenario, timeouts)?;
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
