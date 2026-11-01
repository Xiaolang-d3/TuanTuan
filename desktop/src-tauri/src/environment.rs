use std::ffi::OsString;

// Keep all legacy environment-name handling at this boundary. An explicitly
// supplied TUANTUAN_* value (including an empty value) always wins.
fn resolve_with(suffix: &str, lookup: impl Fn(&str) -> Option<OsString>) -> Option<OsString> {
    lookup(&format!("TUANTUAN_{suffix}")).or_else(|| lookup(&format!("CAREERLOOP_{suffix}")))
}

pub fn value(suffix: &str) -> Option<OsString> {
    resolve_with(suffix, |name| std::env::var_os(name))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_environment_wins_and_legacy_is_a_fallback() {
        for suffix in ["PYTHON", "API_BASE"] {
            let new = format!("TUANTUAN_{suffix}");
            let old = format!("CAREERLOOP_{suffix}");
            let resolve = |values: &[(&str, &str)]| {
                resolve_with(suffix, |key| {
                    values
                        .iter()
                        .find(|(name, _)| *name == key)
                        .map(|(_, value)| OsString::from(value))
                })
            };
            assert_eq!(resolve(&[(&new, "new"), (&old, "old")]), Some("new".into()));
            assert_eq!(resolve(&[(&old, "old")]), Some("old".into()));
            assert_eq!(resolve(&[(&new, ""), (&old, "old")]), Some("".into()));
            assert_eq!(resolve(&[]), None);
        }
    }
}
