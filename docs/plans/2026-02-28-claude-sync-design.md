# Claude Sync Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a Node.js CLI tool that incrementally syncs all Claude.ai conversations to local markdown files, organized by project.

**Architecture:** Single-file Node.js script using only built-in modules (fetch, fs, path). Authenticates via session cookie. Maintains a sync manifest to only download new/changed conversations. Outputs markdown organized into project folders.

**Tech Stack:** Node.js 18+ (built-in fetch), no external dependencies

---

### Task 1: API Discovery Probe

**Purpose:** Before building the full tool, we need to confirm the actual API endpoints and response shapes. This is a throwaway script the user runs in their browser console.

**Files:**
- Create: `api-probe.js` (browser console script, will be deleted after use)

**Step 1: Write the probe script**

This script runs in the browser console on claude.ai and dumps the actual API response shapes to the console. The user copies the output so we can see the real field names.

```javascript
// Paste in browser console on claude.ai
(async () => {
  const orgId = document.cookie.match(/lastActiveOrg=([^;]+)/)?.[1];
  if (!orgId) { console.error('No orgId found in cookies'); return; }

  const api = async (path) => {
    const r = await fetch(`/api/organizations/${orgId}${path}`, {
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' }
    });
    if (!r.ok) return { error: r.status, path };
    return r.json();
  };

  console.log('=== ORG ID ===');
  console.log(orgId);

  console.log('\n=== PROJECTS LIST (first 2) ===');
  const projects = await api('/projects?limit=2');
  console.log(JSON.stringify(projects, null, 2));

  if (projects && !projects.error) {
    const projArray = Array.isArray(projects) ? projects : projects.results || projects.data || [];
    if (projArray.length > 0) {
      const proj = projArray[0];
      const projId = proj.uuid || proj.id;
      console.log('\n=== SINGLE PROJECT ===');
      console.log(JSON.stringify(proj, null, 2));

      console.log('\n=== PROJECT DOCS ===');
      const docs = await api(`/projects/${projId}/docs`);
      console.log(JSON.stringify(docs, null, 2));
    }
  }

  console.log('\n=== CONVERSATIONS LIST (first 2) ===');
  const convos = await api('/chat_conversations?limit=2');
  console.log(JSON.stringify(convos, null, 2));

  if (convos && !convos.error) {
    const convoArray = Array.isArray(convos) ? convos : convos.results || convos.data || [];
    if (convoArray.length > 0) {
      const convoId = convoArray[0].uuid || convoArray[0].id;
      console.log('\n=== SINGLE CONVERSATION (first 2 messages) ===');
      const full = await api(`/chat_conversations/${convoId}?tree=true&rendering_mode=messages&render_all_tools=true`);
      if (full.chat_messages) {
        const preview = { ...full, chat_messages: full.chat_messages.slice(0, 2) };
        console.log(JSON.stringify(preview, null, 2));
      } else {
        console.log(JSON.stringify(full, null, 2));
      }
    }
  }

  console.log('\n=== DONE ===');
})();
```

**Step 2: User runs the probe**

Run: Paste script in browser console on https://claude.ai
Expected: JSON output showing actual API response shapes for projects, conversations, and docs

**Step 3: Capture the output**

Save the console output to `api-probe-output.json` for reference during implementation. This tells us:
- How projects list is paginated (array vs `{ results: [] }`)
- Field names for project ID, name, instructions
- How conversations list is paginated
- Field names for conversation ID, title, updated_at, project_id
- Message content block structure (text, artifacts, tool_use)
- How project docs/files are represented

---

### Task 2: Build the API Client Layer

**Files:**
- Create: `claude-sync.js` (lines 1-150 approx)

**Step 1: Write the foundation — imports, constants, and API client**

```javascript
#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

// ─── Configuration ───────────────────────────────────────────
const BASE_URL = 'https://claude.ai';
const API_DELAY_MS = 200;
const MAX_RETRIES = 3;
const BACKOFF_BASE_MS = 1000;

// ─── API Client ──────────────────────────────────────────────

function createApiClient(sessionKey, orgId) {
  async function apiFetch(endpoint, retries = 0) {
    const url = `${BASE_URL}/api/organizations/${orgId}${endpoint}`;

    await delay(API_DELAY_MS);

    const res = await fetch(url, {
      headers: {
        'Content-Type': 'application/json',
        'Cookie': sessionKey
      }
    });

    if (res.status === 401) {
      throw new Error('Session expired. Please refresh your CLAUDE_SESSION_KEY.');
    }

    if (res.status === 429 && retries < MAX_RETRIES) {
      const wait = BACKOFF_BASE_MS * Math.pow(2, retries);
      console.warn(`  Rate limited. Retrying in ${wait}ms...`);
      await delay(wait);
      return apiFetch(endpoint, retries + 1);
    }

    if (!res.ok) {
      throw new Error(`API ${res.status}: ${endpoint}`);
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
    // Will be adjusted based on probe results for pagination
    listConversationsPaginated: async function* () {
      // Probe results will tell us if this uses cursor, offset, or returns all at once
      // Initial implementation: try fetching all
      const data = await this.listConversations();
      const items = Array.isArray(data) ? data : data.results || data.data || [];
      yield* items;
    }
  };
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
```

**Step 2: Run a quick smoke test**

Run: `node -e "require('./claude-sync.js')" 2>&1 || echo "Syntax check"`
Expected: No syntax errors (will fail on missing args, which is fine)

**Step 3: Commit**

```bash
git add claude-sync.js
git commit -m "feat: add API client layer with retry and rate limiting"
```

---

### Task 3: Build the Manifest Manager

**Files:**
- Modify: `claude-sync.js` (append after API client section)

**Step 1: Write manifest read/write/compare functions**

```javascript
// ─── Manifest Manager ────────────────────────────────────────

const MANIFEST_FILE = '.sync-manifest.json';

function readManifest(outputDir) {
  const manifestPath = path.join(outputDir, MANIFEST_FILE);
  if (fs.existsSync(manifestPath)) {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
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
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
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
```

**Step 2: Commit**

```bash
git add claude-sync.js
git commit -m "feat: add sync manifest manager for incremental updates"
```

---

### Task 4: Build the Markdown Converter

**Files:**
- Modify: `claude-sync.js` (append after manifest section)

**Step 1: Write the message-to-markdown conversion**

This is the core content extraction logic. Key decisions:
- Human messages: extract text content blocks
- Claude messages: extract text + artifact content
- Skip: tool_use, tool_result blocks (unless they contain artifacts)
- Artifacts: inline the content with language-tagged code fences

```javascript
// ─── Markdown Converter ──────────────────────────────────────

function formatTimestamp(isoString) {
  if (!isoString) return null;
  return new Date(isoString).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit'
  });
}

function sanitizeFilename(name) {
  return name
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase()
    .substring(0, 100);
}

function extractMessageContent(message) {
  // Content can be a string or array of content blocks
  const content = message.content;

  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content || '');

  const parts = [];

  for (const block of content) {
    if (block.type === 'text') {
      parts.push(block.text);
    } else if (block.type === 'tool_result') {
      // tool_result may contain nested content with artifacts
      if (Array.isArray(block.content)) {
        for (const inner of block.content) {
          if (inner.type === 'text') parts.push(inner.text);
        }
      }
    }
    // Skip tool_use blocks entirely — these are the tool call mechanics
    // Artifacts are typically rendered as text blocks in the API response
    // with rendering_mode=messages, but we handle them if they appear separately
  }

  return parts.join('\n\n');
}

function buildConversationMarkdown(conversation) {
  const title = conversation.name || 'Untitled Conversation';
  const updatedAt = formatTimestamp(conversation.updated_at);
  const model = conversation.model || 'unknown';
  const messageCount = conversation.chat_messages?.length || 0;

  let md = `# ${title}\n\n`;
  md += `> Exported from Claude.ai`;
  if (updatedAt) md += ` | Last updated: ${updatedAt}`;
  md += `\n`;
  md += `> Model: ${model} | Messages: ${messageCount}\n\n`;
  md += `---\n\n`;

  if (!conversation.chat_messages) return md;

  for (const msg of conversation.chat_messages) {
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
```

**Step 2: Commit**

```bash
git add claude-sync.js
git commit -m "feat: add markdown converter for conversation export"
```

---

### Task 5: Build the Export Logic (Projects + Conversations)

**Files:**
- Modify: `claude-sync.js` (append after markdown converter)

**Step 1: Write the project and conversation export functions**

```javascript
// ─── Export Logic ────────────────────────────────────────────

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

async function exportProject(api, project, outputDir, manifest, force) {
  const projectId = project.uuid || project.id;
  const projectName = sanitizeFilename(project.name || 'unnamed-project');
  const updatedAt = project.updated_at || project.updated_at_iso;
  const projectDir = path.join(outputDir, 'projects', projectName);

  if (!force && !shouldSyncProject(manifest, projectId, updatedAt)) {
    console.log(`  Skipping project "${project.name}" (unchanged)`);
    return projectDir;
  }

  console.log(`  Syncing project: ${project.name}`);
  ensureDir(projectDir);

  // Export project instructions
  try {
    const projectData = await api.getProject(projectId);
    const instructions = projectData.prompt_template
      || projectData.instructions
      || projectData.system_prompt
      || '';

    if (instructions.trim()) {
      fs.writeFileSync(
        path.join(projectDir, 'instructions.md'),
        `# ${project.name} — Project Instructions\n\n${instructions}\n`
      );
      console.log(`    Saved instructions.md`);
    }
  } catch (err) {
    console.warn(`    Failed to fetch project details: ${err.message}`);
  }

  // Export project files/docs
  try {
    const docs = await api.getProjectDocs(projectId);
    const docArray = Array.isArray(docs) ? docs : docs.results || docs.data || [];

    if (docArray.length > 0) {
      const filesDir = path.join(projectDir, 'files');
      ensureDir(filesDir);

      for (const doc of docArray) {
        const filename = doc.filename || doc.name || `doc-${doc.uuid || doc.id}`;
        const content = doc.content || doc.text || '';

        if (content) {
          fs.writeFileSync(path.join(filesDir, filename), content);
          console.log(`    Saved file: ${filename}`);
        }
      }
    }
  } catch (err) {
    console.warn(`    Failed to fetch project docs: ${err.message}`);
  }

  updateManifestProject(manifest, projectId, {
    name: projectName,
    updatedAt
  });

  return projectDir;
}

async function exportConversation(api, convSummary, targetDir, manifest, force) {
  const convId = convSummary.uuid || convSummary.id;
  const updatedAt = convSummary.updated_at;

  if (!force && !shouldSyncConversation(manifest, convId, updatedAt)) {
    return; // Already synced and unchanged
  }

  const title = convSummary.name || 'untitled';
  const filename = sanitizeFilename(title) + '.md';
  const filePath = path.join(targetDir, filename);

  try {
    console.log(`    Exporting: ${title}`);
    const conversation = await api.getConversation(convId);
    const markdown = buildConversationMarkdown(conversation);

    ensureDir(targetDir);
    fs.writeFileSync(filePath, markdown);

    updateManifestConversation(manifest, convId, {
      title: sanitizeFilename(title),
      projectId: convSummary.project_uuid || convSummary.project_id || null,
      updatedAt,
      messageCount: conversation.chat_messages?.length || 0,
      filePath: path.relative(path.dirname(targetDir), filePath)
    });

    return true;
  } catch (err) {
    console.error(`    Failed to export "${title}": ${err.message}`);
    return false;
  }
}
```

**Step 2: Commit**

```bash
git add claude-sync.js
git commit -m "feat: add project and conversation export logic"
```

---

### Task 6: Build the CLI Orchestrator

**Files:**
- Modify: `claude-sync.js` (append after export logic)

**Step 1: Write the main orchestration and CLI argument handling**

```javascript
// ─── CLI & Orchestration ─────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const flags = { force: false, project: null, outputDir: null };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--force') {
      flags.force = true;
    } else if (args[i] === '--project' && args[i + 1]) {
      flags.project = args[++i];
    } else if (!args[i].startsWith('-')) {
      flags.outputDir = args[i];
    }
  }

  return flags;
}

function extractOrgId(sessionKey) {
  // Try to extract from lastActiveOrg in the cookie string
  const match = sessionKey.match(/lastActiveOrg=([^;]+)/);
  return match?.[1] || null;
}

async function main() {
  const flags = parseArgs();

  if (!flags.outputDir) {
    console.log(`
Usage: node claude-sync.js <output-dir> [options]

Options:
  --force              Re-download all conversations
  --project "name"     Only sync a specific project

Environment:
  CLAUDE_SESSION_KEY   Your Claude.ai session cookie string
                       (copy from browser DevTools → Application → Cookies)

Example:
  export CLAUDE_SESSION_KEY="sessionKey=sk-ant-sid01-..."
  node claude-sync.js ./claude-archive
`);
    process.exit(1);
  }

  const sessionKey = process.env.CLAUDE_SESSION_KEY;
  if (!sessionKey) {
    console.error('Error: CLAUDE_SESSION_KEY environment variable not set.');
    console.error('Copy your cookie from browser DevTools → Application → Cookies → claude.ai');
    console.error('Include all cookie values, e.g.: "sessionKey=sk-ant-...; lastActiveOrg=..."');
    process.exit(1);
  }

  // Extract org ID from cookie or discover via API
  let orgId = extractOrgId(sessionKey);
  if (!orgId) {
    console.log('Discovering organization ID...');
    try {
      const res = await fetch(`${BASE_URL}/api/auth/session`, {
        headers: { 'Cookie': sessionKey }
      });
      const session = await res.json();
      orgId = session.account?.memberships?.[0]?.organization?.uuid
        || session.organization?.uuid;
    } catch (err) {
      // fallback: will be handled below
    }
  }

  if (!orgId) {
    console.error('Error: Could not determine organization ID.');
    console.error('Make sure your CLAUDE_SESSION_KEY includes "lastActiveOrg=..." or try refreshing your cookie.');
    process.exit(1);
  }

  console.log(`Organization: ${orgId}`);

  const outputDir = path.resolve(flags.outputDir);
  ensureDir(outputDir);

  const api = createApiClient(sessionKey, orgId);
  const manifest = readManifest(outputDir);
  manifest.orgId = orgId;

  let stats = { projects: 0, conversations: 0, skipped: 0, errors: 0 };

  // ─── Export Projects ───────────────────────────────────────
  console.log('\nFetching projects...');
  let projects = [];
  try {
    const data = await api.listProjects();
    projects = Array.isArray(data) ? data : data.results || data.data || [];
    console.log(`Found ${projects.length} projects`);
  } catch (err) {
    console.error(`Failed to fetch projects: ${err.message}`);
  }

  // Build project ID → directory mapping
  const projectDirs = {};

  for (const project of projects) {
    if (flags.project && sanitizeFilename(project.name) !== sanitizeFilename(flags.project)) {
      continue;
    }

    try {
      const dir = await exportProject(api, project, outputDir, manifest, flags.force);
      projectDirs[project.uuid || project.id] = dir;
      stats.projects++;
      writeManifest(outputDir, manifest); // Save after each project
    } catch (err) {
      console.error(`  Error with project "${project.name}": ${err.message}`);
      stats.errors++;
    }
  }

  // ─── Export Conversations ──────────────────────────────────
  console.log('\nFetching conversations...');
  let conversations = [];
  try {
    const data = await api.listConversations();
    conversations = Array.isArray(data) ? data : data.results || data.data || [];
    console.log(`Found ${conversations.length} conversations`);
  } catch (err) {
    console.error(`Failed to fetch conversations: ${err.message}`);
  }

  for (const conv of conversations) {
    const projectId = conv.project_uuid || conv.project_id;

    // If filtering by project, skip non-matching
    if (flags.project) {
      if (!projectId || !projectDirs[projectId]) continue;
    }

    // Determine target directory
    let targetDir;
    if (projectId && projectDirs[projectId]) {
      targetDir = projectDirs[projectId];
    } else if (projectId) {
      // Project exists but wasn't exported (maybe filtered) — put in projects/unknown
      targetDir = path.join(outputDir, 'projects', `project-${projectId.substring(0, 8)}`);
    } else {
      targetDir = path.join(outputDir, 'conversations');
    }

    const result = await exportConversation(api, conv, targetDir, manifest, flags.force);

    if (result === true) {
      stats.conversations++;
      writeManifest(outputDir, manifest); // Save after each conversation
    } else if (result === false) {
      stats.errors++;
    } else {
      stats.skipped++;
    }
  }

  // ─── Summary ───────────────────────────────────────────────
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`Sync complete!`);
  console.log(`  Projects:      ${stats.projects}`);
  console.log(`  Conversations: ${stats.conversations} exported, ${stats.skipped} skipped (unchanged)`);
  if (stats.errors > 0) {
    console.log(`  Errors:        ${stats.errors}`);
  }
  console.log(`  Output:        ${outputDir}`);
  console.log(`${'─'.repeat(50)}`);
}

main().catch(err => {
  console.error(`Fatal error: ${err.message}`);
  process.exit(1);
});
```

**Step 2: Run syntax check**

Run: `node --check claude-sync.js`
Expected: No output (clean syntax)

**Step 3: Commit**

```bash
git add claude-sync.js
git commit -m "feat: add CLI orchestrator with project-organized export"
```

---

### Task 7: End-to-End Test Run

**Step 1: Run the API probe (Task 1) in browser**

User pastes the probe script in browser console, saves output.

**Step 2: Adjust field names if needed**

Based on probe output, update field names in `claude-sync.js`:
- Project ID field: `uuid` vs `id`
- Conversation list pagination
- Content block structure
- Project instructions field name
- Project docs structure

**Step 3: Run the sync tool**

Run:
```bash
export CLAUDE_SESSION_KEY="sessionKey=sk-ant-...; lastActiveOrg=..."
node claude-sync.js ./test-archive
```

Expected: Console output showing projects and conversations being exported

**Step 4: Verify output**

Check:
- `test-archive/projects/` has folders for each project
- Each project folder has `instructions.md` if project had instructions
- Each project folder has conversation `.md` files
- `test-archive/conversations/` has non-project conversations
- `.sync-manifest.json` exists and has entries

**Step 5: Test incremental sync**

Run: `node claude-sync.js ./test-archive` (same command again)
Expected: All conversations show "skipped (unchanged)"

**Step 6: Test force sync**

Run: `node claude-sync.js ./test-archive --force`
Expected: All conversations re-downloaded

**Step 7: Clean up probe script**

```bash
rm api-probe.js api-probe-output.json
```

**Step 8: Final commit**

```bash
git add -A
git commit -m "feat: claude-sync v1 - incremental conversation exporter"
```

---

### Task 8: Delete Original Browser Script (Optional)

The original `claude-conversation-md.js` is superseded by the new tool. User decides whether to keep it as a lighter-weight single-conversation option or remove it.

**Step 1: Ask user**

Keep `claude-conversation-md.js` for single-conversation browser exports, or delete?

---

## Dependency Order

```
Task 1 (API Probe) → Task 2 (API Client) → Task 3 (Manifest)
                                                ↓
Task 4 (Markdown) ──────────────────────→ Task 5 (Export Logic)
                                                ↓
                                         Task 6 (CLI Orchestrator)
                                                ↓
                                         Task 7 (E2E Test)
                                                ↓
                                         Task 8 (Cleanup)
```

Tasks 2-4 can be developed somewhat independently but must come together in Task 5-6.
