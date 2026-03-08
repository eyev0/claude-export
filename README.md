# claude-export

Incrementally sync all your Claude.ai conversations to local markdown files, organized by project. Zero dependencies — just Node.js 18+.

## Why

You want to continue Claude.ai conversations in Claude Code (or any other tool), but don't want to start over. This tool downloads everything and keeps it in sync.

## What you get

```
archive/
├── projects/
│   ├── my-project/
│   │   ├── instructions.md       # Project custom instructions
│   │   ├── docs/                 # Project knowledge base files
│   │   │   └── reference.pdf
│   │   ├── chat-about-auth.md    # Conversations in this project
│   │   └── fix-login-bug.md
│   └── another-project/
│       └── ...
├── conversations/                # Standalone conversations (no project)
│   ├── help-with-regex.md
│   └── explain-monads.md
└── .sync-manifest.json           # Tracks sync state for incremental updates
```

Each conversation becomes a clean markdown file:

```markdown
# Fix Login Bug

> Exported from Claude.ai | Last updated: Feb 28, 2026
> Model: claude-opus-4-6 | Messages: 24

---

## Human (Jan 15, 2026, 3:42 PM):

Can you help me debug this auth flow?

---

## Claude (Jan 15, 2026, 3:42 PM):

Looking at your auth flow, I see the issue...
```

## Quick start

```bash
git clone https://github.com/eyev/claude-export.git
cd claude-export
npm run sync
```

On first run, it prompts for your session cookie:

```
No session cookie found.

How to get it:
  1. Open https://claude.ai -> DevTools (F12) -> Network tab
  2. Click any API request -> right-click -> "Copy as cURL"
  3. Paste below (or just the Cookie header value)

Paste cookie or cURL: <paste here>
```

It saves the cookie to `.env` for future runs.

## Usage

```bash
npm run sync              # Sync all (skips unchanged conversations)
npm run sync:force        # Re-download everything
node claude-sync.js ./archive --project "My Project"  # Sync one project
```

Or run directly:

```bash
export CLAUDE_SESSION_KEY="sessionKey=sk-ant-...; lastActiveOrg=...; cf_clearance=...; __cf_bm=..."
node claude-sync.js ./my-archive
```

## How it works

1. Fetches your projects and their instructions/knowledge base files
2. Fetches all conversations, organized by project
3. Converts each conversation to clean markdown (text + artifacts, skips internal tool mechanics)
4. Saves a `.sync-manifest.json` — re-runs only download new or updated conversations

Rate-limited (200ms between requests) with automatic retry on throttling.

## Cookie notes

Claude.ai sits behind Cloudflare. Your cookie string needs to include:

| Cookie | Required | Lifespan |
|--------|----------|----------|
| `sessionKey` | Yes | Days–weeks |
| `lastActiveOrg` | Yes (or auto-discovered) | Persistent |
| `cf_clearance` | Yes | ~30 minutes |
| `__cf_bm` | Yes | ~30 minutes |

When you get 403 errors, the Cloudflare cookies expired. Grab a fresh "Copy as cURL" from DevTools:

```bash
rm .env && npm run sync
```

## Requirements

- Node.js 18+ (uses built-in `fetch`, no dependencies)

## License

MIT
