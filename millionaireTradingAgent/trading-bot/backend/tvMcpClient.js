import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import os from 'os';

const execFileAsync = promisify(execFile);

let mcpClient = null;
let mcpConnecting = null;

function getMcpRoot() {
  return process.env.TV_MCP_ROOT || path.join(os.homedir(), 'tradingview-mcp');
}

function resolveServerPath() {
  if (process.env.TV_MCP_SERVER) return process.env.TV_MCP_SERVER;

  const root = getMcpRoot();
  const candidates = [
    path.join(root, 'index.js'),
    path.join(root, 'src', 'server.js'),
  ];
  return candidates.find((p) => fs.existsSync(p)) || candidates[1];
}

function resolveCliPath() {
  if (process.env.TV_MCP_CLI) return process.env.TV_MCP_CLI;

  const root = getMcpRoot();
  const candidates = [
    path.join(root, 'src', 'cli', 'index.js'),
    path.join(root, 'index.js'),
  ];
  return candidates.find((p) => fs.existsSync(p)) || candidates[0];
}

function parseToolPayload(result) {
  if (result == null) return null;
  if (typeof result === 'object' && !Array.isArray(result) && result.content == null) {
    return result;
  }

  const text = result.content?.find((c) => c.type === 'text')?.text;
  if (!text) return result;

  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function getMcpClient() {
  if (mcpClient) return mcpClient;
  if (!mcpConnecting) {
    mcpConnecting = (async () => {
      const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
      const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');

      const serverPath = resolveServerPath();
      const transport = new StdioClientTransport({
        command: 'node',
        args: [serverPath],
      });

      const client = new Client(
        { name: 'trading-bot', version: '1.0.0' },
        { capabilities: {} }
      );
      await client.connect(transport);
      mcpClient = client;
      return client;
    })().catch((err) => {
      mcpConnecting = null;
      throw err;
    });
  }
  return mcpConnecting;
}

async function callToolViaCli(toolName, args = {}) {
  const cliPath = resolveCliPath();
  if (!fs.existsSync(cliPath)) {
    throw new Error(`TradingView MCP CLI not found at ${cliPath}`);
  }

  const { stdout } = await execFileAsync(
    'node',
    [cliPath, toolName, JSON.stringify(args)],
    { timeout: 120000, env: process.env, maxBuffer: 10 * 1024 * 1024 }
  );

  const trimmed = stdout.trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    return { raw: trimmed };
  }
}

export async function callTvTool(toolName, args = {}) {
  try {
    const client = await getMcpClient();
    const result = await client.callTool({ name: toolName, arguments: args });
    return parseToolPayload(result);
  } catch (mcpErr) {
    try {
      return await callToolViaCli(toolName, args);
    } catch (cliErr) {
      throw new Error(`${toolName} failed: ${mcpErr.message}; CLI: ${cliErr.message}`);
    }
  }
}
