//! The command line.
//!
//! Parsed by hand: there are eight options, each a name and one value, and
//! that does not need an argument-parsing crate and what it would bring in.

/// Where `atc-server` listens when it is started with `docker compose up`.
pub const DEFAULT_URL: &str = "ws://localhost:8080/ws";
/// The zoom sent with a viewport when `--zoom` is not given.
pub const DEFAULT_ZOOM: f64 = 6.0;

pub const USAGE: &str = "\
Watches atc-server's stream and prints one line per tick.

Usage: atc-cli [OPTIONS]

Options:
  --url <URL>          The server's socket [default: ws://localhost:8080/ws]
  --viewport <W,S,E,N> Ask for the aircraft in this box only: west, south,
                       east and north edges in degrees, e.g. -80,38,-70,43
  --zoom <ZOOM>        The map zoom sent with the viewport [default: 6]
  --select <ID>        Select this aircraft id, so it keeps streaming when it
                       is outside the viewport
  --track <ID>         Ask for the track this aircraft id has flown so far
  --token <JWT>        The signed token a server that verifies them asks for
                       [default: the ATC_TOKEN environment variable]. Get one
                       with `bun tools/socket-token.ts`
  --frames <N>         Stop after N ticks; without it, run until Ctrl-C
  --dump <N>           Also print N decoded aircraft from every tick
  -h, --help           Print this

Exits with 0 after --frames ticks or Ctrl-C, 1 when the connection fails, is
closed by the server or sends something that does not decode, and 2 when the
arguments are wrong.";

/// A box on the map, in degrees.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Viewport {
    pub west: f64,
    pub south: f64,
    pub east: f64,
    pub north: f64,
}

/// What the client was asked to do.
#[derive(Debug, Clone, PartialEq)]
pub struct Options {
    pub url: String,
    /// The box to ask for. Without one the server sends the whole picture.
    pub viewport: Option<Viewport>,
    pub zoom: f64,
    /// The aircraft id to select.
    pub select: Option<u32>,
    /// The aircraft id to ask for the track of.
    pub track: Option<u32>,
    /// The token to present, when the server verifies them.
    pub token: Option<String>,
    /// How many ticks to stop after.
    pub frames: Option<u64>,
    /// How many aircraft to print from every tick.
    pub dump: usize,
}

impl Default for Options {
    fn default() -> Options {
        Options {
            url: DEFAULT_URL.to_owned(),
            viewport: None,
            zoom: DEFAULT_ZOOM,
            select: None,
            track: None,
            token: None,
            frames: None,
            dump: 0,
        }
    }
}

/// What the arguments ask for.
#[derive(Debug, Clone, PartialEq)]
pub enum Command {
    Run(Options),
    Help,
}

/// Reads the arguments, without the program's name. An option's value is the
/// next argument, or follows an equals sign: `--frames 5` or `--frames=5`.
pub fn parse(args: impl IntoIterator<Item = String>) -> Result<Command, String> {
    let mut options = Options::default();
    let mut zoom_given = false;
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        let (name, inline) = match arg.split_once('=') {
            Some((name, value)) if name.starts_with("--") => (name, Some(value.to_owned())),
            _ => (arg.as_str(), None),
        };
        if name == "-h" || name == "--help" {
            return Ok(Command::Help);
        }
        if !OPTIONS.contains(&name) {
            return Err(format!("unknown argument `{arg}`"));
        }
        let Some(value) = inline.or_else(|| args.next()) else {
            return Err(format!("{name} needs a value"));
        };
        match name {
            "--url" => options.url = value,
            "--viewport" => options.viewport = Some(viewport(&value)?),
            "--zoom" => {
                options.zoom = match value.parse() {
                    Ok(zoom) if (0.0..=24.0).contains(&zoom) => zoom,
                    _ => return Err(format!("--zoom takes a number from 0 to 24, not `{value}`")),
                };
                zoom_given = true;
            }
            "--select" => options.select = Some(number(name, &value)?),
            "--track" => options.track = Some(number(name, &value)?),
            "--token" => {
                if value.is_empty() {
                    return Err("--token needs a value".to_owned());
                }
                options.token = Some(value);
            }
            "--frames" => match number(name, &value)? {
                0 => return Err("--frames must be at least 1".to_owned()),
                frames => options.frames = Some(frames),
            },
            "--dump" => options.dump = number(name, &value)?,
            _ => unreachable!("every name in OPTIONS is handled"),
        }
    }
    if zoom_given && options.viewport.is_none() {
        return Err("--zoom is sent with the viewport, so it needs --viewport".to_owned());
    }
    Ok(Command::Run(options))
}

/// The options that take a value.
const OPTIONS: [&str; 8] = [
    "--token",
    "--url",
    "--viewport",
    "--zoom",
    "--select",
    "--track",
    "--frames",
    "--dump",
];

fn number<T: std::str::FromStr>(name: &str, value: &str) -> Result<T, String> {
    value
        .parse()
        .map_err(|_| format!("{name} takes a whole number, not `{value}`"))
}

/// Reads `west,south,east,north`. West may be greater than east: that box
/// crosses the antimeridian.
fn viewport(value: &str) -> Result<Viewport, String> {
    let wrong = || format!("--viewport takes west,south,east,north in degrees, not `{value}`");
    let edges: Vec<f64> = value
        .split(',')
        .map(|edge| edge.trim().parse())
        .collect::<Result<_, _>>()
        .map_err(|_| wrong())?;
    let &[west, south, east, north] = edges.as_slice() else {
        return Err(wrong());
    };
    let longitudes = (-180.0..=180.0).contains(&west) && (-180.0..=180.0).contains(&east);
    let latitudes = (-90.0..=90.0).contains(&south) && (-90.0..=90.0).contains(&north);
    if !longitudes || !latitudes {
        return Err(format!(
            "--viewport `{value}` is off the map: longitudes run from -180 to 180 and latitudes from -90 to 90"
        ));
    }
    if south > north {
        return Err(format!(
            "--viewport `{value}` has its south edge above its north edge; the order is west,south,east,north"
        ));
    }
    Ok(Viewport {
        west,
        south,
        east,
        north,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_line(line: &str) -> Result<Command, String> {
        parse(line.split_whitespace().map(str::to_owned))
    }

    fn options(line: &str) -> Options {
        match parse_line(line) {
            Ok(Command::Run(options)) => options,
            other => panic!("expected options from `{line}`, got {other:?}"),
        }
    }

    #[test]
    fn no_arguments_means_the_whole_picture_from_the_local_server() {
        assert_eq!(options(""), Options::default());
        assert_eq!(Options::default().url, "ws://localhost:8080/ws");
        assert_eq!(Options::default().frames, None);
    }

    #[test]
    fn every_option_is_read() {
        let line = "--url ws://example.test:9000/ws --viewport -80,38,-70.5,43 --zoom 7.5 \
                    --select 12 --track 34 --frames 5 --dump 3 --token aaa.bbb.ccc";
        assert_eq!(
            options(line),
            Options {
                url: "ws://example.test:9000/ws".to_owned(),
                viewport: Some(Viewport {
                    west: -80.0,
                    south: 38.0,
                    east: -70.5,
                    north: 43.0,
                }),
                zoom: 7.5,
                select: Some(12),
                track: Some(34),
                token: Some("aaa.bbb.ccc".to_owned()),
                frames: Some(5),
                dump: 3,
            }
        );
    }

    #[test]
    fn a_value_may_follow_an_equals_sign() {
        let given = options("--frames=5 --viewport=-80,38,-70,43 --url=ws://h/ws?a=b");
        assert_eq!(given.frames, Some(5));
        assert_eq!(given.viewport.unwrap().west, -80.0);
        assert_eq!(given.url, "ws://h/ws?a=b");
    }

    #[test]
    fn a_token_is_optional_and_may_not_be_empty() {
        assert_eq!(options("").token, None);
        assert_eq!(options("--token=a.b.c").token.as_deref(), Some("a.b.c"));
        assert!(parse(["--token=".to_owned()]).is_err());
        assert!(parse(["--token".to_owned()]).is_err());
    }

    #[test]
    fn a_viewport_may_cross_the_antimeridian() {
        let viewport = options("--viewport 170,-10,-170,10").viewport.unwrap();
        assert_eq!((viewport.west, viewport.east), (170.0, -170.0));
    }

    #[test]
    fn help_wins_over_everything_else() {
        assert_eq!(parse_line("--help"), Ok(Command::Help));
        assert_eq!(parse_line("--frames 5 -h"), Ok(Command::Help));
    }

    #[test]
    fn wrong_arguments_are_refused_with_the_reason() {
        for (line, reason) in [
            ("--bogus 1", "unknown argument `--bogus`"),
            ("extra", "unknown argument `extra`"),
            ("--frames", "--frames needs a value"),
            ("--frames 0", "at least 1"),
            ("--frames five", "whole number"),
            ("--frames -1", "whole number"),
            ("--select 1.5", "whole number"),
            ("--track x", "whole number"),
            ("--dump -2", "whole number"),
            ("--viewport -80,38,-70", "west,south,east,north"),
            ("--viewport -80,38,-70,43,1", "west,south,east,north"),
            ("--viewport a,b,c,d", "west,south,east,north"),
            ("--viewport -80,38,-70,NaN", "off the map"),
            ("--viewport -200,38,-70,43", "off the map"),
            ("--viewport -80,38,-70,91", "off the map"),
            ("--viewport -80,43,-70,38", "south edge above"),
            ("--viewport -80,38,-70,43 --zoom 25", "0 to 24"),
            ("--viewport -80,38,-70,43 --zoom far", "0 to 24"),
            ("--zoom 7", "needs --viewport"),
        ] {
            let problem = parse_line(line).expect_err(line);
            assert!(problem.contains(reason), "`{line}` gave `{problem}`");
        }
    }

    #[test]
    fn the_usage_names_every_option() {
        for name in OPTIONS {
            assert!(USAGE.contains(name), "{name}");
        }
        assert!(USAGE.contains(DEFAULT_URL));
    }
}
