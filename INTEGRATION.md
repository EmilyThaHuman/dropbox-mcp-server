# Dropbox MCP Server Integration Guide

This guide explains how to integrate the Dropbox MCP Server with your application, specifically for the ZeroTwo AI platform.

## Table of Contents

1. [Backend Integration](#backend-integration)
2. [Frontend Integration](#frontend-integration)
3. [OAuth Flow](#oauth-flow)
4. [Tool Usage](#tool-usage)
5. [Error Handling](#error-handling)
6. [Testing](#testing)

## Backend Integration

### 1. Add Dropbox Route Handler

Create `/ZeroTwoApi/routes/ai/tools/dropbox.js`:

```javascript
import { Router } from "express";
import logger from "@utils/logger.js";
import { recordTokenUsageBackground } from "@lib/token-tracking/logger.js";
import { config } from "@config/index.js";

const router = Router();

// Dropbox MCP Server URL
const DROPBOX_MCP_URL = process.env.DROPBOX_MCP_SERVER_URL || 'https://dropbox-mcp-server.your-account.workers.dev';

/**
 * Get user's Dropbox access token from profile settings
 */
async function getUserDropboxToken(userId) {
  const { createClient } = await import("@supabase/supabase-js");
  
  const supabase = createClient(
    config.app.env.SUPABASE_URL,
    config.app.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const { data: profile, error } = await supabase
    .from("profiles")
    .select("settings")
    .eq("id", userId)
    .single();

  if (error || !profile) {
    throw new Error("Dropbox authentication required");
  }

  const dropboxTokens = profile?.settings?.oauth_tokens?.dropbox;
  if (!dropboxTokens) {
    throw new Error("Dropbox authentication required");
  }

  // Check if token is expired and refresh if needed
  if (dropboxTokens.expires_at && new Date(dropboxTokens.expires_at) <= new Date()) {
    if (!dropboxTokens.provider_refresh_token) {
      throw new Error("Dropbox access token expired. Please reconnect your account.");
    }

    // Refresh via MCP server
    const refreshResponse = await fetch(`${DROPBOX_MCP_URL}/oauth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId,
        refreshToken: dropboxTokens.provider_refresh_token,
      }),
    });

    if (!refreshResponse.ok) {
      throw new Error("Failed to refresh Dropbox access token");
    }

    const tokens = await refreshResponse.json();

    // Update profile with new tokens
    const updatedSettings = {
      ...profile.settings,
      oauth_tokens: {
        ...(profile.settings.oauth_tokens || {}),
        dropbox: {
          ...dropboxTokens,
          provider_token: tokens.accessToken,
          expires_at: new Date(Date.now() + tokens.expiresIn * 1000).toISOString(),
          stored_at: new Date().toISOString(),
        },
      },
    };

    await supabase
      .from("profiles")
      .update({
        settings: updatedSettings,
        updated_at: new Date().toISOString(),
      })
      .eq("id", userId);

    // Sync to MCP server
    await fetch(`${DROPBOX_MCP_URL}/oauth/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresIn: tokens.expiresIn,
      }),
    });

    return tokens.accessToken;
  }

  return dropboxTokens.provider_token;
}

/**
 * GET /api/ai/tools/dropbox/token
 * Endpoint for MCP server to fetch tokens (fallback)
 */
router.get("/token", async (req, res) => {
  try {
    const userId = req.query.userId;
    if (!userId) {
      return res.status(400).json({ error: "userId is required" });
    }

    const accessToken = await getUserDropboxToken(userId);
    
    res.json({
      accessToken,
      expiresIn: 14400,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error("[Dropbox] Token endpoint error:", error);
    res.status(401).json({
      error: error.message || "Failed to get Dropbox token",
    });
  }
});

/**
 * POST /api/ai/tools/dropbox-search
 * Search for files in Dropbox
 */
router.post("/dropbox-search", async (req, res) => {
  const startTime = Date.now();

  try {
    const { query = "", maxResults = 100, fileCategories = [], fileExtensions = [], tracking = {} } = req.body;
    const userId = req.body.userId || req.headers["x-user-id"] || req.user?.id || req.userId;

    if (!userId) {
      return res.status(401).json({
        error: true,
        message: "User ID required for Dropbox access",
      });
    }

    logger.info(`[Dropbox][Search] Request for user ${userId}`, { query, maxResults });

    // Get access token
    const accessToken = await getUserDropboxToken(userId);

    // Call MCP server
    const mcpResponse = await fetch(`${DROPBOX_MCP_URL}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-User-Id': userId,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: {
          name: 'dropbox_search',
          arguments: {
            userId,
            query,
            maxResults,
            fileCategories,
            fileExtensions,
          },
        },
        id: 1,
      }),
    });

    if (!mcpResponse.ok) {
      throw new Error("MCP server request failed");
    }

    const mcpResult = await mcpResponse.json();
    
    if (mcpResult.error) {
      throw new Error(mcpResult.error.message || "MCP error");
    }

    const result = JSON.parse(mcpResult.result.content[0].text);
    const processingTime = Date.now() - startTime;

    // Record usage
    recordTokenUsageBackground({
      userId,
      projectId: req.projectId,
      feature: "dropbox_search",
      provider: "dropbox_api",
      model: "dropbox-v2",
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cost: 0,
      requestId: tracking.requestId,
      sessionId: tracking.sessionId,
      metadata: {
        filesFound: result.files.length,
        processingTime,
      },
    });

    res.json({
      result: {
        data: result,
        metadata: {
          provider: "dropbox_api",
          requestId: tracking.requestId || `dropbox-search-${Date.now()}`,
          timestamp: new Date().toISOString(),
          processingTime,
        },
      },
    });
  } catch (error) {
    logger.error("[Dropbox][Search] Error:", error);
    res.status(500).json({
      error: true,
      message: error.message || "Failed to search Dropbox",
    });
  }
});

/**
 * POST /api/ai/tools/dropbox-read
 * Read file contents from Dropbox
 */
router.post("/dropbox-read", async (req, res) => {
  const startTime = Date.now();

  try {
    const { path, rawDownload = false, tracking = {} } = req.body;
    const userId = req.body.userId || req.headers["x-user-id"] || req.user?.id || req.userId;

    if (!userId) {
      return res.status(401).json({
        error: true,
        message: "User ID required",
      });
    }

    if (!path) {
      return res.status(400).json({
        error: true,
        message: "File path is required",
      });
    }

    logger.info(`[Dropbox][Read] Request for user ${userId}`, { path });

    // Get access token
    const accessToken = await getUserDropboxToken(userId);

    // Call MCP server
    const mcpResponse = await fetch(`${DROPBOX_MCP_URL}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-User-Id': userId,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: {
          name: 'dropbox_fetch',
          arguments: {
            userId,
            path,
            rawDownload,
          },
        },
        id: 1,
      }),
    });

    if (!mcpResponse.ok) {
      throw new Error("MCP server request failed");
    }

    const mcpResult = await mcpResponse.json();
    
    if (mcpResult.error) {
      throw new Error(mcpResult.error.message || "MCP error");
    }

    const processingTime = Date.now() - startTime;

    // Record usage
    recordTokenUsageBackground({
      userId,
      projectId: req.projectId,
      feature: "dropbox_read",
      provider: "dropbox_api",
      model: "dropbox-v2",
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cost: 0,
      requestId: tracking.requestId,
      sessionId: tracking.sessionId,
      metadata: {
        filePath: path,
        processingTime,
      },
    });

    res.json({
      result: {
        data: mcpResult.result.content[0].text,
        metadata: {
          provider: "dropbox_api",
          requestId: tracking.requestId || `dropbox-read-${Date.now()}`,
          timestamp: new Date().toISOString(),
          processingTime,
        },
      },
    });
  } catch (error) {
    logger.error("[Dropbox][Read] Error:", error);
    res.status(500).json({
      error: true,
      message: error.message || "Failed to read file from Dropbox",
    });
  }
});

export default router;
```

### 2. Add Auth Route Handler

Create `/ZeroTwoApi/routes/auth/dropbox.js`:

```javascript
import { Router } from "express";
import logger from "@utils/logger.js";
import { config } from "@config/index.js";

const router = Router();

const DROPBOX_MCP_URL = process.env.DROPBOX_MCP_SERVER_URL || 'https://dropbox-mcp-server.your-account.workers.dev';

/**
 * POST /api/auth/dropbox/callback
 * Handle OAuth callback and exchange code for tokens
 */
router.post("/callback", async (req, res) => {
  try {
    const { code, codeVerifier, userId } = req.body;

    if (!code || !codeVerifier || !userId) {
      return res.status(400).json({
        error: true,
        message: "Missing required parameters: code, codeVerifier, userId",
      });
    }

    logger.info("[DropboxAuth] Processing OAuth callback", { userId });

    // Exchange code for tokens via MCP server
    const response = await fetch(`${DROPBOX_MCP_URL}/oauth/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, codeVerifier, userId }),
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error || "Token exchange failed");
    }

    const tokens = await response.json();

    logger.info("[DropboxAuth] Tokens received successfully");

    // Store in user profile
    const { createClient } = await import("@supabase/supabase-js");
    const supabase = createClient(
      config.app.env.SUPABASE_URL,
      config.app.env.SUPABASE_SERVICE_ROLE_KEY
    );

    const { data: profile } = await supabase
      .from("profiles")
      .select("settings")
      .eq("id", userId)
      .single();

    const updatedSettings = {
      ...(profile?.settings || {}),
      oauth_tokens: {
        ...(profile?.settings?.oauth_tokens || {}),
        dropbox: {
          provider_token: tokens.accessToken,
          provider_refresh_token: tokens.refreshToken,
          expires_at: new Date(Date.now() + tokens.expiresIn * 1000).toISOString(),
          stored_at: new Date().toISOString(),
        },
      },
    };

    await supabase
      .from("profiles")
      .update({
        settings: updatedSettings,
        updated_at: new Date().toISOString(),
      })
      .eq("id", userId);

    res.json({
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresIn: tokens.expiresIn,
      timestamp: tokens.timestamp,
    });
  } catch (error) {
    logger.error("[DropboxAuth] Error:", error);
    res.status(500).json({
      error: true,
      message: error.message || "Failed to process OAuth callback",
    });
  }
});

/**
 * POST /api/auth/dropbox/refresh
 * Refresh access token
 */
router.post("/refresh", async (req, res) => {
  try {
    const { refreshToken, userId } = req.body;

    if (!refreshToken || !userId) {
      return res.status(400).json({
        error: true,
        message: "Missing required parameters: refreshToken, userId",
      });
    }

    logger.info("[DropboxAuth] Refreshing token");

    const response = await fetch(`${DROPBOX_MCP_URL}/oauth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, refreshToken }),
    });

    if (!response.ok) {
      throw new Error("Token refresh failed");
    }

    const tokens = await response.json();

    res.json(tokens);
  } catch (error) {
    logger.error("[DropboxAuth] Refresh error:", error);
    res.status(500).json({
      error: true,
      message: error.message || "Failed to refresh token",
    });
  }
});

export default router;
```

### 3. Register Routes

In `/ZeroTwoApi/routes/ai.js`, add:

```javascript
import dropboxRouter from './ai/tools/dropbox.js';
app.use('/api/ai/tools', dropboxRouter);
```

In `/ZeroTwoApi/routes/auth/index.js`, add:

```javascript
import dropboxAuthRouter from './auth/dropbox.js';
app.use('/api/auth/dropbox', dropboxAuthRouter);
```

### 4. Environment Variables

Add to `.env`:

```env
DROPBOX_MCP_SERVER_URL=https://dropbox-mcp-server.your-account.workers.dev
```

## Frontend Integration

### 1. OAuth Initiation

```typescript
// src/lib/auth/dropbox.ts
export async function initiateDropboxAuth(userId: string) {
  const state = userId; // Or generate unique state
  const mcpServerUrl = import.meta.env.VITE_DROPBOX_MCP_SERVER_URL;
  
  // Get authorization URL and code verifier from MCP server
  const response = await fetch(
    `${mcpServerUrl}/oauth/authorize?userId=${userId}&state=${state}`
  );
  
  const data = await response.json();
  
  // Store code verifier in session storage for callback
  sessionStorage.setItem('dropbox_code_verifier', data.codeVerifier);
  sessionStorage.setItem('dropbox_state', state);
  
  // Redirect to Dropbox authorization
  window.location.href = data.authorizationUrl;
}
```

### 2. OAuth Callback Handler

```typescript
// src/pages/settings/DropboxCallback.tsx
import { useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

export function DropboxCallback() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  
  useEffect(() => {
    handleCallback();
  }, []);
  
  async function handleCallback() {
    const code = searchParams.get('oauth_code');
    const state = searchParams.get('state');
    const error = searchParams.get('oauth_error');
    
    if (error) {
      console.error('OAuth error:', error);
      navigate('/settings?error=dropbox_auth_failed');
      return;
    }
    
    if (!code || !state) {
      navigate('/settings?error=missing_oauth_params');
      return;
    }
    
    // Get stored code verifier
    const codeVerifier = sessionStorage.getItem('dropbox_code_verifier');
    const storedState = sessionStorage.getItem('dropbox_state');
    
    if (!codeVerifier || state !== storedState) {
      navigate('/settings?error=invalid_oauth_state');
      return;
    }
    
    try {
      // Exchange code for tokens via backend
      const response = await fetch('/api/auth/dropbox/callback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code,
          codeVerifier,
          userId: state, // or get from auth context
        }),
      });
      
      if (!response.ok) {
        throw new Error('Token exchange failed');
      }
      
      // Clean up session storage
      sessionStorage.removeItem('dropbox_code_verifier');
      sessionStorage.removeItem('dropbox_state');
      
      // Redirect to settings with success
      navigate('/settings?success=dropbox_connected');
    } catch (error) {
      console.error('Callback error:', error);
      navigate('/settings?error=token_exchange_failed');
    }
  }
  
  return <div>Connecting to Dropbox...</div>;
}
```

### 3. Settings UI Component

```typescript
// src/components/settings/DropboxIntegration.tsx
import { Button } from '@/components/ui/button';
import { initiateDropboxAuth } from '@/lib/auth/dropbox';
import { useAuth } from '@/hooks/useAuth';

export function DropboxIntegration() {
  const { user } = useAuth();
  const [isConnected, setIsConnected] = useState(false);
  
  const handleConnect = async () => {
    if (!user?.id) return;
    await initiateDropboxAuth(user.id);
  };
  
  const handleDisconnect = async () => {
    // Call disconnect endpoint
    await fetch('/api/auth/dropbox/disconnect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: user?.id }),
    });
    
    setIsConnected(false);
  };
  
  return (
    <div className="space-y-4">
      <h3 className="text-lg font-semibold">Dropbox Integration</h3>
      <p className="text-sm text-muted-foreground">
        Connect your Dropbox account to access files and folders.
      </p>
      
      {isConnected ? (
        <div className="flex items-center gap-2">
          <span className="text-sm text-green-600">✓ Connected</span>
          <Button variant="outline" size="sm" onClick={handleDisconnect}>
            Disconnect
          </Button>
        </div>
      ) : (
        <Button onClick={handleConnect}>
          Connect Dropbox
        </Button>
      )}
    </div>
  );
}
```

## OAuth Flow

### Complete Flow Diagram

```
1. User clicks "Connect Dropbox" in frontend
   ↓
2. Frontend calls MCP server /oauth/authorize
   ↓
3. MCP server generates PKCE challenge & returns auth URL
   ↓
4. Frontend stores code_verifier and redirects user to Dropbox
   ↓
5. User authorizes on Dropbox
   ↓
6. Dropbox redirects to MCP server /oauth/callback
   ↓
7. MCP server redirects to frontend with code & state
   ↓
8. Frontend calls backend /api/auth/dropbox/callback
   ↓
9. Backend calls MCP server /oauth/exchange with code & code_verifier
   ↓
10. MCP server exchanges code for tokens
    ↓
11. Backend stores tokens in user profile
    ↓
12. Backend syncs tokens to MCP server KV storage
    ↓
13. User is authenticated and can use Dropbox tools
```

## Tool Usage

### Search Files

```typescript
const response = await fetch('/api/ai/tools/dropbox-search', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    userId: user.id,
    query: 'budget 2024',
    maxResults: 20,
    fileExtensions: ['.pdf', '.xlsx'],
  }),
});

const result = await response.json();
console.log('Files found:', result.result.data.files);
```

### Fetch File

```typescript
const response = await fetch('/api/ai/tools/dropbox-read', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    userId: user.id,
    path: '/Documents/report.pdf',
    rawDownload: true, // Set to true for binary files
  }),
});

const result = await response.json();
console.log('File content:', result.result.data);
```

## Error Handling

### Common Errors

| Error | Cause | Solution |
|-------|-------|----------|
| `invalid_grant` | Invalid or expired authorization code | User needs to re-authenticate |
| `invalid_access_token` | Access token expired | Automatically refreshed if refresh token exists |
| `path/not_found` | File path doesn't exist | Verify path is correct |
| `insufficient_scope` | Missing required permissions | Re-authenticate with correct scopes |

### Error Response Format

```json
{
  "error": true,
  "message": "Dropbox authentication required",
  "authRequired": true,
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

## Testing

### 1. Test OAuth Flow

```bash
# Start local MCP server
cd dropbox-mcp-server
npm run dev

# In another terminal, test authorization
curl "http://localhost:3003/oauth/authorize?userId=test123&state=test123"
```

### 2. Test Tools

```bash
# Search files
curl -X POST http://localhost:3003/mcp \
  -H "Content-Type: application/json" \
  -H "X-User-Id: test123" \
  -d '{
    "jsonrpc": "2.0",
    "method": "tools/call",
    "params": {
      "name": "dropbox_search",
      "arguments": {
        "userId": "test123",
        "query": "test",
        "maxResults": 10
      }
    },
    "id": 1
  }'
```

### 3. Test Token Refresh

```bash
curl -X POST http://localhost:3003/oauth/refresh \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "test123",
    "refreshToken": "your_refresh_token"
  }'
```

## Production Deployment

### 1. Deploy MCP Server

```bash
cd dropbox-mcp-server
npm run deploy
```

### 2. Update Backend Environment

```env
DROPBOX_MCP_SERVER_URL=https://dropbox-mcp-server.your-account.workers.dev
```

### 3. Update Frontend Environment

```env
VITE_DROPBOX_MCP_SERVER_URL=https://dropbox-mcp-server.your-account.workers.dev
```

### 4. Update Dropbox App Settings

1. Go to Dropbox App Console
2. Update Redirect URI to production URL
3. Save changes

## Monitoring

### Key Metrics to Monitor

- OAuth success/failure rates
- Token refresh frequency
- API call latency
- Error rates by endpoint
- KV storage usage

### Logging

The MCP server logs:
- OAuth flows
- Tool executions
- Token refreshes
- Errors and exceptions

Access logs in Cloudflare Workers dashboard or via `wrangler tail`.

## Support

For integration issues:
1. Check logs in Cloudflare Workers dashboard
2. Verify OAuth credentials are correct
3. Ensure KV namespace is properly configured
4. Review [README.md](./README.md) for setup details
5. Check Dropbox API status page

## Next Steps

1. Implement additional Dropbox tools as needed
2. Add webhook support for real-time notifications
3. Implement file upload capabilities
4. Add batch operations support
5. Enhance error recovery mechanisms







