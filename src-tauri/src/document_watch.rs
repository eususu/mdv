use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use std::path::Path;

pub fn watch(
    path: &Path,
    changed: impl Fn(&Path) + Send + 'static,
) -> notify::Result<RecommendedWatcher> {
    let target = path.to_owned();
    let mut watcher =
        notify::recommended_watcher(move |result: notify::Result<notify::Event>| match result {
            Ok(event)
                if !matches!(event.kind, notify::EventKind::Access(_))
                    && (event.need_rescan() || event.paths.iter().any(|p| p == &target)) =>
            {
                changed(&target);
            }
            Err(_) => changed(&target),
            _ => {}
        })?;
    // Watching the parent survives editors replacing the file with a temporary file.
    watcher.watch(
        path.parent()
            .ok_or_else(|| notify::Error::generic("Missing parent directory"))?,
        RecursiveMode::NonRecursive,
    )?;
    Ok(watcher)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        path::PathBuf,
        sync::mpsc,
        time::{Duration, SystemTime, UNIX_EPOCH},
    };

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let directory = std::env::temp_dir().join(format!(
                "mdv-watch-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir(&directory).unwrap();
            Self(directory)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn detects_writes_and_file_replacement() {
        let fixture = Fixture::new();
        let path = fixture.0.join("한글 문서.md");
        fs::write(&path, "before").unwrap();
        let (tx, rx) = mpsc::channel();
        let _watcher = watch(&path, move |p| {
            let _ = tx.send(p.to_owned());
        })
        .unwrap();
        fs::write(&path, "after").unwrap();
        assert_eq!(rx.recv_timeout(Duration::from_secs(3)).unwrap(), path);
        // Drain the write burst before testing a replacement save.
        while rx.recv_timeout(Duration::from_millis(100)).is_ok() {}
        let temp = fixture.0.join("temporary");
        fs::write(&temp, "replacement").unwrap();
        fs::remove_file(&path).unwrap();
        fs::rename(&temp, &path).unwrap();
        assert_eq!(rx.recv_timeout(Duration::from_secs(3)).unwrap(), path);
        while rx.recv_timeout(Duration::from_millis(100)).is_ok() {}
        fs::write(&path, "next save").unwrap();
        assert_eq!(rx.recv_timeout(Duration::from_secs(3)).unwrap(), path);
    }

    #[test]
    fn ignores_other_files_and_read_access() {
        let fixture = Fixture::new();
        let path = fixture.0.join("document.md");
        fs::write(&path, "before").unwrap();
        let (tx, rx) = mpsc::channel();
        let _watcher = watch(&path, move |p| {
            let _ = tx.send(p.to_owned());
        })
        .unwrap();
        fs::write(fixture.0.join("other.md"), "other").unwrap();
        fs::read(&path).unwrap();
        assert!(rx.recv_timeout(Duration::from_millis(300)).is_err());
    }
}
