import process from 'node:process'

// An MCP stdio server for the restart tests. It writes one line to the file in MCP_FIXTURE_LOG
// when it starts and one line for each tool call, so that a test can count live processes and executions.
import { appendFileSync } from 'node:fs'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

const logPath = process.env.MCP_FIXTURE_LOG
appendFileSync(logPath, `start ${process.pid}\n`)

const server = new McpServer({ name: 'restart-fixture', version: '0.0.0' })
server.tool('ping', async () => {
  appendFileSync(logPath, `call ${process.pid}\n`)
  return { content: [{ type: 'text', text: 'pong' }] }
})

// A well-behaved stdio server exits when the client closes its input.
process.stdin.on('end', () => process.exit(0))

server.connect(new StdioServerTransport()).catch((error) => {
  console.error(error)
  process.exit(1)
})
