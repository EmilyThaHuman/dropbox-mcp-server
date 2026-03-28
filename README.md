# Dropbox MCP Server

A Model Context Protocol (MCP) server implementation for Dropbox that enables AI assistants to interact with Dropbox files and folders. Built with TypeScript and deployed on Cloudflare Workers for global edge performance.

## Features

- 🔐 **OAuth 2.0 with PKCE** - Secure authentication flow
- 🔍 **File Search** - Search across all Dropbox files and folders
- 📥 **File Fetching** - Download file contents (text or binary)
- 📋 **Recent Files** - List recently modified files
- 👤 **User Profile** - Access Dropbox account information
- ⚡ **Edge Deployment** - Runs on Cloudflare Workers for low latency
- 🔄 **Token Management** - Automatic token refresh and session management

## Available Tools

| Tool | Description | Scopes Required |
|------|-------------|-----------------|
| `dropbox_search` | Search Dropbox for files that match a query | `files.metadata.read`, `account_info.read` |
| `dropbox_fetch` | Fetch a file by path with optional raw download | `files.content.read` |
| `dropbox_search_files` | Search Dropbox files and return results (alias) | `files.metadata.read`, `account_info.read` |
| `dropbox_fetch_file` | Retrieve a file's text or raw content (alias) | `files.content.read`, `account_info.read` |
| `dropbox_list_recent_files` | Return the most recently modified files | `files.metadata.read`, `account_info.read` |
| `dropbox_get_profile` | Retrieve the Dropbox profile of the current user | `account_info.read` |

## Prerequisites

- Node.js 18+ (for local development)
- Dropbox App credentials (App Key & App Secret)
- Cloudflare account (for deployment)
- Wrangler CLI installed (`npm install -g wrangler`)

## Setup

### 1. Create Dropbox App

1. Go to [Dropbox App Console](https://www.dropbox.com/developers/apps)
2. Click "Create app"
3. Choose "Scoped access"
4. Choose "Full Dropbox" access type
5. Give your app a name
6. Click "Create app"
7. In the app settings:
   - Note your **App key** (Client ID)
   - Note your **App secret** (Client Secret)
   - Add redirect URI: `https://your-worker-domain.workers.dev/oauth/callback`
   - Under "Permissions" tab, enable:
     - `files.metadata.read`
     - `files.content.read`
     - `account_info.read`
8. Click "Submit" to save permissions

### 2. Install Dependencies

```bash
cd dropbox-mcp-server
npm install
```

### 3. Configure Environment

Create a `.env` file:

```bash
cp env.example .env
```

Edit `.env` with your Dropbox app credentials:

```env
DROPBOX_CLIENT_ID=your_app_key_here
DROPBOX_CLIENT_SECRET=your_app_secret_here
DROPBOX_REDIRECT_URI=http://localhost:3003/oauth/callback
PORT=3003
NODE_ENV=development
MCP_SERVER_NAME=dropbox-mcp-server
MCP_SERVER_VERSION=1.0.0
FRONTEND_URL=http://localhost:5173
BACKEND_API_URL=http://localhost:3002
```

### 4. Create KV Namespace

```bash
# Create KV namespace for session storage
npm run kv:create

# Note the namespace ID and update wrangler.toml
```

### 5. Configure Cloudflare Secrets

```bash
wrangler secret put DROPBOX_CLIENT_ID
# Enter your Dropbox App Key

wrangler secret put DROPBOX_CLIENT_SECRET
# Enter your Dropbox App Secret

wrangler secret put DROPBOX_REDIRECT_URI
# Enter: https://your-worker-domain.workers.dev/oauth/callback

wrangler secret put FRONTEND_URL
# Enter your frontend URL (e.g., https://zerotwo.app)

wrangler secret put BACKEND_API_URL
# Enter your backend API URL (optional)
```

## Development

### Local Development Server

Run the local Express server:

```bash
npm run dev
```

Server will start on `http://localhost:3003`

### Test with Cloudflare Workers

Run locally with Wrangler:

```bash
npm run dev:worker
```

### Build for Production

```bash
npm run build
```

## Deployment

### Deploy to Cloudflare Workers

```bash
# Deploy to production
npm run deploy

# Or deploy to specific environment
npm run deploy:production
```

### Update wrangler.toml

Before deploying, update `wrangler.toml` with your KV namespace ID:

```toml
[[kv_namespaces]]
binding = "SESSIONS"
id = "your_kv_namespace_id_here"
```

## API Endpoints

### Health Check

```
GET /health
```

Returns server status and version information.

### OAuth Flow

#### 1. Get Authorization URL

```
GET /oauth/authorize?userId={userId}&state={state}
```

**Response:**
```json
{
  "authorizationUrl": "https://www.dropbox.com/oauth2/authorize?...",
  "state": "user-state",
  "codeVerifier": "pkce-code-verifier"
}
```

Frontend should:
1. Store `codeVerifier` in session/localStorage
2. Redirect user to `authorizationUrl`

#### 2. OAuth Callback

```
GET /oauth/callback?code={code}&state={state}
```

Redirects to frontend with code and state parameters.

#### 3. Exchange Code for Tokens

```
POST /oauth/exchange
Content-Type: application/json

{
  "code": "authorization_code",
  "codeVerifier": "pkce_code_verifier",
  "userId": "user_id"
}
```

**Response:**
```json
{
  "accessToken": "sl.xxx",
  "refreshToken": "xxx",
  "expiresIn": 14400,
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

#### 4. Refresh Token

```
POST /oauth/refresh
Content-Type: application/json

{
  "userId": "user_id",
  "refreshToken": "refresh_token"
}
```

#### 5. Disconnect

```
POST /oauth/disconnect
Content-Type: application/json

{
  "userId": "user_id"
}
```

### MCP Protocol Endpoint

```
POST /mcp
Content-Type: application/json

{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "dropbox_search",
    "arguments": {
      "userId": "user_id",
      "query": "contract",
      "maxResults": 20
    }
  },
  "id": 1
}
```

## Tool Examples

### Search Files

```json
{
  "name": "dropbox_search",
  "arguments": {
    "userId": "user123",
    "query": "budget 2024",
    "maxResults": 10,
    "fileExtensions": [".pdf", ".xlsx"]
  }
}
```

### Fetch File

```json
{
  "name": "dropbox_fetch",
  "arguments": {
    "userId": "user123",
    "path": "/Documents/contract.pdf",
    "rawDownload": true
  }
}
```

### List Recent Files

```json
{
  "name": "dropbox_list_recent_files",
  "arguments": {
    "userId": "user123",
    "limit": 20
  }
}
```

### Get User Profile

```json
{
  "name": "dropbox_get_profile",
  "arguments": {
    "userId": "user123"
  }
}
```

## Architecture

### Components

- **OAuth Manager** - Handles OAuth 2.0 flow with PKCE
- **Dropbox Client** - Wraps Dropbox API calls
- **MCP Server** - Implements Model Context Protocol
- **Express Server** - Local development server
- **Cloudflare Worker** - Production edge deployment

### Session Management

Sessions are stored in:
- **Local Development**: In-memory Map
- **Production**: Cloudflare KV (with 30-day TTL)

### Token Refresh

Tokens are automatically refreshed when:
1. Access token is expired
2. Valid refresh token exists in session

Fallback: If KV session is missing, queries backend API for tokens from user profile.

## Security

- ✅ OAuth 2.0 with PKCE (Proof Key for Code Exchange)
- ✅ Secure token storage in Cloudflare KV
- ✅ Automatic token refresh
- ✅ CORS protection
- ✅ No tokens exposed to frontend (except during OAuth flow)

## Troubleshooting

### "Invalid OAuth2 client ID"

- Check your `DROPBOX_CLIENT_ID` is correct
- Verify app is properly configured in Dropbox App Console

### "Redirect URI mismatch"

- Ensure redirect URI in Dropbox app matches your deployed worker URL
- For local dev: `http://localhost:3003/oauth/callback`
- For production: `https://your-worker.workers.dev/oauth/callback`

### "Missing scopes"

- Go to Dropbox App Console → Permissions tab
- Enable required scopes
- Click "Submit" to save changes
- Users may need to re-authenticate

### "KV namespace not found"

- Run `npm run kv:create` to create namespace
- Update `wrangler.toml` with the namespace ID
- Redeploy with `npm run deploy`

## Development Scripts

```bash
npm run dev              # Run local Express server
npm run dev:worker       # Run Cloudflare Workers locally
npm run build            # Build TypeScript
npm run build:worker     # Build and validate for Workers
npm run deploy           # Deploy to Cloudflare Workers
npm run deploy:production # Deploy to production environment
npm run kv:create        # Create KV namespace
npm run lint             # Run ESLint
npm run format           # Format with Prettier
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test locally
5. Submit a pull request

## License

MIT License - see LICENSE file for details

## Support

For issues and questions:
- GitHub Issues: [Create an issue](https://github.com/your-repo/dropbox-mcp-server/issues)
- Documentation: [INTEGRATION.md](./INTEGRATION.md)

## Related Projects

- [Gmail MCP Server](../gmail-mcp-server)
- [Google Calendar MCP Server](../google-calendar-mcp-server)
- [Google Drive MCP Server](../google-drive-mcp-server)

---

## Powered by ZeroTwo

This Dropbox MCP connector is part of the [ZeroTwo AI platform](https://zerotwo.ai) — the all-in-one AI workspace that lets you manage files, search documents, and automate your Dropbox workflow through GPT-5, Claude, and Gemini.

| | |
|---|---|
| 🌐 **[ZeroTwo — All AI Models in One App](https://zerotwo.ai)** | Search and manage your Dropbox files with GPT-5, Claude, and Gemini — all in one place. |
| ✨ **[ZeroTwo Features](https://zerotwo.ai/features)** | AI file management, document analysis, web search, and MCP-powered cloud storage tools. |
| 🤖 **[AI Models — GPT-5, Claude & Gemini](https://zerotwo.ai/zerotwo-models)** | Use the world's best AI to find, analyze, and organize your files. |
| 🔌 **[ZeroTwo Connectors & Integrations](https://zerotwo.ai/connectors)** | Connect Dropbox, Google Drive, SharePoint, Gmail, and more to your AI workflow. |
| 💰 **[ZeroTwo Pricing](https://zerotwo.ai/pricing)** | One subscription that replaces ChatGPT Plus, Claude Pro, and Gemini Advanced. |
| 📝 **[ZeroTwo Blog](https://zerotwo.ai/blog)** | AI file management tips, productivity guides, and ZeroTwo product updates. |
| 🚀 **[Try ZeroTwo Free](https://app.zerotwo.ai/auth/login)** | Let AI organize your Dropbox — get started free today. |

> **Built for ZeroTwo** — Use this Dropbox MCP server with [ZeroTwo's AI connector system](https://zerotwo.ai/connectors) to search, fetch, and manage Dropbox files through natural language in your AI assistant.







