# shack-session-replay

An MCP server that records agent tool-call trajectories and replays recorded responses for deterministic regression testing.

Speaks JSON-RPC 2.0 over stdio: STDOUT carries only protocol messages; all logs go to STDERR.

## MCP tools

| Tool | Description |
|---|---|
| `start_recording` | Begin a named recording session. Subsequent `record_event` calls accumulate into this session until `stop_recording` is called. |
| `stop_recording` | Flush the active recording session to disk and close it. |
| `record_event` | Append a request/response pair to the currently active recording session. |
| `replay_lookup` | Given a trajectory name and a request, return the recorded response (`matched: true`) or report no match (`matched: false`). Matching ignores the `id` field. |
| `list_trajectories` | List all trajectory files in the data directory, with their names and event counts. |

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

The `--data-dir` flag (short: `-d`) sets the directory for trajectory JSON files. Defaults to `trajectories` relative to the working directory. Reads JSON-RPC 2.0 requests from stdin (one per line) and writes responses to stdout.

## Test

```sh
npm test
```
