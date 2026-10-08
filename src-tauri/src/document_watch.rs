use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use std::{
    fs::File,
    io::{self, Read},
    path::Path,
    sync::{mpsc, Arc},
    thread,
    time::Duration,
};

pub struct DocumentWatcher {
    _native: Option<RecommendedWatcher>,
    stop: mpsc::Sender<()>,
}

impl Drop for DocumentWatcher {
    fn drop(&mut self) {
        // Do not join: a disconnected network mount may block an in-flight read.
        let _ = self.stop.send(());
    }
}

// Read only the open document, never scan its folder. Compare contents rather than
// timestamps: remote clients can preserve timestamps or save within their resolution.
fn snapshot(path: &Path) -> Result<Vec<u8>, io::ErrorKind> {
    let file = File::open(path).map_err(|e| e.kind())?;
    let mut bytes = Vec::new();
    file.take(10 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.kind())?;
    Ok(bytes)
}

pub fn watch(
    path: &Path,
    changed: impl Fn(&Path) + Send + Sync + 'static,
) -> notify::Result<DocumentWatcher> {
    watch_with_interval(path, changed, Duration::from_secs(2), true)
}

fn watch_with_interval(
    path: &Path,
    changed: impl Fn(&Path) + Send + Sync + 'static,
    interval: Duration,
    native: bool,
) -> notify::Result<DocumentWatcher> {
    let target = path.to_owned();
    let changed = Arc::new(changed);
    let native_watcher = if native {
        let target = target.clone();
        let changed = changed.clone();
        notify::recommended_watcher(move |result: notify::Result<notify::Event>| match result {
            Ok(event)
                if !matches!(event.kind, notify::EventKind::Access(_))
                    && (event.need_rescan() || event.paths.iter().any(|p| p == &target)) =>
            {
                changed(&target);
            }
            Err(_) => changed(&target),
            _ => {}
        })
        .and_then(|mut watcher| {
            // Watching the parent survives replacement saves.
            watcher.watch(
                path.parent()
                    .ok_or_else(|| notify::Error::generic("Missing parent directory"))?,
                RecursiveMode::NonRecursive,
            )?;
            Ok(watcher)
        })
        .ok() // Unsupported native notifications do not prevent polling.
    } else {
        None
    };
    let mut previous = snapshot(path);
    let (stop, stopped) = mpsc::channel();
    thread::Builder::new()
        .name("mdv-document-poll".into())
        .spawn(move || {
            while matches!(
                stopped.recv_timeout(interval),
                Err(mpsc::RecvTimeoutError::Timeout)
            ) {
                let current = snapshot(&target);
                // The watcher may have been replaced while network I/O was blocked.
                if !matches!(stopped.try_recv(), Err(mpsc::TryRecvError::Empty)) {
                    break;
                }
                if current != previous {
                    previous = current;
                    changed(&target);
                }
            }
        })
        .map_err(notify::Error::io)?;
    Ok(DocumentWatcher {
        _native: native_watcher,
        stop,
    })
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

#[cfg(test)]
mod polling_tests {
    use super::*;
    use std::{
        fs,
        time::{SystemTime, UNIX_EPOCH},
    };

    #[test]
    fn polling_without_native_notifications_detects_changes_and_recovery() {
        let directory = std::env::temp_dir().join(format!(
            "mdv-poll-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&directory).unwrap();
        let path = directory.join("document.md");
        fs::write(&path, "before").unwrap();
        let (tx, rx) = mpsc::channel();
        let watcher = watch_with_interval(
            &path,
            move |p| {
                let _ = tx.send(p.to_owned());
            },
            Duration::from_millis(50),
            false,
        )
        .unwrap();
        // Same-length content change, independent of native events or metadata.
        fs::write(&path, "after!").unwrap();
        assert_eq!(rx.recv_timeout(Duration::from_secs(3)).unwrap(), path);
        fs::write(directory.join("other.md"), "unrelated").unwrap();
        assert!(rx.recv_timeout(Duration::from_millis(200)).is_err());
        fs::remove_file(&path).unwrap();
        assert_eq!(rx.recv_timeout(Duration::from_secs(3)).unwrap(), path);
        // A missing file does not produce an error notification every interval.
        assert!(rx.recv_timeout(Duration::from_millis(200)).is_err());
        fs::write(&path, "restored").unwrap();
        assert_eq!(rx.recv_timeout(Duration::from_secs(3)).unwrap(), path);
        let temporary = directory.join("temporary");
        fs::write(&temporary, "replacement").unwrap();
        fs::remove_file(&path).unwrap();
        fs::rename(&temporary, &path).unwrap();
        assert_eq!(rx.recv_timeout(Duration::from_secs(3)).unwrap(), path);
        drop(watcher);
        fs::write(&path, "stopped").unwrap();
        assert!(rx.recv_timeout(Duration::from_millis(200)).is_err());
        fs::remove_dir_all(directory).unwrap();
    }
}
