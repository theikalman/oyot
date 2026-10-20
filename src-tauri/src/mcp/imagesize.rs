//! An image's size and orientation, read from its header (ADR 0037,
//! decision 10).
//!
//! Enough to decide whether an image can go to an assistant as it is stored,
//! without decoding it and without an image crate: the four formats Claude
//! reads keep their size in the first few bytes, and a JPEG keeps which way
//! up it is in its EXIF block. Anything this cannot read goes to the page,
//! which decodes it properly.

/// Width and height, when the header says them.
pub fn dimensions(bytes: &[u8], mime: &str) -> Option<(u32, u32)> {
    match mime {
        "image/png" => png(bytes),
        "image/gif" => gif(bytes),
        "image/jpeg" => jpeg(bytes).map(|j| j.size),
        "image/webp" => webp(bytes),
        _ => None,
    }
}

/// Whether a JPEG says it is to be shown turned or mirrored. Claude reads no
/// metadata, so such a photo would reach it sideways; the page, which applies
/// the orientation when it decodes, has to redraw it. Anything unreadable
/// counts as turned, to be safe.
pub fn jpeg_is_turned(bytes: &[u8]) -> bool {
    match jpeg(bytes) {
        Some(j) => j.orientation.is_some_and(|o| o != 1),
        None => true,
    }
}

fn be16(b: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_be_bytes([*b.get(at)?, *b.get(at + 1)?]))
}

fn be32(b: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_be_bytes([
        *b.get(at)?,
        *b.get(at + 1)?,
        *b.get(at + 2)?,
        *b.get(at + 3)?,
    ]))
}

fn le16(b: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_le_bytes([*b.get(at)?, *b.get(at + 1)?]))
}

fn le24(b: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes([
        *b.get(at)?,
        *b.get(at + 1)?,
        *b.get(at + 2)?,
        0,
    ]))
}

fn png(b: &[u8]) -> Option<(u32, u32)> {
    // The signature, then IHDR, which must come first.
    if b.get(..8)? != b"\x89PNG\r\n\x1a\n" || b.get(12..16)? != b"IHDR" {
        return None;
    }
    Some((be32(b, 16)?, be32(b, 20)?))
}

fn gif(b: &[u8]) -> Option<(u32, u32)> {
    if !matches!(b.get(..6)?, b"GIF87a" | b"GIF89a") {
        return None;
    }
    Some((u32::from(le16(b, 6)?), u32::from(le16(b, 8)?)))
}

fn webp(b: &[u8]) -> Option<(u32, u32)> {
    if b.get(..4)? != b"RIFF" || b.get(8..12)? != b"WEBP" {
        return None;
    }
    match b.get(12..16)? {
        // Lossy: the frame header after a start code.
        b"VP8 " => {
            if b.get(23..26)? != [0x9d, 0x01, 0x2a] {
                return None;
            }
            Some((
                u32::from(le16(b, 26)? & 0x3fff),
                u32::from(le16(b, 28)? & 0x3fff),
            ))
        }
        // Lossless: fourteen bits each, less one, after a signature byte.
        b"VP8L" => {
            if *b.get(20)? != 0x2f {
                return None;
            }
            let bits = u32::from_le_bytes([*b.get(21)?, *b.get(22)?, *b.get(23)?, *b.get(24)?]);
            Some(((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1))
        }
        // Extended: the canvas, twenty-four bits each, less one.
        b"VP8X" => Some((le24(b, 24)? + 1, le24(b, 27)? + 1)),
        _ => None,
    }
}

struct Jpeg {
    size: (u32, u32),
    orientation: Option<u16>,
}

/// Walk a JPEG's markers to its frame header, noting the EXIF orientation on
/// the way, since EXIF comes before the frame.
fn jpeg(b: &[u8]) -> Option<Jpeg> {
    if b.get(..2)? != [0xff, 0xd8] {
        return None;
    }
    let mut at = 2;
    let mut orientation = None;
    loop {
        if *b.get(at)? != 0xff {
            return None;
        }
        let marker = *b.get(at + 1)?;
        // Fill bytes, and markers that stand alone.
        if marker == 0xff {
            at += 1;
            continue;
        }
        if matches!(marker, 0x01 | 0xd0..=0xd7) {
            at += 2;
            continue;
        }
        let len = usize::from(be16(b, at + 2)?);
        let body = at + 4;
        match marker {
            0xe1 if b.get(body..body + 6) == Some(b"Exif\0\0") => {
                orientation = exif_orientation(b.get(body + 6..at + 2 + len)?);
            }
            // Every start-of-frame but the three that are not frames.
            0xc0..=0xcf if !matches!(marker, 0xc4 | 0xc8 | 0xcc) => {
                let height = u32::from(be16(b, body + 1)?);
                let width = u32::from(be16(b, body + 3)?);
                return Some(Jpeg {
                    size: (width, height),
                    orientation,
                });
            }
            // Image data starts with no frame seen: not a file to trust.
            0xda => return None,
            _ => {}
        }
        at += 2 + len;
    }
}

/// Tag 0x0112 of IFD0 in a TIFF block, in whichever byte order it declares.
fn exif_orientation(tiff: &[u8]) -> Option<u16> {
    let little = match tiff.get(..2)? {
        b"II" => true,
        b"MM" => false,
        _ => return None,
    };
    let u16_at = |at: usize| {
        if little {
            le16(tiff, at)
        } else {
            be16(tiff, at)
        }
    };
    let u32_at = |at: usize| {
        let bytes = [
            *tiff.get(at)?,
            *tiff.get(at + 1)?,
            *tiff.get(at + 2)?,
            *tiff.get(at + 3)?,
        ];
        Some(if little {
            u32::from_le_bytes(bytes)
        } else {
            u32::from_be_bytes(bytes)
        })
    };
    let ifd = usize::try_from(u32_at(4)?).ok()?;
    let entries = usize::from(u16_at(ifd)?);
    for i in 0..entries {
        let entry = ifd + 2 + i * 12;
        if u16_at(entry)? == 0x0112 {
            return u16_at(entry + 8);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png_header(w: u32, h: u32) -> Vec<u8> {
        let mut b = b"\x89PNG\r\n\x1a\n\0\0\0\x0dIHDR".to_vec();
        b.extend(w.to_be_bytes());
        b.extend(h.to_be_bytes());
        b.extend([8, 6, 0, 0, 0]);
        b
    }

    /// A JPEG with an EXIF block saying `orientation`, in either byte order,
    /// then a baseline frame of `w` by `h`.
    fn jpeg_header(w: u16, h: u16, orientation: Option<(u16, bool)>) -> Vec<u8> {
        let mut b = vec![0xff, 0xd8];
        // An APP0 to walk past.
        b.extend([0xff, 0xe0, 0x00, 0x10]);
        b.extend(b"JFIF\0\x01\x01\0\0\x01\0\x01\0\0");
        if let Some((value, little)) = orientation {
            let w16 = |v: u16| {
                if little {
                    v.to_le_bytes()
                } else {
                    v.to_be_bytes()
                }
            };
            let w32 = |v: u32| {
                if little {
                    v.to_le_bytes()
                } else {
                    v.to_be_bytes()
                }
            };
            let mut tiff = Vec::new();
            tiff.extend(if little { b"II" } else { b"MM" });
            tiff.extend(w16(42));
            tiff.extend(w32(8));
            tiff.extend(w16(1));
            tiff.extend(w16(0x0112));
            tiff.extend(w16(3));
            tiff.extend(w32(1));
            tiff.extend(w16(value));
            tiff.extend([0, 0]);
            tiff.extend(w32(0));
            let len = (2 + 6 + tiff.len()) as u16;
            b.extend([0xff, 0xe1]);
            b.extend(len.to_be_bytes());
            b.extend(b"Exif\0\0");
            b.extend(tiff);
        }
        b.extend([0xff, 0xc0, 0x00, 0x11, 0x08]);
        b.extend(h.to_be_bytes());
        b.extend(w.to_be_bytes());
        b.extend([0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);
        b.extend([0xff, 0xda]);
        b
    }

    #[test]
    fn reads_the_size_of_each_format_claude_reads() {
        assert_eq!(
            dimensions(&png_header(1920, 1080), "image/png"),
            Some((1920, 1080))
        );
        assert_eq!(
            dimensions(b"GIF89a\x40\x01\xf0\x00", "image/gif"),
            Some((320, 240))
        );
        assert_eq!(
            dimensions(&jpeg_header(4032, 3024, None), "image/jpeg"),
            Some((4032, 3024))
        );

        let mut lossy = b"RIFF\0\0\0\0WEBPVP8 \0\0\0\0\0\0\0\x9d\x01\x2a".to_vec();
        lossy.extend(800u16.to_le_bytes());
        lossy.extend(600u16.to_le_bytes());
        assert_eq!(dimensions(&lossy, "image/webp"), Some((800, 600)));

        let mut lossless = b"RIFF\0\0\0\0WEBPVP8L\0\0\0\0\x2f".to_vec();
        lossless.extend(((800 - 1) | ((600 - 1) << 14) as u32).to_le_bytes());
        assert_eq!(dimensions(&lossless, "image/webp"), Some((800, 600)));

        let mut extended = b"RIFF\0\0\0\0WEBPVP8X\0\0\0\0\0\0\0\0".to_vec();
        extended.extend(&(3000u32 - 1).to_le_bytes()[..3]);
        extended.extend(&(2000u32 - 1).to_le_bytes()[..3]);
        assert_eq!(dimensions(&extended, "image/webp"), Some((3000, 2000)));
    }

    #[test]
    fn says_nothing_of_what_it_cannot_read() {
        assert_eq!(dimensions(b"not an image", "image/png"), None);
        assert_eq!(dimensions(&png_header(1, 1)[..20], "image/png"), None);
        assert_eq!(dimensions(&png_header(1, 1), "image/bmp"), None);
    }

    #[test]
    fn tells_a_turned_jpeg_from_one_the_right_way_up() {
        assert!(!jpeg_is_turned(&jpeg_header(10, 10, None)));
        assert!(!jpeg_is_turned(&jpeg_header(10, 10, Some((1, true)))));
        assert!(jpeg_is_turned(&jpeg_header(10, 10, Some((6, true)))));
        assert!(jpeg_is_turned(&jpeg_header(10, 10, Some((8, false)))));
        assert_eq!(
            dimensions(&jpeg_header(4032, 3024, Some((6, false))), "image/jpeg"),
            Some((4032, 3024))
        );
        assert!(jpeg_is_turned(b"\xff\xd8 broken"));
    }
}
