//! `oyot --mcp`: what an MCP client launches (ADR 0037, decision 2).
//!
//! It runs before Tauri, from `main`, so neither the window nor the
//! single-instance plugin ever starts: that plugin would otherwise take the
//! launch for a second copy of Oyot and only focus the first. All it does is
//! find the running app's socket, start the app if nothing is listening, and
//! copy bytes between the socket and its own stdin and stdout. The protocol
//! is the app's business, so this never changes when the tools do.
//!
//! Nothing but the client's messages is written to stdout, which is the
//! protocol's channel. Anything for a person goes to stderr, which a client
//! keeps as the server's log.

use super::endpoint::Endpoint;
use std::time::{Duration, Instant};
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt};

/// How long to wait for an app the bridge started to begin listening. A cold
/// start opens the database and runs its migrations first.
const START_TIMEOUT: Duration = Duration::from_secs(20);
const RETRY: Duration = Duration::from_millis(250);

/// Run the bridge, and say what the process should exit with.
pub fn run() -> i32 {
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(e) => {
            eprintln!("oyot --mcp: {e}");
            return 1;
        }
    };
    let code = match runtime.block_on(bridge()) {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("oyot --mcp: {e}");
            1
        }
    };
    // Reading stdin holds a blocking thread the runtime would otherwise wait
    // for at shutdown, and the client may never close it.
    runtime.shutdown_timeout(Duration::from_millis(100));
    code
}

async fn bridge() -> Result<(), String> {
    let endpoint = Endpoint::for_this_user()
        .ok_or("could not find this user's data directory, so not where Oyot listens")?;
    let stream = match connect(&endpoint).await {
        Ok(stream) => stream,
        Err(_) => {
            launch_app()?;
            wait_for(&endpoint).await?
        }
    };
    pipe(stream).await
}

/// Copy the client's messages to the app and the app's back, until either
/// side is done.
async fn pipe<S>(stream: S) -> Result<(), String>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let (mut from_app, mut to_app) = tokio::io::split(stream);
    let mut stdin = tokio::io::stdin();
    let mut stdout = tokio::io::stdout();

    let up = async {
        let copied = tokio::io::copy(&mut stdin, &mut to_app).await;
        let _ = to_app.shutdown().await;
        copied
    };
    let down = async {
        let copied = tokio::io::copy(&mut from_app, &mut stdout).await;
        let _ = stdout.flush().await;
        copied
    };
    let result = tokio::select! {
        copied = up => copied,
        copied = down => copied,
    };
    result
        .map(|_| ())
        .map_err(|e| format!("the connection to Oyot broke: {e}"))
}

/// Start the app in the tray, as a start at login does (ADR 0030, decision
/// 7), detached from the bridge so that it outlives the client that started
/// it.
fn launch_app() -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| format!("could not find Oyot: {e}"))?;
    let mut command = std::process::Command::new(exe);
    command
        .arg(crate::desktop::HIDDEN_FLAG)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // Its own process group: a client that stops its server's group
        // would otherwise stop Oyot with it.
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        command.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    }
    eprintln!("oyot --mcp: Oyot is not running, so starting it");
    command
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("could not start Oyot: {e}"))
}

async fn wait_for(endpoint: &Endpoint) -> Result<Stream, String> {
    let started = Instant::now();
    loop {
        tokio::time::sleep(RETRY).await;
        match connect(endpoint).await {
            Ok(stream) => return Ok(stream),
            Err(e) if started.elapsed() > START_TIMEOUT => {
                return Err(format!("Oyot did not start listening: {e}"));
            }
            Err(_) => {}
        }
    }
}

#[cfg(unix)]
type Stream = tokio::net::UnixStream;

#[cfg(unix)]
async fn connect(endpoint: &Endpoint) -> std::io::Result<Stream> {
    let Endpoint::Socket(path) = endpoint;
    tokio::net::UnixStream::connect(path).await
}

#[cfg(windows)]
type Stream = tokio::net::windows::named_pipe::NamedPipeClient;

/// Every instance busy is the one failure worth waiting out here: the app
/// makes a new one as soon as it hands the last one to a client.
#[cfg(windows)]
async fn connect(endpoint: &Endpoint) -> std::io::Result<Stream> {
    const ERROR_PIPE_BUSY: i32 = 231;
    let Endpoint::Pipe(name) = endpoint;
    for _ in 0..20 {
        match tokio::net::windows::named_pipe::ClientOptions::new().open(name) {
            Err(e) if e.raw_os_error() == Some(ERROR_PIPE_BUSY) => {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            other => return other,
        }
    }
    tokio::net::windows::named_pipe::ClientOptions::new().open(name)
}
