//! The mock provider as a built binary, shared by the test files that start it.

use mock_client::ProviderCommand;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::OnceLock;

/// Builds the mock provider once per test binary and gives its path. The
/// binary is run itself and not through `cargo run`: killing a `cargo run`
/// would leave the provider behind, holding its exe, and every session would
/// pay for a cargo start.
pub fn mock_provider_exe() -> PathBuf {
    static EXE: OnceLock<PathBuf> = OnceLock::new();
    EXE.get_or_init(|| {
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../Cargo.toml");
        let status = Command::new(std::env::var("CARGO").unwrap_or_else(|_| "cargo".into()))
            .args(["build", "--quiet", "-p", "mock-provider", "--manifest-path"])
            .arg(manifest)
            .stdout(Stdio::null())
            .status()
            .expect("cargo runs");
        assert!(status.success(), "mock-provider builds");
        // target/debug/deps/<this test> -> target/debug
        let profile_dir = std::env::current_exe()
            .unwrap()
            .parent()
            .and_then(|deps| deps.parent())
            .unwrap()
            .to_path_buf();
        profile_dir.join(format!("mock-provider{}", std::env::consts::EXE_SUFFIX))
    })
    .clone()
}

pub fn provider_command(scenario: &str) -> ProviderCommand {
    ProviderCommand::new(
        Command::new(mock_provider_exe()),
        vec!["--scenario".into(), scenario.into()],
    )
}
