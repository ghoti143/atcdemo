//! Configuration, read from environment variables once at startup.

use std::fmt;

/// Whether socket connections must present a signed token.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Auth {
    /// Verify tokens against the public keys served at this URL.
    Jwks { url: String },
    /// `ATC_AUTH=off`: treat every connection as a fixed dev user.
    Off,
}

/// Everything `atc-server` reads from its environment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Config {
    /// `DATABASE_URL`: the one Postgres database.
    pub database_url: String,
    /// `ATC_STRESS_MULTIPLIER`: clone multiplier at startup, default 1.
    pub stress_multiplier: u32,
    /// `ATC_ALLOWED_ORIGIN`: the only origin socket connections may come from.
    pub allowed_origin: String,
    /// `ATC_AUTH` and `ATC_JWKS_URL`.
    pub auth: Auth,
}

/// Every problem found in the environment, so one run reports them all.
#[derive(Debug, PartialEq, Eq)]
pub struct ConfigError {
    problems: Vec<String>,
}

impl fmt::Display for ConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        writeln!(f, "Invalid configuration:")?;
        for problem in &self.problems {
            writeln!(f, "  {problem}")?;
        }
        write!(
            f,
            "Copy .env.example to .env at the repo root, or set these in the environment."
        )
    }
}

impl std::error::Error for ConfigError {}

impl Config {
    /// Reads the configuration from the process environment.
    pub fn from_env() -> Result<Config, ConfigError> {
        Config::from_lookup(|name| std::env::var(name).ok())
    }

    /// Reads the configuration through `lookup`, which returns a variable's
    /// value or `None` if it is unset. An empty value counts as unset, so
    /// `.env` can list an optional variable with nothing after the equals
    /// sign.
    pub fn from_lookup(lookup: impl Fn(&str) -> Option<String>) -> Result<Config, ConfigError> {
        let get = |name: &str| {
            lookup(name)
                .map(|v| v.trim().to_owned())
                .filter(|v| !v.is_empty())
        };
        let mut problems = Vec::new();
        let mut require = |name: &str, suffix: &str| {
            let value = get(name);
            if value.is_none() {
                problems.push(format!("{name} is not set{suffix}"));
            }
            value
        };

        let database_url = require("DATABASE_URL", "");
        let allowed_origin = require("ATC_ALLOWED_ORIGIN", "");
        let auth = match get("ATC_AUTH").as_deref() {
            Some("off") => Some(Auth::Off),
            None => require("ATC_JWKS_URL", " (required unless ATC_AUTH=off)")
                .map(|url| Auth::Jwks { url }),
            Some(other) => {
                problems.push(format!("ATC_AUTH must be `off` or empty, not `{other}`"));
                None
            }
        };
        let stress_multiplier = match get("ATC_STRESS_MULTIPLIER") {
            None => Some(1),
            Some(raw) => match raw.parse::<u32>() {
                Ok(value) if value >= 1 => Some(value),
                _ => {
                    problems.push(format!(
                        "ATC_STRESS_MULTIPLIER must be a whole number of 1 or more, not `{raw}`"
                    ));
                    None
                }
            },
        };

        match (database_url, allowed_origin, auth, stress_multiplier) {
            (Some(database_url), Some(allowed_origin), Some(auth), Some(stress_multiplier))
                if problems.is_empty() =>
            {
                Ok(Config {
                    database_url,
                    stress_multiplier,
                    allowed_origin,
                    auth,
                })
            }
            _ => Err(ConfigError { problems }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn load(vars: &[(&str, &str)]) -> Result<Config, ConfigError> {
        Config::from_lookup(|name| {
            vars.iter()
                .find(|(key, _)| *key == name)
                .map(|(_, value)| value.to_string())
        })
    }

    const VALID: [(&str, &str); 3] = [
        ("DATABASE_URL", "postgres://atc:atc@localhost:5432/atc"),
        ("ATC_ALLOWED_ORIGIN", "http://localhost:3000"),
        ("ATC_JWKS_URL", "http://localhost:3000/api/auth/jwks"),
    ];

    fn with(extra: &[(&'static str, &'static str)]) -> Vec<(&'static str, &'static str)> {
        // Overrides go first, because `load` takes the first match.
        extra.iter().chain(&VALID).copied().collect()
    }

    #[test]
    fn reads_the_required_variables_and_applies_defaults() {
        let config = load(&VALID).unwrap();

        assert_eq!(config.database_url, "postgres://atc:atc@localhost:5432/atc");
        assert_eq!(config.allowed_origin, "http://localhost:3000");
        assert_eq!(config.stress_multiplier, 1);
        assert_eq!(
            config.auth,
            Auth::Jwks {
                url: "http://localhost:3000/api/auth/jwks".into()
            }
        );
    }

    #[test]
    fn names_every_missing_variable() {
        let message = load(&[]).unwrap_err().to_string();

        assert!(message.contains("DATABASE_URL is not set"), "{message}");
        assert!(
            message.contains("ATC_ALLOWED_ORIGIN is not set"),
            "{message}"
        );
        assert!(message.contains("ATC_JWKS_URL is not set"), "{message}");
    }

    #[test]
    fn an_empty_value_counts_as_unset() {
        let message = load(&with(&[("DATABASE_URL", "")]))
            .unwrap_err()
            .to_string();

        assert!(message.contains("DATABASE_URL is not set"), "{message}");
        assert!(load(&with(&[("ATC_AUTH", ""), ("ATC_STRESS_MULTIPLIER", "")])).is_ok());
    }

    #[test]
    fn auth_off_needs_no_jwks_url() {
        let config = load(&[
            ("DATABASE_URL", "postgres://localhost/atc"),
            ("ATC_ALLOWED_ORIGIN", "http://localhost:3000"),
            ("ATC_AUTH", "off"),
        ])
        .unwrap();

        assert_eq!(config.auth, Auth::Off);
    }

    #[test]
    fn rejects_an_unknown_auth_mode() {
        let message = load(&with(&[("ATC_AUTH", "none")]))
            .unwrap_err()
            .to_string();

        assert!(
            message.contains("ATC_AUTH must be `off` or empty, not `none`"),
            "{message}"
        );
    }

    #[test]
    fn reads_the_stress_multiplier() {
        assert_eq!(
            load(&with(&[("ATC_STRESS_MULTIPLIER", "100")]))
                .unwrap()
                .stress_multiplier,
            100
        );
    }

    #[test]
    fn rejects_a_bad_stress_multiplier() {
        for bad in ["0", "-1", "ten", "1.5"] {
            let message = load(&with(&[("ATC_STRESS_MULTIPLIER", bad)]))
                .unwrap_err()
                .to_string();

            assert!(
                message.contains("ATC_STRESS_MULTIPLIER must be a whole number"),
                "{message}"
            );
        }
    }
}
