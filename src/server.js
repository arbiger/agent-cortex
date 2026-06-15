import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import { checkContradictions as srcCheckContradictions } from './contradiction.js';
import { loadConfig, VALID_AGENT_TAGS } from './config.js';
import * as db from './db.js';
import { initSchema } from './sqlite_store.js';
import * as vector_search from './vector_search.js';
import {
  normalizePersonName,
  hashContent,
  buildPeopleMemorySelectSql,
  buildPeopleMemorySelectParams,
  renderProvenanceBlock,
  buildDistillPrompt,
  parseDistillResponse,
  buildProposedPeopleContent,
  createUnifiedDiff,
} from './people_distill.js';
import { parseEnrichmentPayload } from './llm_json.js';
import { handleQueryUnified } from './query_unified.js';

const config = loadConfig();
const SERVER_AGENT_TAG = config.SERVER_AGENT_TAG;

// In-memory proposal cache for review-gated distill workflow.
// Map<proposalId, { personName, currentHash, proposedContent, sourceIds, sourceMemories }>
const proposals = new Map();

const VAULT_ROOT = config.VAULT_ROOT;
const LLM_URL = config.LLM_URL;
const LLM_MODEL = config.LLM_MODEL;
const EMBED_URL = config.EMBED_URL;
const EMBED_MODEL = config.EMBED_MODEL;


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
  const memoryId = randomUUID();
  await db.query(
    `INSERT INTO memories (id, agent_tag, source_file, topic_key, content, memory_type, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
    [memoryId, agentTag, sourceFile, topicKey, content, memoryType]
  );
  return memoryId;
}

async function insertEmbedding(memoryId, embedding) {
  // Store as little-endian Float32 BLOB (4096 bytes) + update in-memory index
  const { vectorToBlob } = vector_search;
  const blob = vectorToBlob(new Float32Array(embedding));
  await db.query(
    `INSERT INTO memory_embeddings (id, memory_id, embedding, created_at, updated_at)
     VALUES (lower(hex(randomblob(16))), ?, ?, datetime('now'), datetime('now'))
     ON CONFLICT(memory_id) DO UPDATE SET embedding = excluded.embedding, updated_at = datetime('now')`,
    [memoryId, blob]
  );
  await db.query(
    `UPDATE memories SET embedding_pending = 0 WHERE id = ?`,
    [memoryId]
  );
  // Upsert in memory index
  await vector_search.addOrUpdate(memoryId, new Float32Array(embedding));
}

async function softDeleteMemory(memoryId) {
  const result = await db.query(
    `UPDATE memories SET is_deleted = 1 WHERE id = ? RETURNING id`,
    [memoryId]
  );
  if (!result.rows.length) {
    throw new Error(`Memory ${memoryId} not found`);
  }
  return result.rows[0].id;
}

async function getPendingEmbeddings() {
  const result = await db.query(
    `SELECT m.* FROM memories m
     LEFT JOIN memory_embeddings e ON m.id = e.memory_id
     WHERE m.embedding_pending = 1 AND e.id IS NULL AND m.is_deleted = 0
     ORDER BY m.created_at`
  );
  return result.rows;
}

async function retryPendingEmbeddings(delayMs = 100) {
  const pending = await getPendingEmbeddings();
  if (pending.length === 0) return { attempted: 0, embedded: 0, errors: [] };
  let embedded = 0;
  const errors = [];
  for (const mem of pending) {
    try {
      const embedding = await getEmbedding(mem.content);
      await insertEmbedding(mem.id, embedding);
      embedded++;
    } catch (err) {
      const msg = `memory ${mem.id}: ${err.message}`;
      errors.push(msg);
      console.error(`Failed to embed ${mem.id}:`, err.message);
    }
    if (delayMs > 0 && mem !== pending[pending.length - 1]) {
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  return { attempted: pending.length, embedded, errors };
}

async function semanticSearch(query, agentTag, limit = 10) {
  const embedding = await getEmbedding(query);
  const similar = await vector_search.searchSimilar(embedding, limit);
  if (similar.length === 0) return [];

  const ids = similar.map(s => s.memory_id);
  const placeholders = ids.map(() => '?').join(',');
  let sql = `SELECT m.* FROM memories m WHERE m.id IN (${placeholders}) AND m.is_deleted = 0`;
  const params = [...ids];
  if (agentTag) {
    sql = `SELECT m.* FROM memories m WHERE m.id IN (${placeholders}) AND m.is_deleted = 0 AND m.agent_tag = ?`;
    params.push(agentTag);
  }
  const result = await db.query(sql, params);
  const simById = new Map(similar.map(s => [s.id || s.memory_id, s.similarity]));
  return result.rows.map(r => ({ ...r, similarity: simById.get(r.id) || 0 }));
}

async function keywordSearch(query, agentTag, limit = 10) {
  let result;
  if (agentTag) {
    result = await db.query(
      `SELECT * FROM memories
       WHERE agent_tag = ? AND content LIKE ? AND is_deleted = 0
       ORDER BY created_at DESC LIMIT ?`,
      [agentTag, `%${query}%`, limit]
    );
  } else {
    result = await db.query(
      `SELECT * FROM memories
       WHERE content LIKE ? AND is_deleted = 0
       ORDER BY created_at DESC LIMIT ?`,
      [`%${query}%`, limit]
    );
  }
  return result.rows;
}

async function causalWalk(topic, depth = 5) {
  const startMem = await db.query(
    `SELECT id FROM memories WHERE content LIKE ? ORDER BY created_at DESC LIMIT 1`,
    [`%${topic}%`]
  );
  if (!startMem.rows.length) return [];

  const result = await db.query(
    `WITH RECURSIVE causal_path AS (
       SELECT m.*, cl.target_id, cl.relation, 1 AS depth
       FROM memories m
       JOIN causal_links cl ON m.id = cl.memory_id
       WHERE m.id = ?
       UNION ALL
       SELECT m.*, cl.target_id, cl.relation, cp.depth + 1
       FROM memories m
       JOIN causal_links cl ON m.id = cl.memory_id
       JOIN causal_path cp ON cl.memory_id = cp.id
       WHERE cp.depth < ?
     )
     SELECT * FROM causal_path`,
    [startMem.rows[0].id, depth]
  );
  return result.rows;
}

async function getUnprocessedMemories(since, limit = 50) {
  let result;
  if (since) {
    result = await db.query(
      `SELECT * FROM memories WHERE enriched = 0 AND is_deleted = 0 AND created_at >= ? ORDER BY created_at LIMIT ?`,
      [since, limit]
    );
  } else {
    result = await db.query(
      `SELECT * FROM memories WHERE enriched = 0 AND is_deleted = 0 ORDER BY created_at LIMIT ?`,
      [limit]
    );
  }
  return result.rows;
}

async function enrichMemory(memoryId, facts, narrative) {
  await db.query(
    `UPDATE memories SET facts = ?, narrative = ?, enriched = 1 WHERE id = ?`,
    [JSON.stringify(facts), narrative, memoryId]
  );
}

async function createCausalLink(memoryId, targetId, relation, weight = 0.5) {
  const VALID_RELATIONS = ['caused', 'led_to', 'contradicts', 'references', 'supports', 'replaces'];
  if (!VALID_RELATIONS.includes(relation)) {
    throw new Error(`Invalid relation: "${relation}". Valid: ${VALID_RELATIONS.join(', ')}`);
  }
  const source = await db.query(`SELECT agent_tag FROM memories WHERE id = ?`, [memoryId]);
  if (!source.rows[0]) {
    throw new Error(`Memory ${memoryId} not found`);
  }
  const linkId = randomUUID();
  await db.query(
    `INSERT INTO causal_links (id, memory_id, target_id, relation, weight, created_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))`,
    [linkId, memoryId, targetId, relation, weight]
  );
  return linkId;
}

async function getTimelineWithNeighbors(topic, limit = 10) {
  const embedding = await getEmbedding(topic);
  const similar = await vector_search.searchSimilar(embedding, limit);
  if (similar.length === 0) return [];

  const ids = similar.map(s => s.memory_id);
  const placeholders = ids.map(() => '?').join(',');
  const memories = await db.query(
    `SELECT m.* FROM memories m WHERE m.id IN (${placeholders}) AND m.is_deleted = 0 LIMIT ?`,
    [...ids, limit]
  );

  if (memories.rows.length === 0) return [];

  const memoryIds = memories.rows.map(m => m.id);
  const placeholders2 = memoryIds.map(() => '?').join(',');
  const neighbors = await db.query(
    `SELECT cl.*, m.content, m.agent_tag, m.created_at,
            CASE WHEN cl.target_id IN (${placeholders2}) THEN 'before' ELSE 'after' END as direction
     FROM causal_links cl
     JOIN memories m ON (m.id = cl.target_id OR m.id = cl.memory_id)
     WHERE cl.target_id IN (${placeholders2}) OR cl.memory_id IN (${placeholders2})`,
    [...memoryIds, ...memoryIds]
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
  const result = await db.query(`SELECT * FROM memories WHERE id = ?`, [memoryId]);
  return result.rows[0] || null;
}

async function checkContradictions(memoryId, newFacts) {
  if (!srcCheckContradictions) return [];
  const memory = await getMemoryById(memoryId);
  if (!memory || !memory.facts) return [];
  const existingFacts = typeof memory.facts === 'string' ? JSON.parse(memory.facts) : memory.facts;
  return srcCheckContradictions(existingFacts, newFacts, process.env);
}

async function initializeRuntime() {
  initSchema();
  try {
    await vector_search.loadIndex();
  } catch (err) {
    console.error('Vector index load warning:', err.message);
  }
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
    <div class="legend-item"><div class="legend-color" style="background:#f39c12"></div>codex</div>
  </div>
  <svg id="graph"></svg>
  <script>
    const DATA = ${data};
    const agentColors = { opencode: '#7fdbff', hermes: '#ffdc00', openclaw: '#ff6b6b', george: '#01ff70', codex: '#f39c12', default: '#aaa' };
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
            agent_tag: { type: 'string', description: 'Agent tag (opencode, hermes, openclaw, george, codex)' },
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
      {
        name: 'memory_health',
        description: 'Report system health: DB connection, pending embeddings, unprocessed memories, orphan links, vault status',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'memory_repair',
        description: 'Retry failed embeddings and remove orphan causal links. Always reports counts. Only performs actions when flags are true.',
        inputSchema: {
          type: 'object',
          properties: {
            retry_embeddings: { type: 'boolean', default: false, description: 'Retry pending embeddings' },
            fix_orphans: { type: 'boolean', default: false, description: 'Delete orphan causal links' },
          },
        },
      },
      {
        name: 'memory_distill_people',
        description: 'Review-gated distillation of enriched memories into people file updates. Shows diff first, writes only after approval.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Person name (george, ching, shirley)' },
            since: { type: 'string', description: 'ISO date — only consider memories after this date' },
            dry_run: { type: 'boolean', default: true, description: 'If true, return diff without writing; if false, commit approved proposal' },
            proposal_id: { type: 'string', description: 'Required for commit (dry_run=false). Must match a cached proposal from a prior dry_run.' },
          },
          required: ['name'],
        },
      },
      {
        name: 'query_unified',
        description: 'Search across both Agent-Cortex memories and agentic-taskpad tasks. Returns merged results sorted by RRF relevance.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Natural language query' },
            limit: { type: 'number', default: 10 },
            memory_weight: { type: 'number', default: 0.6 },
            taskpad_filter: { type: 'string', enum: ['all', 'H_only', 'active'], default: 'active' }
          },
          required: ['query'],
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
      let errors = 0;
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
          if (!response.ok) {
            throw new Error(`Enrichment failed: ${response.status} ${response.statusText}`);
          }
          const data = await response.json();
          const rawContent = data.choices?.[0]?.message?.content || '';
          const parsed = parseEnrichmentPayload(rawContent);
          const facts = parsed.facts;
          const narrative = parsed.narrative;
          const suggestedLinks = parsed.links;
          const conflicts = await checkContradictions(mem.id, facts);
          if (conflicts.length > 0) {
            contradictions += conflicts.length;
            console.error(`Contradictions detected for ${mem.id}:`, JSON.stringify(conflicts));
          }
          await enrichMemory(mem.id, facts, narrative);

          for (const link of suggestedLinks) {
            try {
              const targetMem = await db.query(
                `SELECT id FROM memories
                 WHERE content LIKE ? AND id != ?
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
          errors++;
          console.error(`Failed to enrich ${mem.id}:`, err.message);
        }
      }

      return { content: [{ type: 'text', text: `Embeddings: ${embedResult.embedded}/${embedResult.attempted} retry ok${embedResult.errors && embedResult.errors.length > 0 ? ', errors: ' + embedResult.errors.length : ''}. Enriched: ${enriched}/${memories.length}. Contradictions: ${contradictions}. Auto-links created: ${linksCreated}. Errors: ${errors}` }] };
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
      const memories = await db.query(
        `SELECT id, agent_tag, content, created_at, facts, narrative FROM memories WHERE is_deleted = 0 ORDER BY created_at DESC LIMIT 500`
      );

      const links = await db.query(
        `SELECT cl.memory_id, cl.target_id, cl.relation, cl.weight FROM causal_links cl JOIN memories m ON cl.memory_id = m.id WHERE m.is_deleted = 0`
      );

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

    if (name === 'memory_health') {
      const checks = [];
      let dbOk = false;
      let vaultOk = false;

      try {
        await db.query(`SELECT 1`);
        dbOk = true;
        checks.push({ check: 'db_connection', status: 'ok', detail: 'Query SELECT 1 succeeded' });
      } catch (err) {
        checks.push({ check: 'db_connection', status: 'error', detail: err.message });
      }

      try {
        const pendingResult = await db.query(
          `SELECT COUNT(*) as count FROM memories m
           LEFT JOIN memory_embeddings e ON m.id = e.memory_id
           WHERE m.embedding_pending = 1 AND e.id IS NULL AND m.is_deleted = 0`
        );
        checks.push({ check: 'pending_embeddings', status: 'ok', detail: `${pendingResult.rows[0].count} pending` });
      } catch (err) {
        checks.push({ check: 'pending_embeddings', status: 'error', detail: err.message });
      }

      try {
        const unprocessedResult = await db.query(
          `SELECT COUNT(*) as count FROM memories WHERE enriched = 0 AND is_deleted = 0`
        );
        checks.push({ check: 'unprocessed_memories', status: 'ok', detail: `${unprocessedResult.rows[0].count} unprocessed` });
      } catch (err) {
        checks.push({ check: 'unprocessed_memories', status: 'error', detail: err.message });
      }

      try {
        const orphanResult = await db.query(
          `SELECT COUNT(*) as count FROM causal_links cl
           WHERE NOT EXISTS (SELECT 1 FROM memories WHERE id = cl.memory_id)
              OR NOT EXISTS (SELECT 1 FROM memories WHERE id = cl.target_id)`
        );
        checks.push({ check: 'orphan_links', status: 'ok', detail: `${orphanResult.rows[0].count} orphans` });
      } catch (err) {
        checks.push({ check: 'orphan_links', status: 'error', detail: err.message });
      }

      try {
        const [memResult, embResult, linkResult] = await Promise.all([
          db.query(`SELECT COUNT(*) as count FROM memories WHERE is_deleted = 0`),
          db.query(`SELECT COUNT(*) as count FROM memory_embeddings`),
          db.query(`SELECT COUNT(*) as count FROM causal_links`),
        ]);
        checks.push({
          check: 'db_stats',
          status: 'ok',
          detail: `memories:${memResult.rows[0].count} embeddings:${embResult.rows[0].count} links:${linkResult.rows[0].count}`,
        });
      } catch (err) {
        checks.push({ check: 'db_stats', status: 'error', detail: err.message });
      }

      try {
        await fs.access(VAULT_ROOT);
        vaultOk = true;
        checks.push({ check: 'vault_readable', status: 'ok', detail: VAULT_ROOT });
      } catch (err) {
        checks.push({ check: 'vault_readable', status: 'error', detail: err.message });
      }

      const allOk = dbOk && vaultOk && checks.every(c => c.status === 'ok');
      const health = {
        status: allOk ? 'ok' : 'degraded',
        timestamp: new Date().toISOString(),
        checks,
      };

      return { content: [{ type: 'text', text: JSON.stringify(health, null, 2) }] };
    }

    if (name === 'memory_repair') {
      const { retry_embeddings = false, fix_orphans = false } = args;
      const errors = [];

      let pendingCount = 0;
      let orphanCount = 0;
      let embedded = 0;
      let deleted = 0;
      let embedding_errors = [];

      try {
        const pendingResult = await db.query(
          `SELECT COUNT(*) as count FROM memories m
           LEFT JOIN memory_embeddings e ON m.id = e.memory_id
           WHERE m.embedding_pending = 1 AND e.id IS NULL AND m.is_deleted = 0`
        );
        pendingCount = parseInt(pendingResult.rows[0].count, 10);
      } catch (err) {
        errors.push(`pending query: ${err.message}`);
      }

      try {
        const orphanResult = await db.query(
          `SELECT COUNT(*) as count FROM causal_links cl
           WHERE NOT EXISTS (SELECT 1 FROM memories WHERE id = cl.memory_id)
              OR NOT EXISTS (SELECT 1 FROM memories WHERE id = cl.target_id)`
        );
        orphanCount = parseInt(orphanResult.rows[0].count, 10);
      } catch (err) {
        errors.push(`orphan query: ${err.message}`);
      }

      if (fix_orphans && orphanCount > 0) {
        try {
          const deleteResult = await db.query(
            `DELETE FROM causal_links cl
             WHERE NOT EXISTS (SELECT 1 FROM memories WHERE id = cl.memory_id)
                OR NOT EXISTS (SELECT 1 FROM memories WHERE id = cl.target_id)`
          );
          deleted = deleteResult.rowCount || 0;
        } catch (err) {
          errors.push(`orphan delete: ${err.message}`);
        }
      }

      let cleared_stale_pending = null;
      if (retry_embeddings && pendingCount > 0) {
        try {
          const staleResult = await db.query(
            `SELECT COUNT(*) as count FROM memories m
             JOIN memory_embeddings e ON m.id = e.memory_id
             WHERE m.embedding_pending = 1 AND m.is_deleted = 0`
          );
          cleared_stale_pending = parseInt(staleResult.rows[0].count, 10);
          if (cleared_stale_pending > 0) {
            await db.query(
              `UPDATE memories SET embedding_pending = 0
               WHERE id IN (
                 SELECT m.id FROM memories m
                 JOIN memory_embeddings e ON m.id = e.memory_id
                 WHERE m.embedding_pending = 1 AND m.is_deleted = 0
               )`
            );
          }
        } catch (err) {
          errors.push(`clear stale pending: ${err.message}`);
        }

        try {
          const result = await retryPendingEmbeddings();
          embedded = result.embedded;
          embedding_errors = result.errors || [];
        } catch (err) {
          errors.push(`retry embeddings: ${err.message}`);
        }
      }

      const repairSummary = {
        timestamp: new Date().toISOString(),
        pending_embeddings: pendingCount,
        orphan_links: orphanCount,
        actions: {
          retry_embeddings,
          fix_orphans,
        },
        results: {
          embedded: retry_embeddings ? embedded : null,
          deleted: fix_orphans ? deleted : null,
          embedding_errors: retry_embeddings ? embedding_errors : null,
          cleared_stale_pending,
        },
        errors,
      };

      return { content: [{ type: 'text', text: JSON.stringify(repairSummary, null, 2) }] };
    }

    if (name === 'memory_distill_people') {
      const { name: personName, since, dry_run = true, proposal_id } = args;

      // Authorization: only george server can commit
      if (!dry_run && (!SERVER_AGENT_TAG || SERVER_AGENT_TAG !== 'george')) {
        throw new Error(`Forbidden: memory_distill_people commit requires server configured as "george", got "${SERVER_AGENT_TAG || 'unset'}"`);
      }

      // proposal_id required for commit
      if (!dry_run && !proposal_id) {
        throw new Error('proposal_id is required for dry_run=false');
      }

      const normalizedName = normalizePersonName(personName);
      if (!normalizedName) {
        throw new Error(`Invalid person name: "${personName}"`);
      }

      // --- DRY RUN (read-only) ---
      if (dry_run || !proposal_id) {
        // Count unprocessed (non-enriched) memories — respects since if provided
        let unprocessedCount = 0;
        try {
          let countSql;
          const countParams = since ? [since] : [];
          if (since) {
            countSql = `SELECT COUNT(*) as count FROM memories WHERE enriched = 0 AND is_deleted = 0 AND created_at >= ?`;
          } else {
            countSql = `SELECT COUNT(*) as count FROM memories WHERE enriched = 0 AND is_deleted = 0`;
          }
          const unprocessedResult = await db.query(countSql, countParams);
          unprocessedCount = parseInt(unprocessedResult.rows[0].count, 10);
        } catch { /* ignore count failures */ }

        // Query only already-enriched source memories for this person — respects since
        const sql = buildPeopleMemorySelectSql({ since });
        const params = buildPeopleMemorySelectParams(normalizedName, { since });
        const { rows: sourceMemories } = await db.query(sql, params);

        // Read current people file
        const currentContent = await readPeopleFile(normalizedName);

        // Build LLM prompt and call
        const prompt = buildDistillPrompt(normalizedName, currentContent, sourceMemories);
        const llmResponse = await fetch(`${LLM_URL}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: LLM_MODEL,
            messages: [{ role: 'user', content: prompt }],
          }),
        });
        const llmData = await llmResponse.json();
        const rawLLM = llmData.choices?.[0]?.message?.content || '';
        const proposedMarkdown = parseDistillResponse(rawLLM);

        // Build full content with provenance
        const proposedContent = buildProposedPeopleContent(normalizedName, proposedMarkdown, sourceMemories);
        const currentHash = hashContent(currentContent);

        // Cache proposal
        const idSuffix = Date.now().toString(36);
        const cachedProposalId = `${normalizedName}-${idSuffix}`;
        proposals.set(cachedProposalId, {
          personName: normalizedName,
          currentHash,
          proposedContent,
          sourceIds: sourceMemories.map(m => m.id),
          sourceMemories,
        });

        // Build diff
        const diff = createUnifiedDiff(currentContent, proposedContent, normalizedName);

        const unprocessedNote = unprocessedCount > 0
          ? ` Note: ${unprocessedCount} unprocessed memories exist. Run \`memory_enrich\` first if you want them included.`
          : '';

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              proposal_id: cachedProposalId,
              status: 'dry_run (read-only)',
              person: normalizedName,
              diff: diff || '(no changes)',
              source_count: sourceMemories.length,
              source_ids: sourceMemories.map(m => m.id),
              unprocessed_count: unprocessedCount,
              message: `This was a read-only dry run — no memories were enriched. Review the diff above. To commit, re-call with dry_run=false and proposal_id.${unprocessedNote}`,
            }, null, 2),
          }],
        };
      }

      // --- COMMIT ---
      const cached = proposals.get(proposal_id);
      if (!cached) {
        throw new Error(`Unknown proposal_id "${proposal_id}" — run dry_run first`);
      }

      // Validate personName matches cached proposal
      if (cached.personName !== normalizedName) {
        throw new Error(`personName mismatch: got "${normalizedName}" but proposal is for "${cached.personName}"`);
      }

      // Re-read current file and check hash
      const currentContentNow = await readPeopleFile(cached.personName);
      const currentHashNow = hashContent(currentContentNow);

      if (currentHashNow !== cached.currentHash) {
        proposals.delete(proposal_id);
        throw new Error(`Conflict: people file has changed since proposal was generated. Please re-run dry_run.`);
      }

      // Ensure vault dir before write
      await ensureVaultDir();

      // Write exact cached proposal content directly (bypass writePeopleFile which prepends a header)
      const filename = `people - ${cached.personName}.md`;
      const filepath = path.join(VAULT_ROOT, filename);
      await fs.writeFile(filepath, cached.proposedContent, { flag: 'w' });
      proposals.delete(proposal_id);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: 'committed',
            person: cached.personName,
            sources: cached.sourceIds,
            message: `People file updated for ${cached.personName} from ${cached.sourceIds.length} source memories.`,
          }, null, 2),
        }],
      };
    }

    if (name === 'query_unified') {
      return handleQueryUnified(args);
    }

    throw new Error(`Unknown tool: ${name}`);
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
  }
});

async function main() {
  await initializeRuntime();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Agent Cortex MCP server running');
}

main().catch(console.error);
