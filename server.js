import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { randomUUID } from 'crypto';
import { z } from 'zod';

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO_OWNER = 'chellegood';
const REPO_NAME = 'personal-context-portfolio';
const PORTFOLIO_PATH = 'my-portfolio';
const PORT = process.env.PORT || 3000;

if (!GITHUB_TOKEN) {
  console.error('ERROR: GITHUB_TOKEN environment variable is required');
  process.exit(1);
}

async function githubFetch(apiPath) {
  const res = await fetch(
    `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${apiPath}`,
    {
      headers: {
        Authorization: `token ${GITHUB_TOKEN}`,
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'personal-context-mcp',
      },
    }
  );
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
  return res.json();
}

function createServer() {
  const server = new McpServer({
    name: 'personal-context-portfolio',
    version: '1.0.0',
  });

  server.tool(
    'list_portfolio_files',
    'List all markdown files in the personal context portfolio',
    {},
    async () => {
      const files = await githubFetch(PORTFOLIO_PATH);
      const names = files
        .filter((f) => f.type === 'file' && f.name.endsWith('.md'))
        .map((f) => f.name);
      return { content: [{ type: 'text', text: names.join('\n') }] };
    }
  );

  server.tool(
    'read_portfolio_file',
    'Read a specific file from the personal context portfolio by filename',
    { filename: z.string().describe('Filename to read, e.g. "about-me.md"') },
    async ({ filename }) => {
      const file = await githubFetch(`${PORTFOLIO_PATH}/${filename}`);
      const text = Buffer.from(file.content, 'base64').toString('utf-8');
      return { content: [{ type: 'text', text: `# ${filename}\n\n${text}` }] };
    }
  );

  server.tool(
    'read_all_portfolio_files',
    'Read every file in the personal context portfolio at once — use this to fully onboard to who this person is',
    {},
    async () => {
      const files = await githubFetch(PORTFOLIO_PATH);
      const mdFiles = files.filter((f) => f.type === 'file' && f.name.endsWith('.md'));
      const contents = await Promise.all(
        mdFiles.map(async (f) => {
          const file = await githubFetch(`${PORTFOLIO_PATH}/${f.name}`);
          const text = Buffer.from(file.content, 'base64').toString('utf-8');
          return `# ${f.name}\n\n${text}`;
        })
      );
      return { content: [{ type: 'text', text: contents.join('\n\n---\n\n') }] };
    }
  );

  return server;
}

const app = express();
app.use(express.json());

const transports = new Map();

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.post('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];

  if (sessionId && transports.has(sessionId)) {
    const transport = transports.get(sessionId);
    await transport.handleRequest(req, res, req.body);
    return;
  }

  if (sessionId) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  // New session
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (id) => transports.set(id, transport),
  });

  transport.onclose = () => {
    if (transport.sessionId) transports.delete(transport.sessionId);
  };

  const server = createServer();
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.get('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  const transport = transports.get(sessionId);
  if (!transport) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  await transport.handleRequest(req, res);
});

app.delete('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  const transport = transports.get(sessionId);
  if (transport) {
    await transport.close();
    transports.delete(sessionId);
  }
  res.status(204).end();
});

app.listen(PORT, () => console.log(`MCP server listening on port ${PORT}`));
