# shack-session-replay

An MCP server that records agent tool-call trajectories and replays recorded responses for deterministic regression testing.

Speaks JSON-RPC 2.0 over stdio: STDOUT carries only protocol messages; all logs go to STDERR.

## What it does

Agents often call external tools (web search, APIs, databases) whose results are non-deterministic. shack-session-replay lets you capture a complete run — every request and its live response — into a named trajectory file. You can then replay that trajectory later so the agent sees exactly the same responses it received during recording, enabling bit-for-bit reproducible regression tests without hitting live backends.

Workflow:

1. Call `start_recording` to open a named session.
2. For each tool call, call `record_event` with the outgoing request and the live response.
3. Call `stop_recording` to flush the session to a JSON file on disk.
4. In tests, call `replay_lookup` with the trajectory name and a request to retrieve the stored response.

Matching is done on method + params equality; the `id` field is stripped before comparison so the same logical call always resolves regardless of call-site id.

## MCP tools

| Tool | Arguments | Description |
|---|---|---|
| `start_recording` | `name` (string, required) | Begin a named recording session. Fails if one is already active. |
| `stop_recording` | — | Flush the active recording session to disk and close it. |
| `record_event` | `request` (object, required), `response` (object, required) | Append a request/response pair to the currently active recording session. |
| `replay_lookup` | `trajectory` (string, required), `request` (object, required) | Return the first recorded response matching the given request. Reports `matched: true` with the response, or `matched: false` if no recording matches. |
| `list_trajectories` | — | List all trajectory files in the data directory, with names and event counts. |

## Configuration

| Flag | Short | Default | Description |
|---|---|---|---|
| `--data-dir` | `-d` | `trajectories` | Directory where trajectory JSON files are stored. |

## Install

```sh
npm install
```

## Build

```sh
npm run build
```

## Run

```sh
node dist/main.js --data-dir /path/to/trajectories
```

Or, if installed globally:

```sh
shack-session-replay --data-dir /path/to/trajectories
```

The server reads JSON-RPC 2.0 requests from stdin, one per line, and writes responses to stdout.

## Test

```sh
npm test
```

## Usage example

The following shows a complete record-then-replay interaction. Each line sent to stdin is a JSON-RPC 2.0 request; each line received on stdout is its response.

**Stdin:**

```json
{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"start_recording","arguments":{"name":"my_session"}}}
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"record_event","arguments":{"request":{"method":"tools/call","params":{"name":"search","arguments":{"q":"typescript mcp"}}},"response":{"result":{"hits":["doc1","doc2"]}}}}}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"stop_recording","arguments":{}}}
{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"replay_lookup","arguments":{"trajectory":"my_session","request":{"method":"tools/call","params":{"name":"search","arguments":{"q":"typescript mcp"}}}}}}
```

**Stdout:**

```json
{"jsonrpc":"2.0","result":{"content":[{"type":"text","text":"Recording started: my_session"}]},"id":1}
{"jsonrpc":"2.0","result":{"content":[{"type":"text","text":"Event recorded (total in session: 1)"}]},"id":2}
{"jsonrpc":"2.0","result":{"content":[{"type":"text","text":"Recording 'my_session' saved with 1 event(s) at trajectories/my_session.json"}]},"id":3}
{"jsonrpc":"2.0","result":{"content":[{"type":"text","text":"{\"matched\":true,\"response\":{\"result\":{\"hits\":[\"doc1\",\"doc2\"]}},\"recorded_at\":\"...\"}"}]},"id":4}
```
