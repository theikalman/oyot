//! What the attachment store holds: which types, under which extension, up to
//! what size, and how to tell from the bytes which type they are.
//!
//! Pure, so the sync session, which runs without the app's state, holds a
//! transfer to the same limits the store does without a copy of them to keep
//! in step by hand.
//!
//! Pictures and emails, and nothing else. SVG is left out deliberately: it is
//! a script-bearing document, attachments arrive from peers, and an image is
//! rendered in the webview. An email is never rendered there as it is stored:
//! it is parsed in Rust, and what the page shows of it is shown in a sandboxed
//! frame (ADR 0043).

/// Largest image the store takes, from disk, a paste or a peer.
pub const MAX_IMAGE_BYTES: usize = 10 * 1024 * 1024;

/// Largest email the store takes. Emails carry their files as base64, so a
/// 20 MB attachment is about 27 MB of email; this leaves room for that.
pub const MAX_EMAIL_BYTES: usize = 32 * 1024 * 1024;

/// The largest attachment of any type, for limits that do not know the type
/// of what they are holding, such as an entry in a backup archive.
pub const MAX_ATTACHMENT_BYTES: usize = if MAX_EMAIL_BYTES > MAX_IMAGE_BYTES {
    MAX_EMAIL_BYTES
} else {
    MAX_IMAGE_BYTES
};

/// The type an email is stored as.
pub const EMAIL_MIME: &str = "message/rfc822";

/// The extension a stored type is written with, and `None` for a type the
/// store does not take.
pub fn extension_for(mime_type: &str) -> Option<&'static str> {
    match mime_type {
        "image/png" => Some("png"),
        "image/jpeg" | "image/jpg" => Some("jpg"),
        "image/gif" => Some("gif"),
        "image/webp" => Some("webp"),
        EMAIL_MIME => Some("eml"),
        _ => None,
    }
}

/// The largest the store takes of a type, and `None` for a type it does not
/// take at all.
pub fn max_bytes_for(mime_type: &str) -> Option<usize> {
    if is_email(mime_type) {
        Some(MAX_EMAIL_BYTES)
    } else if is_image(mime_type) {
        Some(MAX_IMAGE_BYTES)
    } else {
        None
    }
}

/// Whether a type is one of the pictures the store takes.
pub fn is_image(mime_type: &str) -> bool {
    mime_type.starts_with("image/") && extension_for(mime_type).is_some()
}

pub fn is_email(mime_type: &str) -> bool {
    mime_type == EMAIL_MIME
}

/// What a type is called in a message to the user.
pub fn kind_name(mime_type: &str) -> &'static str {
    if is_email(mime_type) {
        "email"
    } else {
        "image"
    }
}

/// The type the bytes actually are.
///
/// Every declared type arrives from somewhere that could be wrong about it: a
/// filename extension, a webview Blob, or a peer's manifest. The bytes cannot
/// be wrong about themselves.
pub fn sniff(bytes: &[u8]) -> Option<&'static str> {
    sniff_image(bytes).or_else(|| looks_like_email(bytes).then_some(EMAIL_MIME))
}

/// A picture's type, by magic number.
pub fn sniff_image(bytes: &[u8]) -> Option<&'static str> {
    const PNG: &[u8] = &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    const JPEG: &[u8] = &[0xFF, 0xD8, 0xFF];

    if bytes.starts_with(PNG) {
        return Some("image/png");
    }
    if bytes.starts_with(JPEG) {
        return Some("image/jpeg");
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some("image/gif");
    }
    // RIFF container, with the form type at offset 8.
    if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    None
}

/// Whether the bytes are an email (RFC 5322).
///
/// An email has no magic number, so it is held to three things. It begins with
/// a header line, `Name: value`, with a name of letters, digits and hyphens,
/// which no HTML or SVG document does. The parser reads it. And it has at
/// least one of the headers every real email has, so a stray line of text
/// with a colon in it is not taken for one.
fn looks_like_email(bytes: &[u8]) -> bool {
    if !begins_with_header(bytes) {
        return false;
    }
    let Some(message) = mail_parser::MessageParser::new().parse(bytes) else {
        return false;
    };
    message.from().is_some()
        || message.date().is_some()
        || message.subject().is_some()
        || message.message_id().is_some()
}

fn begins_with_header(bytes: &[u8]) -> bool {
    // A mailbox's `From ` separator line, which some apps leave on an email
    // they save, comes before the first header.
    let start = if bytes.starts_with(b"From ") {
        match bytes.iter().position(|&b| b == b'\n') {
            Some(end) => end + 1,
            None => return false,
        }
    } else {
        0
    };
    let rest = &bytes[start..];
    let name_len = rest
        .iter()
        .take_while(|b| b.is_ascii_alphanumeric() || **b == b'-')
        .count();
    name_len > 0 && rest.get(name_len) == Some(&b':')
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png(extra: &[u8]) -> Vec<u8> {
        let mut v = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        v.extend_from_slice(extra);
        v
    }

    const PLAIN: &[u8] = b"From: Ana <ana@example.com>\r\n\
To: you@example.com\r\n\
Subject: Quarterly report\r\n\
Date: Tue, 3 Nov 2026 09:12:00 +0000\r\n\
Message-ID: <1@example.com>\r\n\
\r\n\
The numbers are in.\r\n";

    const MULTIPART: &[u8] = b"From: Ana <ana@example.com>\r\n\
Subject: =?UTF-8?B?Q2Fmw6k=?=\r\n\
MIME-Version: 1.0\r\n\
Content-Type: multipart/alternative; boundary=\"b1\"\r\n\
\r\n\
--b1\r\n\
Content-Type: text/plain; charset=windows-1252\r\n\
Content-Transfer-Encoding: quoted-printable\r\n\
\r\n\
Caf=E9\r\n\
--b1\r\n\
Content-Type: text/html; charset=utf-8\r\n\
\r\n\
<p>Caf\xc3\xa9</p>\r\n\
--b1--\r\n";

    #[test]
    fn the_bytes_decide_the_image_type() {
        assert_eq!(sniff(&png(b"rest")), Some("image/png"));
        assert_eq!(sniff(&[0xFF, 0xD8, 0xFF, 0xE0]), Some("image/jpeg"));
        assert_eq!(sniff(b"GIF89a....."), Some("image/gif"));

        let mut webp = b"RIFF".to_vec();
        webp.extend_from_slice(&[0, 0, 0, 0]);
        webp.extend_from_slice(b"WEBP");
        assert_eq!(sniff(&webp), Some("image/webp"));
    }

    #[test]
    fn an_email_is_recognised() {
        assert_eq!(sniff(PLAIN), Some(EMAIL_MIME));
        assert_eq!(sniff(MULTIPART), Some(EMAIL_MIME));
    }

    #[test]
    fn an_email_saved_with_a_mailbox_separator_is_recognised() {
        let mut saved = b"From - Tue Nov  3 09:12:00 2026\n".to_vec();
        saved.extend_from_slice(PLAIN);
        assert_eq!(sniff(&saved), Some(EMAIL_MIME));
    }

    #[test]
    fn an_email_with_only_unix_line_endings_is_recognised() {
        let unix: Vec<u8> = PLAIN.iter().copied().filter(|&b| b != b'\r').collect();
        assert_eq!(sniff(&unix), Some(EMAIL_MIME));
    }

    // The case this exists for: a peer, or anything rendering in the webview,
    // declaring a type for content that is not that at all.
    #[test]
    fn documents_that_can_run_script_are_not_emails() {
        assert_eq!(sniff(b"<svg xmlns=\"...\"><script/></svg>"), None);
        assert_eq!(sniff(b"<svg:svg xmlns:svg=\"...\"/>"), None);
        assert_eq!(sniff(b"<!doctype html><title>x</title>"), None);
        assert_eq!(sniff(b"<html>\nSubject: hello\n\n</html>"), None);
        assert_eq!(sniff(b"  Subject: hello\n\nbody"), None);
    }

    #[test]
    fn text_that_is_not_an_email_is_refused() {
        assert_eq!(sniff(b""), None);
        assert_eq!(sniff(b"RIFF1234NOPE"), None);
        assert_eq!(sniff(b"just some words"), None);
        assert_eq!(sniff(b"From nowhere"), None);
        assert_eq!(
            sniff(b"Note: buy milk\n\nand eggs"),
            None,
            "a line with a colon is not an email without a header every email has"
        );
    }

    #[test]
    fn a_truncated_header_is_not_mistaken_for_an_image() {
        assert_eq!(sniff(&[0x89, b'P']), None);
        assert_eq!(sniff(b"RIFF"), None);
        assert_eq!(sniff(b"GIF8"), None);
    }

    #[test]
    fn each_type_has_its_own_cap() {
        assert_eq!(max_bytes_for("image/png"), Some(MAX_IMAGE_BYTES));
        assert_eq!(max_bytes_for(EMAIL_MIME), Some(MAX_EMAIL_BYTES));
        assert_eq!(max_bytes_for("image/svg+xml"), None);
        assert_eq!(max_bytes_for("text/html"), None);
        assert_eq!(MAX_ATTACHMENT_BYTES, MAX_EMAIL_BYTES);
    }

    #[test]
    fn an_email_is_written_as_eml() {
        assert_eq!(extension_for(EMAIL_MIME), Some("eml"));
        assert_eq!(extension_for("image/svg+xml"), None);
        assert!(!is_image(EMAIL_MIME));
        assert!(!is_image("image/svg+xml"));
    }
}
