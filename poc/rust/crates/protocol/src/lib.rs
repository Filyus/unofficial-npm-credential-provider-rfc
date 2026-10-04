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
    Erase,
    /// A kind this build does not know, sent by a newer client. A provider
    /// answers it with `operation-not-supported`; a client never sends it.
    #[serde(other)]
    Unsupported,
}

/// The npm action a credential must authorize. npm names the action and the
/// provider maps it onto its registry's own tiers, because those differ: npmjs
/// splits stage-only from direct publish, GitHub Packages and Azure Artifacts
/// put deletion in a tier above write.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Operation {
    Read,
    Publish,
    Stage,
    Deprecate,
    DistTag,
    Unpublish,
    Owner,
    Access,
    /// An action this build does not know. A provider must not treat it as
    /// `read`; it answers `operation-not-supported`.
    #[serde(other)]
    Unsupported,
}

impl Operation {
    pub fn requires_version(&self) -> bool {
        matches!(self, Self::Publish | Self::Stage)
    }
}

/// A bearer-equivalent value: a token or a password. It is written to the
/// wire as a plain string, and `Debug` never shows it, so a logged request or
/// response cannot leak it.
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
    #[serde(rename = "authChallenges", skip_serializing_if = "Option::is_none")]
    pub auth_challenges: Option<Vec<String>>,
}

impl Request {
    /// A request carrying only the fields every kind has.
    pub fn bare(kind: RequestKind, registry: impl Into<String>) -> Self {
        Self {
            v: PROTOCOL_VERSION,
            kind,
            registry: registry.into(),
            scope: None,
            package: None,
            version: None,
            operation: None,
            command: None,
            interactive: None,
            retry: None,
            http_status: None,
            auth_challenges: None,
        }
    }

    pub fn get_install(registry: impl Into<String>, scope: Option<&str>, package: &str) -> Self {
        Self {
            scope: scope.map(str::to_string),
            package: Some(package.to_string()),
            operation: Some(Operation::Read),
            command: Some("install".into()),
            interactive: Some(false),
            ..Self::bare(RequestKind::Get, registry)
        }
    }

    pub fn get_publish(
        registry: impl Into<String>,
        scope: Option<&str>,
        package: &str,
        version: &str,
    ) -> Self {
        Self {
            version: Some(version.into()),
            operation: Some(Operation::Publish),
            command: Some("publish".into()),
            interactive: Some(true),
            ..Self::get_install(registry, scope, package)
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
            RequestKind::Login | RequestKind::Logout | RequestKind::Erase => {}
            RequestKind::Unsupported => {
                return Err(ProtocolError::InvalidMessage(
                    "a client must not send an unknown request kind".into(),
                ));
            }
        }
        if let Some(operation) = &self.operation {
            require(
                *operation != Operation::Unsupported,
                "a client must not send an unknown operation",
            )?;
            if operation.requires_version() {
                require(self.version.is_some(), "publish and stage require version")?;
            }
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub granularity: Option<Granularity>,
}

impl ProviderOk {
    /// An `Ok` with no credential, the answer to login, logout and erase.
    pub fn done(kind: RequestKind) -> Self {
        Self {
            kind,
            auth: None,
            cache: None,
            expires_at: None,
            operation_independent: None,
            granularity: None,
        }
    }

    pub fn bearer(token: impl Into<Secret>, granularity: Granularity) -> Self {
        Self {
            auth: Some(Auth::Bearer {
                token: token.into(),
            }),
            cache: Some(CachePolicy::Session),
            granularity: Some(granularity),
            ..Self::done(RequestKind::Get)
        }
    }

    /// A short-lived token. When it nears `expires_at` the client sends a
    /// plain `get` again; refreshing is the provider's own business.
    pub fn expiring(token: impl Into<Secret>, expires_at: u64) -> Self {
        Self {
            cache: Some(CachePolicy::Expires),
            expires_at: Some(expires_at),
            operation_independent: Some(true),
            ..Self::bearer(token, Granularity::Scope)
        }
    }

    pub fn validate_for(&self, kind: &RequestKind) -> Result<(), ProtocolError> {
        require(&self.kind == kind, "Ok.kind must match request kind")?;
        if self.kind != RequestKind::Get {
            return Ok(());
        }
        self.auth
            .as_ref()
            .ok_or_else(|| ProtocolError::InvalidMessage("token response requires auth".into()))?
            .validate()?;
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
    fn publish_and_stage_require_version() {
        let mut request = Request::get_publish(
            "https://registry.example.test/",
            Some("@scope"),
            "pkg",
            "1.0.0",
        );
        assert!(request.validate().is_ok());

        request.version = None;
        for operation in [Operation::Publish, Operation::Stage] {
            request.operation = Some(operation);
            assert!(request.validate().is_err());
        }
        request.operation = Some(Operation::Unpublish);
        assert!(request.validate().is_ok());
    }

    #[test]
    fn unknown_operation_parses_as_unsupported_and_is_never_sent() {
        let request: Request = serde_json::from_str(
            r#"{"v":1,"kind":"get","registry":"https://registry.example.test/","operation":"yank","interactive":false}"#,
        )
        .unwrap();

        assert_eq!(request.operation, Some(Operation::Unsupported));
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
            RequestKind::Erase,
        ]);

        assert_eq!(actual, generated::REQUEST_KINDS);
    }

    #[test]
    fn generated_operation_values_match_serde() {
        let all = [
            Operation::Read,
            Operation::Publish,
            Operation::Stage,
            Operation::Deprecate,
            Operation::DistTag,
            Operation::Unpublish,
            Operation::Owner,
            Operation::Access,
        ];
        let requiring_version: Vec<String> = all
            .iter()
            .filter(|operation| operation.requires_version())
            .map(|operation| serialized_values([operation.clone()]).remove(0))
            .collect();

        assert_eq!(serialized_values(all), generated::OPERATIONS);
        assert_eq!(requiring_version, generated::OPERATIONS_REQUIRING_VERSION);
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
    fn removed_request_kinds_are_unsupported() {
        for kind in ["get-batch", "refresh"] {
            let request: Request = serde_json::from_value(serde_json::json!({
                "v": 1, "kind": kind, "registry": "https://registry.example.test/"
            }))
            .unwrap();

            assert_eq!(request.kind, RequestKind::Unsupported);
        }
    }

    #[test]
    fn debug_output_redacts_secrets() {
        let bearer = ProviderOk::expiring("bearer-secret", 1_893_456_000);
        let basic = ProviderOk {
            auth: Some(Auth::Basic {
                username: "deploy".into(),
                password: "basic-secret".into(),
            }),
            ..ProviderOk::done(RequestKind::Get)
        };
        let rendered = format!("{bearer:?} {basic:?}");

        for secret in ["bearer-secret", "basic-secret"] {
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
