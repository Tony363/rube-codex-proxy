#!/usr/bin/env node

import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { inspect } from 'node:util';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

const pkgDir = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));

const DEFAULT_REMOTE_URL = 'https://rube.app/mcp';
const DEFAULT_REMOTE_VERSION = '0.1.29';

const remoteUrl = process.env.RUBE_REMOTE_URL ?? DEFAULT_REMOTE_URL;
const remoteCmd = process.env.RUBE_REMOTE_COMMAND ?? 'npx';
const remoteVersion = process.env.RUBE_REMOTE_VERSION ?? DEFAULT_REMOTE_VERSION;
const remoteArgs = process.env.RUBE_REMOTE_ARGS
  ? parseArgsEnv(process.env.RUBE_REMOTE_ARGS)
  : ['-y', `mcp-remote@${remoteVersion}`, remoteUrl];
const remoteCwd = process.env.RUBE_REMOTE_CWD ?? pkgDir;

const proxyName = process.env.RUBE_PROXY_NAME ?? 'rube-codex-proxy';
const proxyVersion = process.env.RUBE_PROXY_VERSION ?? '0.1.0';

const schemaPreviewLimit = Number(process.env.RUBE_SCHEMA_PREVIEW_LIMIT ?? '6000');

const log = (level, message, meta) => {
  const payload = meta ? `${message} ${inspect(meta, { depth: 4 })}` : message;
  process.stderr.write(`[${proxyName}] ${level.toUpperCase()}: ${payload}\n`);
};

function parseArgsEnv(value) {
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) {
      return parsed;
    }
  } catch (error) {
    log('warning', 'Failed to parse RUBE_REMOTE_ARGS; falling back to whitespace split', error);
  }
  return value.split(/\s+/).filter(Boolean);
}

function summariseSchema(schema) {
  if (!schema) return 'Remote tool reports no input schema (arguments optional).';
  try {
    const text = JSON.stringify(schema, null, 2);
    if (text.length <= schemaPreviewLimit) return text;
    return `${text.slice(0, schemaPreviewLimit)}\n... (truncated)`;
  } catch (error) {
    return `Unable to serialise remote schema: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function buildDescription(tool) {
  const lines = [];
  if (tool.title && tool.title !== tool.name) {
    lines.push(`Remote title: ${tool.title}`);
  }
  if (tool.description) {
    lines.push(tool.description.trim());
  }
  lines.push('---');
  lines.push('Codex shim for the Composio Rube tool. Provide JSON arguments in `args_json`. Leave blank for `{}`.');
  lines.push('Original input schema (truncated if large):');
  lines.push(summariseSchema(tool.inputSchema));
  return lines.join('\n');
}

const argsSchema = {
  args_json: z
    .string()
    .trim()
    .describe('JSON payload forwarded to the upstream Rube tool. Leave blank to send `{}`.')
    .optional(),
};

const toolState = new Map();
const remoteToolSchemas = new Map();

async function createRemoteClient() {
  const transport = new StdioClientTransport({
    command: remoteCmd,
    args: remoteArgs,
    cwd: remoteCwd,
    env: {
      ...process.env,
    },
    stderr: 'pipe',
  });

  const client = new McpClient({
    name: `${proxyName}-remote-client`,
    version: proxyVersion,
  }, {
    capabilities: {
      tools: {},
      logging: {},
    },
  });

  if (transport.stderr) {
    transport.stderr.on('data', (chunk) => {
      process.stderr.write(`[mcp-remote] ${chunk}`);
    });
  }

  client.onerror = (error) => {
    log('error', 'Remote client error', error);
  };

  client.onclose = () => {
    log('error', 'Connection to mcp-remote closed unexpectedly. Exiting.');
    process.exit(2);
  };

  await client.connect(transport);
  log('info', `Connected to mcp-remote (${remoteArgs.join(' ')})`);
  return client;
}

async function syncTools(proxy, remote) {
  const { tools } = await remote.listTools();
  const seen = new Set();
  for (const tool of tools) {
    seen.add(tool.name);
    remoteToolSchemas.set(tool.name, tool.inputSchema ?? null);
    const description = buildDescription(tool);
    if (!toolState.has(tool.name)) {
      const handle = proxy.registerTool(tool.name, {
        title: tool.title ?? tool.name,
        description,
        inputSchema: argsSchema,
      }, async ({ args_json }) => invokeRemoteTool(remote, tool.name, args_json));
      toolState.set(tool.name, handle);
    } else {
      const handle = toolState.get(tool.name);
      handle.update({ description, enabled: true });
    }
  }

  for (const [name, handle] of toolState.entries()) {
    if (!seen.has(name)) {
      handle.update({ enabled: false });
    }
  }

  proxy.sendToolListChanged();
  log('debug', `Synced ${tools.length} Rube tools`);
}

async function invokeRemoteTool(remote, name, rawArgs) {
  let parsedArgs;
  const trimmed = rawArgs?.trim();
  if (trimmed) {
    try {
      parsedArgs = JSON.parse(trimmed);
    } catch (error) {
      throw new Error(`Invalid JSON for args_json: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (parsedArgs === undefined) {
    parsedArgs = {};
  }

  log('info', `Forwarding call to ${name}`);
  const result = await remote.callTool({
    name,
    arguments: parsedArgs,
  });
  return result;
}

async function main() {
  const remote = await createRemoteClient();

  const proxy = new McpServer({
    name: proxyName,
    version: proxyVersion,
  }, {
    capabilities: {
      tools: {},
      logging: {},
    },
  });

  proxy.onerror = (error) => {
    log('error', 'Proxy server error', error);
  };

  proxy.onclose = () => {
    log('info', 'Codex disconnected from proxy');
  };

  await syncTools(proxy, remote);

  remote.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
    try {
      await syncTools(proxy, remote);
    } catch (error) {
      log('warning', 'Failed to refresh tool list after remote notification', error);
    }
  });

  const transport = new StdioServerTransport();
  await proxy.connect(transport);
  log('info', 'Proxy ready (stdin/stdout)');
}

main().catch((error) => {
  log('error', 'Fatal proxy error', error);
  process.exit(1);
});
