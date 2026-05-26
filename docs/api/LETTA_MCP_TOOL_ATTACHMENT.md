# Letta MCP Tool Attachment Guide

## Overview

The Letta PM agents require MCP tools to interact with Legacy and Vibe Kanban. Currently, the Letta Node SDK does not support MCP tool management, so tools must be attached manually via the Letta UI or API.

## Required MCP Tools

Each PM agent needs access to two MCP servers:

1. **Legacy MCP Server** (`http://192.168.50.90:3457/mcp`)
   - Issue management
   - Project queries
   - Status updates

2. **Vibe Kanban MCP Server** (`http://192.168.50.90:9717/mcp`)
   - Task management
   - Board operations
   - Workflow management

## Manual Attachment via Letta UI

### Step 1: Access Letta UI
Navigate to your Letta instance: `https://letta2.oculair.ca`

### Step 2: Register MCP Servers (One-time setup)
1. Go to **Settings** → **MCP Servers**
2. Click **Add MCP Server**
3. Add Legacy MCP:
   - Name: `legacy-mcp`
   - Transport: `HTTP`
   - URL: `http://192.168.50.90:3457/mcp`
4. Add Vibe MCP:
   - Name: `vibe-mcp`
   - Transport: `HTTP`
   - URL: `http://192.168.50.90:9717/mcp`

### Step 3: Attach Tools to Each Agent
For each agent (e.g., `Legacy-VIBEK-PM`):
1. Navigate to **Agents** → Select the agent
2. Go to **Tools** tab
3. Click **Attach Tool**
4. Select `legacy-mcp` from the list
5. Click **Attach Tool** again
6. Select `vibe-mcp` from the list
7. Save changes

## Manual Attachment via API

You can also attach tools programmatically using the Letta API:

```bash
# Set your Letta credentials
export LETTA_API_URL="http://letta2.oculair.ca/v1"
export LETTA_TOKEN="lettaSecurePass123"

# First, create/register the MCP servers (one-time)
curl -X POST "${LETTA_API_URL}/tools/mcp/servers" \
  -H "Authorization: Bearer ${LETTA_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "legacy-mcp",
    "transport": "http",
    "url": "http://192.168.50.90:3457/mcp"
  }'

curl -X POST "${LETTA_API_URL}/tools/mcp/servers" \
  -H "Authorization: Bearer ${LETTA_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "vibe-mcp",
    "transport": "http",
    "url": "http://192.168.50.90:9717/mcp"
  }'

# Then attach tools to an agent
# Get the tool IDs first
LEGACY_TOOL_ID=$(curl -s "${LETTA_API_URL}/tools?name=legacy-mcp" \
  -H "Authorization: Bearer ${LETTA_TOKEN}" | jq -r '.[0].id')

VIBE_TOOL_ID=$(curl -s "${LETTA_API_URL}/tools?name=vibe-mcp" \
  -H "Authorization: Bearer ${LETTA_TOKEN}" | jq -r '.[0].id')

# Attach to agent (replace AGENT_ID)
AGENT_ID="agent-xxxxx"

curl -X POST "${LETTA_API_URL}/agents/${AGENT_ID}/tools/${LEGACY_TOOL_ID}/attach" \
  -H "Authorization: Bearer ${LETTA_TOKEN}"

curl -X POST "${LETTA_API_URL}/agents/${AGENT_ID}/tools/${VIBE_TOOL_ID}/attach" \
  -H "Authorization: Bearer ${LETTA_TOKEN}"
```

## Verification

To verify tools are attached:

```bash
# List tools for an agent
curl "${LETTA_API_URL}/agents/${AGENT_ID}/tools" \
  -H "Authorization: Bearer ${LETTA_TOKEN}"
```

You should see both `legacy-mcp` and `vibe-mcp` in the response.

## Automation (Future)

Once the Letta SDK supports MCP tool management, the `attachMcpTools()` method in `lib/LettaService.js` will be updated to handle this automatically. Track progress in the SDK repository or check for updates.

## Troubleshooting

### Tools not appearing in agent context
- Verify MCP servers are registered and accessible
- Check that tools are actually attached to the agent
- Restart the agent if needed

### MCP server connection errors
- Verify the MCP server URLs are accessible from the Letta server
- Check network/firewall rules
- Test MCP endpoints manually:
  ```bash
  curl http://192.168.50.90:3457/mcp/health
  curl http://192.168.50.90:9717/mcp/health
  ```

## Related Documentation
- [Letta MCP Integration](../LETTA_CODE_INTEGRATION_ANALYSIS.md)
- [System Engineering Review](../SYSTEM_ENGINEERING_REVIEW_LETTA_INTEGRATION.md)
- [Vibesync HTTP API Reference](./API.md)
