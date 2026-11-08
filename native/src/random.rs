//! Random tokens and UUIDs, from the operating system's random source.
//!
//! Version-4 and version-5 UUIDs follow RFC 9562, so names and identifiers keep the form and
//! values they had when they came from the `uuid` crate.

/// `N` bytes from the operating system's random source.
pub fn bytes<const N: usize>() -> [u8; N] {
    let mut out = [0u8; N];
    getrandom::fill(&mut out).expect("the operating system's random source is unavailable");
    out
}

/// Lowercase hexadecimal, two digits per byte.
pub fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(DIGITS[usize::from(byte >> 4)] as char);
        out.push(DIGITS[usize::from(byte & 0x0f)] as char);
    }
    out
}

/// A random version-4 UUID.
pub fn uuid_v4() -> [u8; 16] {
    let mut uuid = bytes::<16>();
    set_version(&mut uuid, 4);
    uuid
}

/// A random version-4 UUID as 32 hex digits without hyphens.
pub fn uuid_v4_simple() -> String {
    hex(&uuid_v4())
}

/// The RFC 9562 namespace for URLs.
pub const NAMESPACE_URL: [u8; 16] = [
    0x6b, 0xa7, 0xb8, 0x11, 0x9d, 0xad, 0x11, 0xd1, 0x80, 0xb4, 0x00, 0xc0, 0x4f, 0xd4, 0x30, 0xc8,
];
/// The RFC 9562 namespace for ISO object identifiers.
pub const NAMESPACE_OID: [u8; 16] = [
    0x6b, 0xa7, 0xb8, 0x12, 0x9d, 0xad, 0x11, 0xd1, 0x80, 0xb4, 0x00, 0xc0, 0x4f, 0xd4, 0x30, 0xc8,
];

/// The version-5 (SHA-1, name-based) UUID of `name` in `namespace`, hyphenated in lowercase.
pub fn uuid_v5(namespace: &[u8; 16], name: &[u8]) -> String {
    let mut uuid = [0u8; 16];
    uuid.copy_from_slice(&sha1(&[namespace, name])[..16]);
    set_version(&mut uuid, 5);
    let digits = hex(&uuid);
    format!(
        "{}-{}-{}-{}-{}",
        &digits[..8],
        &digits[8..12],
        &digits[12..16],
        &digits[16..20],
        &digits[20..]
    )
}

/// SHA-1 (FIPS 180-4) of the concatenated parts. RFC 9562 defines version-5 UUIDs with it; nothing else here uses it.
fn sha1(parts: &[&[u8]]) -> [u8; 20] {
    let mut message = parts.concat();
    let bit_length = (message.len() as u64).wrapping_mul(8);
    message.push(0x80);
    // Zeros up to 8 bytes short of a 64-byte block boundary, then the length in bits.
    message.resize((message.len() + 8).next_multiple_of(64) - 8, 0);
    message.extend_from_slice(&bit_length.to_be_bytes());
    let mut state: [u32; 5] = [
        0x6745_2301,
        0xefcd_ab89,
        0x98ba_dcfe,
        0x1032_5476,
        0xc3d2_e1f0,
    ];
    for block in message.as_chunks::<64>().0 {
        let mut schedule = [0u32; 80];
        for (word, bytes) in schedule.iter_mut().zip(block.as_chunks::<4>().0) {
            *word = u32::from_be_bytes(*bytes);
        }
        for i in 16..80 {
            schedule[i] = (schedule[i - 3] ^ schedule[i - 8] ^ schedule[i - 14] ^ schedule[i - 16])
                .rotate_left(1);
        }
        let [mut a, mut b, mut c, mut d, mut e] = state;
        for (i, word) in schedule.into_iter().enumerate() {
            let (mix, constant) = match i {
                0..20 => ((b & c) | (!b & d), 0x5a82_7999),
                20..40 => (b ^ c ^ d, 0x6ed9_eba1),
                40..60 => ((b & c) | (b & d) | (c & d), 0x8f1b_bcdc),
                _ => (b ^ c ^ d, 0xca62_c1d6),
            };
            let next = a
                .rotate_left(5)
                .wrapping_add(mix)
                .wrapping_add(e)
                .wrapping_add(constant)
                .wrapping_add(word);
            (e, d, c, b, a) = (d, c, b.rotate_left(30), a, next);
        }
        for (total, value) in state.iter_mut().zip([a, b, c, d, e]) {
            *total = total.wrapping_add(value);
        }
    }
    let mut digest = [0u8; 20];
    for (bytes, word) in digest.as_chunks_mut::<4>().0.iter_mut().zip(state) {
        *bytes = word.to_be_bytes();
    }
    digest
}

fn set_version(uuid: &mut [u8; 16], version: u8) {
    uuid[6] = (uuid[6] & 0x0f) | (version << 4);
    uuid[8] = (uuid[8] & 0x3f) | 0x80;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_5_matches_rfc_9562_and_python() {
        // RFC 9562 appendix A.4.
        const NAMESPACE_DNS: [u8; 16] = [
            0x6b, 0xa7, 0xb8, 0x10, 0x9d, 0xad, 0x11, 0xd1, 0x80, 0xb4, 0x00, 0xc0, 0x4f, 0xd4,
            0x30, 0xc8,
        ];
        assert_eq!(
            uuid_v5(&NAMESPACE_DNS, b"www.example.com"),
            "2ed6657d-e927-568b-95e1-2665a8aea6a2"
        );
        // Computed with Python's uuid.uuid5, which the former `uuid` crate also matched.
        assert_eq!(
            uuid_v5(&NAMESPACE_URL, b"image-study:/tmp/Bench CT"),
            "e14e560b-6c0a-5ac3-be3c-93ee28641753"
        );
        assert_eq!(
            uuid_v5(&NAMESPACE_URL, "image-series:/tmp/ö/1".as_bytes()),
            "de6ff02b-14f2-5599-be3e-6946c7e9e47c"
        );
        assert_eq!(
            uuid_v5(&NAMESPACE_OID, b"1.2.840.113619.2.55|7"),
            "30853fa0-aef0-5beb-ae42-edaa8f1e7592"
        );
    }

    #[test]
    fn sha1_matches_fips_180_and_python() {
        let digest = |parts: &[&[u8]]| hex(&sha1(parts));
        // FIPS 180 examples: empty, one block, two blocks, and a million repeated bytes.
        assert_eq!(digest(&[]), "da39a3ee5e6b4b0d3255bfef95601890afd80709");
        assert_eq!(
            digest(&[b"abc"]),
            "a9993e364706816aba3e25717850c26c9cd0d89d"
        );
        assert_eq!(
            digest(&[
                b"abcdbcdecdefdefgefghfghighijhi",
                b"jkijkljklmklmnlmnomnopnopq"
            ]),
            "84983e441c3bd26ebaae4aa1f95129e5e54670f1"
        );
        assert_eq!(
            digest(&[&[b'a'; 1_000_000]]),
            "34aa973cd4c4daa4f61eeb2bdbad27316534016f"
        );
        // Lengths either side of the padding boundaries, against Python's hashlib.
        for (length, expected) in [
            (55, "8ae2d46729cfe68ff927af5eec9c7d1b66d65ac2"),
            (56, "636e2ec698dac903498e648bd2f3af641d3c88cb"),
            (63, "6d942da0c4392b123528f2905c713a3ce28364bd"),
            (64, "c6138d514ffa2135bfce0ed0b8fac65669917ec7"),
            (65, "69bd728ad6e13cd76ff19751fde427b00e395746"),
            (1000, "c9c960a0b925474fab83942cc27d504fc24ac37b"),
        ] {
            let bytes: Vec<u8> = (0..length).map(|i: u32| (i % 251) as u8).collect();
            assert_eq!(digest(&[&bytes]), expected, "{length} bytes");
        }
    }

    #[test]
    fn version_4_is_random_with_version_and_variant_bits() {
        let (first, second) = (uuid_v4(), uuid_v4());
        assert_ne!(first, second);
        for uuid in [first, second] {
            assert_eq!(uuid[6] >> 4, 4);
            assert_eq!(uuid[8] >> 6, 0b10);
        }
        let simple = uuid_v4_simple();
        assert_eq!(simple.len(), 32);
        assert!(
            simple
                .bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
        );
        assert_eq!(&simple[12..13], "4");
    }

    #[test]
    fn hex_is_lowercase_and_two_digits_per_byte() {
        assert_eq!(hex(&[0x00, 0x0f, 0xa5, 0xff]), "000fa5ff");
    }
}
