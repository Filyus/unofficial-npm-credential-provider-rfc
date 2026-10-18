use serde::{Deserialize, Serialize, de::DeserializeOwned};
use std::fmt;
use std::io::{self, BufRead, Write};

#[rustfmt::skip]
pub mod generated;

pub use generated::PROTOCOL_VERSION;

/// How the messages are read where JSON readers differ. A member that is
/// present has its type, and `null` is no value; an integer is any number
/// without a fractional part (`1`, `1.0` and `1e0` are one number) up to
/// 2^53 - 1, the largest every reader holds exactly; unknown members are
/// ignored.
mod wire {
    use serde::de::Error;
    use serde::{Deserialize, Deserializer};

    pub const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

    /// An optional member that, when it is there, is a `T`.
    pub fn present<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
        deserializer: D,
    ) -> Result<Option<T>, D::Error> {
        T::deserialize(deserializer).map(Some)
    }

    pub struct Integer(pub u64);

    impl<'de> Deserialize<'de> for Integer {
        fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
            let number = serde_json::Number::deserialize(deserializer)?;
            let value = match number.as_u64() {
                Some(value) => value,
                None => match number.as_f64() {
                    Some(float) if float.is_finite() && float.fract() == 0.0 && float >= 0.0 => {
                        float as u64
                    }
                    _ => return Err(D::Error::custom("expected a non-negative integer")),
                },
            };
            if value > MAX_SAFE_INTEGER {
                return Err(D::Error::custom("integer beyond 2^53 - 1"));
            }
            Ok(Self(value))
        }
    }

    /// A required integer member that fits `T`.
    pub fn integer<'de, D: Deserializer<'de>, T: TryFrom<u64>>(
        deserializer: D,
    ) -> Result<T, D::Error> {
        let Integer(value) = Integer::deserialize(deserializer)?;
        T::try_from(value).map_err(|_| D::Error::custom("integer out of range"))
    }

    /// An optional integer member that fits `T`, present or absent.
    pub fn optional_integer<'de, D: Deserializer<'de>, T: TryFrom<u64>>(
        deserializer: D,
    ) -> Result<Option<T>, D::Error> {
        integer(deserializer).map(Some)
    }

    pub fn integers<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Vec<u64>, D::Error> {
        let list = Vec::<Integer>::deserialize(deserializer)?;
        Ok(list.into_iter().map(|Integer(value)| value).collect())
    }
}

/// Upper bound on one protocol line, newline included. The draft leaves the
/// value to each peer above a floor every peer accepts (`LINE_SIZE_MINIMUM`,
/// 1 MiB); this build uses the floor. An oversized line is rejected whole
/// instead of being buffered without limit.
pub const MAX_LINE_BYTES: usize = generated::LINE_SIZE_MINIMUM;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Hello {
    #[serde(deserialize_with = "wire::integers")]
    pub v: Vec<u64>,
    #[serde(
        default,
        deserialize_with = "wire::present",
        skip_serializing_if = "Option::is_none"
    )]
    pub capabilities: Option<Vec<String>>,
    /// The registries the provider serves. npm treats any other registry as
    /// `url-not-supported` and sends the provider nothing about it.
    #[serde(
        default,
        deserialize_with = "wire::present",
        skip_serializing_if = "Option::is_none"
    )]
    pub registries: Option<Vec<String>>,
}

impl Hello {
    /// The schema's rules for a hello: `v` is at least one unique integer
    /// from 1, `capabilities` unique non-empty strings, and `registries`
    /// unique absolute `http:`/`https:` URLs, lowercase scheme, no user info,
    /// backslash, query or fragment.
    pub fn validate(&self) -> Result<(), ProtocolError> {
        require(!self.v.is_empty(), "hello v must list a version")?;
        for (index, version) in self.v.iter().enumerate() {
            require(*version >= 1, "hello versions are integers from 1")?;
            require(
                !self.v[..index].contains(version),
                "hello versions must be unique",
            )?;
        }
        if let Some(capabilities) = &self.capabilities {
            for (index, capability) in capabilities.iter().enumerate() {
                require(
                    !capability.is_empty(),
                    "hello capabilities must not be empty",
                )?;
                require(
                    !capabilities[..index].contains(capability),
                    "hello capabilities must be unique",
                )?;
            }
        }
        let Some(registries) = &self.registries else {
            return Ok(());
        };
        for (index, entry) in registries.iter().enumerate() {
            require(
                served_registry_is_well_formed(entry),
                "hello registries must be absolute http(s) URLs without user info, backslash, query or fragment",
            )?;
            require(
                !registries[..index].contains(entry),
                "hello registries must be unique",
            )?;
        }
        Ok(())
    }

    /// Whether this provider serves `registry`: always without a list;
    /// otherwise a listed URL with the same scheme, host and port whose path
    /// is a prefix of the registry's at a segment boundary. Both sides are
    /// taken as already canonical; canonicalization is pinned elsewhere.
    pub fn serves(&self, registry: &str) -> bool {
        let Some(registries) = &self.registries else {
            return true;
        };
        let with_slash = |url: &str| {
            if url.ends_with('/') {
                url.to_string()
            } else {
                format!("{url}/")
            }
        };
        let registry = with_slash(registry);
        registries
            .iter()
            .any(|served| registry.starts_with(&with_slash(served)))
    }

    pub fn v1() -> Self {
        Self {
            v: vec![u64::from(PROTOCOL_VERSION)],
            capabilities: Some(
                generated::CAPABILITIES
                    .iter()
                    .map(|capability| (*capability).to_string())
                    .collect(),
            ),
            registries: None,
        }
    }
}

fn served_registry_is_well_formed(entry: &str) -> bool {
    let Some(rest) = entry
        .strip_prefix("https://")
        .or_else(|| entry.strip_prefix("http://"))
    else {
        return false;
    };
    let (authority, path) = rest.split_at(rest.find('/').unwrap_or(rest.len()));
    !authority.is_empty()
        && !authority
            .chars()
            .any(|c| matches!(c, '/' | '?' | '#' | '@' | '\\') || c.is_whitespace())
        && !path
            .chars()
            .any(|c| matches!(c, '?' | '#' | '\\') || c.is_whitespace())
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
    StageRead,
    Deprecate,
    DistTag,
    Unpublish,
    Owner,
    Access,
    Trust,
    StageReject,
    Account,
    /// An action this build does not know. A provider must not treat it as
    /// `read`; it answers `operation-not-supported`.
    #[serde(other)]
    Unsupported,
}

impl Operation {
    pub fn requires_version(&self) -> bool {
        matches!(self, Self::Publish | Self::Stage | Self::StageReject)
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
    #[serde(deserialize_with = "wire::integer")]
    pub v: u32,
    pub kind: RequestKind,
    pub registry: String,
    #[serde(
        default,
        deserialize_with = "wire::present",
        skip_serializing_if = "Option::is_none"
    )]
    pub scope: Option<String>,
    #[serde(
        default,
        deserialize_with = "wire::present",
        skip_serializing_if = "Option::is_none"
    )]
    pub package: Option<String>,
    #[serde(
        default,
        deserialize_with = "wire::present",
        skip_serializing_if = "Option::is_none"
    )]
    pub version: Option<String>,
    #[serde(
        default,
        deserialize_with = "wire::present",
        skip_serializing_if = "Option::is_none"
    )]
    pub operation: Option<Operation>,
    /// `erase` only: the granularity of the response that carried the rejected
    /// credential. With `scope`, `package` and `operation` it repeats the
    /// context of the `get` that produced that credential.
    #[serde(
        default,
        deserialize_with = "wire::present",
        skip_serializing_if = "Option::is_none"
    )]
    pub granularity: Option<Granularity>,
    /// Informational, so open-ended: `generated::KNOWN_COMMANDS` lists the
    /// values the draft names, and any other npm command may appear.
    #[serde(
        default,
        deserialize_with = "wire::present",
        skip_serializing_if = "Option::is_none"
    )]
    pub command: Option<String>,
    #[serde(
        default,
        deserialize_with = "wire::present",
        skip_serializing_if = "Option::is_none"
    )]
    pub interactive: Option<bool>,
    #[serde(
        default,
        deserialize_with = "wire::present",
        skip_serializing_if = "Option::is_none"
    )]
    pub retry: Option<bool>,
    #[serde(
        rename = "httpStatus",
        default,
        deserialize_with = "wire::optional_integer",
        skip_serializing_if = "Option::is_none"
    )]
    pub http_status: Option<u16>,
    /// `login` only: a token the user already holds, kept out of `Debug`.
    #[serde(
        default,
        deserialize_with = "wire::present",
        skip_serializing_if = "Option::is_none"
    )]
    pub token: Option<Secret>,
    #[serde(
        rename = "authChallenges",
        default,
        deserialize_with = "wire::present",
        skip_serializing_if = "Option::is_none"
    )]
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
            granularity: None,
            command: None,
            interactive: None,
            retry: None,
            http_status: None,
            token: None,
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
            RequestKind::Erase => {
                require(
                    self.operation.is_some() && self.granularity.is_some(),
                    "erase carries the get's operation and the response's granularity",
                )?;
            }
            RequestKind::Login | RequestKind::Logout => {}
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
                require(
                    self.version.is_some(),
                    "publish, stage and stage-reject require version",
                )?;
            }
        }
        if let Some(token) = &self.token {
            require(!token.expose().is_empty(), "token must not be empty")?;
        }
        if let Some(scope) = &self.scope {
            require(
                scope.len() > 1 && scope.starts_with('@') && !scope.contains('/'),
                "scope must look like @name",
            )?;
        }
        for (name, value) in [
            ("package", &self.package),
            ("version", &self.version),
            ("command", &self.command),
        ] {
            if let Some(value) = value {
                require(!value.is_empty(), &format!("{name} must not be empty"))?;
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
    #[serde(
        default,
        deserialize_with = "wire::present",
        skip_serializing_if = "Option::is_none"
    )]
    pub auth: Option<Auth>,
    #[serde(
        default,
        deserialize_with = "wire::present",
        skip_serializing_if = "Option::is_none"
    )]
    pub cache: Option<CachePolicy>,
    #[serde(
        rename = "expiresAt",
        default,
        deserialize_with = "wire::optional_integer",
        skip_serializing_if = "Option::is_none"
    )]
    pub expires_at: Option<u64>,
    #[serde(
        rename = "operationIndependent",
        default,
        deserialize_with = "wire::present",
        skip_serializing_if = "Option::is_none"
    )]
    pub operation_independent: Option<bool>,
    #[serde(
        default,
        deserialize_with = "wire::present",
        skip_serializing_if = "Option::is_none"
    )]
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
        // the schema's cache=expires rule carries no kind condition
        if self.cache == Some(CachePolicy::Expires) {
            require(
                self.expires_at.is_some(),
                "cache=expires requires expiresAt",
            )?;
        }
        // required for get only, but checked wherever it is present, as the
        // schema's `auth` property applies to every kind
        match &self.auth {
            Some(auth) => auth.validate()?,
            None if self.kind == RequestKind::Get => {
                return Err(ProtocolError::InvalidMessage(
                    "token response requires auth".into(),
                ));
            }
            None => {}
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderErr {
    pub kind: ErrorKind,
    #[serde(
        default,
        deserialize_with = "wire::present",
        skip_serializing_if = "Option::is_none"
    )]
    pub message: Option<String>,
    #[serde(
        rename = "causedBy",
        default,
        deserialize_with = "wire::present",
        skip_serializing_if = "Option::is_none"
    )]
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub enum ProviderResponse {
    Ok(ProviderOk),
    Err(ProviderErr),
}

impl<'de> Deserialize<'de> for ProviderResponse {
    /// Exactly one of `Ok` and `Err`; any other member of the envelope is
    /// unknown and ignored, as everywhere in the protocol.
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        struct Envelope {
            #[serde(rename = "Ok", default, deserialize_with = "wire::present")]
            ok: Option<ProviderOk>,
            #[serde(rename = "Err", default, deserialize_with = "wire::present")]
            err: Option<ProviderErr>,
        }
        match Envelope::deserialize(deserializer)? {
            Envelope {
                ok: Some(ok),
                err: None,
            } => Ok(Self::Ok(ok)),
            Envelope {
                ok: None,
                err: Some(err),
            } => Ok(Self::Err(err)),
            _ => Err(serde::de::Error::custom(
                "a response holds exactly one of Ok and Err",
            )),
        }
    }
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
    NoCompatibleVersion { supported: Vec<u64> },
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
    hello.validate()?;
    if hello.v.contains(&u64::from(PROTOCOL_VERSION)) {
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
    // through `Value` first: a string with a lone surrogate is refused
    // wherever it is, an unknown member's included, and a member named twice
    // keeps its last value, as everywhere else
    // not trimmed: JSON's own whitespace (space, tab, CR, LF) may follow the
    // value and serde_json allows it, but ASCII whitespace such as a form feed
    // is not JSON whitespace
    let value: serde_json::Value = serde_json::from_slice(&line)?;
    Ok(Some(serde_json::from_value(value)?))
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

    fn read<T: serde::de::DeserializeOwned>(line: &str) -> Result<T, ProtocolError> {
        read_json_line(&mut io::Cursor::new(format!("{line}\n")))
            .map(|message| message.expect("a line"))
    }

    const GET: &str =
        r#""v":1,"kind":"get","registry":"https://r.test/","operation":"read","interactive":true"#;

    // Found by fuzzing the readers of the protocol against each other
    // (tests/differential.py): each of these was accepted or refused where
    // the schema, the Python model and the JavaScript providers said the
    // opposite.

    #[test]
    fn a_hello_lists_a_version_and_a_capability_is_a_name() {
        for hello in [
            r#"{"v":[]}"#,
            r#"{"v":[0]}"#,
            r#"{"v":[1,1]}"#,
            r#"{"v":[1],"capabilities":[""]}"#,
            r#"{"v":[1],"capabilities":["a","a"]}"#,
        ] {
            let hello: Hello = read(hello).unwrap();
            assert!(hello.validate().is_err(), "{hello:?}");
        }
        read::<Hello>(r#"{"v":[2,1],"capabilities":["login"]}"#)
            .unwrap()
            .validate()
            .unwrap();
    }

    #[test]
    fn a_member_that_is_there_has_its_type_and_null_is_no_value() {
        for line in [
            format!(r#"{{{GET},"retry":null}}"#),
            format!(r#"{{{GET},"httpStatus":null}}"#),
            format!(r#"{{{GET},"scope":null}}"#),
            format!(r#"{{{GET},"authChallenges":null}}"#),
        ] {
            assert!(read::<Request>(&line).is_err(), "{line}");
        }
        assert!(read::<Hello>(r#"{"v":[1],"registries":null}"#).is_err());
        assert!(read::<ProviderResponse>(r#"{"Err":{"kind":"other","message":null}}"#).is_err());
        assert!(
            read::<ProviderResponse>(
                r#"{"Ok":{"kind":"get","auth":{"type":"bearer","token":"t"},"cache":null}}"#
            )
            .is_err()
        );
    }

    #[test]
    fn an_integer_is_a_number_without_a_fraction_up_to_2_pow_53() {
        for spelled in ["1", "1.0", "1e0", "10e-1"] {
            let request: Request = read(&format!(
                r#"{{"v":{spelled},"kind":"logout","registry":"https://r.test/"}}"#
            ))
            .unwrap();
            request.validate().unwrap();
        }
        let hello: Hello = read(r#"{"v":[9007199254740991]}"#).unwrap();
        assert_eq!(hello.v, vec![9_007_199_254_740_991]);
        for refused in [
            r#"{"v":[9007199254740992]}"#,
            r#"{"v":[1.5]}"#,
            r#"{"v":[-1]}"#,
            r#"{"v":[1e400]}"#,
        ] {
            assert!(read::<Hello>(refused).is_err(), "{refused}");
        }
        assert!(
            read::<ProviderResponse>(r#"{"Ok":{"kind":"logout","expiresAt":9007199254740992}}"#)
                .is_err()
        );
    }

    #[test]
    fn a_response_holds_one_of_ok_and_err_and_ignores_other_members() {
        let err: ProviderResponse =
            read(r#"{"Err":{"kind":"other"},"retry":false,"note":[1]}"#).unwrap();
        assert!(matches!(err, ProviderResponse::Err(_)));
        for both in [
            r#"{"Ok":{"kind":"logout"},"Err":{"kind":"other"}}"#,
            r#"{}"#,
            r#"{"retry":false}"#,
        ] {
            assert!(read::<ProviderResponse>(both).is_err(), "{both}");
        }
    }

    #[test]
    fn a_request_follows_the_schema_in_its_text_members() {
        for line in [
            format!(r#"{{{GET},"scope":"a"}}"#),
            format!(r#"{{{GET},"scope":"@"}}"#),
            format!(r#"{{{GET},"scope":"@a/b"}}"#),
            format!(r#"{{{GET},"package":""}}"#),
            format!(r#"{{{GET},"version":""}}"#),
            format!(r#"{{{GET},"command":""}}"#),
        ] {
            let request: Request = read(&line).unwrap();
            assert!(request.validate().is_err(), "{line}");
        }
        read::<Request>(&format!(r#"{{{GET},"scope":"@a","package":"p"}}"#))
            .unwrap()
            .validate()
            .unwrap();
    }

    #[test]
    fn a_lone_surrogate_is_refused_wherever_it_is() {
        for line in [
            r#"{"v":[1],"x":"\ud800"}"#,
            r#"{"v":[1],"x":["\udc00"]}"#,
            r#"{"v":[1],"\ud800":1}"#,
        ] {
            assert!(read::<Hello>(line).is_err(), "{line}");
        }
        read::<Hello>(r#"{"v":[1],"x":"\ud83d\ude00"}"#).unwrap();
    }

    #[test]
    fn only_json_whitespace_may_follow_a_value() {
        read::<Hello>("{\"v\":[1]} \t\r").unwrap();
        for stray in ["\u{c}", "\u{b}", "\u{a0}", "x"] {
            assert!(
                read::<Hello>(&format!("{{\"v\":[1]}}{stray}")).is_err(),
                "{stray:?}"
            );
        }
    }

    #[test]
    fn a_member_named_twice_keeps_its_last_value() {
        let hello: Hello = read(r#"{"v":[2],"v":[1]}"#).unwrap();
        assert_eq!(hello.v, vec![1]);
    }

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
            registries: None,
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
    fn erase_carries_the_context_of_the_get_it_rejects() {
        let line = r#"{"v":1,"kind":"erase","registry":"https://registry.example.test/","scope":"@scope","package":"pkg","operation":"read","granularity":"scope","authChallenges":["Bearer realm=\"r\""]}"#;
        let request: Request = serde_json::from_str(line).unwrap();

        assert_eq!(request.kind, RequestKind::Erase);
        assert_eq!(request.scope.as_deref(), Some("@scope"));
        assert_eq!(request.package.as_deref(), Some("pkg"));
        assert_eq!(request.operation, Some(Operation::Read));
        assert_eq!(request.granularity, Some(Granularity::Scope));
        request.validate().unwrap();
        assert_eq!(
            serde_json::to_value(&request).unwrap(),
            serde_json::from_str::<serde_json::Value>(line).unwrap()
        );
        assert!(
            !serde_json::to_string(&Request::bare(RequestKind::Erase, "https://r.test/"))
                .unwrap()
                .contains("granularity")
        );
    }

    #[test]
    fn interactive_get_budget_is_the_login_budget() {
        assert_eq!(
            generated::GET_INTERACTIVE_TIMEOUT_SECONDS,
            generated::LOGIN_TIMEOUT_SECONDS
        );
        const { assert!(generated::GET_INTERACTIVE_TIMEOUT_SECONDS > generated::GET_TIMEOUT_SECONDS) };
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
            Operation::StageRead,
            Operation::Deprecate,
            Operation::DistTag,
            Operation::Unpublish,
            Operation::Owner,
            Operation::Access,
            Operation::Trust,
            Operation::StageReject,
            Operation::Account,
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
    fn hello_registries_follow_the_schema() {
        let hello = |registries: &[&str]| Hello {
            v: vec![1],
            capabilities: None,
            registries: Some(registries.iter().map(|r| (*r).to_string()).collect()),
        };
        assert!(
            hello(&["https://gitlab.example.com/", "http://10.0.0.1:4873/npm"])
                .validate()
                .is_ok()
        );
        assert!(hello(&[]).validate().is_ok());
        for bad in [
            "/npm/",
            "ftp://x.test/",
            "HTTPS://x.test/",
            "https://u@x.test/",
            "https://gitlab.example.com\\@evil.test/",
            "https://x.test/?a",
            "https://x.test/#a",
            "https://x.test/a b",
        ] {
            assert!(hello(&[bad]).validate().is_err(), "{bad}");
            assert!(negotiate(&hello(&[bad])).is_err(), "{bad}");
        }
        assert!(
            hello(&["https://x.test/", "https://x.test/"])
                .validate()
                .is_err()
        );
    }

    #[test]
    fn hello_registries_decide_what_the_provider_is_asked() {
        let hello = Hello {
            v: vec![1],
            capabilities: None,
            registries: Some(vec!["https://gitlab.example.com/api/".into()]),
        };
        assert!(hello.serves("https://gitlab.example.com/api/v4/"));
        assert!(hello.serves("https://gitlab.example.com/api/"));
        assert!(!hello.serves("https://gitlab.example.com/apix/"));
        assert!(!hello.serves("http://gitlab.example.com/api/v4/"));
        assert!(!hello.serves("https://registry.npmjs.org/"));
        assert!(Hello::v1().serves("https://registry.npmjs.org/"));

        // an empty path segment is part of the path, as in a stored-token key
        let doubled = Hello {
            registries: Some(vec!["https://gitlab.example.com//".into()]),
            ..hello
        };
        assert!(!doubled.serves("https://gitlab.example.com/"));
        assert!(!doubled.serves("https://gitlab.example.com/api/"));
        assert!(doubled.serves("https://gitlab.example.com//api/"));
    }

    #[test]
    fn erase_carries_operation_granularity_and_the_publish_version() {
        let mut erase = Request {
            operation: Some(Operation::Publish),
            version: Some("1.0.0".into()),
            granularity: Some(Granularity::Package),
            ..Request::bare(RequestKind::Erase, "https://registry.example.test/")
        };
        erase.validate().unwrap();
        erase.version = None;
        assert!(erase.validate().is_err(), "publish keeps its version rule");
        erase.version = Some("1.0.0".into());
        erase.granularity = None;
        assert!(erase.validate().is_err());
    }

    #[test]
    fn login_request_with_token_round_trips_and_hides_the_token() {
        let line = r#"{"v":1,"kind":"login","registry":"https://registry.example.test/","interactive":true,"token":"login-secret"}"#;
        let request: Request = serde_json::from_str(line).unwrap();

        assert_eq!(request.token.as_ref().unwrap().expose(), "login-secret");
        request.validate().unwrap();
        assert!(!format!("{request:?}").contains("login-secret"));
        let again: serde_json::Value = serde_json::to_value(&request).unwrap();
        assert_eq!(
            again,
            serde_json::from_str::<serde_json::Value>(line).unwrap()
        );
        assert_eq!(serde_json::from_value::<Request>(again).unwrap(), request);

        let mut empty = request;
        empty.token = Some("".into());
        assert!(empty.validate().is_err());
    }

    #[test]
    fn cache_expires_requires_expires_at_for_every_kind() {
        for kind in [
            RequestKind::Login,
            RequestKind::Logout,
            RequestKind::Get,
            RequestKind::Erase,
        ] {
            let mut ok = if kind == RequestKind::Get {
                ProviderOk::bearer("t", Granularity::Registry)
            } else {
                ProviderOk::done(kind.clone())
            };
            ok.cache = Some(CachePolicy::Expires);
            assert!(ok.validate_for(&kind).is_err(), "{kind:?} accepted");
            ok.expires_at = Some(0);
            ok.validate_for(&kind).unwrap();
        }
    }

    #[test]
    fn auth_present_on_any_kind_is_validated() {
        let mut ok = ProviderOk::done(RequestKind::Erase);
        ok.auth = ProviderOk::bearer("", Granularity::Registry).auth;

        assert!(ok.validate_for(&RequestKind::Erase).is_err());
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
