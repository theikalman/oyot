//! Accepting MCP clients on the endpoint, one session each.

use super::endpoint::Endpoint;
use super::server::OyotServer;
use super::tools::Context;
use rmcp::ServiceExt;
use std::sync::Arc;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::watch;

pub struct Listener {
    endpoint: Endpoint,
    task: tauri::async_runtime::JoinHandle<()>,
    /// Bumped to end every session, which each one watches.
    generation: watch::Sender<u64>,
}

impl Listener {
    pub fn start(endpoint: Endpoint, ctx: Arc<Context>) -> Result<Self, String> {
        let (generation, _) = watch::channel(0u64);
        let sessions = generation.clone();

        #[cfg(unix)]
        let task = {
            let Endpoint::Socket(path) = &endpoint;
            let listener = unix::bind(path)?;
            tauri::async_runtime::spawn(async move {
                let listener = match tokio::net::UnixListener::from_std(listener) {
                    Ok(listener) => listener,
                    Err(e) => return warn_log!("[mcp] could not listen: {e}"),
                };
                loop {
                    match listener.accept().await {
                        Ok((stream, _)) => spawn_session(stream, ctx.clone(), sessions.subscribe()),
                        Err(e) => {
                            warn_log!("[mcp] could not accept a client: {e}");
                            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                        }
                    }
                }
            })
        };

        #[cfg(windows)]
        let task = {
            let Endpoint::Pipe(name) = endpoint.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = windows::accept(&name, ctx, sessions).await {
                    warn_log!("[mcp] stopped listening: {e}");
                }
            })
        };

        trace!("[mcp] listening at {endpoint:?}");
        Ok(Self {
            endpoint,
            task,
            generation,
        })
    }

    /// End every connected session. The listener keeps accepting.
    pub fn drop_sessions(&self) {
        self.generation.send_modify(|g| *g += 1);
    }

    pub fn stop(self) {
        self.drop_sessions();
        self.task.abort();
        #[cfg(unix)]
        {
            let Endpoint::Socket(path) = &self.endpoint;
            let _ = std::fs::remove_file(path);
        }
    }
}

fn spawn_session<S>(stream: S, ctx: Arc<Context>, mut generation: watch::Receiver<u64>)
where
    S: AsyncRead + AsyncWrite + Send + Unpin + 'static,
{
    tauri::async_runtime::spawn(async move {
        let running = match OyotServer::new(ctx).serve(stream).await {
            Ok(running) => running,
            Err(e) => return trace!("[mcp] a client left before it began: {e}"),
        };
        let token = running.cancellation_token();
        tokio::select! {
            _ = running.waiting() => {}
            _ = generation.changed() => token.cancel(),
        }
        trace!("[mcp] a session ended");
    });
}

#[cfg(unix)]
mod unix {
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::net::{UnixListener, UnixStream};
    use std::path::Path;

    /// Bind the socket so that it is never reachable by anyone but this user.
    ///
    /// It is bound under a temporary name, made `0600`, and only then moved to
    /// where clients look: binding in place would leave it, for a moment, with
    /// whatever the umask allows. A socket left behind by a copy of Oyot that
    /// did not exit cleanly is removed; one that something still answers on is
    /// not, since that is another copy running.
    pub fn bind(path: &Path) -> Result<UnixListener, String> {
        if path.exists() {
            if UnixStream::connect(path).is_ok() {
                return Err(format!(
                    "something is already listening at {}",
                    path.display()
                ));
            }
            std::fs::remove_file(path)
                .map_err(|e| format!("could not remove a stale socket: {e}"))?;
        }
        let staged = path.with_extension(format!("sock.{}", std::process::id()));
        let _ = std::fs::remove_file(&staged);
        let listener = UnixListener::bind(&staged).map_err(|e| e.to_string())?;
        let made = std::fs::set_permissions(&staged, std::fs::Permissions::from_mode(0o600))
            .and_then(|_| std::fs::rename(&staged, path))
            .and_then(|_| listener.set_nonblocking(true));
        if let Err(e) = made {
            let _ = std::fs::remove_file(&staged);
            return Err(e.to_string());
        }
        Ok(listener)
    }
}

#[cfg(windows)]
mod windows {
    use super::{spawn_session, Context};
    use std::sync::Arc;
    use tokio::net::windows::named_pipe::ServerOptions;
    use tokio::sync::watch;

    /// Serve one pipe instance per client, making the next before handing the
    /// connected one off, so a client is never refused for arriving between
    /// two. The first instance claims the name, so nothing that made a pipe
    /// of that name first can be mistaken for Oyot.
    pub async fn accept(
        name: &str,
        ctx: Arc<Context>,
        sessions: watch::Sender<u64>,
    ) -> std::io::Result<()> {
        let mut server = ServerOptions::new()
            .first_pipe_instance(true)
            .reject_remote_clients(true)
            .create(name)?;
        loop {
            server.connect().await?;
            let connected = server;
            server = ServerOptions::new()
                .reject_remote_clients(true)
                .create(name)?;
            spawn_session(connected, ctx.clone(), sessions.subscribe());
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::unix::bind;
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::net::UnixStream;

    #[test]
    fn the_socket_is_this_users_alone_and_answers_where_clients_look() {
        let dir = tempdir();
        let path = dir.join("mcp.sock");
        let listener = bind(&path).unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        UnixStream::connect(&path).expect("a client reaches it at its final name");
        drop(listener);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_stale_socket_is_replaced_and_a_live_one_is_not() {
        let dir = tempdir();
        let path = dir.join("mcp.sock");
        let first = bind(&path).unwrap();
        assert!(
            bind(&path).is_err(),
            "a socket something answers on is left alone"
        );
        drop(first);
        // Nothing answers now, so the file is stale.
        bind(&path).expect("a stale socket is replaced");
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Under `/tmp` rather than `temp_dir()`, which can be deep enough to
    /// pass the hundred or so bytes a socket's path may hold.
    fn tempdir() -> std::path::PathBuf {
        let id = uuid::Uuid::new_v4().simple().to_string();
        let dir = std::path::Path::new("/tmp").join(format!("oyot-mcp-{}", &id[..12]));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }
}
