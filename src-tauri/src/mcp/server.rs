//! The MCP server one client talks to.

use super::tools::{self, Context};
use rmcp::model::{
    CallToolRequestParams, CallToolResponse, Implementation, ListToolsResult,
    PaginatedRequestParams, ServerCapabilities, ServerConfig,
};
use rmcp::service::RequestContext;
use rmcp::{ErrorData, RoleServer, ServerHandler};
use std::sync::Arc;

/// What a client is told about using Oyot, once, when it connects.
const INSTRUCTIONS: &str = "Oyot is the user's note-taking app. Notes and \
journals (one per day) live on their devices and sync between them. Search \
before listing. A note's id is what other tools take. Todos are numbered by \
their ordinal within their note. If no tools are listed, the user has not \
turned on access for AI assistants in Oyot's settings.";

pub struct OyotServer {
    ctx: Arc<Context>,
}

impl OyotServer {
    pub fn new(ctx: Arc<Context>) -> Self {
        Self { ctx }
    }
}

impl ServerHandler for OyotServer {
    fn get_info(&self) -> ServerConfig {
        let mut implementation = Implementation::new("oyot", env!("CARGO_PKG_VERSION"));
        implementation.title = Some("Oyot".into());
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(implementation)
            .with_instructions(INSTRUCTIONS)
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        Ok(ListToolsResult {
            tools: tools::list(self.ctx.access.get()),
            ..Default::default()
        })
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        let arguments = request.arguments.unwrap_or_default();
        Ok(tools::call(self.ctx.clone(), &request.name, arguments)
            .await
            .into())
    }
}
