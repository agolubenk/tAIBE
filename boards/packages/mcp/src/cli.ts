import { stdin as input } from "node:process";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { runInstall } from "./install/index.js";
import { createStdioServer } from "./server.js";

const SERVE_ALIASES = new Set(["serve", "server", "stdio", "run"]);

export async function runCli(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === "-h" || argv[0] === "--help" || argv[0] === "help") {
    printMainHelp();
    return;
  }
  if (argv[0] === "install" || argv[0] === "setup") {
    await runInstall(argv.slice(1));
    return;
  }
  if (argv[0] !== undefined) {
    if (SERVE_ALIASES.has(argv[0])) {
      await startMcpServer();
      return;
    }
    console.error(`Unknown command: ${argv[0]}`);
    printMainHelp();
    process.exitCode = 1;
    return;
  }
  if (input.isTTY) {
    await runInstall([]);
    return;
  }
  await startMcpServer();
}

// TB-135: the journal's last batch goes out before the process ends. A signal
// or the end of stdin gives it 3 s, then the process exits whatever the API
// does. SIGKILL loses what is held: under 20 calls, 15 s.
const LAST_BATCH_MS = 3_000;

async function startMcpServer(): Promise<void> {
  const { server, close } = createStdioServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const shutdown = (code: number) => () => {
    const deadline = new Promise((done) => setTimeout(done, LAST_BATCH_MS));
    void Promise.race([close(), deadline]).finally(() => process.exit(code));
  };
  process.once("SIGTERM", shutdown(143));
  process.once("SIGINT", shutdown(130));
  input.once("end", shutdown(0));
}

function printMainHelp(): void {
  console.log(`kaneo-mcp: Kaneo MCP server (stdio transport)

Usage:
  npx @kaneo/mcp         Interactive installer (terminal only; no global install)
  kaneo-mcp              Same: installer in a TTY; MCP server when stdin is piped
  kaneo-mcp install      Register in Cursor / Claude / a custom path (explicit)
  kaneo-mcp serve        Run the MCP server (use from a terminal to test stdio)
  kaneo-mcp help

Options:
  -h, --help             Show this help

MCP clients (Cursor, etc.) run this process with a pipe, so they get the server.
In a normal terminal, the default is the interactive installer.

See also: kaneo-mcp install --help
`);
}
