#!/usr/bin/env node

const BASE_URL = String(process.env.ZOTERO_DASHBOARD_MCP_BASE_URL || '').trim().replace(/\/+$/, '');
const ACCESS_TOKEN = String(process.env.ZOTERO_DASHBOARD_MCP_TOKEN || '').trim();
const DEFAULT_PROTOCOL_VERSION = '2024-11-05';

const TOOLS = [
  {
    name: 'zotero_get_item_metadata',
    description: 'Get detailed metadata for a Zotero item by item key.',
    inputSchema: {
      type: 'object',
      properties: {
        item_key: { type: 'string' },
        item_api_base: { type: 'string' },
      },
      required: ['item_key'],
      additionalProperties: true,
    },
  },
  {
    name: 'zotero_get_item_fulltext',
    description: 'Get extracted full text for a Zotero item or its PDF attachment.',
    inputSchema: {
      type: 'object',
      properties: {
        item_key: { type: 'string' },
        item_api_base: { type: 'string' },
      },
      required: ['item_key'],
      additionalProperties: true,
    },
  },
  {
    name: 'zotero_get_notes',
    description: 'Get child notes for a Zotero item.',
    inputSchema: {
      type: 'object',
      properties: {
        item_key: { type: 'string' },
        item_api_base: { type: 'string' },
      },
      required: ['item_key'],
      additionalProperties: true,
    },
  },
  {
    name: 'zotero_get_annotations',
    description: 'Get PDF annotations for a Zotero item.',
    inputSchema: {
      type: 'object',
      properties: {
        item_key: { type: 'string' },
        item_api_base: { type: 'string' },
      },
      required: ['item_key'],
      additionalProperties: true,
    },
  },
  {
    name: 'zotero_semantic_search',
    description: 'Search related works in the Zotero library.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'integer' },
        item_api_base: { type: 'string' },
      },
      required: ['query'],
      additionalProperties: true,
    },
  },
  {
    name: 'zotero_search_items',
    description: 'Search items in the Zotero library.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'integer' },
        item_api_base: { type: 'string' },
      },
      required: ['query'],
      additionalProperties: true,
    },
  },
  {
    name: 'zotero_get_recent',
    description: 'Get recently added items from the Zotero library.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer' },
        item_api_base: { type: 'string' },
      },
      additionalProperties: true,
    },
  },
  {
    name: 'zotero_get_collections',
    description: 'List Zotero collections.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer' },
        item_api_base: { type: 'string' },
      },
      additionalProperties: true,
    },
  },
  {
    name: 'zotero_get_collection_items',
    description: 'List items in a Zotero collection.',
    inputSchema: {
      type: 'object',
      properties: {
        collection_key: { type: 'string' },
        limit: { type: 'integer' },
        item_api_base: { type: 'string' },
      },
      required: ['collection_key'],
      additionalProperties: true,
    },
  },
];

function printHelp() {
  process.stdout.write('Orhon Zotero MCP Bridge\n');
  process.stdout.write('Uses the local dashboard server as an MCP tool bridge.\n');
}

function sendMessage(message) {
  const payload = Buffer.from(JSON.stringify(message), 'utf8');
  process.stdout.write(`Content-Length: ${payload.length}\r\n\r\n`);
  process.stdout.write(payload);
}

function sendResult(id, result) {
  sendMessage({ jsonrpc: '2.0', id, result });
}

function sendError(id, code, message) {
  sendMessage({
    jsonrpc: '2.0',
    id,
    error: { code, message: String(message || 'Unknown error') },
  });
}

async function callInternalTool(name, args) {
  if (!BASE_URL || !ACCESS_TOKEN) {
    throw new Error('Bridge configuration is missing.');
  }

  const resp = await fetch(`${BASE_URL}/internal/mcp/tool`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Zdash-Token': ACCESS_TOKEN,
    },
    body: JSON.stringify({
      name,
      arguments: args && typeof args === 'object' ? args : {},
    }),
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(String(data?.error || `HTTP ${resp.status}`));
  }
  return data?.result || {
    content: [{ type: 'text', text: 'Tool returned no data.' }],
    isError: true,
  };
}

async function handleRequest(message) {
  const method = String(message?.method || '').trim();
  const id = Object.prototype.hasOwnProperty.call(message || {}, 'id') ? message.id : null;
  const params = message?.params && typeof message.params === 'object' ? message.params : {};

  if (!method) {
    if (id !== null) sendError(id, -32600, 'Invalid Request');
    return;
  }

  if (method === 'notifications/initialized') return;

  if (method === 'initialize') {
    sendResult(id, {
      protocolVersion: String(params.protocolVersion || DEFAULT_PROTOCOL_VERSION),
      capabilities: {
        tools: { listChanged: false },
      },
      serverInfo: {
        name: 'orhon-zotero-mcp-bridge',
        version: '0.0.4',
      },
    });
    return;
  }

  if (method === 'ping') {
    sendResult(id, {});
    return;
  }

  if (method === 'tools/list') {
    sendResult(id, { tools: TOOLS });
    return;
  }

  if (method === 'tools/call') {
    try {
      const result = await callInternalTool(params.name, params.arguments || {});
      sendResult(id, result);
    } catch (error) {
      sendResult(id, {
        content: [{ type: 'text', text: String(error?.message || error || 'Tool failed') }],
        isError: true,
      });
    }
    return;
  }

  if (method === 'resources/list') {
    sendResult(id, { resources: [] });
    return;
  }

  if (id !== null) {
    sendError(id, -32601, `Method not found: ${method}`);
  }
}

let buffer = Buffer.alloc(0);

function tryConsumeFramedMessage() {
  const headerEnd = buffer.indexOf('\r\n\r\n');
  const altHeaderEnd = buffer.indexOf('\n\n');
  const boundary = headerEnd >= 0 ? headerEnd : altHeaderEnd;
  if (boundary < 0) return false;

  const headerLength = headerEnd >= 0 ? 4 : 2;
  const headerBlock = buffer.slice(0, boundary).toString('utf8');
  if (!/^content-length:/im.test(headerBlock)) return false;

  const match = headerBlock.match(/content-length:\s*(\d+)/i);
  if (!match) {
    buffer = Buffer.alloc(0);
    return true;
  }

  const length = Number(match[1] || 0);
  const bodyStart = boundary + headerLength;
  if (buffer.length < bodyStart + length) return false;

  const payload = buffer.slice(bodyStart, bodyStart + length).toString('utf8');
  buffer = buffer.slice(bodyStart + length);
  dispatchPayload(payload);
  return true;
}

function tryConsumeLineMessage() {
  const lineEnd = buffer.indexOf('\n');
  if (lineEnd < 0) return false;

  const line = buffer.slice(0, lineEnd).toString('utf8').trim();
  buffer = buffer.slice(lineEnd + 1);
  if (!line) return true;
  dispatchPayload(line);
  return true;
}

function processBuffer() {
  while (buffer.length) {
    const preview = buffer.slice(0, 32).toString('utf8');
    if (/^content-length:/i.test(preview)) {
      if (!tryConsumeFramedMessage()) break;
      continue;
    }
    if (!tryConsumeLineMessage()) break;
  }
}

function dispatchPayload(payload) {
  let message = null;
  try {
    message = JSON.parse(String(payload || '').trim());
  } catch {
    return;
  }

  if (Array.isArray(message)) {
    message.forEach((entry) => {
      void handleRequest(entry);
    });
    return;
  }

  void handleRequest(message);
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  printHelp();
  process.exit(0);
}

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
  processBuffer();
});

process.stdin.on('end', () => {
  process.exit(0);
});

process.stdin.resume();
