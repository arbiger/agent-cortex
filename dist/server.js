import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import pg from 'pg';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const { Pool } = pg;

const VALID_AGENT_TAGS = ['opencode', 'hermes', 'openclaw', 'george'];
const SERVER_AGENT_TAG = process.env.CORTEX_AGENT_TAG;

const pool = new Pool({
  connectionString: process.env.CORTEX_PG_CONN || 'postgresql://george@localhost:5432/agent_cortex',
});

(async () => {
  try {
    await pool.query(`ALTER TABLE memories ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN DEFAULT FALSE`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_memories_is_deleted ON memories(is_deleted)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_causal_links_target ON causal_links(target_id)`);
  } catch (err) {
    console.error('Migration warning:', err.message);
  }
})();

const VAULT_ROOT = process.env.CORTEX_VAULT_ROOT || '/Users/george/Documents/Georges/06 🧠 Memory';
const LLM_URL = process.env.CORTEX_LLM_URL || 'http://localhost:8000';
const LLM_MODEL = process.env.CORTEX_LLM_MODEL || 'supergemma4-26b-uncensored-mlx-4bit-v2';
const EMBED_URL = process.env.CORTEX_EMBED_URL || 'http://localhost:8000/v1/embeddings';
const EMBED_MODEL = process.env.CORTEX_EMBED_MODEL || 'bge-m3-mlx-fp16';

function validateAgentTag(agentTag, operation) {
  if (!agentTag || !VALID_AGENT_TAGS.includes(agentTag)) {
    throw new Error(`Invalid agent_tag: "${agentTag}". Valid: ${VALID_AGENT_TAGS.join(', ')}`);
  }
  if (operation === 'memory_write' && SERVER_AGENT_TAG && agentTag !== SERVER_AGENT_TAG) {
    throw new Error(`Forbidden: cannot use agent_tag "${agentTag}" — server configured as "${SERVER_AGENT_TAG}"`);
  }
}

async function ensureVaultDir() {
  try {
    await fs.mkdir(VAULT_ROOT, { recursive: true });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
}

async function writeMemoryFile(agentTag, content) {
  await ensureVaultDir();
  const today = new Date().toISOString().split('T')[0];
  const filename = `memory - ${agentTag} - ${today}.md`;
  const filepath = path.join(VAULT_ROOT, filename);
  const header = `---\nagent_tag: ${agentTag}\ndate: ${today}\n---\n\n`;
  await fs.writeFile(filepath, header + content, { flag: 'a' });
  return filepath;
}

async function readPeopleFile(name) {
  const filename = `people - ${name}.md`;
  const filepath = path.join(VAULT_ROOT, filename);
  try {
    return await fs.readFile(filepath, 'utf-8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

async function getEmbedding(text) {
  const response = await fetch(EMBED_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: EMBED_MODEL, input: text }),
  });
  if (!response.ok) throw new Error(`Embedding failed: ${response.statusText}`);
  const data = await response.json();
  return data.data[0].embedding;
}

async function insertMemory(agentTag, sourceFile, topicKey, content, memoryType = 'session') {
  const result = await pool.query(
    `INSERT INTO memories (agent_tag, source_file, topic_key, content, memory_type)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [agentTag, sourceFile, topicKey, content, memoryType]
  );
  return result.rows[0].id;
}

async function insertEmbedding(memoryId, embedding) {
  const vec = `[${embedding.join(',')}]`;
  await pool.query(
    `INSERT INTO memory_embeddings (memory_id, embedding) VALUES ($1, $2::vector)
     ON CONFLICT (memory_id) DO NOTHING`,
    [memoryId, vec]
  );
  await pool.query(
    `UPDATE memories SET embedding_pending = FALSE WHERE id = $1`,
    [memoryId]
  );
}

async function softDeleteMemory(memoryId) {
  const result = await pool.query(
    `UPDATE memories SET is_deleted = TRUE WHERE id = $1 RETURNING id`,
    [memoryId]
  );
  if (!result.rows.length) {
    throw new Error(`Memory ${memoryId} not found`);
  }
  return result.rows[0].id;
}

async function getPendingEmbeddings() {
  const result = await pool.query(
    `SELECT m.* FROM memories m
     LEFT JOIN memory_embeddings e ON m.id = e.memory_id
     WHERE m.embedding_pending = TRUE AND e.id IS NULL AND m.is_deleted = FALSE
     ORDER BY m.created_at`
  );
  return result.rows;
}

async function retryPendingEmbeddings() {
  const pending = await getPendingEmbeddings();
  let embedded = 0;
  for (const mem of pending) {
    try {
      const embedding = await getEmbedding(mem.content);
      await insertEmbedding(mem.id, embedding);
      embedded++;
    } catch (err) {
      console.error(`Failed to embed ${mem.id}:`, err.message);
    }
  }
  return { attempted: pending.length, embedded };
}

async function semanticSearch(query, agentTag, limit = 10) {
  const embedding = await getEmbedding(query);
  const embeddingVec = `[${embedding.join(',')}]`;
  let result;
  if (agentTag) {
    result = await pool.query(
      `SELECT m.*, (e.embedding <=> $1::vector) AS similarity
       FROM memories m
       JOIN memory_embeddings e ON m.id = e.memory_id
       WHERE m.agent_tag = $2
       ORDER BY e.embedding <=> $1::vector
       LIMIT $3`,
      [embeddingVec, agentTag, limit]
    );
  } else {
    result = await pool.query(
      `SELECT m.*, (e.embedding <=> $1::vector) AS similarity
       FROM memories m
       JOIN memory_embeddings e ON m.id = e.memory_id
       ORDER BY e.embedding <=> $1::vector
       LIMIT $2`,
      [embeddingVec, limit]
    );
  }
  return result.rows;
}

async function keywordSearch(query, agentTag, limit = 10) {
  let result;
  if (agentTag) {
    result = await pool.query(
      `SELECT * FROM memories
       WHERE agent_tag = $1 AND content ILIKE $2 AND is_deleted = FALSE
       ORDER BY created_at DESC LIMIT $3`,
      [agentTag, `%${query}%`, limit]
    );
  } else {
    result = await pool.query(
      `SELECT * FROM memories
       WHERE content ILIKE $1 AND is_deleted = FALSE
       ORDER BY created_at DESC LIMIT $2`,
      [`%${query}%`, limit]
    );
  }
  return result.rows;
}

async function causalWalk(topic, depth = 5) {
  const startMem = await pool.query(
    `SELECT id FROM memories WHERE content ILIKE $1 ORDER BY created_at DESC LIMIT 1`,
    [`%${topic}%`]
  );
  if (!startMem.rows.length) return [];

  const result = await pool.query(
    `WITH RECURSIVE causal_path AS (
       SELECT m.*, cl.target_id, cl.relation, 1 AS depth
       FROM memories m
       JOIN causal_links cl ON m.id = cl.memory_id
       WHERE m.id = $1
       UNION ALL
       SELECT m.*, cl.target_id, cl.relation, cp.depth + 1
       FROM memories m
       JOIN causal_links cl ON m.id = cl.memory_id
       JOIN causal_path cp ON cl.memory_id = cp.id
       WHERE cp.depth < $2
     )
     SELECT * FROM causal_path`,
    [startMem.rows[0].id, depth]
  );
  return result.rows;
}

async function getUnprocessedMemories(since, limit = 50) {
  let result;
  if (since) {
    result = await pool.query(
      `SELECT * FROM memories WHERE enriched = FALSE AND is_deleted = FALSE AND created_at >= $1 ORDER BY created_at LIMIT $2`,
      [since, limit]
    );
  } else {
    result = await pool.query(
      `SELECT * FROM memories WHERE enriched = FALSE AND is_deleted = FALSE ORDER BY created_at LIMIT $1`,
      [limit]
    );
  }
  return result.rows;
}

async function enrichMemory(memoryId, facts, narrative) {
  await pool.query(
    `UPDATE memories SET facts = $1, narrative = $2, enriched = TRUE WHERE id = $3`,
    [JSON.stringify(facts), narrative, memoryId]
  );
}

async function createCausalLink(memoryId, targetId, relation, weight = 0.5) {
  const VALID_RELATIONS = ['caused', 'led_to', 'contradicts', 'references', 'supports', 'replaces'];
  if (!VALID_RELATIONS.includes(relation)) {
    throw new Error(`Invalid relation: "${relation}". Valid: ${VALID_RELATIONS.join(', ')}`);
  }
  const source = await pool.query(`SELECT agent_tag FROM memories WHERE id = $1`, [memoryId]);
  if (!source.rows[0]) {
    throw new Error(`Memory ${memoryId} not found`);
  }
  const result = await pool.query(
    `INSERT INTO causal_links (memory_id, target_id, relation, weight)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [memoryId, targetId, relation, weight]
  );
  return result.rows[0].id;
}

async function getTimelineWithNeighbors(topic, limit = 10) {
  const embedding = await getEmbedding(topic);
  const embeddingVec = `[${embedding.join(',')}]`;
  const memories = await pool.query(
    `SELECT m.*, (e.embedding <=> $1::vector) AS similarity
     FROM memories m
     JOIN memory_embeddings e ON m.id = e.memory_id
     ORDER BY e.embedding <=> $1::vector
     LIMIT $2`,
    [embeddingVec, limit]
  );

  if (memories.rows.length === 0) return [];

  const memoryIds = memories.rows.map(m => m.id);
  const neighbors = await pool.query(
    `SELECT cl.*, m.content, m.agent_tag, m.created_at,
            CASE WHEN cl.target_id = ANY($1) THEN 'before' ELSE 'after' END as direction
     FROM causal_links cl
     JOIN memories m ON (m.id = cl.target_id OR m.id = cl.memory_id)
     WHERE cl.target_id = ANY($1) OR cl.memory_id = ANY($1)`,
    [memoryIds]
  );

  const neighborMap = new Map();
  for (const row of neighbors.rows) {
    const key = row.direction === 'before' ? row.target_id : row.memory_id;
    if (!neighborMap.has(key)) neighborMap.set(key, { before: [], after: [] });
    if (row.direction === 'before') {
      neighborMap.get(key).before.push(row);
    } else {
      neighborMap.get(key).after.push(row);
    }
  }

  return memories.rows.map(m => ({
    ...m,
    neighbors: neighborMap.get(m.id) || { before: [], after: [] }
  }));
}

async function getMemoryById(memoryId) {
  const result = await pool.query(`SELECT * FROM memories WHERE id = $1`, [memoryId]);
  return result.rows[0] || null;
}





async function checkContradictions(memoryId, newFacts) {
  const memory = await getMemoryById(memoryId);
  if (!memory || !memory.facts) return [];
  const existingFacts = typeof memory.facts === 'string' ? JSON.parse(memory.facts) : memory.facts;
  const contradictions = [];
  for (const existing of existingFacts) {
    for (const newFact of newFacts) {
      if (existing.toLowerCase().includes('not') !== newFact.toLowerCase().includes('not') ||
          existing.includes('no ') !== newFact.includes('no ')) {
        if (Math.random() < 0.3) {
          contradictions.push({
            existing,
            new: newFact,
            type: 'potential_conflict'
          });
        }
      }
    }
  }
  return contradictions;
}

async function writePeopleFile(name, content) {
  await ensureVaultDir();
  const filename = `people - ${name}.md`;
  const filepath = path.join(VAULT_ROOT, filename);
  const header = `---\nname: ${name}\nupdated: ${new Date().toISOString().split('T')[0]}\n---\n\n`;
  await fs.writeFile(filepath, header + content, { flag: 'w' });
  return filepath;
}

function rrfMerge(results, k = 60) {
  const scores = new Map();
  results.forEach((resultSet, setIdx) => {
    resultSet.forEach((r, idx) => {
      const score = scores.get(r.id) || 0;
      scores.set(r.id, score + 1 / (k + idx + 1));
    });
  });
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => results.flat().find(r => r.id === id));
}

function generateGraphHTML({ nodes, edges }) {
  const data = JSON.stringify({ nodes, edges });
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Agent-Cortex Memory Graph</title>
  <script src="https://d3js.org/d3.v7.min.js"><\/script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #1a1a2e; color: #eee; overflow: hidden; }
    #graph { width: 100vw; height: 100vh; }
    .node circle { stroke: #fff; stroke-width: 1.5px; cursor: pointer; }
    .node text { font-size: 10px; fill: #ccc; pointer-events: none; }
    .link { stroke: #555; stroke-opacity: 0.6; }
    #info { position: fixed; top: 20px; right: 20px; width: 340px; background: #16213e; border-radius: 8px; padding: 16px; box-shadow: 0 4px 20px rgba(0,0,0,0.4); display: none; max-height: 85vh; overflow-y: auto; }
    #info h3 { font-size: 14px; color: #7fdbff; margin-bottom: 8px; }
    #info .meta { font-size: 11px; color: #888; margin-bottom: 12px; }
    #info .narrative { font-size: 13px; line-height: 1.5; margin-bottom: 12px; }
    #info .facts { font-size: 12px; padding-left: 16px; }
    #info .facts li { margin-bottom: 4px; color: #aaa; }
    #info .agent-tag { display: inline-block; background: #0f3460; padding: 2px 8px; border-radius: 4px; font-size: 11px; margin-bottom: 8px; }
    #info .close { position: absolute; top: 10px; right: 12px; cursor: pointer; color: #666; font-size: 18px; }
    #search { position: fixed; top: 20px; left: 20px; background: #16213e; padding: 12px; border-radius: 8px; box-shadow: 0 4px 20px rgba(0,0,0,0.4); }
    #search input { background: #1a1a2e; border: 1px solid #333; color: #fff; padding: 8px 12px; border-radius: 4px; width: 200px; font-size: 13px; }
    #search input:focus { outline: none; border-color: #7fdbff; }
    #search button { background: #0f3460; border: none; color: #fff; padding: 8px 12px; border-radius: 4px; cursor: pointer; margin-left: 8px; }
    #stats { position: fixed; bottom: 20px; left: 20px; background: #16213e; padding: 12px 16px; border-radius: 8px; font-size: 12px; color: #888; }
    .legend { position: fixed; bottom: 20px; right: 20px; background: #16213e; padding: 12px; border-radius: 8px; font-size: 11px; }
    .legend-item { display: flex; align-items: center; margin-bottom: 4px; }
    .legend-color { width: 12px; height: 12px; border-radius: 50%; margin-right: 8px; }
  </style>
</head>
<body>
  <div id="search"><input type="text" id="searchInput" placeholder="Search..."><button onclick="searchNodes()">Search</button></div>
  <div id="info"><span class="close" onclick="closeInfo()">&times;</span><div class="agent-tag" id="infoAgent"></div><h3 id="infoContent"></h3><div class="meta" id="infoMeta"></div><div class="narrative" id="infoNarrative"></div><ul class="facts" id="infoFacts"></ul></div>
  <div id="stats"></div>
  <div class="legend">
    <div class="legend-item"><div class="legend-color" style="background:#7fdbff"></div>opencode</div>
    <div class="legend-item"><div class="legend-color" style="background:#ffdc00"></div>hermes</div>
    <div class="legend-item"><div class="legend-color" style="background:#ff6b6b"></div>openclaw</div>
    <div class="legend-item"><div class="legend-color" style="background:#01ff70"></div>george</div>
  </div>
  <svg id="graph"></svg>
  <script>
    const DATA = ${data};
    const agentColors = { opencode: '#7fdbff', hermes: '#ffdc00', openclaw: '#ff6b6b', george: '#01ff70', default: '#aaa' };
    const relationColors = { caused: '#ff6b6b', led_to: '#ff9f43', contradicts: '#ff4757', references: '#7fdbff', supports: '#2ed573', replaces: '#a55eea' };

    let svg, g, sim, graphNodes, graphLinks;

    function init() {
      svg = d3.select('#graph').attr('width', window.innerWidth).attr('height', window.innerHeight);
      g = svg.append('g');
      svg.call(d3.zoom().scaleExtent([.1, 4]).on('zoom', e => g.attr('transform', e.transform)));
      sim = d3.forceSimulation().force('link', d3.forceLink().id(d => d.id).distance(120)).force('charge', d3.forceManyBody().strength(-300)).force('center', d3.forceCenter(window.innerWidth/2, window.innerHeight/2)).force('collision', d3.forceCollide().radius(50));
      graphLinks = g.append('g').selectAll('.link').data(DATA.edges).enter().append('line').attr('class', 'link').attr('stroke', d => relationColors[d.relation]||'#555').attr('stroke-width', d => (d.weight||.5)*2);
      graphNodes = g.append('g').selectAll('.node').data(DATA.nodes).enter().append('g').attr('class', 'node').call(d3.drag().on('start', s => { if (!event.active) sim.alphaTarget(.3).restart(); d.fx = d.x; d.fy = d.y; }).on('drag', d => { d.fx = event.x; d.fy = event.y; }).on('end', d => { if (!event.active) sim.alphaTarget(0); d.fx = null; d.fy = null; })).on('click', (e, d) => showInfo(d));
      graphNodes.append('circle').attr('r', 12).attr('fill', d => agentColors[d.agent] || agentColors.default);
      graphNodes.append('text').attr('dx', 16).attr('dy', 4).text(d => d.label.slice(0, 30));
      sim.nodes(DATA.nodes).on('tick', () => { graphLinks.attr('x1', d => d.source.x).attr('y1', d => d.source.y).attr('x2', d => d.target.x).attr('y2', d => d.target.y); graphNodes.attr('transform', d => \`translate(\${d.x},\${d.y})\`); });
      sim.force('link').links(DATA.edges);
      document.getElementById('stats').textContent = DATA.nodes.length + ' memories | ' + DATA.edges.length + ' links';
    }

    function showInfo(d) {
      const info = document.getElementById('info'); info.style.display = 'block';
      document.getElementById('infoAgent').textContent = d.agent;
      document.getElementById('infoContent').textContent = d.label;
      document.getElementById('infoMeta').textContent = d.date ? new Date(d.date).toLocaleString() : '';
      document.getElementById('infoNarrative').textContent = d.narrative || 'No narrative';
      const fEl = document.getElementById('infoFacts'); fEl.innerHTML = '';
      if (d.facts && d.facts.length) d.facts.forEach(f => { const li = document.createElement('li'); li.textContent = f; fEl.appendChild(li); }); else fEl.innerHTML = '<li>No facts yet</li>';
    }
    function closeInfo() { document.getElementById('info').style.display = 'none'; }
    function searchNodes() {
      const q = document.getElementById('searchInput').value.toLowerCase();
      const found = DATA.nodes.find(n => n.label.toLowerCase().includes(q) || n.content && n.content.toLowerCase().includes(q));
      if (found) { showInfo(found); } else { alert('Not found'); }
    }
    window.addEventListener('resize', () => { svg.attr('width', window.innerWidth).attr('height', window.innerHeight); sim.force('center', d3.forceCenter(window.innerWidth/2, window.innerHeight/2)); sim.alpha(.3).restart(); });
    init();
  <\/script>
</body>
</html>`;
}

const server = new Server(
  { name: 'agent-cortex', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, () => {
  return {
    tools: [
      {
        name: 'memory_write',
        description: 'Write a memory document to the vault and database',
        inputSchema: {
          type: 'object',
          properties: {
            agent_tag: { type: 'string', description: 'Agent tag (opencode, hermes, openclaw, george)' },
            content: { type: 'string', description: 'Markdown content' },
            memory_type: { type: 'string', enum: ['session', 'people', 'company', 'skill'], default: 'session' },
            topic_key: { type: 'string', description: 'Optional topic tag' },
          },
          required: ['agent_tag', 'content'],
        },
      },
      {
        name: 'memory_query',
        description: 'Query memories using semantic, keyword, hybrid, or causal search',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Natural language query' },
            agent_tag: { type: 'string', description: 'Filter by agent (null for all)' },
            limit: { type: 'number', default: 10 },
            depth: { type: 'number', default: 5, description: 'Max depth for causal mode' },
            mode: { type: 'string', enum: ['semantic', 'keyword', 'hybrid', 'causal'], default: 'semantic' },
          },
          required: ['query'],
        },
      },
      {
        name: 'memory_read_people',
        description: 'Read accumulated cognition about a person',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Person name (george, ching, shirley)' },
          },
          required: ['name'],
        },
      },
      {
        name: 'memory_causal_walk',
        description: 'Walk the causal chain for a topic',
        inputSchema: {
          type: 'object',
          properties: {
            topic: { type: 'string', description: 'Topic relation (e.g. why-did-we-choose-clawmem)' },
            depth: { type: 'number', default: 5 },
          },
          required: ['topic'],
        },
      },
      {
        name: 'memory_enrich',
        description: 'Enrich unprocessed memories with facts and narrative. Also retries any pending embeddings. Auto-creates causal links.',
        inputSchema: {
          type: 'object',
          properties: {
            since: { type: 'string', description: 'ISO date (null for all unprocessed)' },
            limit: { type: 'number', default: 5, description: 'Max memories to enrich per call' },
          },
        },
      },
      {
        name: 'memory_link',
        description: 'Create a causal link between two memories',
        inputSchema: {
          type: 'object',
          properties: {
            memory_id: { type: 'string', description: 'Source memory ID (UUID)' },
            target_id: { type: 'string', description: 'Target memory ID (UUID)' },
            relation: { type: 'string', enum: ['caused', 'led_to', 'contradicts', 'references', 'supports', 'replaces'], description: 'Relationship type' },
            weight: { type: 'number', default: 0.5, description: 'Link weight (0-1)' },
          },
          required: ['memory_id', 'target_id', 'relation'],
        },
      },
      {
        name: 'memory_delete',
        description: 'Soft-delete a memory (marks as deleted, does not remove from DB)',
        inputSchema: {
          type: 'object',
          properties: {
            memory_id: { type: 'string', description: 'Memory ID to delete' },
          },
          required: ['memory_id'],
        },
      },
      {
        name: 'memory_export_graph',
        description: 'Export all memories and causal links as a standalone HTML graph visualization',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'memory_timeline',
        description: 'Navigate memories chronologically with causal context',
        inputSchema: {
          type: 'object',
          properties: {
            topic: { type: 'string', description: 'Topic to timeline' },
            limit: { type: 'number', default: 10, description: 'Max memories to show' },
            display: { type: 'string', enum: ['brief', 'compact', 'full'], default: 'compact', description: 'Detail level' },
          },
          required: ['topic'],
        },
      },
      {
        name: 'memory_write_people',
        description: 'Write/update accumulated cognition about a person',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Person name (george, ching, shirley)' },
            content: { type: 'string', description: 'Markdown content to write' },
          },
          required: ['name', 'content'],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (name === 'memory_write') {
      const { agent_tag, content, memory_type = 'session', topic_key } = args;

      validateAgentTag(agent_tag, 'memory_write');

      const filepath = await writeMemoryFile(agent_tag, content);
      const memoryId = await insertMemory(agent_tag, path.basename(filepath), topic_key, content, memory_type);

      try {
        const embedding = await getEmbedding(content);
        await insertEmbedding(memoryId, embedding);
      } catch (embErr) {
        console.error('Embedding failed, continuing without vector:', embErr.message);
      }

      return { content: [{ type: 'text', text: `Memory saved to ${filepath}, DB id: ${memoryId}` }] };
    }

    if (name === 'memory_query') {
      const { query, agent_tag, limit = 10, mode = 'semantic', depth = 5 } = args;

      if (agent_tag) validateAgentTag(agent_tag, 'memory_query');

      let results;
      if (mode === 'semantic') {
        results = await semanticSearch(query, agent_tag || null, limit);
      } else if (mode === 'keyword') {
        results = await keywordSearch(query, agent_tag || null, limit);
      } else if (mode === 'causal') {
        results = await causalWalk(query, depth);
      } else if (mode === 'hybrid') {
        const [semResults, kwResults] = await Promise.all([
          semanticSearch(query, agent_tag || null, limit),
          keywordSearch(query, agent_tag || null, limit),
        ]);
        results = rrfMerge([semResults, kwResults], 60).slice(0, limit);
      } else {
        throw new Error(`Unknown mode: ${mode}`);
      }

      return {
        content: [{
          type: 'text',
          text: results.length
            ? results.map(r => {
              let line = `[agent-cortex-return] ${r.content.slice(0, 200)}...`;
              if (r.narrative) {
                line += `\n   Narrative: ${r.narrative.slice(0, 100)}...`;
              }
              if (r.facts && r.facts !== '[]') {
                const facts = typeof r.facts === 'string' ? JSON.parse(r.facts) : r.facts;
                if (facts.length > 0) {
                  line += `\n   Facts: ${facts.slice(0, 3).join(', ')}`;
                }
              }
              return line;
            }).join('\n\n')
            : 'No results found',
        }],
      };
    }

    if (name === 'memory_read_people') {
      const { name: personName } = args;
      const content = await readPeopleFile(personName);

      if (!content) {
        return { content: [{ type: 'text', text: `No memory file found for: ${personName}` }] };
      }

      return { content: [{ type: 'text', text: content }] };
    }

    if (name === 'memory_causal_walk') {
      const { topic, depth = 5 } = args;
      const results = await causalWalk(topic, depth);

      return {
        content: [{
          type: 'text',
          text: results.length
            ? results.map(r => `[${r.depth}] ${r.content.slice(0, 200)}...`).join('\n\n')
            : 'No causal chain found',
        }],
      };
    }

    if (name === 'memory_enrich') {
      const { since, limit = 5 } = args;

      const embedResult = await retryPendingEmbeddings();
      const memories = await getUnprocessedMemories(since || null, limit);

      let enriched = 0;
      let contradictions = 0;
      let linksCreated = 0;
      for (const mem of memories) {
        try {
          const response = await fetch(`${LLM_URL}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: LLM_MODEL,
              messages: [{
                role: 'user',
                content: `Analyze the following content and extract structured information. Return JSON with:
- "facts": array of key facts (strings)
- "narrative": one paragraph summary
- "links": array of suggested causal links, each with "target_topic" (what topic/memory to link to), "relation" (caused/led_to/contradicts/references/supports/replaces), and "reason" (why this link exists)

Content:
${mem.content}

Return valid JSON only.`,
              }],
            }),
          });
          const data = await response.json();
          const rawContent = data.choices?.[0]?.message?.content || '';
          let facts = [];
          let narrative = rawContent;
          let suggestedLinks = [];
          try {
            const parsed = JSON.parse(rawContent);
            facts = Array.isArray(parsed.facts) ? parsed.facts : [];
            narrative = parsed.narrative || rawContent;
            suggestedLinks = Array.isArray(parsed.links) ? parsed.links : [];
          } catch {
          }
          const conflicts = await checkContradictions(mem.id, facts);
          if (conflicts.length > 0) {
            contradictions += conflicts.length;
            console.error(`Contradictions detected for ${mem.id}:`, JSON.stringify(conflicts));
          }
          await enrichMemory(mem.id, facts, narrative);

          for (const link of suggestedLinks) {
            try {
              const targetMem = await pool.query(
                `SELECT id FROM memories
                 WHERE content ILIKE $1 AND id != $2
                 ORDER BY created_at DESC LIMIT 1`,
                [`%${link.target_topic}%`, mem.id]
              );
              if (targetMem.rows.length > 0) {
                await createCausalLink(mem.id, targetMem.rows[0].id, link.relation, 0.6);
                linksCreated++;
              }
            } catch (linkErr) {
              console.error(`Failed to create link:`, linkErr.message);
            }
          }

          enriched++;
        } catch (err) {
          console.error(`Failed to enrich ${mem.id}:`, err.message);
        }
      }

      return { content: [{ type: 'text', text: `Embeddings: ${embedResult.embedded}/${embedResult.attempted} retry ok. Enriched: ${enriched}/${memories.length}. Contradictions: ${contradictions}. Auto-links created: ${linksCreated}` }] };
    }

    if (name === 'memory_link') {
      const { memory_id, target_id, relation, weight = 0.5 } = args;

      if (!memory_id || !target_id) {
        throw new Error('memory_id and target_id are required');
      }

      const linkId = await createCausalLink(memory_id, target_id, relation, weight);

      return { content: [{ type: 'text', text: `Causal link created: ${linkId} (${relation})` }] };
    }

    if (name === 'memory_delete') {
      const { memory_id } = args;

      if (!memory_id) {
        throw new Error('memory_id is required');
      }

      await softDeleteMemory(memory_id);

      return { content: [{ type: 'text', text: `Memory ${memory_id} soft-deleted` }] };
    }

    if (name === 'memory_export_graph') {
      const memories = await pool.query(`
        SELECT id, agent_tag, content, created_at, facts, narrative
        FROM memories WHERE is_deleted = FALSE
        ORDER BY created_at DESC LIMIT 500
      `);

      const links = await pool.query(`
        SELECT cl.memory_id, cl.target_id, cl.relation, cl.weight
        FROM causal_links cl
        JOIN memories m ON cl.memory_id = m.id
        WHERE m.is_deleted = FALSE
      `);

      const nodes = memories.rows.map(m => ({
        id: m.id,
        label: m.content.slice(0, 100) + (m.content.length > 100 ? '...' : ''),
        agent: m.agent_tag,
        date: m.created_at,
        facts: m.facts ? (typeof m.facts === 'string' ? JSON.parse(m.facts) : m.facts) : [],
        narrative: m.narrative || '',
      }));

      const edges = links.rows.map(l => ({
        source: l.memory_id,
        target: l.target_id,
        relation: l.relation,
        weight: l.weight,
      }));

      const html = generateGraphHTML({ nodes, edges });
      const outPath = path.join(VAULT_ROOT, 'memory-graph.html');
      await fs.writeFile(outPath, html);

      return { content: [{ type: 'text', text: `Graph exported to ${outPath} (${nodes.length} nodes, ${edges.length} edges)` }] };
    }

    if (name === 'memory_timeline') {
      const { topic, limit = 10, display = 'compact' } = args;

      const memoriesWithNeighbors = await getTimelineWithNeighbors(topic, limit);
      if (memoriesWithNeighbors.length === 0) {
        return { content: [{ type: 'text', text: 'No timeline found for this topic' }] };
      }

      let output = `═══ TIMELINE: ${topic} ═══\n\n`;

      for (const mem of memoriesWithNeighbors) {
        const date = new Date(mem.created_at).toLocaleDateString();

        if (display === 'brief') {
          output += `📅 ${date} — ${mem.content.slice(0, 80)}...\n`;
        } else if (display === 'compact') {
          output += `📅 ${date} | ${mem.agent_tag} | ${mem.memory_type}\n`;
          output += `   ${mem.content.slice(0, 120)}...\n`;
          if (mem.neighbors.before.length > 0) {
            output += `   ↑ ${mem.neighbors.before[0].content.slice(0, 50)}...\n`;
          }
          if (mem.neighbors.after.length > 0) {
            output += `   ↓ ${mem.neighbors.after[0].content.slice(0, 50)}...\n`;
          }
          output += '\n';
        } else {
          output += `═══════════════════════════════════════\n`;
          output += `📅 ${date} — ${mem.agent_tag} | ${mem.memory_type}\n\n`;
          output += `${mem.content}\n\n`;
          if (mem.narrative) {
            output += `Summary: ${mem.narrative}\n`;
          }
          if (mem.facts && mem.facts !== '[]') {
            const facts = typeof mem.facts === 'string' ? JSON.parse(mem.facts) : mem.facts;
            output += `Facts: ${facts.join(', ')}\n`;
          }
          output += `\n↑ Before: ${mem.neighbors.before.map(m => m.content.slice(0, 50)).join(', ') || '(none)'}\n`;
          output += `↓ After: ${mem.neighbors.after.map(m => m.content.slice(0, 50)).join(', ') || '(none)'}\n`;
        }
      }

      return { content: [{ type: 'text', text: output }] };
    }

    if (name === 'memory_write_people') {
      const { name: personName, content } = args;

      if (SERVER_AGENT_TAG && SERVER_AGENT_TAG !== 'george') {
        throw new Error(`Forbidden: memory_write_people requires server configured as "george", got "${SERVER_AGENT_TAG}"`);
      }

      const filepath = await writePeopleFile(personName, content);

      return { content: [{ type: 'text', text: `People file updated: ${filepath}` }] };
    }

    throw new Error(`Unknown tool: ${name}`);
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Agent Cortex MCP server running');
}

main().catch(console.error);
