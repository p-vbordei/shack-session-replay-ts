/**
 * Core server logic: JSON-RPC 2.0 dispatch and tool implementations.
 */

import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export interface TrajectoryEvent {
  recorded_at: string;
  request: unknown;
  response: unknown;
}

export interface Trajectory {
  events: TrajectoryEvent[];
}

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

export function loadTrajectory(filePath: string): Trajectory {
  const text = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(text) as Trajectory;
}

export function saveTrajectory(filePath: string, traj: Trajectory): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(traj, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// Server state
// ---------------------------------------------------------------------------

export class ServerState {
  dataDir: string;
  activeRecording: string | null = null;
  pendingEvents: TrajectoryEvent[] = [];

  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  trajectoryPath(name: string): string {
    return path.join(this.dataDir, `${name}.json`);
  }
}

// ---------------------------------------------------------------------------
// Canonical request (strips `id` for comparison)
// ---------------------------------------------------------------------------

export function canonicalRequest(req: unknown): string {
  if (req !== null && typeof req === "object" && !Array.isArray(req)) {
    const copy = { ...(req as Record<string, unknown>) };
    delete copy["id"];
    return JSON.stringify(copy);
  }
  return JSON.stringify(req);
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

export function toolStartRecording(args: Record<string, unknown>, state: ServerState): string {
  const name = args["name"];
  if (typeof name !== "string" || !name) {
    throw new Error("Missing or non-string parameter: name");
  }
  if (state.activeRecording !== null) {
    throw new Error(
      `A recording session is already active (${state.activeRecording}). Call stop_recording first.`
    );
  }
  state.activeRecording = name;
  state.pendingEvents = [];
  process.stderr.write(`Recording started: ${name}\n`);
  return `Recording started: ${name}`;
}

export function toolStopRecording(state: ServerState): string {
  if (state.activeRecording === null) {
    throw new Error("No active recording session.");
  }
  const name = state.activeRecording;
  state.activeRecording = null;
  const events = state.pendingEvents;
  state.pendingEvents = [];

  const filePath = state.trajectoryPath(name);
  saveTrajectory(filePath, { events });
  const count = events.length;
  process.stderr.write(`Recording stopped: ${name} (${count} events) -> ${filePath}\n`);
  return `Recording '${name}' saved with ${count} event(s) at ${filePath}`;
}

export function toolRecordEvent(args: Record<string, unknown>, state: ServerState): string {
  if (!("request" in args)) {
    throw new Error("Missing parameter: request");
  }
  if (!("response" in args)) {
    throw new Error("Missing parameter: response");
  }
  if (state.activeRecording === null) {
    throw new Error("No active recording session. Call start_recording first.");
  }
  const event: TrajectoryEvent = {
    recorded_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    request: args["request"],
    response: args["response"],
  };
  state.pendingEvents.push(event);
  const count = state.pendingEvents.length;
  return `Event recorded (total in session: ${count})`;
}

export function toolReplayLookup(args: Record<string, unknown>, state: ServerState): string {
  const trajectoryName = args["trajectory"];
  if (typeof trajectoryName !== "string" || !trajectoryName) {
    throw new Error("Missing or non-string parameter: trajectory");
  }
  if (!("request" in args)) {
    throw new Error("Missing parameter: request");
  }
  const request = args["request"];
  const filePath = state.trajectoryPath(trajectoryName);

  if (!fs.existsSync(filePath)) {
    throw new Error(`Trajectory not found: ${trajectoryName}`);
  }

  const traj = loadTrajectory(filePath);
  const canonical = canonicalRequest(request);

  for (const event of traj.events) {
    if (canonicalRequest(event.request) === canonical) {
      return JSON.stringify({
        matched: true,
        response: event.response,
        recorded_at: event.recorded_at,
      });
    }
  }

  return JSON.stringify({
    matched: false,
    reason: "No recorded response matches the given request",
  });
}

export function toolListTrajectories(state: ServerState): string {
  const dataDir = state.dataDir;

  if (!fs.existsSync(dataDir)) {
    return JSON.stringify({ trajectories: [] });
  }

  const entries: Array<{ name: string; event_count: number; path: string }> = [];
  for (const entry of fs.readdirSync(dataDir)) {
    if (!entry.endsWith(".json")) continue;
    const filePath = path.join(dataDir, entry);
    const name = entry.slice(0, -5);
    let eventCount = 0;
    try {
      const traj = loadTrajectory(filePath);
      eventCount = traj.events.length;
    } catch {
      // leave count at 0 if the file is unreadable
    }
    entries.push({ name, event_count: eventCount, path: filePath });
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));
  return JSON.stringify({ trajectories: entries });
}

// ---------------------------------------------------------------------------
// Tool list (MCP schema)
// ---------------------------------------------------------------------------

export const TOOL_LIST = [
  {
    name: "start_recording",
    description:
      "Begin a named recording session. All subsequent record_event calls accumulate into this session until stop_recording is called.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Unique name for the trajectory (used as the file stem)",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "stop_recording",
    description: "Flush the active recording session to disk and close it.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "record_event",
    description: "Append a request/response pair to the currently active recording session.",
    inputSchema: {
      type: "object",
      properties: {
        request: {
          type: "object",
          description: "The tool-call request (JSON object)",
        },
        response: {
          type: "object",
          description: "The response received for that request (JSON object)",
        },
      },
      required: ["request", "response"],
    },
  },
  {
    name: "replay_lookup",
    description:
      "Given a trajectory name and a request, return the recorded response. Reports matched:true with the response, or matched:false if no recording matches.",
    inputSchema: {
      type: "object",
      properties: {
        trajectory: {
          type: "string",
          description: "Name of the trajectory to search",
        },
        request: {
          type: "object",
          description: "The request to look up (compared by method + params, id is ignored)",
        },
      },
      required: ["trajectory", "request"],
    },
  },
  {
    name: "list_trajectories",
    description:
      "List all trajectory files in the data directory, with their names and event counts.",
    inputSchema: { type: "object", properties: {} },
  },
];

// ---------------------------------------------------------------------------
// JSON-RPC helpers
// ---------------------------------------------------------------------------

function rpcError(id: unknown, code: number, message: string): object {
  return { jsonrpc: "2.0", error: { code, message }, id };
}

// ---------------------------------------------------------------------------
// Request dispatch
// ---------------------------------------------------------------------------

function dispatchTool(name: string, args: Record<string, unknown>, state: ServerState): string {
  switch (name) {
    case "start_recording":
      return toolStartRecording(args, state);
    case "stop_recording":
      return toolStopRecording(state);
    case "record_event":
      return toolRecordEvent(args, state);
    case "replay_lookup":
      return toolReplayLookup(args, state);
    case "list_trajectories":
      return toolListTrajectories(state);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export function handleRequest(req: Record<string, unknown>, state: ServerState): object | null {
  const id = req["id"] ?? null;
  const method = req["method"];

  if (typeof method !== "string") {
    return rpcError(id, -32600, "Invalid Request: missing method");
  }

  switch (method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "shack-session-replay", version: "0.1.0" },
        },
        id,
      };

    case "notifications/initialized":
      return null;

    case "tools/list":
      return { jsonrpc: "2.0", result: { tools: TOOL_LIST }, id };

    case "tools/call": {
      const params = (req["params"] as Record<string, unknown>) ?? {};
      const toolName = params["name"];
      if (typeof toolName !== "string") {
        return rpcError(id, -32602, "Invalid Params: missing tool name");
      }
      const args = (params["arguments"] as Record<string, unknown>) ?? {};
      try {
        const content = dispatchTool(toolName, args, state);
        return {
          jsonrpc: "2.0",
          result: { content: [{ type: "text", text: content }] },
          id,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Tool ${toolName} failed: ${message}\n`);
        return rpcError(id, -32603, message);
      }
    }

    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}
