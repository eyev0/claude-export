#!/usr/bin/env node

// claude-sync.js — Incrementally sync all Claude.ai conversations to local markdown files
// No external dependencies. Requires Node.js 18+ (built-in fetch).

const fs = require('fs');
const path = require('path');

// ─── Configuration ───────────────────────────────────────────────────────────

const BASE_URL = 'https://claude.ai';
const API_DELAY_MS = 200;
const MAX_RETRIES = 3;
const BACKOFF_BASE_MS = 1000;
const MANIFEST_FILE = '.sync-manifest.json';

// ─── Utilities ───────────────────────────────────────────────────────────────

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function formatTimestamp(isoString) {
  if (!isoString) return null;
  return new Date(isoString).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit'
  });
}

function sanitizeFilename(name) {
  if (!name) return 'untitled';
  return name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/\.+$/, '')
    .toLowerCase()
    .substring(0, 100) || 'untitled';
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

// ─── Section 1: API Client ──────────────────────────────────────────────────

function createApiClient(sessionKey, orgId) {
  let requestCount = 0;

  async function apiFetch(endpoint, retries = 0) {
    const url = `${BASE_URL}/api/organizations/${orgId}${endpoint}`;

    // Rate-limit: pause between requests
    if (requestCount > 0) {
      await delay(API_DELAY_MS);
    }
    requestCount++;

    let res;
    try {
      res = await fetch(url, {
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
          'Referer': 'https://claude.ai/',
          'Origin': 'https://claude.ai',
          'Cookie': sessionKey
        }
      });
    } catch (err) {
      throw new Error(`Network error fetching ${endpoint}: ${err.message}`);
    }

    if (res.status === 401 || res.status === 403) {
      throw new Error(
        'Session expired or forbidden (HTTP ' + res.status + '). ' +
        'Please refresh your CLAUDE_SESSION_KEY cookie.'
      );
    }

    if (res.status === 429 && retries < MAX_RETRIES) {
      const wait = BACKOFF_BASE_MS * Math.pow(2, retries);
      console.warn(`  Rate limited (429). Retrying in ${wait}ms... (attempt ${retries + 1}/${MAX_RETRIES})`);
      await delay(wait);
      return apiFetch(endpoint, retries + 1);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`API error ${res.status} on ${endpoint}: ${body.substring(0, 200)}`);
    }

    return res.json();
  }

  return {
    listProjects: () => apiFetch('/projects'),
    getProject: (id) => apiFetch(`/projects/${id}`),
    getProjectDocs: (id) => apiFetch(`/projects/${id}/docs`),
    listConversations: () => apiFetch('/chat_conversations'),
    getConversation: (id) =>
      apiFetch(`/chat_conversations/${id}?tree=true&rendering_mode=messages&render_all_tools=true`),
  };
}

// ─── Section 2: Manifest Manager ────────────────────────────────────────────

function readManifest(outputDir) {
  const manifestPath = path.join(outputDir, MANIFEST_FILE);
  if (fs.existsSync(manifestPath)) {
    try {
      return JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    } catch (err) {
      console.warn(`Warning: corrupt manifest, starting fresh. (${err.message})`);
    }
  }
  return {
    lastSync: null,
    orgId: null,
    conversations: {},
    projects: {}
  };
}

function writeManifest(outputDir, manifest) {
  manifest.lastSync = new Date().toISOString();
  const manifestPath = path.join(outputDir, MANIFEST_FILE);
  // Write atomically: write to temp file then rename
  const tmpPath = manifestPath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(manifest, null, 2) + '\n');
  fs.renameSync(tmpPath, manifestPath);
}

function shouldSyncConversation(manifest, convId, updatedAt) {
  const existing = manifest.conversations[convId];
  if (!existing) return true;
  return existing.updatedAt !== updatedAt;
}

function shouldSyncProject(manifest, projectId, updatedAt) {
  const existing = manifest.projects[projectId];
  if (!existing) return true;
  return existing.updatedAt !== updatedAt;
}

function updateManifestConversation(manifest, convId, data) {
  manifest.conversations[convId] = {
    title: data.title,
    projectId: data.projectId || null,
    updatedAt: data.updatedAt,
    messageCount: data.messageCount,
    filePath: data.filePath
  };
}

function updateManifestProject(manifest, projectId, data) {
  manifest.projects[projectId] = {
    name: data.name,
    updatedAt: data.updatedAt
  };
}

// ─── Section 3: Markdown Converter ──────────────────────────────────────────

/**
 * Extract displayable text from a message's content blocks.
 * Rules:
 *   - type "text"     -> include the text
 *   - type "thinking" -> skip (internal reasoning)
 *   - type "tool_use" -> skip (tool call mechanics)
 *   - type "tool_result" -> skip (tool result mechanics)
 *   - anything else   -> skip
 */
function extractMessageContent(message) {
  const content = message.content;

  // Sometimes content is just a plain string
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return message.text || '';

  const parts = [];

  for (const block of content) {
    if (block.type === 'text' && block.text) {
      parts.push(block.text);
    }
    // Skip: thinking, tool_use, tool_result, and any other block types
  }

  // Fallback: if content array was empty or had no text blocks,
  // try the top-level `text` field
  if (parts.length === 0 && message.text) {
    return message.text;
  }

  return parts.join('\n\n');
}

function buildConversationMarkdown(conversation) {
  const title = conversation.name || 'Untitled Conversation';
  const updatedAt = formatTimestamp(conversation.updated_at);
  const model = conversation.model || 'unknown';
  const messages = conversation.chat_messages || [];
  const messageCount = messages.length;

  let md = `# ${title}\n\n`;
  md += `> Exported from Claude.ai`;
  if (updatedAt) md += ` | Last updated: ${updatedAt}`;
  md += '\n';
  md += `> Model: ${model} | Messages: ${messageCount}\n\n`;
  md += '---\n\n';

  for (const msg of messages) {
    const sender = msg.sender === 'human' ? 'Human' : 'Claude';
    const ts = formatTimestamp(msg.created_at);
    const header = ts ? `## ${sender} (${ts}):` : `## ${sender}:`;
    const content = extractMessageContent(msg);

    if (content.trim()) {
      md += `${header}\n\n${content}\n\n---\n\n`;
    }
  }

  return md;
}

function buildProjectInstructionsMd(project, instructions) {
  let md = `# ${project.name || 'Unnamed Project'} -- Project Instructions\n\n`;
  if (project.description) {
    md += `> ${project.description}\n\n`;
  }
  md += instructions + '\n';
  return md;
}

// ─── Section 4: Export Logic ────────────────────────────────────────────────

async function exportProject(api, project, outputDir, manifest, force) {
  const projectId = project.uuid;
  const projectName = sanitizeFilename(project.name);
  const updatedAt = project.updated_at;
  const projectDir = path.join(outputDir, 'projects', projectName);

  if (!force && !shouldSyncProject(manifest, projectId, updatedAt)) {
    console.log(`  [skip] Project "${project.name}" (unchanged)`);
    return { dir: projectDir, status: 'skipped' };
  }

  console.log(`  [sync] Project: ${project.name}`);
  ensureDir(projectDir);

  // Fetch project detail for instructions (prompt_template)
  try {
    const detail = await api.getProject(projectId);
    const instructions = detail.prompt_template || '';

    if (instructions.trim()) {
      const mdContent = buildProjectInstructionsMd(project, instructions);
      fs.writeFileSync(path.join(projectDir, 'instructions.md'), mdContent);
      console.log(`         Saved instructions.md`);
    }
  } catch (err) {
    console.error(`         Failed to fetch project details: ${err.message}`);
  }

  // Fetch project docs
  try {
    const docs = await api.getProjectDocs(projectId);
    const docArray = Array.isArray(docs) ? docs : [];

    if (docArray.length > 0) {
      const docsDir = path.join(projectDir, 'docs');
      ensureDir(docsDir);

      for (const doc of docArray) {
        const filename = doc.file_name || `doc-${doc.uuid}.txt`;
        const content = doc.content || '';

        if (content) {
          const ext = path.extname(filename);
          const base = path.basename(filename, ext);
          const safeFilename = sanitizeFilename(base) + ext.toLowerCase();
          fs.writeFileSync(path.join(docsDir, safeFilename), content);
          console.log(`         Saved doc: ${filename}`);
        }
      }
    }
  } catch (err) {
    console.error(`         Failed to fetch project docs: ${err.message}`);
  }

  updateManifestProject(manifest, projectId, {
    name: projectName,
    updatedAt
  });

  return { dir: projectDir, status: 'synced' };
}

async function exportConversation(api, convSummary, targetDir, outputDir, manifest, force) {
  const convId = convSummary.uuid;
  const updatedAt = convSummary.updated_at;

  if (!force && !shouldSyncConversation(manifest, convId, updatedAt)) {
    return 'skipped';
  }

  const title = convSummary.name || 'untitled';
  const sanitizedTitle = sanitizeFilename(title);
  const filename = sanitizedTitle + '_' + convId.substring(0, 8) + '.md';
  const filePath = path.join(targetDir, filename);

  try {
    console.log(`    [sync] ${title}`);
    const conversation = await api.getConversation(convId);
    const markdown = buildConversationMarkdown(conversation);

    ensureDir(targetDir);
    fs.writeFileSync(filePath, markdown);

    const relativePath = path.relative(outputDir, filePath);

    updateManifestConversation(manifest, convId, {
      title: sanitizedTitle,
      projectId: convSummary.project_uuid || null,
      updatedAt,
      messageCount: conversation.chat_messages?.length || 0,
      filePath: relativePath
    });

    // Save manifest after each successful conversation (crash-resumable)
    writeManifest(outputDir, manifest);

    return 'exported';
  } catch (err) {
    console.error(`    [FAIL] "${title}": ${err.message}`);
    return 'error';
  }
}

// ─── Section 5: CLI Orchestrator ────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const flags = { force: false, project: null, outputDir: null };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--force' || args[i] === '-f') {
      flags.force = true;
    } else if ((args[i] === '--project' || args[i] === '-p') && args[i + 1]) {
      flags.project = args[++i];
    } else if (args[i] === '--help' || args[i] === '-h') {
      flags.help = true;
    } else if (!args[i].startsWith('-')) {
      flags.outputDir = args[i];
    }
  }

  return flags;
}

function printUsage() {
  console.log(`
claude-sync — Incrementally sync Claude.ai conversations to local markdown

Usage:
  node claude-sync.js <output-dir> [options]

Options:
  --force, -f            Re-download all conversations (ignore manifest)
  --project, -p "name"   Only sync a specific project (by name)
  --help, -h             Show this help message

Environment:
  CLAUDE_SESSION_KEY     Your Claude.ai session cookie string
                         (copy from browser DevTools -> Application -> Cookies)
                         Should include "sessionKey=sk-ant-..." and optionally
                         "lastActiveOrg=..."

Examples:
  export CLAUDE_SESSION_KEY="sessionKey=sk-ant-sid01-...; lastActiveOrg=..."
  node claude-sync.js ./archive             # sync all
  node claude-sync.js ./archive --force     # re-download everything
  node claude-sync.js ./archive -p "My Project"  # sync one project only
`);
}

function extractOrgId(sessionKey) {
  const match = sessionKey.match(/lastActiveOrg=([^;]+)/);
  return match ? match[1].trim() : null;
}

async function discoverOrgId(sessionKey) {
  console.log('Organization ID not found in cookie. Discovering via API...');
  try {
    const res = await fetch(`${BASE_URL}/api/auth/session`, {
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
        'Referer': 'https://claude.ai/',
        'Origin': 'https://claude.ai',
        'Cookie': sessionKey
      }
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const session = await res.json();

    // Try various known locations for org ID
    const orgId =
      session.account?.memberships?.[0]?.organization?.uuid ||
      session.organization?.uuid ||
      session.orgId ||
      null;

    if (orgId) {
      console.log(`Discovered org ID: ${orgId}`);
    }

    return orgId;
  } catch (err) {
    console.error(`Failed to discover org ID: ${err.message}`);
    return null;
  }
}

async function main() {
  const flags = parseArgs();

  if (flags.help || !flags.outputDir) {
    printUsage();
    process.exit(flags.help ? 0 : 1);
  }

  // Validate session key
  const sessionKey = process.env.CLAUDE_SESSION_KEY;
  if (!sessionKey) {
    console.error('Error: CLAUDE_SESSION_KEY environment variable is not set.');
    console.error('');
    console.error('How to get your session cookie:');
    console.error('  1. Open https://claude.ai in your browser');
    console.error('  2. Open DevTools (F12) -> Application -> Cookies -> claude.ai');
    console.error('  3. Copy the "sessionKey" value (starts with sk-ant-)');
    console.error('  4. Export it:');
    console.error('     export CLAUDE_SESSION_KEY="sessionKey=sk-ant-...; lastActiveOrg=..."');
    process.exit(1);
  }

  if (!sessionKey.includes('sessionKey=')) {
    console.warn('Warning: CLAUDE_SESSION_KEY does not appear to contain "sessionKey=...".');
    console.warn('Make sure you copied the full cookie value.');
  }

  // Resolve org ID
  let orgId = extractOrgId(sessionKey);
  if (!orgId) {
    orgId = await discoverOrgId(sessionKey);
  }

  if (!orgId) {
    console.error('Error: Could not determine organization ID.');
    console.error('Include "lastActiveOrg=..." in your CLAUDE_SESSION_KEY cookie string,');
    console.error('or ensure your session cookie is valid for org ID discovery.');
    process.exit(1);
  }

  const outputDir = path.resolve(flags.outputDir);
  ensureDir(outputDir);

  console.log(`Organization: ${orgId}`);
  console.log(`Output:       ${outputDir}`);
  if (flags.force) console.log('Mode:         FORCE (re-downloading all)');
  if (flags.project) console.log(`Filter:       project = "${flags.project}"`);
  console.log('');

  const api = createApiClient(sessionKey, orgId);
  const manifest = readManifest(outputDir);
  manifest.orgId = orgId;

  const stats = { projects: 0, projectsSkipped: 0, conversations: 0, skipped: 0, errors: 0 };

  // ── Phase 1: Export Projects ────────────────────────────────────────────

  console.log('Fetching projects...');
  let projects = [];
  try {
    const data = await api.listProjects();
    projects = Array.isArray(data) ? data : [];
    console.log(`Found ${projects.length} project(s)\n`);
  } catch (err) {
    console.error(`Failed to fetch projects: ${err.message}\n`);
  }

  // Map project UUID -> output directory
  const projectDirs = {};

  for (const project of projects) {
    // Filter by project name if --project flag set
    if (flags.project) {
      const needle = flags.project.toLowerCase();
      const haystack = (project.name || '').toLowerCase();
      if (!haystack.includes(needle) && sanitizeFilename(project.name) !== sanitizeFilename(flags.project)) {
        continue;
      }
    }

    try {
      const result = await exportProject(api, project, outputDir, manifest, flags.force);
      projectDirs[project.uuid] = result.dir;
      if (result.status === 'synced') {
        stats.projects++;
        writeManifest(outputDir, manifest);
      } else {
        stats.projectsSkipped++;
      }
    } catch (err) {
      console.error(`  [ERROR] Project "${project.name}": ${err.message}`);
      stats.errors++;
    }
  }

  // ── Phase 2: Export Conversations ───────────────────────────────────────

  console.log('\nFetching conversations...');
  let conversations = [];
  try {
    const data = await api.listConversations();
    conversations = Array.isArray(data) ? data : [];
    console.log(`Found ${conversations.length} conversation(s)\n`);
    if (conversations.length > 0 && conversations.length % 50 === 0) {
      console.warn(`Warning: Got exactly ${conversations.length} conversations -- the API may be paginating. Some conversations could be missing.`);
    }
  } catch (err) {
    console.error(`Failed to fetch conversations: ${err.message}\n`);
  }

  for (const conv of conversations) {
    const projectId = conv.project_uuid || null;

    // When filtering by project, skip conversations not in that project
    if (flags.project) {
      if (!projectId || !projectDirs[projectId]) {
        continue;
      }
    }

    // Determine target directory
    let targetDir;
    if (projectId && projectDirs[projectId]) {
      targetDir = projectDirs[projectId];
    } else if (projectId) {
      // Conversation belongs to a project we didn't export (e.g., filtered out).
      // Try to name the folder from the conversation's embedded project object.
      const projName = conv.project?.name
        ? sanitizeFilename(conv.project.name)
        : `project-${projectId.substring(0, 8)}`;
      targetDir = path.join(outputDir, 'projects', projName);
    } else {
      targetDir = path.join(outputDir, 'conversations');
    }

    const result = await exportConversation(api, conv, targetDir, outputDir, manifest, flags.force);

    if (result === 'exported') {
      stats.conversations++;
    } else if (result === 'error') {
      stats.errors++;
    } else {
      stats.skipped++;
    }
  }

  // ── Summary ─────────────────────────────────────────────────────────────

  console.log('');
  console.log('='.repeat(52));
  console.log('  Sync complete');
  console.log('='.repeat(52));
  console.log(`  Projects synced:        ${stats.projects}${stats.projectsSkipped ? `, ${stats.projectsSkipped} skipped` : ''}`);
  console.log(`  Conversations exported: ${stats.conversations}`);
  console.log(`  Conversations skipped:  ${stats.skipped} (unchanged)`);
  if (stats.errors > 0) {
    console.log(`  Errors:                 ${stats.errors}`);
  }
  console.log(`  Output directory:       ${outputDir}`);
  console.log('='.repeat(52));
}

main().catch(err => {
  console.error(`\nFatal error: ${err.message}`);
  if (err.message.includes('Session expired') || err.message.includes('forbidden')) {
    console.error('Your session cookie may have expired. Please get a fresh one from claude.ai.');
  }
  process.exit(1);
});
