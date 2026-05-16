use mock_client::{ClientScenario, run_exchange};
use std::process::Command;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut provider: Option<String> = None;
    let mut provider_args = Vec::new();
    let mut scenario = ClientScenario::InstallGet;
    let mut args = std::env::args().skip(1);

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--provider" => provider = args.next(),
            "--provider-arg" => {
                provider_args.push(args.next().ok_or("--provider-arg requires a value")?);
            }
            "--scenario" => {
                scenario = match args.next().as_deref() {
                    Some("install-get") => ClientScenario::InstallGet,
                    Some("refresh") => ClientScenario::Refresh,
                    Some("batch-install") => ClientScenario::BatchInstall,
                    Some("login") => ClientScenario::Login,
                    Some("logout") => ClientScenario::Logout,
                    Some("erase") => ClientScenario::Erase,
                    Some(other) => {
                        return Err(format!("unsupported client scenario: {other}").into());
                    }
                    None => return Err("--scenario requires a value".into()),
                }
            }
            other => return Err(format!("unsupported argument: {other}").into()),
        }
    }

    let provider = provider.ok_or("--provider is required")?;
    let mut command = Command::new(provider);
    command.args(provider_args);
    let summary = run_exchange(command, scenario)?;
    println!(
        "version={} outcome={}",
        summary.selected_version, summary.outcome
    );
    Ok(())
}
