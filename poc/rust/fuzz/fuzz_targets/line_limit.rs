//! A line near the limit: one the limit allows is read, one it does not is
//! refused whole, and neither is held in memory beyond the limit. The input
//! is the pattern the line is made of, and its first byte says how far over
//! or under the limit the line is.

#![no_main]

use credential_provider_protocol::{MAX_LINE_BYTES, ProtocolError, Request, read_json_line};
use libfuzzer_sys::fuzz_target;
use std::io::Cursor;

fuzz_target!(|data: &[u8]| {
    let Some((offset, pattern)) = data.split_first() else {
        return;
    };
    // the line is the pattern, repeated, with its newline: MAX_LINE_BYTES
    // minus 2 to plus 2 bytes of it
    let length = MAX_LINE_BYTES + usize::from(*offset % 5) - 2;
    let mut line: Vec<u8> = pattern.iter().copied().cycle().take(length - 1).collect();
    if pattern.is_empty() {
        line = vec![b' '; length - 1];
    }
    line.retain(|byte| *byte != b'\n');
    let held = line.len() + 1;
    line.push(b'\n');
    line.extend_from_slice(b"{}\n");

    let mut input = Cursor::new(line);
    match read_json_line::<Request>(&mut input) {
        Err(ProtocolError::LineTooLong { limit }) => {
            assert_eq!(limit, MAX_LINE_BYTES);
            assert!(
                held > MAX_LINE_BYTES,
                "a line within the limit was refused as too long"
            );
            // refused whole: nothing read past the limit
            assert!(input.position() <= MAX_LINE_BYTES as u64 + 1);
        }
        _ => assert!(
            held <= MAX_LINE_BYTES,
            "a line over the limit was not refused as too long"
        ),
    }
});
