//! Says whether this crate accepts each message it is given, for the
//! differential fuzzing in tests/fuzz_messages.py: the same messages go to the
//! JSON schema, the Python model and the JavaScript providers, and what the
//! four say must agree.
//!
//! Reads lines of `role<TAB>json` from stdin, where the role is `hello`,
//! `request` or `response`, and writes one line for each: `ok`, or `err` and
//! the reason, or `panic` if the crate panicked on it. The message goes
//! through `read_json_line`, the path a client or a provider reads it by, then
//! through the validation the role has: a hello is `negotiate`d, a request is
//! `validate_received` (what a provider may be sent: a kind or an operation this
//! build has no variant for is a well-formed name, and one that is not a name
//! does not parse), a response is `validate_for` a `get`.

use credential_provider_protocol::{
    Hello, ProtocolError, ProviderResponse, Request, RequestKind, negotiate, read_json_line,
};
use std::io::{BufRead, Cursor, Write};
use std::panic::{AssertUnwindSafe, catch_unwind};

fn classify(role: &str, message: &[u8]) -> Result<(), String> {
    let mut line = Cursor::new([message, b"\n"].concat());
    let at_the_end = |error: ProtocolError| error.to_string();
    match role {
        "hello" => {
            let hello: Hello = read_json_line(&mut line)
                .map_err(at_the_end)?
                .ok_or("empty")?;
            // a hello with no version in common is still a well-formed hello
            match negotiate(&hello) {
                Err(ProtocolError::NoCompatibleVersion { .. }) => Ok(()),
                other => other.map(|_| ()).map_err(at_the_end),
            }
        }
        "request" => {
            let request: Request = read_json_line(&mut line)
                .map_err(at_the_end)?
                .ok_or("empty")?;
            request.validate_received().map_err(at_the_end)
        }
        "response" => {
            let response: ProviderResponse = read_json_line(&mut line)
                .map_err(at_the_end)?
                .ok_or("empty")?;
            response.validate_for(&RequestKind::Get).map_err(at_the_end)
        }
        other => Err(format!("unknown role {other}")),
    }
}

fn main() {
    std::panic::set_hook(Box::new(|_| {}));
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout().lock();
    for line in stdin.lock().split(b'\n') {
        let line = line.unwrap();
        let (role, message) = match line.iter().position(|byte| *byte == b'\t') {
            Some(at) => (
                String::from_utf8_lossy(&line[..at]).into_owned(),
                &line[at + 1..],
            ),
            None => (String::new(), &line[..]),
        };
        let verdict = match catch_unwind(AssertUnwindSafe(|| classify(&role, message))) {
            Ok(Ok(())) => "ok".to_string(),
            Ok(Err(reason)) => format!("err\t{}", reason.replace(['\n', '\t'], " ")),
            Err(_) => "panic".to_string(),
        };
        writeln!(stdout, "{verdict}").unwrap();
    }
}
