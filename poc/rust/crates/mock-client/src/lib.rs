use credential_provider_protocol::{
    Auth, ErrorKind, Granularity, Hello, Operation, ProtocolError, ProviderResponse, Request,
    RequestKind, generated, generated::SENTINEL_ARGUMENT, negotiate, read_provider_line,
    write_json_line,
};
use std::fmt;
use std::io::{BufReader, Read, Write};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

/// How long `close` waits for a provider to exit once its stdin is closed.
/// npm need not wait at all; a test harness that does must not wait for ever.
const CLOSE_LIMIT: Duration = Duration::from_secs(10);

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

/// One line of the provider's stdout as the reader thread read it, with its
/// length in bytes, or how reading it failed.
type Line = Result<Option<(serde_json::Value, usize)>, ProtocolError>;

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
    /// The entries of the provider's hello `registries` that name the host of
    /// the request's registry, in any form: what a global chain that every
    /// provider declined needs to know before it may fall back to a stored
    /// credential.
    pub listed_forms: Vec<String>,
}

#[derive(Debug)]
pub enum ExchangeError {
    Protocol(ProtocolError),
    Provider(String),
    /// The provider exited, or closed its stdout, before `waiting_for` came.
    Exited {
        waiting_for: String,
    },
    /// The provider wrote a line while no request was outstanding.
    StrayLine,
    /// The provider's hello failed (a version npm does not speak, a malformed
    /// one, none) or it could not be started: it is skipped for the rest of
    /// the command, and the request fails.
    Skipped,
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
    /// `FAILED_SESSIONS_BEFORE_NO_RESTART` sessions of this provider have ended
    /// in a failure in this command, so it is not started again.
    NotRestarted,
}

impl fmt::Display for ExchangeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Protocol(error) => write!(f, "{error}"),
            Self::Provider(message) => write!(f, "provider error: {message}"),
            Self::Exited { waiting_for } => write!(f, "provider exited before {waiting_for}"),
            Self::StrayLine => write!(f, "a line arrived while no request was outstanding"),
            Self::Skipped => write!(f, "provider skipped for the rest of the command"),
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
                "provider failed in {} sessions; not started again",
                generated::FAILED_SESSIONS_BEFORE_NO_RESTART
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

/// What a provider did while no request was outstanding.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Idle {
    /// Nothing, or only blank lines.
    Quiet,
    /// It wrote a line nobody asked for.
    Stray,
    /// It exited, or closed its stdout.
    Exited,
}

/// One provider process for the lifetime of an npm command: spawned once,
/// asked any number of strictly sequential requests, ended by closing stdin.
/// Dropping a session without `close` kills the process. A provider that does
/// not answer within its limit (`Timeouts`) is killed, that request fails, and so
/// does every later one on the session.
pub struct ProviderSession {
    child: Child,
    /// Lines for the thread that owns the provider's stdin: a write that blocks
    /// (a provider that reads nothing, a pipe that is full) is then inside the
    /// deadline of the wait for the answer, and killing the provider ends it.
    writer: Option<Sender<Vec<u8>>>,
    write_failed: Arc<Mutex<Option<String>>>,
    /// What the provider has written to stderr so far, drained as it comes so
    /// that a chatty provider is never blocked on a full pipe.
    stderr: Arc<Mutex<Vec<u8>>>,
    stderr_thread: Option<JoinHandle<()>>,
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
        let mut stdin = child
            .stdin
            .take()
            .ok_or(ExchangeError::MissingPipe("stdin"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or(ExchangeError::MissingPipe("stdout"))?;
        let mut stderr_pipe = child
            .stderr
            .take()
            .ok_or(ExchangeError::MissingPipe("stderr"))?;
        let stderr = Arc::new(Mutex::new(Vec::new()));
        let drained = Arc::clone(&stderr);
        let stderr_thread = thread::spawn(move || {
            let mut chunk = [0_u8; 4096];
            while let Ok(read) = stderr_pipe.read(&mut chunk) {
                if read == 0 {
                    break;
                }
                drained
                    .lock()
                    .expect("no panic holds the lock")
                    .extend_from_slice(&chunk[..read]);
            }
        });
        let (writer, queued) = mpsc::channel::<Vec<u8>>();
        let write_failed = Arc::new(Mutex::new(None));
        let failed = Arc::clone(&write_failed);
        thread::spawn(move || {
            for bytes in queued {
                if let Err(error) = stdin.write_all(&bytes).and_then(|()| stdin.flush()) {
                    *failed.lock().expect("no panic holds the lock") = Some(error.to_string());
                    break;
                }
            }
        });
        // a thread reads the provider's lines so a wait can end at a deadline;
        // killing the provider closes its stdout, which ends the thread
        let (sender, lines) = mpsc::channel::<Line>();
        thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            let mut at_start = true;
            loop {
                let line = read_provider_line::<serde_json::Value>(&mut reader, at_start);
                at_start = false;
                let last = matches!(line, Ok(None) | Err(ProtocolError::Io(_)));
                if sender.send(line).is_err() || last {
                    break;
                }
            }
        });
        let mut session = Self {
            child,
            writer: Some(writer),
            write_failed,
            stderr,
            stderr_thread: Some(stderr_thread),
            lines,
            timeouts,
            killed: false,
            version: 0,
            capabilities: Vec::new(),
            hello: None,
        };

        let limit = timeouts.hello;
        let hello = session.next_line::<Hello>(limit, "hello")?;
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
        if let Err(error) = response.validate_for(&request.kind) {
            // an answer that does not fit its request (an `Ok` of another
            // kind, an expiry that is missing) is a malformed message: the
            // session ends
            self.kill();
            return Err(error.into());
        }
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
        self.send_bytes(bytes.to_vec())
    }

    /// Hands bytes to the writer thread. A write that failed earlier is
    /// reported here, the next time something is sent.
    fn send_bytes(&mut self, bytes: Vec<u8>) -> Result<(), ExchangeError> {
        if let Some(error) = self
            .write_failed
            .lock()
            .expect("no panic holds the lock")
            .clone()
        {
            return Err(ExchangeError::ProcessFailed(error));
        }
        self.writer
            .as_ref()
            .ok_or(ExchangeError::MissingPipe("stdin"))?
            .send(bytes)
            .map_err(|_| ExchangeError::ProcessFailed("the provider closed its stdin".into()))
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
        // Requests carry no id, so a line that arrived while none was
        // outstanding would be read as the answer to this one: Phase 2,
        // Session lifecycle. This catches what has arrived by now. A line the
        // provider writes after the request below was sent cannot be told
        // from its answer, so it is read as one.
        match self.watch_idle(Duration::ZERO) {
            Idle::Quiet => {}
            Idle::Stray => return Err(ExchangeError::StrayLine),
            Idle::Exited => {
                return Err(ExchangeError::Exited {
                    waiting_for: waiting_for.into(),
                });
            }
        }
        // the deadline starts before the write: a provider that reads nothing
        // is killed at the limit like one that reads and never answers
        let deadline = Instant::now() + limit;
        let mut bytes = Vec::new();
        write_json_line(&mut bytes, message)?;
        if let Err(error) = self.send_bytes(bytes) {
            // the pipe is closed: the provider is gone with a request outstanding
            self.kill();
            return Err(error);
        }
        self.next_line_within(
            deadline.saturating_duration_since(Instant::now()),
            limit,
            waiting_for,
        )
    }

    /// The provider's next line, or the end of it: past `limit` it is killed.
    fn next_line<T: serde::de::DeserializeOwned>(
        &mut self,
        limit: Duration,
        waiting_for: &str,
    ) -> Result<T, ExchangeError> {
        self.next_line_within(limit, limit, waiting_for)
    }

    /// `next_line` with `left` of the `limit` still to wait (the rest went on
    /// the write).
    fn next_line_within<T: serde::de::DeserializeOwned>(
        &mut self,
        left: Duration,
        limit: Duration,
        waiting_for: &str,
    ) -> Result<T, ExchangeError> {
        if self.killed {
            return Err(ExchangeError::SessionEnded);
        }
        let exited = || ExchangeError::Exited {
            waiting_for: waiting_for.into(),
        };
        let result = match self.lines.recv_timeout(left) {
            Ok(line) => match line {
                Ok(Some((value, bytes))) => serde_json::from_value(value)
                    // not the serde error, which quotes what it found: the
                    // line may carry a credential, so only its length is said
                    .map_err(|_| ProtocolError::Malformed { bytes }.into()),
                Ok(None) => Err(exited()),
                Err(error) => Err(error.into()),
            },
            Err(RecvTimeoutError::Timeout) => Err(ExchangeError::TimedOut {
                waiting_for: waiting_for.into(),
                limit,
            }),
            Err(RecvTimeoutError::Disconnected) => Err(exited()),
        };
        if result.is_err() {
            // every way a wait fails ends the session: no answer in time, the
            // provider gone, an oversized line, a line that is not a message
            self.kill();
        }
        result
    }

    /// Looks at what the provider has written while no request is outstanding,
    /// waiting up to `wait` for it: a blank line was dropped by the reader and
    /// is nothing, any other line is a stray one, and the provider having
    /// exited is the end of the session. Either of the last two ends it, as
    /// npm does the moment it sees one, with the provider killed.
    pub fn watch_idle(&mut self, wait: Duration) -> Idle {
        if self.killed {
            return Idle::Quiet;
        }
        let seen = match wait {
            Duration::ZERO => self.lines.try_recv().map_err(|error| match error {
                mpsc::TryRecvError::Empty => RecvTimeoutError::Timeout,
                mpsc::TryRecvError::Disconnected => RecvTimeoutError::Disconnected,
            }),
            wait => self.lines.recv_timeout(wait),
        };
        let idle = match seen {
            Err(RecvTimeoutError::Timeout) => return Idle::Quiet,
            // any line is one, a malformed or an oversized one included
            Ok(
                Ok(Some(_))
                | Err(ProtocolError::Malformed { .. } | ProtocolError::LineTooLong { .. }),
            ) => Idle::Stray,
            Ok(Ok(None) | Err(_)) | Err(RecvTimeoutError::Disconnected) => Idle::Exited,
        };
        self.kill();
        idle
    }

    fn kill(&mut self) {
        self.killed = true;
        drop(self.writer.take());
        let _ = self.child.kill();
        let _ = self.child.wait();
    }

    /// What the provider has written to stderr so far.
    pub fn stderr(&self) -> String {
        String::from_utf8_lossy(&self.stderr.lock().expect("no panic holds the lock")).into_owned()
    }

    /// Closes stdin, the end-of-session signal, and requires a clean exit
    /// within `CLOSE_LIMIT`; a provider that stays is killed and that is an
    /// error. A test harness waits to check the exit; npm need not wait for
    /// the provider at all, so a provider cannot count on work after this.
    pub fn close(self) -> Result<(), ExchangeError> {
        self.close_with_stderr().map(|_| ())
    }

    /// `close`, giving back what the provider wrote to stderr over the whole
    /// session, for a test that checks it (it is what npm logs).
    pub fn close_with_stderr(self) -> Result<String, ExchangeError> {
        self.close_within(CLOSE_LIMIT)
    }

    /// `close_with_stderr` with a limit of the caller's for the exit.
    pub fn close_within(mut self, limit: Duration) -> Result<String, ExchangeError> {
        if self.killed {
            return Ok(self.stderr());
        }
        drop(self.writer.take());
        let deadline = Instant::now() + limit;
        let status = loop {
            match self.child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(5)),
                Ok(None) => {
                    self.kill();
                    return Err(ExchangeError::ProcessFailed(format!(
                        "the provider did not exit within {}s of its stdin closing; {}",
                        limit.as_secs_f64(),
                        self.stderr()
                    )));
                }
                Err(error) => return Err(ExchangeError::ProcessFailed(error.to_string())),
            }
        };
        // the pipe closes with the process, unless it handed it on: a moment, not for ever
        if let Some(thread) = self.stderr_thread.take() {
            let settle = Instant::now() + Duration::from_secs(1);
            while !thread.is_finished() && Instant::now() < settle {
                thread::sleep(Duration::from_millis(2));
            }
        }
        let stderr = self.stderr();
        if !status.success() {
            return Err(ExchangeError::ProcessFailed(stderr));
        }
        Ok(stderr)
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
    let listed_forms = session
        .hello
        .as_ref()
        .map(|hello| hello.listed_forms(&request.registry))
        .unwrap_or_default();
    if !session.serves(&request.registry) {
        let selected_version = session.version;
        session.close()?;
        return Ok(ExchangeSummary {
            selected_version,
            outcome: "try-next-provider".into(),
            provider_index: 0,
            listed_forms,
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
        listed_forms,
    })
}

/// One provider across an npm command: starts a session when a request needs
/// one and sees to what ends it. What each cause does is the policy's table
/// (`credentialProvider.sessionEnds`, `generated::SESSION_ENDS`):
///
/// - a timeout, an exit with a request outstanding, an oversized line or a
///   malformed message fail the request in flight and end the session, and the
///   next request starts a new process; each counts toward
///   `FAILED_SESSIONS_BEFORE_NO_RESTART`, after which the provider is not
///   started again;
/// - a stray line, written while no request was outstanding, ends the session
///   as soon as it is seen (`watch_idle`, or the next request), is warned
///   about, counts, and fails nothing: the request that comes next starts a new
///   process;
/// - a provider that exits while idle fails nothing and does not count;
/// - a hello that failed (no common version, malformed or none, or a provider
///   that cannot be started) fails the request and skips the provider for the
///   rest of the command;
/// - an `Err` answer fails its request and leaves the session alone.
///
/// Nothing is cached here, so what a cache keeps across an end is the caller's.
pub struct ProviderSupervisor {
    start: Box<dyn FnMut() -> ProviderCommand>,
    timeouts: Timeouts,
    name: String,
    session: Option<ProviderSession>,
    failed_sessions: u32,
    skipped: bool,
    warnings: Vec<String>,
}

impl ProviderSupervisor {
    pub fn new(start: impl FnMut() -> ProviderCommand + 'static, timeouts: Timeouts) -> Self {
        Self {
            start: Box::new(start),
            timeouts,
            name: "provider".into(),
            session: None,
            failed_sessions: 0,
            skipped: false,
            warnings: Vec::new(),
        }
    }

    /// The name a warning gives the provider by.
    pub fn named(mut self, name: &str) -> Self {
        self.name = name.into();
        self
    }

    /// The sessions that ended in a failure that counts toward the limit.
    pub fn kills(&self) -> u32 {
        self.failed_sessions
    }

    /// What npm warned about, naming the provider: a stray line.
    pub fn warnings(&self) -> &[String] {
        &self.warnings
    }

    /// Whether a session is open.
    pub fn is_running(&self) -> bool {
        self.session.is_some()
    }

    /// Sees what the provider did while no request was outstanding, waiting up
    /// to `wait`, and ends the session as the table says. npm's reader does
    /// this the moment a line arrives; a request does it too, for what has
    /// arrived by then.
    pub fn watch_idle(&mut self, wait: Duration) -> Idle {
        let Some(session) = self.session.as_mut() else {
            return Idle::Quiet;
        };
        let idle = session.watch_idle(wait);
        match idle {
            Idle::Quiet => {}
            Idle::Stray => {
                self.failed_sessions += 1;
                self.session = None;
                self.warnings.push(format!(
                    "{} wrote a line while no request was outstanding; it was ended",
                    self.name
                ));
            }
            // not a failure: it does not count
            Idle::Exited => self.session = None,
        }
        idle
    }

    pub fn request(&mut self, request: &Request) -> Result<ProviderResponse, ExchangeError> {
        if self.skipped {
            return Err(ExchangeError::Skipped);
        }
        self.watch_idle(Duration::ZERO);
        if self.session.is_none() {
            if self.failed_sessions >= generated::FAILED_SESSIONS_BEFORE_NO_RESTART {
                return Err(ExchangeError::NotRestarted);
            }
            match ProviderSession::spawn_with((self.start)(), self.timeouts) {
                Ok(session) => self.session = Some(session),
                Err(error) => return Err(self.hello_failed(error)),
            }
        }
        let session = self.session.as_mut().expect("a session was just ensured");
        let result = session.request(request);
        // an error that ended the session (a timeout, the provider gone, a
        // line that is no message, an answer that does not fit) counts; one
        // that did not (the request npm built was wrong) is nobody's failure
        if result.is_err() && session.killed() {
            self.failed_sessions += 1;
            self.session = None;
        }
        result
    }

    /// The hello did not come right. A timeout is a timeout like any other and
    /// counts; the rest skip the provider for the command.
    fn hello_failed(&mut self, error: ExchangeError) -> ExchangeError {
        if matches!(error, ExchangeError::TimedOut { .. }) {
            self.failed_sessions += 1;
        } else {
            self.skipped = true;
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
/// `as-no-provider`: npm's behaviour today), except where some provider's hello
/// lists the registry's host in any form: that is a URL form it declined, npm
/// sends no stored credential, and the request fails, naming the provider and
/// the forms it lists. A per-registry list that declines fails, and so does a
/// chain in which someone answered `not-found`: a stored credential behind
/// it is used only where the chain lists `npm:token`, which is the model's
/// business, not this mock's.
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
    let mut listing = Vec::new();
    for (provider_index, provider_command) in provider_commands.into_iter().enumerate() {
        let name = provider_command
            .program
            .get_program()
            .to_string_lossy()
            .into_owned();
        let mut summary = run_exchange_with(provider_command, scenario, timeouts)?;
        selected_version = summary.selected_version;
        if !summary.listed_forms.is_empty() {
            listing.push(format!("{name} lists {}", summary.listed_forms.join(", ")));
        }
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
    if kind == ChainKind::Global && !listing.is_empty() && !not_found {
        return Err(ExchangeError::Provider(format!(
            "every provider declined {}, a URL form on a host a provider's hello lists, so npm sends no stored credential: {}",
            request_for(scenario).registry,
            listing.join("; ")
        )));
    }

    if not_found {
        return Err(ExchangeError::Provider(
            "not-found: no provider had a credential, and the chain does not list npm:token".into(),
        ));
    }
    match kind {
        ChainKind::Global => Ok(ExchangeSummary {
            selected_version,
            outcome: "as-no-provider".into(),
            provider_index: 0,
            listed_forms: Vec::new(),
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
            if let Some(Auth::Unknown(name)) = &ok.auth {
                // npm has nothing it can send: an `other` answer, which fails
                return Err(ExchangeError::Provider(format!(
                    "other: unknown auth.type {name}"
                )));
            }
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
