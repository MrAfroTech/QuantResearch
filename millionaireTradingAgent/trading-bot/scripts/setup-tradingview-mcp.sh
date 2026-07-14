#!/bin/bash
set -euo pipefail

# Clone and install TradingView MCP, then register it for Cursor (not Claude Code).
TV_MCP_DIR="${TV_MCP_ROOT:-$HOME/tradingview-mcp}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$BOT_DIR/../.." && pwd)"

if [ ! -d "$TV_MCP_DIR/.git" ]; then
  git clone https://github.com/tradesdontlie/tradingview-mcp "$TV_MCP_DIR"
fi

cd "$TV_MCP_DIR"
npm install

SERVER_ENTRY=""
for candidate in "$TV_MCP_DIR/src/server.js" "$TV_MCP_DIR/index.js"; do
  if [ -f "$candidate" ]; then
    SERVER_ENTRY="$candidate"
    break
  fi
done

if [ -z "$SERVER_ENTRY" ]; then
  echo "ERROR: Could not find TradingView MCP server entry (src/server.js or index.js)"
  exit 1
fi

write_mcp_json() {
  local target_dir="$1"
  mkdir -p "$target_dir"
  cat > "$target_dir/mcp.json" <<EOF
{
  "mcpServers": {
    "tradingview": {
      "command": "node",
      "args": ["$SERVER_ENTRY"]
    }
  }
}
EOF
  echo "  → $target_dir/mcp.json"
}

echo ""
echo "Writing Cursor MCP config to:"
write_mcp_json "$BOT_DIR/.cursor"
write_mcp_json "$REPO_ROOT/.cursor"
write_mcp_json "$HOME/.cursor"

echo ""
echo "TradingView MCP installed at: $TV_MCP_DIR"
echo ""
echo "Next steps:"
echo "  1. Reload Cursor: Cmd+Shift+P → Developer: Reload Window"
echo "  2. Open Settings → MCP — \"tradingview\" should appear"
echo "  3. Launch TradingView Desktop:"
echo "     open -a TradingView --args --remote-debugging-port=9222"
echo "  4. Open a real chart tab (not the welcome screen)"
echo "  5. In Cursor chat, ask the agent to run tv_health_check (cdp_connected: true)"
echo ""
echo "Note: Cursor reads .cursor/mcp.json from your workspace root."
echo "      This script writes configs for trading-bot, QuantResearch repo root, and ~/.cursor."
