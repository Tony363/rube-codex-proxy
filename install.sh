#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
PROXY_DIR="$SCRIPT_DIR"
NODE_BIN="$PROXY_DIR/bin/rube-codex-proxy.js"
CONFIG_FILE="$HOME/.codex/config.toml"
TMP_CONFIG="$CONFIG_FILE.tmp.$$"

cd "$PROXY_DIR"

if [ ! -f package-lock.json ]; then
  npm install
else
  npm install --prefer-offline
fi

if [ ! -f "$NODE_BIN" ]; then
  echo "Proxy binary missing at $NODE_BIN" >&2
  exit 1
fi

mkdir -p "$(dirname "$CONFIG_FILE")"
touch "$CONFIG_FILE"

python3 - "$CONFIG_FILE" "$NODE_BIN" >"$TMP_CONFIG" <<'PY'
from __future__ import annotations
import re
import sys
from pathlib import Path

config_path = Path(sys.argv[1])
proxy_bin = sys.argv[2]
block = f"""[mcp_servers.rube]\ncommand = \"{proxy_bin}\"\nargs = []\nstartup_timeout_seconds = 120\n\n"""

text = config_path.read_text() if config_path.exists() else ""

if text and not text.endswith("\n"):
    text += "\n"

if "[mcp_servers]" not in text:
    if text and not text.endswith("\n\n"):
        text += "\n"
    text += "[mcp_servers]\n\n"

pattern = re.compile(r"\[mcp_servers\.rube\][\s\S]*?(?=\n\[|\Z)")
if pattern.search(text):
    text = pattern.sub(block.strip() + "\n\n", text)
else:
    text += block

sys.stdout.write(text)
PY

mv "$TMP_CONFIG" "$CONFIG_FILE"

cat <<'MSG'
Ensuring Rube authentication…
If a LinkUp login URL appears below, open it in a browser and complete the authorization.
The script will finish once the proxy can list tools successfully.
MSG

RUBE_PROXY_BIN="$NODE_BIN" node --input-type=module <<'JS'
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const proxyCommand = process.env.RUBE_PROXY_BIN;
if (!proxyCommand) {
  console.error('RUBE_PROXY_BIN not set');
  process.exit(1);
}

const transport = new StdioClientTransport({
  command: proxyCommand,
  args: [],
  stderr: 'pipe',
});

if (transport.stderr) {
  transport.stderr.on('data', (chunk) => {
    process.stderr.write(chunk);
  });
}

const client = new McpClient({
  name: 'rube-install-check',
  version: '0.0.1',
}, {
  capabilities: {
    tools: {},
    logging: {},
  },
});

client.onerror = (error) => {
  console.error('Proxy client error:', error);
};

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  console.log(`Rube proxy ready. Detected ${tools.length} tool(s).`);
  await client.close();
} catch (error) {
  console.error('Rube proxy verification failed:', error);
  process.exitCode = 1;
}
JS

cat <<'DONE'
Rube MCP proxy installed for Codex.
Next steps:
  1. Launch `codex` (tools should already be available thanks to the verification step).
  2. Use `/mcp` to confirm Rube tools are listed.
DONE
