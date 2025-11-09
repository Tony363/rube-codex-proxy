# Rube ↔ Codex MCP Proxy

This Node-based shim lets OpenAI Codex CLI talk to Composio’s Rube MCP server without triggering Codex’s stricter tool-schema validation. Codex sees plain string-based tools, while the proxy forwards JSON payloads to Rube unchanged.

## Quick Install
```bash
cd rube-codex-proxy
bash install.sh
```
The script will:
1. Install local npm dependencies for the proxy.
2. Add/update the `[mcp_servers.rube]` entry in `~/.codex/config.toml` (leaving the rest untouched).
3. Launch the proxy once so you can complete the LinkUp OAuth prompt; it finishes only after Rube tools are reachable.

After it succeeds, open `codex` and run `/mcp` to confirm the Rube tools are listed.

## Manual Steps (if you need to do things by hand)
1. `cd scripts/rube-codex-proxy && npm install`
2. Edit `~/.codex/config.toml`:
   ```toml
   [mcp_servers.rube]
   command = "/absolute/path/to/scripts/rube-codex-proxy/bin/rube-codex-proxy.js"
   args = []
   startup_timeout_seconds = 120
   ```
3. Start the proxy once manually to trigger authentication:
   ```bash
   node --input-type=module <<'JS'
   import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
   import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
   const transport = new StdioClientTransport({
     command: '/absolute/path/to/scripts/rube-codex-proxy/bin/rube-codex-proxy.js',
     args: [],
     stderr: 'pipe',
   });
   const client = new McpClient({ name: 'manual-check', version: '0.0.1' }, { capabilities: { tools: {}, logging: {} } });
   if (transport.stderr) transport.stderr.on('data', (chunk) => process.stderr.write(chunk));
   await client.connect(transport);
   const { tools } = await client.listTools();
   console.log(`Detected ${tools.length} Rube tool(s)`);
   await client.close();
   JS
   ```

## How It Works
- The proxy spawns `npx -y mcp-remote@0.1.29 https://rube.app/mcp`.
- It mirrors every upstream tool into Codex with a single string argument (`args_json`).
- Tool calls JSON-parse `args_json`, forward to Rube, and stream responses back.

## Troubleshooting
- **Login prompt keeps appearing**: Delete `~/.mcp-auth/mcp-remote-0.1.29/` and re-run the install script to authorize again.
- **Codex says tools timed out**: Ensure `npm install` finished successfully and `~/.codex/config.toml` points to the correct absolute path.
- **Engine warning from `undici`**: Upgrade Node.js to ≥20.18.1 when convenient.
- **Proxy logs**: Look for `[rube-codex-proxy]` (proxy) and `[mcp-remote]` (upstream) in stderr; Codex’s own logs live in `~/.codex/log/`.

## Resetting
To recreate a “fresh developer” state:
```bash
rm -rf scripts/rube-codex-proxy/node_modules
rm -rf ~/.mcp-auth/mcp-remote-0.1.29
python3 - <<'PY'
from pathlib import Path
import re
path = Path.home() / '.codex' / 'config.toml'
text = path.read_text()
pattern = re.compile(r"\n?\[mcp_servers\.rube\][\s\S]*?(?=\n\[|\Z)")
path.write_text(pattern.sub('\n', text))
PY
```
Then run the install script again.
