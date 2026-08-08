//! The risk band. `.context/conventions.md` pins it; this module carries it
//! and nothing else.

/// Conventions: exactly three values, ordered. Colours and captions are the
/// UI's; this crate stores the band only. Never extended, never reused.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Risk {
    ReadOnly,
    ChangesConfig,
    Disruptive,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ordering_is_read_only_then_changes_config_then_disruptive() {
        assert!(Risk::ReadOnly < Risk::ChangesConfig);
        assert!(Risk::ChangesConfig < Risk::Disruptive);
    }
}
