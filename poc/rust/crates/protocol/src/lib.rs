use serde::{Deserialize, Serialize, de::DeserializeOwned};
use std::collections::HashSet;
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
        // a set, not a scan of what came before: a hello may be a megabyte of
        // entries, and comparing each with all the others would take minutes
        require(!self.v.is_empty(), "hello v must list a version")?;
        let mut seen = HashSet::new();
        for version in &self.v {
            require(*version >= 1, "hello versions are integers from 1")?;
            require(seen.insert(version), "hello versions must be unique")?;
        }
        if let Some(capabilities) = &self.capabilities {
            let mut seen = HashSet::new();
            for capability in capabilities {
                require(
                    !capability.is_empty(),
                    "hello capabilities must not be empty",
                )?;
                require(
                    seen.insert(capability.as_str()),
                    "hello capabilities must be unique",
                )?;
            }
        }
        let Some(registries) = &self.registries else {
            return Ok(());
        };
        let mut seen = HashSet::new();
        for entry in registries {
            require(
                served_registry_is_well_formed(entry),
                "hello registries must be absolute http(s) URLs without user info, backslash, query or fragment",
            )?;
            require(
                seen.insert(entry.as_str()),
                "hello registries must be unique",
            )?;
        }
        Ok(())
    }

    /// Whether this provider serves `registry`: always without a list;
    /// otherwise a listed URL with the same scheme, host and port whose path
    /// is a prefix of the registry's at a segment boundary, as the Python model
    /// compares them (`registry_matches`): host case, a default port and dot
    /// segments are not differences, the path is compared byte for byte, and a
    /// URL with no canonical form (a port over 65535, an unpaired bracket)
    /// matches nothing. Limit: a host with a non-ASCII character is compared
    /// lowercased and not as punycode (no IDNA table in this crate), so
    /// `https://bücher.example/` and `https://xn--bcher-kva.example/` differ
    /// here and agree in the Python model.
    pub fn serves(&self, registry: &str) -> bool {
        self.serves_in(registry, false)
    }

    /// `serves`, for a provider that may be in the global chain: there a
    /// hello with no `registries` serves no registry, since a provider in
    /// the global chain must list what it serves. In a per-registry list the
    /// user named the registry, so no list means the provider is asked.
    pub fn serves_in(&self, registry: &str, global_chain: bool) -> bool {
        let Some(registries) = &self.registries else {
            return !global_chain;
        };
        let Some(wanted) = canonical(registry) else {
            return false;
        };
        registries
            .iter()
            .any(|served| canonical(served).is_some_and(|served| served.covers(&wanted)))
    }

    /// The entries of this hello's `registries` that name the host of
    /// `registry`, in any form: another scheme, port or path on that host. A
    /// global chain every provider of which declined `registry` sends no stored
    /// credential where some provider lists the host (`fallback` in
    /// spec/policy-v1.json): that is a URL form the provider declined. Hosts
    /// compare as `serves` compares them.
    pub fn listed_forms(&self, registry: &str) -> Vec<String> {
        let (Some(registries), Some(wanted)) = (&self.registries, canonical(registry)) else {
            return Vec::new();
        };
        registries
            .iter()
            .filter(|entry| canonical(entry).is_some_and(|entry| entry.host == wanted.host))
            .cloned()
            .collect()
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

/// A URL as registry matching compares it: scheme (absent for a `//host/path/`
/// key), lowercase host, port (absent when it is the scheme's default), and the
/// path with its dot segments resolved, ending in `/`.
#[derive(Debug, PartialEq, Eq)]
struct Canonical {
    scheme: Option<String>,
    host: String,
    port: Option<u16>,
    path: String,
}

impl Canonical {
    /// Whether `other` falls under `self`: the scheme compared only when `self`
    /// has one, host and port equal, `self`'s path a prefix of `other`'s.
    fn covers(&self, other: &Self) -> bool {
        let mut port = other.port;
        if self.scheme.is_none() && port == other.scheme.as_deref().and_then(default_port) {
            port = None;
        }
        if self.scheme.is_some() && self.scheme != other.scheme {
            return false;
        }
        self.host == other.host && self.port == port && other.path.starts_with(&self.path)
    }
}

fn default_port(scheme: &str) -> Option<u16> {
    match scheme {
        "http" => Some(80),
        "https" => Some(443),
        _ => None,
    }
}

fn canonical(url: &str) -> Option<Canonical> {
    let (scheme, rest) = match url.split_once("://") {
        Some((scheme, rest))
            if scheme.starts_with(|c: char| c.is_ascii_alphabetic())
                && scheme
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.')) =>
        {
            (Some(scheme.to_ascii_lowercase()), rest)
        }
        _ => (None, url.strip_prefix("//")?),
    };
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let (authority, tail) = rest.split_at(end);
    let path = &tail[..tail.find(['?', '#']).unwrap_or(tail.len())];
    let hostport = authority
        .rsplit_once('@')
        .map_or(authority, |(_, rest)| rest);
    let (host, port) = if let Some(bracketed) = hostport.strip_prefix('[') {
        let (host, after) = bracketed.split_once(']')?;
        (host, after.strip_prefix(':'))
    } else {
        match hostport.rsplit_once(':') {
            Some((host, port)) => (host, Some(port)),
            None => (hostport, None),
        }
    };
    let port = match port {
        None | Some("") => None,
        Some(digits) if digits.bytes().all(|b| b.is_ascii_digit()) => Some(digits.parse().ok()?),
        Some(_) => return None,
    };
    let port = match &scheme {
        Some(scheme) if port == default_port(scheme) => None,
        _ => port,
    };
    // as the IDNA encoding the Python model applies refuses it: a label of more than 63 characters
    if host.is_ascii() && host.split('.').any(|label| label.len() > 63) {
        return None;
    }
    let mut segments: Vec<&str> = Vec::new();
    for segment in path.split('/').skip(1) {
        match segment {
            ".." => {
                segments.pop();
            }
            "." => {}
            other => segments.push(other),
        }
    }
    let mut path = format!("/{}", segments.join("/"));
    if !path.ends_with('/') {
        path.push('/');
    }
    Some(Canonical {
        scheme,
        host: host.to_lowercase(),
        port,
        path,
    })
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

/// The schema's pattern for an open-ended name, `kind` and `operation`: a lowercase
/// letter, then lowercase letters, digits and hyphens, and nothing after (a
/// trailing newline included).
pub fn is_identifier(text: &str) -> bool {
    let mut chars = text.chars();
    matches!(chars.next(), Some('a'..='z'))
        && chars.all(|c| matches!(c, 'a'..='z' | '0'..='9' | '-'))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RequestKind {
    Login,
    Logout,
    Get,
    Erase,
    /// A kind this build does not know, sent by a newer client: a well-formed
    /// name (`is_identifier`) it has no variant for. A provider answers it with
    /// `operation-not-supported`; a client never sends it. A text that is not a
    /// name is not a kind at all and does not parse.
    Unsupported,
}

impl<'de> Deserialize<'de> for RequestKind {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let text = String::deserialize(deserializer)?;
        Ok(match text.as_str() {
            "login" => Self::Login,
            "logout" => Self::Logout,
            "get" => Self::Get,
            "erase" => Self::Erase,
            other if is_identifier(other) => Self::Unsupported,
            _ => {
                return Err(serde::de::Error::custom(
                    "kind must be a lowercase identifier",
                ));
            }
        })
    }
}

/// The npm action a credential must authorize. npm names the action and the
/// provider maps it onto its registry's own tiers, because those differ: npmjs
/// splits stage-only from direct publish, GitHub Packages and Azure Artifacts
/// put deletion in a tier above write.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
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
    /// An action this build does not know: a well-formed name it has no variant
    /// for. A provider must not treat it as `read`; it answers
    /// `operation-not-supported`. A text that is not a name does not parse.
    Unsupported,
}

impl<'de> Deserialize<'de> for Operation {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let text = String::deserialize(deserializer)?;
        Ok(match text.as_str() {
            "read" => Self::Read,
            "publish" => Self::Publish,
            "stage" => Self::Stage,
            "stage-read" => Self::StageRead,
            "deprecate" => Self::Deprecate,
            "dist-tag" => Self::DistTag,
            "unpublish" => Self::Unpublish,
            "owner" => Self::Owner,
            "access" => Self::Access,
            "trust" => Self::Trust,
            "stage-reject" => Self::StageReject,
            "account" => Self::Account,
            other if is_identifier(other) => Self::Unsupported,
            _ => {
                return Err(serde::de::Error::custom(
                    "operation must be a lowercase identifier",
                ));
            }
        })
    }
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

    /// What a client may send: a request the schema allows, of a kind and with
    /// an operation this build knows.
    pub fn validate(&self) -> Result<(), ProtocolError> {
        self.validate_received()?;
        require(
            self.kind != RequestKind::Unsupported,
            "a client must not send an unknown request kind",
        )?;
        require(
            self.operation != Some(Operation::Unsupported),
            "a client must not send an unknown operation",
        )
    }

    /// What a provider may receive: a request the schema allows. A kind or an
    /// operation this build does not know is well formed (a newer client sends
    /// them) and is answered `operation-not-supported`, not refused as malformed.
    pub fn validate_received(&self) -> Result<(), ProtocolError> {
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
            RequestKind::Login | RequestKind::Logout | RequestKind::Unsupported => {}
        }
        if let Some(operation) = &self.operation
            && operation.requires_version()
        {
            require(
                self.version.is_some(),
                "publish, stage and stage-reject require version",
            )?;
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Auth {
    Bearer {
        token: Secret,
    },
    Basic {
        username: String,
        password: Secret,
    },
    /// An anonymous answer, `{"type": "none"}`: npm sends the request with no
    /// credential. Valid only as the answer to a first `get` for `read` (see
    /// `ProviderOk::validate_answer_to`).
    Anonymous,
    /// An `auth.type` this build does not know, sent by a newer provider: a
    /// well-formed name (`is_identifier`) it has no variant for. npm has
    /// nothing it can send, so a client fails the request as an `other` answer.
    /// It is written back as `{"type": <name>}`, which reads as itself, so a
    /// message the crate holds always survives its writer and reader.
    Unknown(String),
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum KnownAuthRef<'a> {
    Bearer {
        token: &'a Secret,
    },
    Basic {
        username: &'a str,
        password: &'a Secret,
    },
    None {},
}

impl Serialize for Auth {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        match self {
            Self::Bearer { token } => KnownAuthRef::Bearer { token }.serialize(serializer),
            Self::Basic { username, password } => {
                KnownAuthRef::Basic { username, password }.serialize(serializer)
            }
            Self::Anonymous => KnownAuthRef::None {}.serialize(serializer),
            Self::Unknown(name) => {
                let mut map = serializer.serialize_map(Some(1))?;
                map.serialize_entry("type", name)?;
                map.end()
            }
        }
    }
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum KnownAuth {
    Bearer { token: Secret },
    Basic { username: String, password: Secret },
    None {},
}

impl<'de> Deserialize<'de> for Auth {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        use serde::de::Error;
        let value = serde_json::Value::deserialize(deserializer)?;
        let name = value
            .get("type")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| D::Error::custom("auth.type must be a string"))?;
        match name {
            "bearer" | "basic" | "none" => KnownAuth::deserialize(value.clone())
                .map(|known| match known {
                    KnownAuth::Bearer { token } => Self::Bearer { token },
                    KnownAuth::Basic { username, password } => Self::Basic { username, password },
                    KnownAuth::None {} => Self::Anonymous,
                })
                .map_err(D::Error::custom),
            other if is_identifier(other) => Ok(Self::Unknown(other.to_owned())),
            _ => Err(D::Error::custom("auth.type must be a lowercase identifier")),
        }
    }
}

impl Auth {
    pub fn validate(&self) -> Result<(), ProtocolError> {
        match self {
            // well formed: what to do with it is the client's business
            Self::Unknown(_) | Self::Anonymous => Ok(()),
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
        deserialize_with = "open::cache",
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
        deserialize_with = "open::granularity",
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

    /// Whether the answer serves every operation: the field when the answer
    /// carries it, else the policy's default (`false`: the answer serves only
    /// the operation it was issued for).
    pub fn serves_every_operation(&self) -> bool {
        self.operation_independent
            .unwrap_or(generated::OPERATION_INDEPENDENT_DEFAULT)
    }

    /// `validate_for`, and the rule that needs the request: an anonymous
    /// answer (`auth.type` `none`) is valid only for a first `get` for `read`,
    /// not for another operation or kind, nor for a retry. Anything else is a
    /// malformed answer, as a bearer answer with no token is.
    pub fn validate_answer_to(&self, request: &Request) -> Result<(), ProtocolError> {
        self.validate_for(&request.kind)?;
        if self.auth == Some(Auth::Anonymous) {
            require(
                request.kind == RequestKind::Get
                    && request.operation == Some(Operation::Read)
                    && request.retry != Some(true),
                "an anonymous answer is valid only for a get for read that is not a retry",
            )?;
        }
        Ok(())
    }

    pub fn validate_for(&self, kind: &RequestKind) -> Result<(), ProtocolError> {
        require(&self.kind == kind, "Ok.kind must match request kind")?;
        // an anonymous answer is never operation independent: it serves a
        // read, and nothing else may find it in a cache
        if self.auth == Some(Auth::Anonymous) {
            require(
                self.operation_independent != Some(true),
                "an anonymous answer is never operation independent",
            )?;
        }
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ProviderErr {
    pub kind: ErrorKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(rename = "causedBy", skip_serializing_if = "Option::is_none")]
    pub caused_by: Option<Vec<String>>,
}

/// `ProviderErr` as it is on the wire: an object. (The derived reader of a
/// struct also takes a JSON array, by position, and `open::error_kind` takes
/// any name, so `["a"]` would be an `Err` of kind `a`.)
#[derive(Deserialize)]
struct WireErr {
    #[serde(deserialize_with = "open::error_kind")]
    kind: ErrorKind,
    #[serde(default, deserialize_with = "wire::present")]
    message: Option<String>,
    #[serde(rename = "causedBy", default, deserialize_with = "wire::present")]
    caused_by: Option<Vec<String>>,
}

impl<'de> Deserialize<'de> for ProviderErr {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        use serde::de::Error;
        let value = serde_json::Value::deserialize(deserializer)?;
        if !value.is_object() {
            return Err(D::Error::custom("Err must be an object"));
        }
        let WireErr {
            kind,
            message,
            caused_by,
        } = WireErr::deserialize(value).map_err(D::Error::custom)?;
        Ok(Self {
            kind,
            message,
            caused_by,
        })
    }
}

/// An error kind of the protocol. A provider newer than npm may answer with one
/// this version does not know: on the wire that is read as `Other`
/// (`UNKNOWN_ERROR_KIND`), the most cautious known kind, by `open::error_kind`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ErrorKind {
    UrlNotSupported,
    NotFound,
    OperationNotSupported,
    Other,
}

/// Values of known response fields that a provider newer than npm may extend:
/// a well-formed name (`is_identifier`) this build has no variant for is read as
/// the most cautious known value, the mapping `forwardCompatibility` of
/// spec/policy-v1.json says; a text that is not a name is not a value at all and
/// does not parse. (`auth.type` has no such value: see `Auth::Unknown`.)
mod open {
    use super::{CachePolicy, ErrorKind, Granularity, is_identifier};
    use serde::de::Error;
    use serde::{Deserialize, Deserializer};

    fn name<'de, D: Deserializer<'de>>(deserializer: D, what: &str) -> Result<String, D::Error> {
        let text = String::deserialize(deserializer)?;
        if is_identifier(&text) {
            Ok(text)
        } else {
            Err(D::Error::custom(format!(
                "{what} must be a lowercase identifier"
            )))
        }
    }

    pub fn error_kind<'de, D: Deserializer<'de>>(deserializer: D) -> Result<ErrorKind, D::Error> {
        Ok(match name(deserializer, "Err.kind")?.as_str() {
            "url-not-supported" => ErrorKind::UrlNotSupported,
            "not-found" => ErrorKind::NotFound,
            "operation-not-supported" => ErrorKind::OperationNotSupported,
            _ => ErrorKind::Other,
        })
    }

    pub fn cache<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<Option<CachePolicy>, D::Error> {
        Ok(Some(match name(deserializer, "cache")?.as_str() {
            "session" => CachePolicy::Session,
            "expires" => CachePolicy::Expires,
            _ => CachePolicy::Never,
        }))
    }

    pub fn granularity<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<Option<Granularity>, D::Error> {
        Ok(Some(match name(deserializer, "granularity")?.as_str() {
            "registry" => Granularity::Registry,
            "scope" => Granularity::Scope,
            _ => Granularity::Package,
        }))
    }
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
    /// `validate_for` with the request itself, for the rules that need more
    /// than its kind (an anonymous answer is valid for a first `get` for
    /// `read` only).
    pub fn validate_answer_to(&self, request: &Request) -> Result<(), ProtocolError> {
        match self {
            ProviderResponse::Ok(ok) => ok.validate_answer_to(request),
            ProviderResponse::Err(_) => Ok(()),
        }
    }

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
    NoCompatibleVersion {
        supported: Vec<u64>,
    },
    LineTooLong {
        limit: usize,
    },
    /// A line that is not a message of the kind asked for. It names the length
    /// of the line and never its content, which may be a credential.
    Malformed {
        bytes: usize,
    },
    Io(io::Error),
    /// A message that could not be written.
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
            Self::Malformed { bytes } => {
                write!(f, "malformed protocol line of {bytes} bytes")
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
/// rather than buffering whatever the peer chooses to send. What is left of an
/// oversized line is thrown away as it is read, so the next call starts where a
/// line starts. A line of nothing but spaces, tabs and carriage returns is
/// skipped.
pub fn read_json_line<T: DeserializeOwned>(
    reader: &mut impl BufRead,
) -> Result<Option<T>, ProtocolError> {
    Ok(read_line(reader, false)?.map(|(message, _)| message))
}

/// `read_json_line` for what npm reads from a provider's stdout. `at_start` is
/// true for the first read of the stream: a UTF-8 byte order mark before the
/// first line is skipped, as Phase 1a skips one before a helper's output. A
/// line that is not a message is `Malformed`, which says how long the line was
/// and nothing of what it held, since it may carry a credential. The length of a
/// line that is a message comes with it, for a caller that later finds it
/// does not fit what it asked for and must say so the same way.
pub fn read_provider_line<T: DeserializeOwned>(
    reader: &mut impl BufRead,
    at_start: bool,
) -> Result<Option<(T, usize)>, ProtocolError> {
    read_line(reader, at_start)
}

const BYTE_ORDER_MARK: &[u8] = b"\xEF\xBB\xBF";

fn read_line<T: DeserializeOwned>(
    reader: &mut impl BufRead,
    mut skip_mark: bool,
) -> Result<Option<(T, usize)>, ProtocolError> {
    loop {
        let mut line = Vec::new();
        let bytes =
            io::Read::take(&mut *reader, MAX_LINE_BYTES as u64 + 1).read_until(b'\n', &mut line)?;
        if bytes == 0 {
            return Ok(None);
        }
        if line.len() > MAX_LINE_BYTES {
            if !line.ends_with(b"\n") {
                skip_to_newline(reader)?;
            }
            return Err(ProtocolError::LineTooLong {
                limit: MAX_LINE_BYTES,
            });
        }
        // only the first line of the stream: a mark anywhere else is not JSON
        if std::mem::take(&mut skip_mark) && line.starts_with(BYTE_ORDER_MARK) {
            line.drain(..BYTE_ORDER_MARK.len());
        }
        if line
            .iter()
            .all(|byte| matches!(byte, b' ' | b'\t' | b'\r' | b'\n'))
        {
            continue;
        }
        // through `Value` first: a string with a lone surrogate is refused
        // wherever it is, an unknown member's included, and a member named twice
        // keeps its last value, as everywhere else
        // not trimmed: JSON's own whitespace (space, tab, CR, LF) may follow the
        // value and serde_json allows it, but ASCII whitespace such as a form feed
        // is not JSON whitespace
        let malformed = |_| ProtocolError::Malformed { bytes: line.len() };
        let value: serde_json::Value = serde_json::from_slice(&line).map_err(malformed)?;
        let message = serde_json::from_value(value).map_err(malformed)?;
        return Ok(Some((message, line.len())));
    }
}

/// Reads and drops the rest of the line, a buffer at a time.
fn skip_to_newline(reader: &mut impl BufRead) -> Result<(), ProtocolError> {
    loop {
        let buffer = reader.fill_buf()?;
        if buffer.is_empty() {
            return Ok(());
        }
        match buffer.iter().position(|byte| *byte == b'\n') {
            Some(at) => {
                reader.consume(at + 1);
                return Ok(());
            }
            None => {
                let all = buffer.len();
                reader.consume(all);
            }
        }
    }
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

    // Found by a review of the crate (and then pinned): a hello can be a megabyte
    // of entries, and the lines around it must stay in step.

    #[test]
    fn a_hello_of_a_megabyte_is_validated_in_a_moment() {
        let versions: Vec<u64> = (1..=100_000).collect();
        let capabilities: Vec<String> = (0..60_000).map(|number| format!("c{number}")).collect();
        let registries: Vec<String> = (0..30_000)
            .map(|number| format!("https://r{number}.example.test/"))
            .collect();
        let hello = Hello {
            v: versions,
            capabilities: Some(capabilities),
            registries: Some(registries),
        };
        let started = std::time::Instant::now();
        hello.validate().unwrap();
        assert!(
            started.elapsed() < std::time::Duration::from_secs(5),
            "validating took {:?}",
            started.elapsed()
        );
    }

    #[test]
    fn a_blank_line_is_skipped_and_an_oversized_one_leaves_the_next_line_readable() {
        let mut input = io::Cursor::new(b"  \r\n\n\t\n{\"n\":1}\n".to_vec());
        let first: serde_json::Value = read_json_line(&mut input).unwrap().unwrap();
        assert_eq!(first["n"], 1);
        assert!(
            read_json_line::<serde_json::Value>(&mut input)
                .unwrap()
                .is_none()
        );

        let mut long = vec![b'x'; MAX_LINE_BYTES + 5000];
        long.push(b'\n');
        long.extend_from_slice(b"{\"n\":2}\n");
        let mut input = io::Cursor::new(long);
        assert!(matches!(
            read_json_line::<serde_json::Value>(&mut input),
            Err(ProtocolError::LineTooLong { .. })
        ));
        let next: serde_json::Value = read_json_line(&mut input).unwrap().unwrap();
        assert_eq!(next["n"], 2, "the stream is where a line starts");
    }

    #[test]
    fn a_byte_order_mark_before_the_first_line_of_a_provider_is_skipped() {
        let value = |input: &[u8], at_start| {
            let mut input = io::Cursor::new(input.to_vec());
            read_provider_line::<serde_json::Value>(&mut input, at_start)
        };
        // before the first line, the first of the stream
        let (hello, _) = value(b"\xEF\xBB\xBF{\"v\":[1]}\n", true).unwrap().unwrap();
        assert_eq!(hello["v"][0], 1);
        // a line of its own is a blank line, and the next one is the first message
        let mut input = io::Cursor::new(b"\xEF\xBB\xBF\n{\"v\":[1]}\n".to_vec());
        let (hello, _) = read_provider_line::<serde_json::Value>(&mut input, true)
            .unwrap()
            .unwrap();
        assert_eq!(hello["v"][0], 1);
        // anywhere else it is not JSON: not on a later line, nor on a read that is not the first
        assert!(matches!(
            value(b"\xEF\xBB\xBF{\"v\":[1]}\n", false),
            Err(ProtocolError::Malformed { .. })
        ));
        let mut input = io::Cursor::new(b"{\"n\":1}\n\xEF\xBB\xBF{\"n\":2}\n".to_vec());
        read_provider_line::<serde_json::Value>(&mut input, true)
            .unwrap()
            .unwrap();
        assert!(matches!(
            read_provider_line::<serde_json::Value>(&mut input, false),
            Err(ProtocolError::Malformed { .. })
        ));
    }

    #[test]
    fn a_carriage_return_ends_a_line_as_trailing_whitespace() {
        let mut input = io::Cursor::new(b"{\"n\":1}\r\n{\"n\":2} \t\r\n".to_vec());
        for number in [1, 2] {
            let line: serde_json::Value = read_json_line(&mut input).unwrap().unwrap();
            assert_eq!(line["n"], number);
        }
    }

    #[test]
    fn a_malformed_line_is_reported_by_its_length_and_never_quoted() {
        // a valid JSON line that is not the message asked for would make serde
        // quote the string it found, and this one stands for a credential
        let line = r#"{"Ok":{"kind":"get","auth":"super-secret-token"}}"#;
        let mut input = io::Cursor::new(format!("{line}\n"));
        let error = read_provider_line::<ProviderResponse>(&mut input, true).unwrap_err();
        assert!(
            matches!(error, ProtocolError::Malformed { bytes } if bytes == line.len() + 1),
            "{error}"
        );
        assert!(!error.to_string().contains("secret"), "{error}");
        // not JSON at all, with the secret in it
        let mut input = io::Cursor::new(b"token=super-secret-token\n".to_vec());
        let error = read_provider_line::<serde_json::Value>(&mut input, true).unwrap_err();
        assert!(!format!("{error:?}{error}").contains("secret"));
    }

    #[test]
    fn a_line_of_exactly_the_limit_with_its_newline_is_read_and_one_byte_more_is_not() {
        let at_limit = format!("{}{}\n", " ".repeat(MAX_LINE_BYTES - 3), "{}");
        let mut input = io::Cursor::new(at_limit.into_bytes());
        read_json_line::<serde_json::Value>(&mut input)
            .unwrap()
            .unwrap();
        let over = format!("{}{}\n", " ".repeat(MAX_LINE_BYTES - 2), "{}");
        let mut input = io::Cursor::new(over.into_bytes());
        assert!(matches!(
            read_json_line::<serde_json::Value>(&mut input),
            Err(ProtocolError::LineTooLong { .. })
        ));
    }

    #[test]
    fn a_request_a_provider_receives_may_have_a_kind_this_build_does_not_know() {
        let request: Request = read(r#"{"v":1,"kind":"refresh","registry":"x"}"#).unwrap();
        request.validate_received().unwrap();
        assert!(request.validate().is_err(), "a client does not send it");
        let known: Request =
            read(r#"{"v":1,"kind":"get","registry":"x","operation":"read"}"#).unwrap();
        assert!(
            known.validate_received().is_err(),
            "a get still needs interactive"
        );
    }

    #[test]
    fn a_kind_or_an_operation_that_is_not_a_name_does_not_parse() {
        // the schema's pattern, as the Python model and the providers hold it: `Get`,
        // `login` followed by a newline, a digit first or an underscore make no name
        for kind in ["Get", "login\\n", "9x", "x_y", "", "get "] {
            let line = format!(r#"{{"v":1,"kind":"{kind}","registry":"x"}}"#);
            assert!(read::<Request>(&line).is_err(), "kind {kind:?}");
            let line = format!(r#"{{"Ok":{{"kind":"{kind}"}}}}"#);
            assert!(read::<ProviderResponse>(&line).is_err(), "Ok.kind {kind:?}");
            let line = format!(r#"{{{GET},"operation":"{kind}"}}"#);
            assert!(read::<Request>(&line).is_err(), "operation {kind:?}");
        }
        for name in ["refresh", "x-y", "a1"] {
            let request: Request =
                read(&format!(r#"{{"v":1,"kind":"{name}","registry":"x"}}"#)).unwrap();
            assert_eq!(request.kind, RequestKind::Unsupported);
            let request: Request = read(&format!(r#"{{{GET},"operation":"{name}"}}"#)).unwrap();
            assert_eq!(request.operation, Some(Operation::Unsupported));
            request.validate_received().unwrap();
        }
    }

    // The cases of Registry matching shared with the Python model
    // (tests/test_registry_matching.py reads the same file).
    #[test]
    fn registry_matching_answers_as_the_python_model_does() {
        let shared: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../../../tests/registry_matching_cases.json"
            ))
            .expect("the cases are in the repository"),
        )
        .unwrap();
        let cases = shared["cases"].as_array().unwrap();
        assert!(cases.len() >= 25, "{} cases", cases.len());
        for case in cases {
            let (served, url, expected) = (
                case[0].as_str().unwrap(),
                case[1].as_str().unwrap(),
                case[2].as_bool().unwrap(),
            );
            let hello = Hello {
                v: vec![1],
                capabilities: None,
                registries: Some(vec![served.to_string()]),
            };
            assert_eq!(hello.serves(url), expected, "{served} serving {url}");
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
    fn an_answer_without_operation_independent_serves_only_its_own_operation() {
        let answer = |extra: serde_json::Value| -> ProviderOk {
            let mut ok = serde_json::json!({
                "kind": "get", "auth": {"type": "bearer", "token": "t"}
            });
            ok.as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            serde_json::from_value(ok).unwrap()
        };

        const { assert!(!generated::OPERATION_INDEPENDENT_DEFAULT) };
        assert!(!answer(serde_json::json!({})).serves_every_operation());
        assert!(
            !answer(serde_json::json!({"operationIndependent": false})).serves_every_operation()
        );
        assert!(answer(serde_json::json!({"operationIndependent": true})).serves_every_operation());
    }

    #[test]
    fn an_anonymous_answer_is_valid_for_a_first_get_for_read_only() {
        let ok: ProviderOk = serde_json::from_str(
            r#"{"kind":"get","auth":{"type":"none"},"cache":"session","granularity":"registry"}"#,
        )
        .unwrap();
        assert_eq!(ok.auth, Some(Auth::Anonymous));
        let read = Request::get_install("https://registry.example.test/", None, "left-pad");
        ok.validate_answer_to(&read).unwrap();

        let publish = Request::get_publish("https://registry.example.test/", None, "p", "1.0.0");
        assert!(ok.validate_answer_to(&publish).is_err());
        let retry = Request {
            retry: Some(true),
            http_status: Some(401),
            ..read.clone()
        };
        assert!(ok.validate_answer_to(&retry).is_err());
        let login = Request::bare(RequestKind::Login, "https://registry.example.test/");
        let answer = ProviderOk {
            kind: RequestKind::Login,
            ..ok.clone()
        };
        assert!(answer.validate_answer_to(&login).is_err());
    }

    #[test]
    fn an_anonymous_answer_is_never_operation_independent() {
        let ok: ProviderOk = serde_json::from_str(
            r#"{"kind":"get","auth":{"type":"none"},"operationIndependent":true}"#,
        )
        .unwrap();
        assert!(ok.validate_for(&RequestKind::Get).is_err());
        let ok: ProviderOk = serde_json::from_str(
            r#"{"kind":"get","auth":{"type":"none"},"operationIndependent":false}"#,
        )
        .unwrap();
        ok.validate_for(&RequestKind::Get).unwrap();
    }

    #[test]
    fn a_provider_in_the_global_chain_without_registries_serves_none() {
        let without = Hello::v1();
        assert!(without.serves("https://registry.example.test/"));
        assert!(without.serves_in("https://registry.example.test/", false));
        assert!(!without.serves_in("https://registry.example.test/", true));
        let with = Hello {
            registries: Some(vec!["https://registry.example.test/".into()]),
            ..Hello::v1()
        };
        assert!(with.serves_in("https://registry.example.test/", true));
        assert!(!with.serves_in("https://other.example.test/", true));
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
        let none = serde_json::to_value(Auth::Anonymous).unwrap();
        let actual = vec![
            bearer["type"].as_str().unwrap().to_string(),
            basic["type"].as_str().unwrap().to_string(),
            none["type"].as_str().unwrap().to_string(),
        ];

        assert_eq!(actual, generated::AUTH_TYPES);
    }

    fn response(text: &str) -> Result<ProviderResponse, serde_json::Error> {
        serde_json::from_str(text)
    }

    #[test]
    fn an_unknown_error_kind_is_read_as_other() {
        for kind in ["permission-denied", "rate-limited", "x1"] {
            let parsed = response(&format!(r#"{{"Err":{{"kind":"{kind}"}}}}"#)).unwrap();
            let ProviderResponse::Err(err) = parsed else {
                panic!("an Err")
            };
            assert_eq!(err.kind, ErrorKind::Other, "{kind}");
        }
        assert_eq!(
            serde_json::to_value(ErrorKind::Other).unwrap(),
            generated::UNKNOWN_ERROR_KIND
        );
        // an array is not an object, whatever its first element reads as
        assert!(response(r#"{"Err":["a"]}"#).is_err());
        assert!(response(r#"{"Err":["other","m"]}"#).is_err());
        for bad in [r#""Other""#, r#""""#, "1", "null", r#""other\n""#] {
            assert!(
                response(&format!(r#"{{"Err":{{"kind":{bad}}}}}"#)).is_err(),
                "{bad}"
            );
        }
    }

    #[test]
    fn an_unknown_cache_is_read_as_never_and_an_unknown_granularity_as_package() {
        let ProviderResponse::Ok(ok) = response(
            r#"{"Ok":{"kind":"get","auth":{"type":"bearer","token":"t"},"cache":"lease","granularity":"host"}}"#,
        )
        .unwrap() else {
            panic!("an Ok")
        };
        assert_eq!(ok.cache, Some(CachePolicy::Never));
        assert_eq!(ok.granularity, Some(Granularity::Package));
        ok.validate_for(&RequestKind::Get).unwrap();
        // an unknown cache needs no expiresAt, which only `expires` requires
        assert!(
            response(r#"{"Ok":{"kind":"login","cache":"lease"}}"#)
                .unwrap()
                .validate_for(&RequestKind::Login)
                .is_ok()
        );
        assert_eq!(
            serde_json::to_value(CachePolicy::Never).unwrap(),
            generated::UNKNOWN_CACHE
        );
        assert_eq!(
            serde_json::to_value(Granularity::Package).unwrap(),
            generated::UNKNOWN_GRANULARITY
        );
        for bad in [
            r#""cache":"Lease""#,
            r#""cache":"""#,
            r#""cache":1"#,
            r#""granularity":"Host""#,
            r#""granularity":"""#,
            r#""granularity":null"#,
        ] {
            assert!(
                response(&format!(r#"{{"Ok":{{"kind":"login",{bad}}}}}"#)).is_err(),
                "{bad}"
            );
        }
    }

    #[test]
    fn an_unknown_auth_type_is_well_formed_and_a_client_fails_it() {
        let ProviderResponse::Ok(ok) =
            response(r#"{"Ok":{"kind":"get","auth":{"type":"digest","realm":"r"}}}"#).unwrap()
        else {
            panic!("an Ok")
        };
        assert_eq!(ok.auth, Some(Auth::Unknown("digest".into())));
        // what the crate reads it writes back, and reads again as the same value
        let written = serde_json::to_string(&ok.auth).unwrap();
        assert_eq!(written, r#"{"type":"digest"}"#);
        let back: Option<Auth> = serde_json::from_str(&written).unwrap();
        assert_eq!(back, ok.auth);
        ok.validate_for(&RequestKind::Get).unwrap();
        for bad in [
            r#"{"type":"Digest"}"#,
            r#"{"type":""}"#,
            r#"{"type":1}"#,
            r#"{}"#,
            r#"{"type":"bearer"}"#,
            r#"{"type":"basic","username":"u"}"#,
        ] {
            assert!(
                response(&format!(r#"{{"Ok":{{"kind":"get","auth":{bad}}}}}"#)).is_err(),
                "{bad}"
            );
        }
    }

    #[test]
    fn a_hello_says_which_forms_of_a_host_it_lists() {
        let hello = Hello {
            registries: Some(vec![
                "https://registry.example.test/npm/".into(),
                "http://REGISTRY.example.test:8080/".into(),
                "https://other.example.test/".into(),
            ]),
            ..Hello::v1()
        };
        assert_eq!(
            hello.listed_forms("http://registry.example.test/"),
            vec![
                "https://registry.example.test/npm/".to_string(),
                "http://REGISTRY.example.test:8080/".to_string()
            ]
        );
        assert!(
            hello
                .listed_forms("https://elsewhere.example.test/")
                .is_empty()
        );
        assert!(
            Hello::v1()
                .listed_forms("https://registry.example.test/")
                .is_empty()
        );
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
