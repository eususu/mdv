use std::path::Path;

// Keep filesystem operations on the canonical path; only expose a friendly path.
pub fn display_path(canonical: &Path, requested: &str) -> String {
    let path = canonical.to_string_lossy();
    #[cfg(windows)]
    {
        let requested = strip_verbatim(requested);
        // Preserve the drive chosen by the user, even when several drives map to a share.
        if requested.as_bytes().get(1) == Some(&b':') {
            return requested;
        }
        let path = strip_verbatim(&path);
        if path.starts_with(r"\\") {
            for letter in b'A'..=b'Z' {
                if let Some(remote) = remote_drive(letter) {
                    if let Some(mapped) = mapped_path(&path, &remote, letter) {
                        return mapped;
                    }
                }
            }
        }
        path
    }
    #[cfg(not(windows))]
    {
        let _ = requested;
        path.into_owned()
    }
}

#[cfg(any(windows, test))]
fn strip_verbatim(path: &str) -> String {
    if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else {
        path.strip_prefix(r"\\?\").unwrap_or(path).to_owned()
    }
}

#[cfg(any(windows, test))]
fn mapped_path(path: &str, remote: &str, letter: u8) -> Option<String> {
    let remote = remote.trim_end_matches('\\');
    let prefix = path.get(..remote.len())?;
    let suffix = path.get(remote.len()..)?;
    if !prefix.eq_ignore_ascii_case(remote) || (!suffix.is_empty() && !suffix.starts_with('\\')) {
        return None;
    }
    Some(format!(
        "{}:{}",
        letter as char,
        if suffix.is_empty() { "\\" } else { suffix }
    ))
}

#[cfg(windows)]
fn remote_drive(letter: u8) -> Option<String> {
    #[link(name = "mpr")]
    extern "system" {
        fn WNetGetConnectionW(local: *const u16, remote: *mut u16, length: *mut u32) -> u32;
    }
    let local = [letter as u16, b':' as u16, 0];
    let mut buffer = vec![0u16; 512];
    let mut length = buffer.len() as u32;
    // Both buffers stay alive for the call; length is measured in UTF-16 code units.
    let mut result =
        unsafe { WNetGetConnectionW(local.as_ptr(), buffer.as_mut_ptr(), &mut length) };
    if result == 234 {
        // ERROR_MORE_DATA
        buffer.resize(length as usize, 0);
        result = unsafe { WNetGetConnectionW(local.as_ptr(), buffer.as_mut_ptr(), &mut length) };
    }
    if result != 0 {
        return None;
    }
    let end = buffer.iter().position(|&c| c == 0).unwrap_or(buffer.len());
    Some(String::from_utf16_lossy(&buffer[..end]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_windows_paths() {
        assert_eq!(
            strip_verbatim(r"\\?\UNC\172.16.10.15\docs\문서.md"),
            r"\\172.16.10.15\docs\문서.md"
        );
        assert_eq!(strip_verbatim(r"\\?\Z:\docs\문서.md"), r"Z:\docs\문서.md");
        assert_eq!(strip_verbatim(r"Z:\docs\문서.md"), r"Z:\docs\문서.md");
    }

    #[test]
    fn maps_only_matching_share_boundaries() {
        assert_eq!(
            mapped_path(r"\\SERVER\docs\문서.md", r"\\server\docs", b'Z'),
            Some(r"Z:\문서.md".into())
        );
        assert_eq!(
            mapped_path(r"\\server\docs", r"\\server\docs", b'Z'),
            Some(r"Z:\".into())
        );
        assert_eq!(
            mapped_path(r"\\server\docs-other\a.md", r"\\server\docs", b'Z'),
            None
        );
        assert_eq!(
            mapped_path(r"\\server\other\a.md", r"\\server\docs", b'Z'),
            None
        );
    }
}
