# Dropbox MCP Server - Deployment Guide

## Prerequisites

Before deploying, ensure you have:

1. ✅ Cloudflare account set up
2. ✅ Wrangler CLI installed (`npm install -g wrangler`)
3. ✅ Dropbox App created with proper scopes
4. ✅ All environment variables ready

## Deployment Steps

### 1. Create KV Namespace

First, create a KV namespace for session storage:

```bash
cd /Users/reedvogt/Documents/GitHub/dropbox-mcp-server
wrangler kv:namespace create SESSIONS
```

This will output something like:

```
{ binding = "SESSIONS", id = "abc123def456" }
```

Copy the `id` value.

### 2. Update wrangler.toml

Update the KV namespace ID in `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "SESSIONS"
id = "YOUR_KV_NAMESPACE_ID_HERE"  # Replace with your actual ID
```

### 3. Set Cloudflare Secrets

Set all required secrets:

```bash
# Set Dropbox credentials
wrangler secret put DROPBOX_CLIENT_ID
# Paste your Dropbox App Key

wrangler secret put DROPBOX_CLIENT_SECRET  
# Paste your Dropbox App Secret

# Set redirect URI (will be your worker URL)
wrangler secret put DROPBOX_REDIRECT_URI
# Enter: https://dropbox-mcp-server.YOUR-ACCOUNT.workers.dev/oauth/callback

# Set frontend URL
wrangler secret put FRONTEND_URL
# Enter your frontend URL (e.g., https://zerotwo.app)

# Optional: Set backend API URL for token fallback
wrangler secret put BACKEND_API_URL
# Enter your backend API URL (e.g., https://api.zerotwo.app)
```

### 4. Update Dropbox App Settings

1. Go to [Dropbox App Console](https://www.dropbox.com/developers/apps)
2. Select your app
3. Go to "Settings" tab
4. Under "OAuth 2" → "Redirect URIs", add:
   ```
   https://dropbox-mcp-server.YOUR-ACCOUNT.workers.dev/oauth/callback
   ```
5. Click "Add"
6. Save changes

### 5. Deploy to Cloudflare Workers

```bash
npm run deploy
```

This will:
- Build the TypeScript code
- Upload the worker to Cloudflare
- Deploy to your account

You should see output like:

```
Total Upload: XX.XX KiB / gzip: XX.XX KiB
Uploaded dropbox-mcp-server (X.XX sec)
Published dropbox-mcp-server (X.XX sec)
  https://dropbox-mcp-server.YOUR-ACCOUNT.workers.dev
```

### 6. Test Deployment

Test the health endpoint:

```bash
curl https://dropbox-mcp-server.YOUR-ACCOUNT.workers.dev/health
```

Expected response:

```json
{
  "status": "healthy",
  "server": "dropbox-mcp-server",
  "version": "1.0.0",
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

### 7. Update Backend Environment

Update your backend `.env` file:

```env
DROPBOX_MCP_SERVER_URL=https://dropbox-mcp-server.YOUR-ACCOUNT.workers.dev
```

Restart your backend server to pick up the new environment variable.

### 8. Update Frontend Environment

Update your frontend `.env` file:

```env
VITE_DROPBOX_MCP_SERVER_URL=https://dropbox-mcp-server.YOUR-ACCOUNT.workers.dev
```

Rebuild and redeploy your frontend if necessary.

## Verification

### Test OAuth Flow

1. Go to your frontend settings page
2. Click "Connect Dropbox"
3. You should be redirected to Dropbox authorization
4. Authorize the app
5. You should be redirected back to your frontend with success message

### Test MCP Tools

Use the deployed MCP server URL in your backend:

```bash
curl -X POST https://dropbox-mcp-server.YOUR-ACCOUNT.workers.dev/mcp \
  -H "Content-Type: application/json" \
  -H "X-User-Id: your_user_id" \
  -d '{
    "jsonrpc": "2.0",
    "method": "initialize",
    "params": {},
    "id": 1
  }'
```

## Monitoring

### View Logs

```bash
wrangler tail
```

This will stream live logs from your worker.

### View Metrics

Go to Cloudflare dashboard → Workers → dropbox-mcp-server → Metrics

Monitor:
- Request count
- Error rate
- CPU time
- KV operations

## Troubleshooting

### "Worker not found"

- Check that deployment succeeded
- Verify your Cloudflare account is active
- Try redeploying

### "KV namespace not found"

- Verify KV namespace ID in wrangler.toml is correct
- Ensure KV namespace was created successfully
- Try creating a new namespace

### "Invalid OAuth2 client"

- Check DROPBOX_CLIENT_ID secret is set correctly
- Verify Dropbox App Key is correct
- Ensure no extra whitespace in secret value

### "Redirect URI mismatch"

- Check DROPBOX_REDIRECT_URI matches worker URL exactly
- Ensure redirect URI is added in Dropbox App Console
- Include `/oauth/callback` at the end

### "Missing scopes"

- Go to Dropbox App Console → Permissions
- Enable required scopes:
  - `files.metadata.read`
  - `files.content.read`
  - `account_info.read`
- Click "Submit"
- Users need to re-authenticate

## Updating

### Update Code

1. Make changes to source code
2. Build: `npm run build`
3. Deploy: `npm run deploy`

### Update Secrets

```bash
wrangler secret put SECRET_NAME
```

### Update Environment Variables

Edit `wrangler.toml` and redeploy.

## Production Checklist

- [ ] KV namespace created and ID updated in wrangler.toml
- [ ] All secrets set in Cloudflare
- [ ] Dropbox App redirect URI updated
- [ ] Dropbox App permissions configured
- [ ] Worker deployed successfully
- [ ] Health endpoint responding
- [ ] Backend environment variable updated
- [ ] Frontend environment variable updated
- [ ] OAuth flow tested end-to-end
- [ ] MCP tools tested and working
- [ ] Monitoring set up
- [ ] Logs reviewed for errors

## Rollback

If you need to rollback:

```bash
# Deploy previous version
wrangler deploy --version-id PREVIOUS_VERSION_ID

# Or rollback to specific deployment
wrangler rollback
```

## Custom Domain (Optional)

To use a custom domain:

1. Add domain to Cloudflare
2. Go to Workers → dropbox-mcp-server → Settings → Triggers
3. Add custom domain
4. Update redirect URI in Dropbox App Console
5. Update DROPBOX_REDIRECT_URI secret
6. Update backend and frontend environment variables

## Security Notes

- Never commit secrets to version control
- Use Cloudflare's secret management
- Rotate secrets periodically
- Monitor for suspicious activity
- Enable rate limiting if needed
- Use custom domain for production

## Support

For deployment issues:
- Check Cloudflare Workers documentation
- Review deployment logs
- Check Dropbox API status
- Verify all secrets are set correctly
- Test locally first with `npm run dev:worker`







