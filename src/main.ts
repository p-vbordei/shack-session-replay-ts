#!/usr/bin/env node
/**
 * CLI entry point and stdio JSON-RPC loop.
 */

import readline from "node:readline";
import { handleRequest, ServerState } from "./server.js";

function parseArgs(): { dataDir: string } {
  const args = process.argv.slice(2);
  let dataDir = "trajectories";

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "--data-dir" || args[i] === "-d") && i + 1 < args.length) {
      dataDir = args[i + 1];
      i++;
    }
  }

  return { dataDir };
}

function writeResponse(obj: object): void {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

async function main(): Promise<void> {
  const { dataDir } = parseArgs();
  process.stderr.write(`Starting session-replay server. Data dir: ${dataDir}\n`);

  const state = new ServerState(dataDir);

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let req: Record<string, unknown>;
    try {
      req = JSON.parse(trimmed) as Record<string, unknown>;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      writeResponse({
        jsonrpc: "2.0",
        error: { code: -32700, message: `Parse error: ${message}` },
        id: null,
      });
      continue;
    }

    const resp = handleRequest(req, state);
    if (resp !== null) {
      writeResponse(resp);
    }
  }
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err}\n`);
  process.exit(1);
});
