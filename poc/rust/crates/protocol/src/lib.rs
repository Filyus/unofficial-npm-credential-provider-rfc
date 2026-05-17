use serde::{Deserialize, Serialize, de::DeserializeOwned};
use std::fmt;
use std::io::{self, BufRead, Write};

#[rustfmt::skip]
pub mod generated;

pub use generated::PROTOCOL_VERSION;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Hello {
    pub v: Vec<u32>,
}

impl Hello {
    pub fn v1() -> Self {
        Self {
            v: vec![PROTOCOL_VERSION],
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
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Operation {
    Read,
    Publish,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NpmCommand {
    Install,
    Ci,
    Publish,
    Search,
    View,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PackageContext {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    pub package: String,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<NpmCommand>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interactive: Option<bool>,
    #[serde(rename = "refreshState", skip_serializing_if = "Option::is_none")]
    pub refresh_state: Option<String>,
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
            command: Some(NpmCommand::Install),
            interactive: Some(false),
            refresh_state: None,
            auth_challenges: None,
            packages: None,
        }
    }

    pub fn refresh(registry: impl Into<String>, refresh_state: impl Into<String>) -> Self {
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
            command: Some(NpmCommand::Install),
            interactive: Some(false),
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
                require(self.operation.is_some(), "get-batch requires operation")?;
                require(self.interactive.is_some(), "get-batch requires interactive")?;
                require(self.packages.is_some(), "get-batch requires packages")?;
            }
            RequestKind::Refresh => {
                require(
                    self.refresh_state.is_some(),
                    "refresh requires refreshState",
                )?;
            }
            RequestKind::Login | RequestKind::Logout | RequestKind::Erase => {}
        }
        if self.operation == Some(Operation::Publish) {
            require(self.version.is_some(), "publish requires version")?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Auth {
    Bearer { token: String },
    Basic { username: String, password: String },
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
    pub refresh_state: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub granularity: Option<Granularity>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub results: Option<Vec<TokenResult>>,
}

impl ProviderOk {
    pub fn bearer(token: impl Into<String>, granularity: Granularity) -> Self {
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

    pub fn refreshed(token: impl Into<String>, refresh_state: impl Into<String>) -> Self {
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
        if self.kind == RequestKind::GetBatch {
            require(
                self.results.is_some(),
                "get-batch response requires results",
            )?;
            return Ok(());
        }
        if matches!(
            self.kind,
            RequestKind::Login | RequestKind::Logout | RequestKind::Erase
        ) {
            return Ok(());
        }
        require(self.auth.is_some(), "token response requires auth")?;
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

pub fn read_json_line<T: DeserializeOwned>(
    reader: &mut impl BufRead,
) -> Result<Option<T>, ProtocolError> {
    let mut line = String::new();
    let bytes = reader.read_line(&mut line)?;
    if bytes == 0 {
        return Ok(None);
    }
    Ok(Some(serde_json::from_str(line.trim_end())?))
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
        let error = negotiate(&Hello { v: vec![2] }).unwrap_err();

        assert!(matches!(error, ProtocolError::NoCompatibleVersion { .. }));
    }

    #[test]
    fn publish_requires_version() {
        let mut request =
            Request::get_install("https://registry.example.test/", Some("@scope"), "pkg");
        request.operation = Some(Operation::Publish);

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
    fn generated_command_values_match_serde() {
        let actual = serialized_values([
            NpmCommand::Install,
            NpmCommand::Ci,
            NpmCommand::Publish,
            NpmCommand::Search,
            NpmCommand::View,
        ]);

        assert_eq!(actual, generated::COMMANDS);
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
