use std::{
    io,
    path::{Path, PathBuf},
};

const LEGACY_IDENTIFIER: &str = "com.careerloop.desktop";

fn has_backend_data(directory: &Path) -> bool {
    // Include split-account databases and pre-rebrand databases. A newly
    // created WebView cache in the new identifier directory is not user data.
    [
        "tuantuan.db",
        "careerloop.db",
        "bosscopilot.db",
        "auth.db",
        "workspaces",
        "attachments",
    ]
    .iter()
    .any(|name| directory.join(name).exists())
}

pub fn discover(current: PathBuf) -> io::Result<PathBuf> {
    let parent = current
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "应用数据目录缺少父目录"))?;
    let legacy = parent.join(LEGACY_IDENTIFIER);
    if legacy == current || !legacy.try_exists()? {
        return Ok(current);
    }
    let legacy_has_data = has_backend_data(&legacy);
    let current_has_data = has_backend_data(&current);
    if legacy_has_data && current_has_data {
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            format!(
                "新旧应用目录均有资料，请先备份并合并后重试：{}；{}",
                current.display(),
                legacy.display()
            ),
        ));
    }
    // Reuse the original directory in place instead of copying live SQLite
    // databases or breaking absolute attachment paths. Never delete either tree.
    if !current_has_data
        && (legacy_has_data || std::fs::read_dir(&legacy)?.next().transpose()?.is_some())
    {
        Ok(legacy)
    } else {
        Ok(current)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQUENCE: AtomicU64 = AtomicU64::new(0);

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "tuantuan-data-test-{}-{}",
                std::process::id(),
                SEQUENCE.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir(&path).unwrap();
            Self(path)
        }
        fn current(&self) -> PathBuf {
            self.0.join("com.tuantuan.desktop")
        }
        fn legacy(&self) -> PathBuf {
            self.0.join(LEGACY_IDENTIFIER)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn fresh_install_uses_new_identifier() {
        let fixture = Fixture::new();
        assert_eq!(discover(fixture.current()).unwrap(), fixture.current());
        assert!(!fixture.current().exists());
    }

    #[test]
    fn upgrade_discovers_legacy_data_even_when_webview_created_new_directory() {
        for name in [
            "careerloop.db",
            "bosscopilot.db",
            "tuantuan.db",
            "auth.db",
            "workspaces",
        ] {
            let fixture = Fixture::new();
            std::fs::create_dir(fixture.legacy()).unwrap();
            std::fs::create_dir(fixture.current()).unwrap();
            std::fs::write(fixture.current().join("webview-cache"), b"cache").unwrap();
            let file = fixture.legacy().join(name);
            std::fs::write(&file, b"synthetic user data").unwrap();
            assert_eq!(discover(fixture.current()).unwrap(), fixture.legacy());
            assert_eq!(std::fs::read(file).unwrap(), b"synthetic user data");
            assert!(!fixture.current().join(name).exists());
        }
    }

    #[test]
    fn conflicting_data_is_reported_without_overwriting() {
        let fixture = Fixture::new();
        for path in [fixture.current(), fixture.legacy()] {
            std::fs::create_dir(&path).unwrap();
            std::fs::write(path.join("auth.db"), b"synthetic").unwrap();
        }
        assert_eq!(
            discover(fixture.current()).unwrap_err().kind(),
            io::ErrorKind::AlreadyExists
        );
        for path in [fixture.current(), fixture.legacy()] {
            assert_eq!(std::fs::read(path.join("auth.db")).unwrap(), b"synthetic");
        }
    }

    #[test]
    fn existing_new_data_wins_over_empty_legacy_directory() {
        let fixture = Fixture::new();
        std::fs::create_dir(fixture.legacy()).unwrap();
        std::fs::create_dir(fixture.current()).unwrap();
        std::fs::write(fixture.current().join("auth.db"), b"synthetic").unwrap();
        assert_eq!(discover(fixture.current()).unwrap(), fixture.current());
    }

    #[test]
    fn legacy_unrecognized_files_are_preserved_and_discovered() {
        let fixture = Fixture::new();
        std::fs::create_dir(fixture.legacy()).unwrap();
        std::fs::write(fixture.legacy().join("saved-settings.json"), b"{}").unwrap();
        assert_eq!(discover(fixture.current()).unwrap(), fixture.legacy());
    }
}
