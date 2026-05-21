/**
 * Tests for the session-replay server core logic.
 *
 * Covers success paths, error paths, boundary conditions, and helpers for all
 * five MCP tools and the JSON-RPC dispatch layer.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ServerState,
  canonicalRequest,
  handleRequest,
  loadTrajectory,
  saveTrajectory,
  toolListTrajectories,
  toolRecordEvent,
  toolReplayLookup,
  toolStartRecording,
  toolStopRecording,
} from "./server.js";

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "traj-test-"));
}

function makeState(dir: string): ServerState {
  return new ServerState(dir);
}

// ---------------------------------------------------------------------------
// Success paths
// ---------------------------------------------------------------------------

test("record then replay returns response", () => {
  const dir = makeTmpDir();
  const state = makeState(dir);

  const result = toolStartRecording({ name: "run1" }, state);
  expect(result).toContain("run1");

  const req = { method: "tools/call", params: { name: "search", arguments: { q: "hello" } } };
  const resp = { result: { hits: ["a", "b"] } };
  toolRecordEvent({ request: req, response: resp }, state);

  toolStopRecording(state);

  // Replay with same request but different id — id is stripped before matching.
  const lookupReq = {
    method: "tools/call",
    params: { name: "search", arguments: { q: "hello" } },
    id: 99,
  };
  const raw = toolReplayLookup({ trajectory: "run1", request: lookupReq }, state);
  const parsed = JSON.parse(raw);
  expect(parsed.matched).toBe(true);
  expect(parsed.response.result.hits[0]).toBe("a");
});

test("replay unrecorded request reports no match", () => {
  const dir = makeTmpDir();
  const state = makeState(dir);

  toolStartRecording({ name: "run2" }, state);
  toolRecordEvent(
    { request: { method: "foo", params: { x: 1 } }, response: { result: "yes" } },
    state
  );
  toolStopRecording(state);

  const raw = toolReplayLookup(
    { trajectory: "run2", request: { method: "bar", params: { x: 1 } } },
    state
  );
  const parsed = JSON.parse(raw);
  expect(parsed.matched).toBe(false);
});

test("trajectory round trip", () => {
  const dir = makeTmpDir();
  const state = makeState(dir);

  toolStartRecording({ name: "alpha" }, state);
  toolRecordEvent({ request: { method: "ping" }, response: { result: "pong" } }, state);
  toolStopRecording(state);

  const filePath = state.trajectoryPath("alpha");
  expect(fs.existsSync(filePath)).toBe(true);
  const traj = loadTrajectory(filePath);
  expect(traj.events).toHaveLength(1);
  expect(traj.events[0].request).toEqual({ method: "ping" });
  expect(traj.events[0].response).toEqual({ result: "pong" });
});

test("list trajectories empty", () => {
  const dir = makeTmpDir();
  const state = makeState(dir);
  const raw = toolListTrajectories(state);
  const parsed = JSON.parse(raw);
  expect(parsed.trajectories).toEqual([]);
});

test("list trajectories shows files", () => {
  const dir = makeTmpDir();
  const state = makeState(dir);

  toolStartRecording({ name: "alpha" }, state);
  toolRecordEvent({ request: { method: "x" }, response: { result: 1 } }, state);
  toolStopRecording(state);

  const raw = toolListTrajectories(state);
  const parsed = JSON.parse(raw);
  expect(parsed.trajectories).toHaveLength(1);
  expect(parsed.trajectories[0].name).toBe("alpha");
  expect(parsed.trajectories[0].event_count).toBe(1);
});

test("multiple events in a session are all persisted", () => {
  const dir = makeTmpDir();
  const state = makeState(dir);

  toolStartRecording({ name: "multi" }, state);
  for (let i = 0; i < 5; i++) {
    toolRecordEvent(
      { request: { method: "call", params: { n: i } }, response: { result: i * 2 } },
      state
    );
  }
  toolStopRecording(state);

  const traj = loadTrajectory(state.trajectoryPath("multi"));
  expect(traj.events).toHaveLength(5);
  expect((traj.events[4].response as { result: number }).result).toBe(8);
});

test("stop recording with no events writes an empty trajectory", () => {
  const dir = makeTmpDir();
  const state = makeState(dir);
  toolStartRecording({ name: "empty" }, state);
  toolStopRecording(state);
  const traj = loadTrajectory(state.trajectoryPath("empty"));
  expect(traj.events).toHaveLength(0);
});

test("replay returns first match when the same request appears twice", () => {
  const dir = makeTmpDir();
  const state = makeState(dir);
  toolStartRecording({ name: "dup" }, state);
  const req = { method: "ping" };
  toolRecordEvent({ request: req, response: { result: "first" } }, state);
  toolRecordEvent({ request: req, response: { result: "second" } }, state);
  toolStopRecording(state);

  const raw = toolReplayLookup({ trajectory: "dup", request: { method: "ping" } }, state);
  const parsed = JSON.parse(raw);
  expect(parsed.matched).toBe(true);
  expect((parsed.response as { result: string }).result).toBe("first");
});

test("list trajectories returns entries sorted alphabetically", () => {
  const dir = makeTmpDir();
  const state = makeState(dir);
  for (const name of ["gamma", "beta", "alpha"]) {
    toolStartRecording({ name }, state);
    toolRecordEvent({ request: { method: "x" }, response: { r: 1 } }, state);
    toolStopRecording(state);
  }
  const parsed = JSON.parse(toolListTrajectories(state));
  const names = (parsed.trajectories as Array<{ name: string }>).map((e) => e.name);
  expect(names).toEqual(["alpha", "beta", "gamma"]);
});

test("list trajectories ignores non-.json files", () => {
  const dir = makeTmpDir();
  fs.writeFileSync(path.join(dir, "notes.txt"), "not a trajectory");
  const state = makeState(dir);
  const parsed = JSON.parse(toolListTrajectories(state));
  expect(parsed.trajectories).toEqual([]);
});

// ---------------------------------------------------------------------------
// Error paths
// ---------------------------------------------------------------------------

test("start recording while active fails", () => {
  const dir = makeTmpDir();
  const state = makeState(dir);
  toolStartRecording({ name: "s1" }, state);
  expect(() => toolStartRecording({ name: "s2" }, state)).toThrow();
});

test("stop recording without start fails", () => {
  const dir = makeTmpDir();
  const state = makeState(dir);
  expect(() => toolStopRecording(state)).toThrow();
});

test("record event without start fails", () => {
  const dir = makeTmpDir();
  const state = makeState(dir);
  expect(() =>
    toolRecordEvent({ request: { method: "x" }, response: {} }, state)
  ).toThrow();
});

test("start recording with missing name throws", () => {
  const dir = makeTmpDir();
  const state = makeState(dir);
  expect(() => toolStartRecording({}, state)).toThrow(/name/);
});

test("start recording with non-string name throws", () => {
  const dir = makeTmpDir();
  const state = makeState(dir);
  expect(() => toolStartRecording({ name: 123 }, state)).toThrow();
});

test("start recording with empty name throws", () => {
  const dir = makeTmpDir();
  const state = makeState(dir);
  expect(() => toolStartRecording({ name: "" }, state)).toThrow();
});

test("record event missing request throws", () => {
  const dir = makeTmpDir();
  const state = makeState(dir);
  toolStartRecording({ name: "s" }, state);
  expect(() => toolRecordEvent({ response: { r: 1 } }, state)).toThrow(/request/);
});

test("record event missing response throws", () => {
  const dir = makeTmpDir();
  const state = makeState(dir);
  toolStartRecording({ name: "s" }, state);
  expect(() => toolRecordEvent({ request: { method: "x" } }, state)).toThrow(/response/);
});

test("replay lookup with missing trajectory throws", () => {
  const dir = makeTmpDir();
  const state = makeState(dir);
  expect(() => toolReplayLookup({ request: { method: "x" } }, state)).toThrow(/trajectory/);
});

test("replay lookup with missing request throws", () => {
  const dir = makeTmpDir();
  const state = makeState(dir);
  expect(() => toolReplayLookup({ trajectory: "t1" }, state)).toThrow(/request/);
});

test("replay lookup for nonexistent trajectory throws", () => {
  const dir = makeTmpDir();
  const state = makeState(dir);
  expect(() =>
    toolReplayLookup({ trajectory: "no_such", request: { method: "x" } }, state)
  ).toThrow(/Trajectory not found/);
});

// ---------------------------------------------------------------------------
// Helper tests
// ---------------------------------------------------------------------------

test("canonical request strips id", () => {
  const req = { jsonrpc: "2.0", method: "foo", params: { a: 1 }, id: 42 };
  const canon = JSON.parse(canonicalRequest(req));
  expect(canon.id).toBeUndefined();
  expect(canon.method).toBe("foo");
});

test("canonical request passes non-object through unchanged", () => {
  expect(canonicalRequest([1, 2, 3])).toBe("[1,2,3]");
  expect(canonicalRequest("hello")).toBe('"hello"');
});

test("saveTrajectory creates parent directories", () => {
  const base = makeTmpDir();
  const nested = path.join(base, "a", "b", "traj.json");
  saveTrajectory(nested, { events: [] });
  expect(fs.existsSync(nested)).toBe(true);
});

test("loadTrajectory round-trips event data", () => {
  const dir = makeTmpDir();
  const filePath = path.join(dir, "t.json");
  const events = [{ recorded_at: "2024-01-01T00:00:00Z", request: { m: "ping" }, response: { r: "pong" } }];
  saveTrajectory(filePath, { events });
  const traj = loadTrajectory(filePath);
  expect(traj.events).toEqual(events);
});

test("loadTrajectory throws on invalid JSON", () => {
  const dir = makeTmpDir();
  const filePath = path.join(dir, "bad.json");
  fs.writeFileSync(filePath, "{ not json {{{{");
  expect(() => loadTrajectory(filePath)).toThrow();
});

// ---------------------------------------------------------------------------
// JSON-RPC dispatch tests
// ---------------------------------------------------------------------------

test("handleRequest initialize returns protocol version and server info", () => {
  const dir = makeTmpDir();
  const state = makeState(dir);
  const resp = handleRequest({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, state) as Record<string, unknown>;
  expect(resp).not.toBeNull();
  const result = resp["result"] as Record<string, unknown>;
  expect(result["protocolVersion"]).toBe("2024-11-05");
  const info = result["serverInfo"] as Record<string, unknown>;
  expect(info["name"]).toBe("shack-session-replay");
});

test("handleRequest tools/list returns all five tool names", () => {
  const dir = makeTmpDir();
  const state = makeState(dir);
  const resp = handleRequest({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, state) as Record<string, unknown>;
  const result = resp["result"] as Record<string, unknown>;
  const tools = result["tools"] as Array<{ name: string }>;
  const names = tools.map((t) => t.name);
  for (const expected of ["start_recording", "stop_recording", "record_event", "replay_lookup", "list_trajectories"]) {
    expect(names).toContain(expected);
  }
});

test("handleRequest notifications/initialized returns null", () => {
  const dir = makeTmpDir();
  const state = makeState(dir);
  const resp = handleRequest({ jsonrpc: "2.0", method: "notifications/initialized" }, state);
  expect(resp).toBeNull();
});

test("handleRequest unknown method returns -32601 error", () => {
  const dir = makeTmpDir();
  const state = makeState(dir);
  const resp = handleRequest({ jsonrpc: "2.0", id: 9, method: "no_such" }, state) as Record<string, unknown>;
  const error = resp["error"] as Record<string, unknown>;
  expect(error["code"]).toBe(-32601);
});

test("handleRequest missing method returns -32600 error", () => {
  const dir = makeTmpDir();
  const state = makeState(dir);
  const resp = handleRequest({ jsonrpc: "2.0", id: 10 }, state) as Record<string, unknown>;
  const error = resp["error"] as Record<string, unknown>;
  expect(error["code"]).toBe(-32600);
});

test("handleRequest tool error returns -32603 error", () => {
  const dir = makeTmpDir();
  const state = makeState(dir);
  // stop_recording with no active session triggers an error.
  const resp = handleRequest(
    { jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "stop_recording", arguments: {} } },
    state
  ) as Record<string, unknown>;
  const error = resp["error"] as Record<string, unknown>;
  expect(error["code"]).toBe(-32603);
});

test("handleRequest unknown tool name returns -32603 error", () => {
  const dir = makeTmpDir();
  const state = makeState(dir);
  const resp = handleRequest(
    { jsonrpc: "2.0", id: 12, method: "tools/call", params: { name: "no_such_tool", arguments: {} } },
    state
  ) as Record<string, unknown>;
  const error = resp["error"] as Record<string, unknown>;
  expect(error["code"]).toBe(-32603);
});
