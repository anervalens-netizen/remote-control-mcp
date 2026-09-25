# Secret Broker

Purpose: keep raw secret bytes out of ChatGPT/MCP tool arguments and results while preserving full owner-controlled capability.

The broker is additive. Raw `exec`, `fs_read`, `fs_write`, root/SYSTEM access and direct file transfer remain available.

## Local ingestion

Run locally on the server that hosts the central MCP:

```bash
node deploy/secrets/rcmcp-secret.ts put openai_api_key
```

The TTY value is entered with echo disabled. For multiline/binary material:

```bash
node deploy/secrets/rcmcp-secret.ts put signing_key --file /local/path/to/key
cat /local/path/to/key | node deploy/secrets/rcmcp-secret.ts put signing_key
```

Only metadata is printed (`alias`, `present`, byte count, update time). Secret bytes are stored under `RCMCP_SECRET_DIR` or, by default, `~/.config/remote-control-mcp/secrets`, using hashed alias directories and mode `0700/0600` on POSIX.

Local inspection/removal:

```bash
node deploy/secrets/rcmcp-secret.ts status openai_api_key
node deploy/secrets/rcmcp-secret.ts list
node deploy/secrets/rcmcp-secret.ts delete openai_api_key
```

## MCP operations

- `secret_status` — metadata only.
- `secret_list` — aliases + metadata only.
- `secret_import_file` — reads a file from a remote owner/root endpoint internally and stores it as an alias. Raw bytes are not returned by the MCP tool.
- `secret_install` — atomically installs an alias to any remote path as `root` or `owner`.
- `secret_template_render` — renders `{{secret:alias}}` or `{{secret_base64:alias}}` internally and atomically installs the rendered file.
- `secret_rotate` — replaces one alias from another alias internally.
- `secret_delete` — deletes a broker alias.

Remote writes use sibling staging files and activate with the existing recoverable filesystem move semantics. The model receives only alias/path/byte-count/status metadata.
