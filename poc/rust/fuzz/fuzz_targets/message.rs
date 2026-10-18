//! Any bytes, read as a hello, a request or a response by the path a peer
//! reads a line by. Nothing may panic, and a message the crate accepts must
//! come back unchanged through its own writer and reader.
//!
//! The first byte picks the role; the rest is the line.

#![no_main]

use credential_provider_protocol::{
    Hello, ProviderResponse, Request, RequestKind, negotiate, read_json_line,
};
use libfuzzer_sys::fuzz_target;
use std::io::Cursor;

fn read<T: serde::de::DeserializeOwned>(line: &[u8]) -> Option<T> {
    let mut input = Cursor::new([line, b"\n"].concat());
    read_json_line(&mut input).ok().flatten()
}

fn again<T: serde::Serialize + serde::de::DeserializeOwned + PartialEq + std::fmt::Debug>(
    message: &T,
) {
    let written = serde_json::to_vec(message).expect("a message the crate holds can be written");
    let back: T = read(&written).expect("what the crate wrote it reads");
    assert_eq!(
        &back, message,
        "a message changed on its way through the crate"
    );
}

fuzz_target!(|data: &[u8]| {
    let Some((role, line)) = data.split_first() else {
        return;
    };
    match role % 3 {
        0 => {
            if let Some(hello) = read::<Hello>(line) {
                let _ = negotiate(&hello);
                if hello.validate().is_ok() {
                    again(&hello);
                    for entry in hello.registries.iter().flatten() {
                        assert!(
                            hello.serves(entry),
                            "a hello does not serve a registry it lists"
                        );
                    }
                }
                let _ = hello.serves(&String::from_utf8_lossy(line));
            }
        }
        1 => {
            if let Some(request) = read::<Request>(line) {
                if request.validate().is_ok() {
                    again(&request);
                }
                let _ = format!("{request:?}");
            }
        }
        _ => {
            if let Some(response) = read::<ProviderResponse>(line) {
                for kind in [
                    RequestKind::Get,
                    RequestKind::Login,
                    RequestKind::Logout,
                    RequestKind::Erase,
                    RequestKind::Unsupported,
                ] {
                    if response.validate_for(&kind).is_ok() {
                        again(&response);
                    }
                }
                let _ = format!("{response:?}");
            }
        }
    }
});
