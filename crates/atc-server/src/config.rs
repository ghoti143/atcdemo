//! Configuration, read from environment variables once at startup.

use std::fmt;
use std::path::PathBuf;

/// Where the seed file is when `ATC_SEED_FILE` is not set, relative to the
/// working directory: the repo root for `cargo run`, and the directory the
/// image starts in.
pub const DEFAULT_SEED_FILE: &str = "data/seed/flights.bin.gz";

/// The latest sim time `ATC_START_SECONDS` may name. Sim time is a `u32` of
/// seconds, and a clock started here still has over a century to run.
pub const MAX_START_SECONDS: u32 = 1_000_000_000;

/// Whether socket connections must present a signed token.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Auth {
    /// Verify tokens against the public keys served at `url`. `issuer` is
    /// who must have issued them and whom they must be for: the web app's
    /// public URL, `ATC_TOKEN_ISSUER`, which is `ATC_ALLOWED_ORIGIN` unless
    /// it is set.
    Jwks { url: String, issuer: String },
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
    /// `ATC_START_SECONDS`: the sim time the clock starts from, default 0.
    pub start_seconds: u32,
    /// `ATC_SEED_FILE`: the recording to replay, default [`DEFAULT_SEED_FILE`].
    pub seed_file: PathBuf,
    /// `ATC_LOG_LEVEL`: the least serious level that is logged, default `info`.
    pub log_level: tracing::Level,
    /// `ATC_ALLOWED_ORIGIN`: the only origin socket connections may come from.
    pub allowed_origin: String,
    /// `ATC_AUTH`, `ATC_JWKS_URL` and `ATC_TOKEN_ISSUER`.
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
            None => {
                let url = require("ATC_JWKS_URL", " (required unless ATC_AUTH=off)");
                // Better Auth signs with its own URL as issuer and audience,
                // with no slash at the end. In the usual setup that is the
                // allowed origin, so it need not be given twice.
                let issuer = get("ATC_TOKEN_ISSUER").or_else(|| allowed_origin.clone());
                match (url, issuer) {
                    (Some(url), Some(issuer)) => Some(Auth::Jwks {
                        url,
                        issuer: issuer.trim_end_matches('/').to_owned(),
                    }),
                    _ => None,
                }
            }
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
        let start_seconds = match get("ATC_START_SECONDS") {
            None => Some(0),
            Some(raw) => match raw.parse::<u32>() {
                Ok(value) if value <= MAX_START_SECONDS => Some(value),
                _ => {
                    problems.push(format!(
                        "ATC_START_SECONDS must be a whole number from 0 to {MAX_START_SECONDS}, not `{raw}`"
                    ));
                    None
                }
            },
        };

        let log_level = match get("ATC_LOG_LEVEL") {
            None => Some(tracing::Level::INFO),
            Some(raw) => match raw.parse::<tracing::Level>() {
                Ok(level) => Some(level),
                Err(_) => {
                    problems.push(format!(
                        "ATC_LOG_LEVEL must be error, warn, info, debug or trace, not `{raw}`"
                    ));
                    None
                }
            },
        };

        match (
            database_url,
            allowed_origin,
            auth,
            stress_multiplier,
            start_seconds,
            log_level,
        ) {
            (
                Some(database_url),
                Some(allowed_origin),
                Some(auth),
                Some(stress_multiplier),
                Some(start_seconds),
                Some(log_level),
            ) if problems.is_empty() => Ok(Config {
                database_url,
                stress_multiplier,
                start_seconds,
                log_level,
                seed_file: get("ATC_SEED_FILE")
                    .unwrap_or_else(|| DEFAULT_SEED_FILE.to_owned())
                    .into(),
                allowed_origin,
                auth,
            }),
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
        assert_eq!(config.start_seconds, 0);
        assert_eq!(
            config.auth,
            Auth::Jwks {
                url: "http://localhost:3000/api/auth/jwks".into(),
                issuer: "http://localhost:3000".into(),
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
    fn the_seed_file_has_a_default_and_can_be_set() {
        let config = load(&with(&[("ATC_SEED_FILE", "")])).unwrap();
        assert_eq!(config.seed_file, PathBuf::from(DEFAULT_SEED_FILE));

        let config = load(&with(&[("ATC_SEED_FILE", "/tmp/other.bin.gz")])).unwrap();
        assert_eq!(config.seed_file, PathBuf::from("/tmp/other.bin.gz"));
    }

    #[test]
    fn the_log_level_defaults_to_info_and_can_be_set() {
        assert_eq!(load(&VALID).unwrap().log_level, tracing::Level::INFO);
        let config = load(&with(&[("ATC_LOG_LEVEL", "debug")])).unwrap();
        assert_eq!(config.log_level, tracing::Level::DEBUG);
        let config = load(&with(&[("ATC_LOG_LEVEL", "WARN")])).unwrap();
        assert_eq!(config.log_level, tracing::Level::WARN);

        let message = load(&with(&[("ATC_LOG_LEVEL", "loud")]))
            .unwrap_err()
            .to_string();
        assert!(
            message.contains("ATC_LOG_LEVEL must be error, warn, info, debug or trace"),
            "{message}"
        );
    }

    #[test]
    fn the_start_time_defaults_to_zero_and_can_be_set() {
        let config = load(&with(&[("ATC_START_SECONDS", "")])).unwrap();
        assert_eq!(config.start_seconds, 0);

        // Past the end of a four hour window is allowed.
        for (raw, expected) in [
            ("0", 0),
            ("14340", 14_340),
            ("30000", 30_000),
            ("1000000000", MAX_START_SECONDS),
        ] {
            let config = load(&with(&[("ATC_START_SECONDS", raw)])).unwrap();
            assert_eq!(config.start_seconds, expected);
        }
    }

    #[test]
    fn rejects_a_bad_start_time() {
        for bad in ["-1", "soon", "1.5", "14340s", "1000000001", "4294967296"] {
            let message = load(&with(&[("ATC_START_SECONDS", bad)]))
                .unwrap_err()
                .to_string();

            assert!(
                message.contains(&format!(
                    "ATC_START_SECONDS must be a whole number from 0 to 1000000000, not `{bad}`"
                )),
                "{message}"
            );
        }
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
