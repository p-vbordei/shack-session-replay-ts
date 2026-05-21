/**
 * Core server logic: JSON-RPC 2.0 dispatch and tool implementations.
 *
 * This module owns all stateful logic for shack-session-replay:
 * - {@link ServerState} holds the in-memory recording state.
 * - {@link loadTrajectory} / {@link saveTrajectory} persist trajectory files.
 * - Five `tool*` functions implement the MCP tools.
 * - {@link handleRequest} is the top-level JSON-RPC dispatcher.
 *
 * All tool functions are pure (no global state) and accept a {@link ServerState}
 * argument so they can be tested in isolation.
 */

import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

/** A single recorded request/response pair. */
export interface TrajectoryEvent {
  /** ISO-8601 timestamp of when the event was captured. */
  recorded_at: string;
  /** The outgoing tool-call request (method + params; id not required). */
  request: unknown;
  /** The response received for that request. */
  response: unknown;
}

/** The persisted file format: an object with an `events` array. */
export interface Trajectory {
  events: TrajectoryEvent[];
}

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

/**
 * Read a trajectory JSON file from disk and return it.
 *
 * @throws If the file does not exist or contains invalid JSON.
 */
export function loadTrajectory(filePath: string): Trajectory {
  const text = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(text) as Trajectory;
}

/**
 * Persist a trajectory to disk, creating intermediate directories as needed.
 *
 * The file is written as pretty-printed JSON.
 */
export function saveTrajectory(filePath: string, traj: Trajectory): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(traj, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// Server state
// ---------------------------------------------------------------------------

/**
 * Runtime state shared across all request handlers.
 *
 * A single `ServerState` instance lives for the lifetime of the process.
 * Because the stdio loop is single-threaded in Node.js, no locking is needed.
 */
export class ServerState {
  /** Root directory where trajectory JSON files are stored. */
  dataDir: string;
  /** Name of the open recording session, or `null` when idle. */
  activeRecording: string | null = null;
  /** Events accumulated since the last `start_recording`; flushed by `stop_recording`. */
  pendingEvents: TrajectoryEvent[] = [];

  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  /** Return the file path where the named trajectory is stored. */
  trajectoryPath(name: string): string {
    return path.join(this.dataDir, `${name}.json`);
  }
}

// ---------------------------------------------------------------------------
// Canonical request (strips `id` for comparison)
// ---------------------------------------------------------------------------

/**
 * Serialize `req` to a canonical JSON string with the `id` field removed.
 *
 * Stripping `id` before comparison lets {@link toolReplayLookup} match the
 * same logical call regardless of the call-site identifier assigned by the
 * client.  Non-object values (arrays, primitives) are serialized unchanged.
 */
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

/**
 * Open a new named recording session.
 *
 * Subsequent {@link toolRecordEvent} calls accumulate into this session until
 * {@link toolStopRecording} closes it.
 *
 * @throws {Error} If `name` is missing, non-string, or empty.
 * @throws {Error} If another session is already active.
 */
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

/**
 * Flush the active session to disk and clear it.
 *
 * @throws {Error} If no session is currently active.
 */
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

/**
 * Append a request/response pair to the active recording session.
 *
 * @throws {Error} If `request` or `response` is absent.
 * @throws {Error} If no session is active.
 */
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

/**
 * Return the recorded response for a given request in a named trajectory.
 *
 * Matching strips the `id` field before comparing so the same logical call
 * always resolves regardless of call-site id.  The first matching event wins.
 *
 * @returns JSON string: `{"matched":true,"response":...,"recorded_at":"..."}` on a
 *   hit, or `{"matched":false,"reason":"..."}` when no event matches.
 * @throws {Error} If `trajectory` or `request` is missing/invalid.
 * @throws {Error} If the trajectory file does not exist.
 */
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

/**
 * List all trajectory files in the data directory.
 *
 * Non-`.json` files are ignored.  Unreadable files are included with an
 * event count of 0.  Results are sorted alphabetically by name.
 *
 * @returns JSON string: `{"trajectories":[{"name":"...","event_count":N,"path":"..."},...]}`.
 */
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
