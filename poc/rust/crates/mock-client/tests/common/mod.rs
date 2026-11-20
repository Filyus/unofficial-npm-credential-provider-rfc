//! The mock provider as a built binary, shared by the test files that start it.

use mock_client::ProviderCommand;
use std::path::PathBuf;
use std::process::Command;
use std::sync::OnceLock;

/// Builds the mock provider once per test binary and gives its path. The
/// binary is run itself and not through `cargo run`: killing a `cargo run`
/// would leave the provider behind, holding its exe, and every session would
/// pay for a cargo start.
pub fn mock_provider_exe() -> PathBuf {
    static EXE: OnceLock<PathBuf> = OnceLock::new();
    EXE.get_or_init(|| {
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../Cargo.toml");
        let output = Command::new(std::env::var("CARGO").unwrap_or_else(|_| "cargo".into()))
            .args([
                "build",
                "--quiet",
                "-p",
                "mock-provider",
                "--message-format=json",
                "--manifest-path",
            ])
            .arg(manifest)
            .output()
            .expect("cargo runs");
        assert!(
            output.status.success(),
            "mock-provider builds: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let stdout = String::from_utf8(output.stdout).expect("cargo json is utf-8");
        stdout
            .lines()
            .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
            .filter(|msg| {
                msg.get("reason").and_then(|v| v.as_str()) == Some("compiler-artifact")
                    && msg.pointer("/target/name").and_then(|v| v.as_str()) == Some("mock-provider")
            })
            .filter_map(|msg| {
                msg.get("executable")
                    .and_then(|v| v.as_str())
                    .map(PathBuf::from)
            })
            .next_back()
            .expect("cargo reports mock-provider executable")
    })
    .clone()
}

pub fn provider_command(scenario: &str) -> ProviderCommand {
    ProviderCommand::new(
        Command::new(mock_provider_exe()),
        vec!["--scenario".into(), scenario.into()],
    )
}
