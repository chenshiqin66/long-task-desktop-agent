import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "fixture", version: "0.0.1" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "ping",
      description: "report env flags",
      inputSchema: { type: "object", properties: { text: { type: "string" } } },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const args = request.params.arguments ?? {};
  const text = typeof args.text === "string" ? args.text : "";
  const leaked = process.env.MCP_PARENT_SECRET ? "leaked" : "absent";
  const key = process.env.AMAP_MAPS_API_KEY ?? "";
  return { content: [{ type: "text", text: `${text}|${leaked}|${key}` }] };
});

await server.connect(new StdioServerTransport());
