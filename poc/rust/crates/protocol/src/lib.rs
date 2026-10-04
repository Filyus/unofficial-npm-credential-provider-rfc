use serde::{Deserialize, Serialize, de::DeserializeOwned};
use std::fmt;
use std::io::{self, BufRead, Write};

#[rustfmt::skip]
pub mod generated;

pub use generated::PROTOCOL_VERSION;

/// Upper bound on one protocol line, newline included. The draft leaves the
/// exact value implementation-defined; what it fixes is that an oversized line
/// is rejected whole instead of being buffered without limit.
pub const MAX_LINE_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Hello {
    pub v: Vec<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<Vec<String>>,
}

impl Hello {
    pub fn v1() -> Self {
        Self {
            v: vec![PROTOCOL_VERSION],
            capabilities: Some(
                generated::CAPABILITIES
                    .iter()
                    .map(|capability| (*capability).to_string())
                    .collect(),
            ),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RequestKind {
    Login,
    Logout,
    Get,
    GetBatch,
    Refresh,
    Erase,
    /// A kind this build does not know, sent by a newer client. A provider
    /// answers it with `operation-not-supported`; a client never sends it.
    #[serde(other)]
    Unsupported,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Operation {
    Read,
    Publish,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PackageContext {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    pub package: String,
}

/// A bearer-equivalent value: a token, a password or a `refreshState`. It is
/// written to the wire as a plain string, and `Debug` never shows it, so a
/// logged request or response cannot leak it.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Secret(String);

impl Secret {
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl From<String> for Secret {
    fn from(value: String) -> Self {
        Self(value)
    }
}

impl From<&str> for Secret {
    fn from(value: &str) -> Self {
        Self(value.to_owned())
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Secret(<redacted>)")
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Request {
    pub v: u32,
    pub kind: RequestKind,
    pub registry: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub package: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operation: Option<Operation>,
    /// Informational, so open-ended: `generated::KNOWN_COMMANDS` lists the
    /// values the draft names, and any other npm command may appear.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interactive: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry: Option<bool>,
    #[serde(rename = "httpStatus", skip_serializing_if = "Option::is_none")]
    pub http_status: Option<u16>,
    #[serde(rename = "refreshState", skip_serializing_if = "Option::is_none")]
    pub refresh_state: Option<Secret>,
    #[serde(rename = "authChallenges", skip_serializing_if = "Option::is_none")]
    pub auth_challenges: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub packages: Option<Vec<PackageContext>>,
}

impl Request {
    pub fn get_install(registry: impl Into<String>, scope: Option<&str>, package: &str) -> Self {
        Self {
            v: PROTOCOL_VERSION,
            kind: RequestKind::Get,
            registry: registry.into(),
            scope: scope.map(str::to_string),
            package: Some(package.to_string()),
            version: None,
            operation: Some(Operation::Read),
            command: Some("install".into()),
            interactive: Some(false),
            retry: None,
            http_status: None,
            refresh_state: None,
            auth_challenges: None,
            packages: None,
        }
    }

    pub fn refresh(registry: impl Into<String>, refresh_state: impl Into<Secret>) -> Self {
        Self {
            v: PROTOCOL_VERSION,
            kind: RequestKind::Refresh,
            registry: registry.into(),
            scope: None,
            package: None,
            version: None,
            operation: None,
            command: None,
            interactive: None,
            retry: None,
            http_status: None,
            refresh_state: Some(refresh_state.into()),
            auth_challenges: None,
            packages: None,
        }
    }

    pub fn get_batch(registry: impl Into<String>, packages: Vec<PackageContext>) -> Self {
        Self {
            v: PROTOCOL_VERSION,
            kind: RequestKind::GetBatch,
            registry: registry.into(),
            scope: None,
            package: None,
            version: None,
            operation: Some(Operation::Read),
            command: Some("install".into()),
            interactive: Some(false),
            retry: None,
            http_status: None,
            refresh_state: None,
            auth_challenges: None,
            packages: Some(packages),
        }
    }

    pub fn validate(&self) -> Result<(), ProtocolError> {
        if self.v != PROTOCOL_VERSION {
            return Err(ProtocolError::InvalidMessage(
                "request version must match negotiated protocol version".into(),
            ));
        }
        match self.kind {
            RequestKind::Get => {
                require(self.operation.is_some(), "get requires operation")?;
                require(self.interactive.is_some(), "get requires interactive")?;
            }
            RequestKind::GetBatch => {
                require(
                    self.operation == Some(Operation::Read),
                    "get-batch is for read operations only",
                )?;
                require(self.interactive.is_some(), "get-batch requires interactive")?;
                require(
                    self.packages
                        .as_ref()
                        .is_some_and(|packages| !packages.is_empty()),
                    "get-batch requires packages",
                )?;
            }
            RequestKind::Refresh => {
                require(
                    self.refresh_state.is_some(),
                    "refresh requires refreshState",
                )?;
            }
            RequestKind::Login | RequestKind::Logout | RequestKind::Erase => {}
            RequestKind::Unsupported => {
                return Err(ProtocolError::InvalidMessage(
                    "a client must not send an unknown request kind".into(),
                ));
            }
        }
        if self.operation == Some(Operation::Publish) {
            require(self.version.is_some(), "publish requires version")?;
        }
        if self.retry == Some(true) {
            require(self.http_status.is_some(), "retry=true requires httpStatus")?;
        }
        if let Some(http_status) = self.http_status {
            require(
                (100..=599).contains(&http_status),
                "httpStatus must be an HTTP status code",
            )?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Auth {
    Bearer { token: Secret },
    Basic { username: String, password: Secret },
}

impl Auth {
    pub fn validate(&self) -> Result<(), ProtocolError> {
        match self {
            Self::Bearer { token } => require(!token.expose().is_empty(), "bearer token is empty"),
            Self::Basic { username, password } => require(
                !username.is_empty() && !password.expose().is_empty(),
                "basic auth requires username and password",
            ),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CachePolicy {
    Never,
    Session,
    Expires,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Granularity {
    Registry,
    Scope,
    Package,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TokenResult {
    pub auth: Auth,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub granularity: Option<Granularity>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderOk {
    pub kind: RequestKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auth: Option<Auth>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache: Option<CachePolicy>,
    #[serde(rename = "expiresAt", skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<u64>,
    #[serde(
        rename = "operationIndependent",
        skip_serializing_if = "Option::is_none"
    )]
    pub operation_independent: Option<bool>,
    #[serde(rename = "refreshState", skip_serializing_if = "Option::is_none")]
    pub refresh_state: Option<Secret>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub granularity: Option<Granularity>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub results: Option<Vec<TokenResult>>,
}

impl ProviderOk {
    pub fn bearer(token: impl Into<Secret>, granularity: Granularity) -> Self {
        Self {
            kind: RequestKind::Get,
            auth: Some(Auth::Bearer {
                token: token.into(),
            }),
            cache: Some(CachePolicy::Session),
            expires_at: None,
            operation_independent: None,
            refresh_state: None,
            granularity: Some(granularity),
            results: None,
        }
    }

    pub fn refreshed(token: impl Into<Secret>, refresh_state: impl Into<Secret>) -> Self {
        Self {
            kind: RequestKind::Refresh,
            auth: Some(Auth::Bearer {
                token: token.into(),
            }),
            cache: Some(CachePolicy::Expires),
            expires_at: Some(1_893_456_000),
            operation_independent: Some(true),
            refresh_state: Some(refresh_state.into()),
            granularity: Some(Granularity::Scope),
            results: None,
        }
    }

    pub fn batch(results: Vec<TokenResult>) -> Self {
        Self {
            kind: RequestKind::GetBatch,
            auth: None,
            cache: Some(CachePolicy::Session),
            expires_at: None,
            operation_independent: None,
            refresh_state: None,
            granularity: None,
            results: Some(results),
        }
    }

    pub fn validate_for(&self, kind: &RequestKind) -> Result<(), ProtocolError> {
        require(&self.kind == kind, "Ok.kind must match request kind")?;
        if matches!(
            self.kind,
            RequestKind::Login | RequestKind::Logout | RequestKind::Erase
        ) {
            return Ok(());
        }
        if self.kind == RequestKind::GetBatch {
            let results = self.results.as_ref().ok_or_else(|| {
                ProtocolError::InvalidMessage("get-batch response requires results".into())
            })?;
            for result in results {
                result.auth.validate()?;
            }
        } else {
            self.auth
                .as_ref()
                .ok_or_else(|| {
                    ProtocolError::InvalidMessage("token response requires auth".into())
                })?
                .validate()?;
        }
        if self.cache == Some(CachePolicy::Expires) {
            require(
                self.expires_at.is_some(),
                "cache=expires requires expiresAt",
            )?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderErr {
    pub kind: ErrorKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(rename = "causedBy", skip_serializing_if = "Option::is_none")]
    pub caused_by: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ErrorKind {
    UrlNotSupported,
    NotFound,
    OperationNotSupported,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ProviderResponse {
    Ok(ProviderOk),
    Err(ProviderErr),
}

impl ProviderResponse {
    pub fn validate_for(&self, kind: &RequestKind) -> Result<(), ProtocolError> {
        match self {
            ProviderResponse::Ok(ok) => ok.validate_for(kind),
            ProviderResponse::Err(_) => Ok(()),
        }
    }
}

#[derive(Debug)]
pub enum ProtocolError {
    InvalidMessage(String),
    NoCompatibleVersion { supported: Vec<u32> },
    LineTooLong { limit: usize },
    Io(io::Error),
    Json(serde_json::Error),
}

impl fmt::Display for ProtocolError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidMessage(message) => write!(f, "invalid message: {message}"),
            Self::NoCompatibleVersion { supported } => {
                write!(f, "no compatible protocol version in {supported:?}")
            }
            Self::LineTooLong { limit } => {
                write!(f, "protocol line exceeds {limit} bytes")
            }
            Self::Io(error) => write!(f, "io error: {error}"),
            Self::Json(error) => write!(f, "json error: {error}"),
        }
    }
}

impl std::error::Error for ProtocolError {}

impl From<io::Error> for ProtocolError {
    fn from(value: io::Error) -> Self {
        Self::Io(value)
    }
}

impl From<serde_json::Error> for ProtocolError {
    fn from(value: serde_json::Error) -> Self {
        Self::Json(value)
    }
}

pub fn negotiate(hello: &Hello) -> Result<u32, ProtocolError> {
    if hello.v.contains(&PROTOCOL_VERSION) {
        Ok(PROTOCOL_VERSION)
    } else {
        Err(ProtocolError::NoCompatibleVersion {
            supported: hello.v.clone(),
        })
    }
}

/// Reads one protocol line, refusing it whole once it passes `MAX_LINE_BYTES`
/// rather than buffering whatever the peer chooses to send.
pub fn read_json_line<T: DeserializeOwned>(
    reader: &mut impl BufRead,
) -> Result<Option<T>, ProtocolError> {
    let mut line = Vec::new();
    let bytes =
        io::Read::take(&mut *reader, MAX_LINE_BYTES as u64 + 1).read_until(b'\n', &mut line)?;
    if bytes == 0 {
        return Ok(None);
    }
    if line.len() > MAX_LINE_BYTES {
        return Err(ProtocolError::LineTooLong {
            limit: MAX_LINE_BYTES,
        });
    }
    Ok(Some(serde_json::from_slice(line.trim_ascii_end())?))
}

pub fn write_json_line<T: Serialize>(
    writer: &mut impl Write,
    value: &T,
) -> Result<(), ProtocolError> {
    serde_json::to_writer(&mut *writer, value)?;
    writer.write_all(b"\n")?;
    writer.flush()?;
    Ok(())
}

fn require(condition: bool, message: &str) -> Result<(), ProtocolError> {
    if condition {
        Ok(())
    } else {
        Err(ProtocolError::InvalidMessage(message.into()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn response_shape_matches_rfc_external_tagging() {
        let response = ProviderResponse::Ok(ProviderOk::bearer("token", Granularity::Scope));
        let json = serde_json::to_string(&response).unwrap();

        assert_eq!(
            json,
            r#"{"Ok":{"kind":"get","auth":{"type":"bearer","token":"token"},"cache":"session","granularity":"scope"}}"#
        );
    }

    #[test]
    fn version_mismatch_fails_negotiation() {
        let error = negotiate(&Hello {
            v: vec![2],
            capabilities: None,
        })
        .unwrap_err();

        assert!(matches!(error, ProtocolError::NoCompatibleVersion { .. }));
    }

    #[test]
    fn hello_v1_advertises_generated_capabilities() {
        let expected = generated::CAPABILITIES
            .iter()
            .map(|capability| (*capability).to_string())
            .collect();

        assert_eq!(Hello::v1().capabilities, Some(expected));
    }

    #[test]
    fn publish_requires_version() {
        let mut request =
            Request::get_install("https://registry.example.test/", Some("@scope"), "pkg");
        request.operation = Some(Operation::Publish);

        assert!(request.validate().is_err());
    }

    #[test]
    fn retry_requires_valid_http_status() {
        let mut request =
            Request::get_install("https://registry.example.test/", Some("@scope"), "pkg");
        request.retry = Some(true);

        assert!(request.validate().is_err());

        request.http_status = Some(401);
        assert!(request.validate().is_ok());

        request.http_status = Some(99);
        assert!(request.validate().is_err());
    }

    #[test]
    fn generated_request_kind_values_match_serde() {
        let actual = serialized_values([
            RequestKind::Login,
            RequestKind::Logout,
            RequestKind::Get,
            RequestKind::GetBatch,
            RequestKind::Refresh,
            RequestKind::Erase,
        ]);

        assert_eq!(actual, generated::REQUEST_KINDS);
    }

    #[test]
    fn generated_operation_values_match_serde() {
        let actual = serialized_values([Operation::Read, Operation::Publish]);

        assert_eq!(actual, generated::OPERATIONS);
    }

    #[test]
    fn unknown_request_kind_parses_as_unsupported() {
        let request: Request = serde_json::from_str(
            r#"{"v":1,"kind":"store","registry":"https://registry.example.test/"}"#,
        )
        .unwrap();

        assert_eq!(request.kind, RequestKind::Unsupported);
        assert!(request.validate().is_err());
    }

    #[test]
    fn command_is_informational_and_open_ended() {
        let request: Request = serde_json::from_str(
            r#"{"v":1,"kind":"get","registry":"https://registry.example.test/","operation":"read","command":"outdated","interactive":false}"#,
        )
        .unwrap();

        assert!(!generated::KNOWN_COMMANDS.contains(&"outdated"));
        assert_eq!(request.command.as_deref(), Some("outdated"));
        assert!(request.validate().is_ok());
    }

    #[test]
    fn get_batch_rejects_publish() {
        let mut request = Request::get_batch(
            "https://registry.example.test/",
            vec![PackageContext {
                scope: None,
                package: "pkg".into(),
            }],
        );
        assert!(request.validate().is_ok());

        request.operation = Some(Operation::Publish);
        request.version = Some("1.0.0".into());
        assert!(request.validate().is_err());
    }

    #[test]
    fn debug_output_redacts_secrets() {
        let mut ok = ProviderOk::refreshed("bearer-secret", "refresh-secret");
        ok.results = Some(vec![TokenResult {
            auth: Auth::Basic {
                username: "deploy".into(),
                password: "basic-secret".into(),
            },
            granularity: None,
        }]);
        let request = Request::refresh("https://registry.example.test/", "refresh-secret");
        let rendered = format!("{ok:?} {request:?}");

        for secret in ["bearer-secret", "refresh-secret", "basic-secret"] {
            assert!(
                !rendered.contains(secret),
                "{secret} leaked into {rendered}"
            );
        }
        assert!(rendered.contains("deploy"));
    }

    #[test]
    fn oversized_line_is_rejected_whole() {
        let mut fits = vec![b' '; MAX_LINE_BYTES - 3];
        fits.extend_from_slice(b"{}\n");
        let mut reader = io::Cursor::new(fits);
        assert!(
            read_json_line::<serde_json::Value>(&mut reader)
                .unwrap()
                .is_some()
        );

        let mut oversized = vec![b' '; MAX_LINE_BYTES - 2];
        oversized.extend_from_slice(b"{}\n{}\n");
        let mut reader = io::Cursor::new(oversized);
        let error = read_json_line::<serde_json::Value>(&mut reader).unwrap_err();
        assert!(matches!(error, ProtocolError::LineTooLong { .. }));
    }

    #[test]
    fn empty_bearer_token_is_rejected() {
        let ok = ProviderOk::bearer("", Granularity::Registry);

        assert!(ok.validate_for(&RequestKind::Get).is_err());
    }

    #[test]
    fn generated_cache_values_match_serde() {
        let actual = serialized_values([
            CachePolicy::Never,
            CachePolicy::Session,
            CachePolicy::Expires,
        ]);

        assert_eq!(actual, generated::CACHE_POLICIES);
    }

    #[test]
    fn generated_granularity_values_match_serde() {
        let actual = serialized_values([
            Granularity::Registry,
            Granularity::Scope,
            Granularity::Package,
        ]);

        assert_eq!(actual, generated::GRANULARITIES);
    }

    #[test]
    fn generated_error_kind_values_match_serde() {
        let actual = serialized_values([
            ErrorKind::UrlNotSupported,
            ErrorKind::NotFound,
            ErrorKind::OperationNotSupported,
            ErrorKind::Other,
        ]);

        assert_eq!(actual, generated::ERROR_KINDS);
    }

    #[test]
    fn generated_auth_type_values_match_serde() {
        let bearer = serde_json::to_value(Auth::Bearer {
            token: "token".into(),
        })
        .unwrap();
        let basic = serde_json::to_value(Auth::Basic {
            username: "user".into(),
            password: "secret".into(),
        })
        .unwrap();
        let actual = vec![
            bearer["type"].as_str().unwrap().to_string(),
            basic["type"].as_str().unwrap().to_string(),
        ];

        assert_eq!(actual, generated::AUTH_TYPES);
    }

    fn serialized_values<T, const N: usize>(values: [T; N]) -> Vec<String>
    where
        T: Serialize,
    {
        values
            .into_iter()
            .map(|value| {
                serde_json::to_value(value)
                    .unwrap()
                    .as_str()
                    .unwrap()
                    .to_string()
            })
            .collect()
    }
}
