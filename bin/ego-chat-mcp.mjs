#!/usr/bin/env node

import { runMcpServer } from "../src/mcp-server.mjs"

runMcpServer().catch((error) => {
  console.error("Ego Chat MCP server failed:", error)
  process.exit(1)
})
