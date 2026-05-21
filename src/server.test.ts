/**
 * Tests for the session-replay server core logic.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ServerState,
  canonicalRequest,
  loadTrajectory,
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

afterEach(() => {
  // Each test uses its own tmp dir, nothing global to clean.
});

test("record then replay returns response", () => {
  const dir = makeTmpDir();
  const state = makeState(dir);

  const result = toolStartRecording({ name: "run1" }, state);
  expect(result).toContain("run1");

  const req = { method: "tools/call", params: { name: "search", arguments: { q: "hello" } } };
  const resp = { result: { hits: ["a", "b"] } };
  toolRecordEvent({ request: req, response: resp }, state);

  toolStopRecording(state);

  // Replay with same request but different id.
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

test("start recording while active fails", () => {
  const dir = makeTmpDir();
  const state = makeState(dir);
  toolStartRecording({ name: "s1" }, state);
  expect(() => toolStartRecording({ name: "s2" }, state)).toThrow();
});

test("canonical request strips id", () => {
  const req = { jsonrpc: "2.0", method: "foo", params: { a: 1 }, id: 42 };
  const canon = JSON.parse(canonicalRequest(req));
  expect(canon.id).toBeUndefined();
  expect(canon.method).toBe("foo");
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
