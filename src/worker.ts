/**
 * Cloudflare Workers Entry Point for Dropbox MCP Server
 * Implements MCP protocol with SSE support for ChatGPT integration
 */

import { dropboxTools } from './mcp/tools.js';
import { OAuthTokens, SessionData, DropboxFile, DropboxAccount } from './types/index.js';
import crypto from 'node:crypto';

// Environment interface for Cloudflare Workers
interface Env {
  DROPBOX_CLIENT_ID: string;
  DROPBOX_CLIENT_SECRET: string;
  DROPBOX_REDIRECT_URI: string;
  FRONTEND_URL: string;
  BACKEND_API_URL?: string; // Optional: Backend API URL for token fallback
  MCP_SERVER_NAME: string;
  MCP_SERVER_VERSION: string;
  NODE_ENV: string;
  SESSIONS: KVNamespace;
}

/**
 * Dropbox API Configuration
 */
const DROPBOX_API = {
  authUrl: 'https://www.dropbox.com/oauth2/authorize',
  tokenUrl: 'https://api.dropboxapi.com/oauth2/token',
  apiUrl: 'https://api.dropboxapi.com/2',
  contentUrl: 'https://content.dropboxapi.com/2',
};

/**
 * Dropbox Client for Cloudflare Workers
 */
class DropboxClientWorker {
  private accessToken: string;

  constructor(accessToken: string) {
    this.accessToken = accessToken;
  }

  private getHeaders(contentType: string = 'application/json'): HeadersInit {
    return {
      'Authorization': `Bearer ${this.accessToken}`,
      'Content-Type': contentType,
    };
  }

  async search(options: {
    query: string;
    maxResults?: number;
    fileCategories?: string[];
    fileExtensions?: string[];
  }): Promise<DropboxFile[]> {
    const { query, maxResults = 100, fileCategories = [], fileExtensions = [] } = options;

    // Build the request body according to Dropbox API v2 spec
    const requestBody: any = {
      query: query, // Required field
      options: {
        max_results: Math.min(Math.max(1, maxResults), 1000),
        file_status: 'active',
        filename_only: false,
      },
      match_field_options: {
        include_highlights: false,
      },
    };

    // Add optional file categories if provided
    if (fileCategories && fileCategories.length > 0) {
      requestBody.options.file_categories = fileCategories;
    }

    // Add optional file extensions if provided
    if (fileExtensions && fileExtensions.length > 0) {
      requestBody.options.file_extensions = fileExtensions;
    }

    console.log('Dropbox search_v2 request:', JSON.stringify(requestBody));

    const response = await fetch(`${DROPBOX_API.apiUrl}/files/search_v2`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      let errorMessage = 'Search failed';
      try {
        const responseText = await response.text();
        try {
          const errorData = JSON.parse(responseText);
          errorMessage = errorData.error_summary || errorData.error || responseText;
        } catch (parseError) {
          // If JSON parsing fails, use the raw text
          errorMessage = responseText || `HTTP ${response.status}: ${response.statusText}`;
        }
      } catch (textError) {
        errorMessage = `HTTP ${response.status}: ${response.statusText}`;
      }
      throw new Error(errorMessage);
    }

    const data = await response.json() as any;
    const matches = data.matches || [];
    return matches.map((match: any) => match.metadata?.metadata).filter(Boolean);
  }

  async fetchFile(
    path: string,
    rawDownload: boolean = false
  ): Promise<{ content: string; metadata: DropboxFile }> {
    const response = await fetch(`${DROPBOX_API.contentUrl}/files/download`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.accessToken}`,
        'Dropbox-API-Arg': JSON.stringify({ path }),
      },
    });

    if (!response.ok) {
      let errorMessage = 'File download failed';
      try {
        const responseText = await response.text();
        try {
          const errorData = JSON.parse(responseText);
          errorMessage = errorData.error_summary || errorData.error || responseText;
        } catch (parseError) {
          errorMessage = responseText || `HTTP ${response.status}: ${response.statusText}`;
        }
      } catch (textError) {
        errorMessage = `HTTP ${response.status}: ${response.statusText}`;
      }
      throw new Error(errorMessage);
    }

    const metadataHeader = response.headers.get('dropbox-api-result');
    const metadata = metadataHeader ? JSON.parse(metadataHeader) : {};

    let content: string;
    if (rawDownload) {
      const buffer = await response.arrayBuffer();
      content = btoa(String.fromCharCode(...new Uint8Array(buffer)));
    } else {
      content = await response.text();
    }

    return { content, metadata };
  }

  async listRecentFiles(limit: number = 20): Promise<DropboxFile[]> {
    const response = await fetch(`${DROPBOX_API.apiUrl}/files/list_folder`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({
        path: '',
        recursive: true,
        include_deleted: false,
        include_has_explicit_shared_members: false,
        include_mounted_folders: true,
        limit: Math.min(Math.max(1, limit * 5), 2000), // Request more to filter
      }),
    });

    if (!response.ok) {
      let errorMessage = 'List folder failed';
      try {
        const responseText = await response.text();
        try {
          const errorData = JSON.parse(responseText);
          errorMessage = errorData.error_summary || errorData.error || responseText;
        } catch (parseError) {
          errorMessage = responseText || `HTTP ${response.status}: ${response.statusText}`;
        }
      } catch (textError) {
        errorMessage = `HTTP ${response.status}: ${response.statusText}`;
      }
      throw new Error(errorMessage);
    }

    const data = await response.json() as any;
    const files: DropboxFile[] = data.entries || [];

    return files
      .filter((file) => file['.tag'] === 'file' && file.server_modified)
      .sort((a, b) => {
        const dateA = new Date(a.server_modified!).getTime();
        const dateB = new Date(b.server_modified!).getTime();
        return dateB - dateA;
      })
      .slice(0, limit);
  }

  async getProfile(): Promise<DropboxAccount> {
    const response = await fetch(`${DROPBOX_API.apiUrl}/users/get_current_account`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: 'null',
    });

    if (!response.ok) {
      let errorMessage = 'Get profile failed';
      try {
        const responseText = await response.text();
        try {
          const errorData = JSON.parse(responseText);
          errorMessage = errorData.error_summary || errorData.error || responseText;
        } catch (parseError) {
          errorMessage = responseText || `HTTP ${response.status}: ${response.statusText}`;
        }
      } catch (textError) {
        errorMessage = `HTTP ${response.status}: ${response.statusText}`;
      }
      throw new Error(errorMessage);
    }

    return await response.json() as DropboxAccount;
  }

  async getFileMetadata(path: string): Promise<DropboxFile> {
    const response = await fetch(`${DROPBOX_API.apiUrl}/files/get_metadata`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ path }),
    });

    if (!response.ok) {
      let errorMessage = 'Get metadata failed';
      try {
        const responseText = await response.text();
        try {
          const errorData = JSON.parse(responseText);
          errorMessage = errorData.error_summary || errorData.error || responseText;
        } catch (parseError) {
          errorMessage = responseText || `HTTP ${response.status}: ${response.statusText}`;
        }
      } catch (textError) {
        errorMessage = `HTTP ${response.status}: ${response.statusText}`;
      }
      throw new Error(errorMessage);
    }

    return await response.json() as DropboxFile;
  }

  async getTemporaryLink(path: string): Promise<string> {
    const response = await fetch(`${DROPBOX_API.apiUrl}/files/get_temporary_link`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ path }),
    });

    if (!response.ok) {
      let errorMessage = 'Get temporary link failed';
      try {
        const responseText = await response.text();
        try {
          const errorData = JSON.parse(responseText);
          errorMessage = errorData.error_summary || errorData.error || responseText;
        } catch (parseError) {
          errorMessage = responseText || `HTTP ${response.status}: ${response.statusText}`;
        }
      } catch (textError) {
        errorMessage = `HTTP ${response.status}: ${response.statusText}`;
      }
      throw new Error(errorMessage);
    }

    const data = await response.json() as any;
    let link = data.link;
    
    // Convert download link to viewable link by changing dl=1 to raw=1
    // This makes the link render directly in browsers instead of forcing download
    if (link.includes('dl=1')) {
      link = link.replace('dl=1', 'raw=1');
    } else if (!link.includes('raw=1')) {
      // Add raw=1 parameter if neither dl nor raw is present
      link += (link.includes('?') ? '&' : '?') + 'raw=1';
    }
    
    return link;
  }

  static isImageFile(filename: string): boolean {
    const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg', '.ico', '.tiff', '.tif', '.heic', '.heif'];
    const lowerFilename = filename.toLowerCase();
    return imageExtensions.some(ext => lowerFilename.endsWith(ext));
  }
}

/**
 * OAuth Manager for Cloudflare Workers
 */
class CloudflareOAuthManager {
  private env: Env;

  constructor(env: Env) {
    this.env = env;
  }

  generatePKCE(): { codeVerifier: string; codeChallenge: string } {
    const array = new Uint8Array(32);
    crypto.getRandomValues(array);
    const codeVerifier = btoa(String.fromCharCode(...array))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');

    const encoder = new TextEncoder();
    const data = encoder.encode(codeVerifier);
    return crypto.subtle.digest('SHA-256', data).then((hash) => {
      const codeChallenge = btoa(String.fromCharCode(...new Uint8Array(hash)))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '');
      return { codeVerifier, codeChallenge };
    }) as any;
  }

  getAuthorizationUrl(state: string, codeChallenge: string): string {
    const params = new URLSearchParams({
      client_id: this.env.DROPBOX_CLIENT_ID,
      response_type: 'code',
      redirect_uri: this.env.DROPBOX_REDIRECT_URI,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      token_access_type: 'offline',
      scope: 'files.metadata.read files.content.read account_info.read',
    });

    return `${DROPBOX_API.authUrl}?${params.toString()}`;
  }

  async exchangeCodeForTokens(code: string, codeVerifier: string): Promise<OAuthTokens> {
    const params = new URLSearchParams({
      code,
      grant_type: 'authorization_code',
      code_verifier: codeVerifier,
      client_id: this.env.DROPBOX_CLIENT_ID,
      client_secret: this.env.DROPBOX_CLIENT_SECRET,
      redirect_uri: this.env.DROPBOX_REDIRECT_URI,
    });

    const response = await fetch(DROPBOX_API.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    if (!response.ok) {
      let errorMessage = 'Token exchange failed';
      try {
        const responseText = await response.text();
        try {
          const errorData = JSON.parse(responseText);
          errorMessage = errorData.error_description || errorData.error || responseText;
        } catch (parseError) {
          errorMessage = responseText || `HTTP ${response.status}: ${response.statusText}`;
        }
      } catch (textError) {
        errorMessage = `HTTP ${response.status}: ${response.statusText}`;
      }
      throw new Error(errorMessage);
    }

    const tokens = await response.json() as any;

    return {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token || undefined,
      expires_in: tokens.expires_in || 14400,
      token_type: tokens.token_type || 'Bearer',
      account_id: tokens.account_id,
      uid: tokens.uid,
    };
  }

  async refreshAccessToken(refreshToken: string): Promise<OAuthTokens> {
    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: this.env.DROPBOX_CLIENT_ID,
      client_secret: this.env.DROPBOX_CLIENT_SECRET,
    });

    const response = await fetch(DROPBOX_API.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    if (!response.ok) {
      let errorMessage = 'Token refresh failed';
      try {
        const responseText = await response.text();
        try {
          const errorData = JSON.parse(responseText);
          errorMessage = errorData.error_description || errorData.error || responseText;
        } catch (parseError) {
          errorMessage = responseText || `HTTP ${response.status}: ${response.statusText}`;
        }
      } catch (textError) {
        errorMessage = `HTTP ${response.status}: ${response.statusText}`;
      }
      throw new Error(errorMessage);
    }

    const tokens = await response.json() as any;

    return {
      access_token: tokens.access_token,
      refresh_token: refreshToken,
      expires_in: tokens.expires_in || 14400,
      token_type: tokens.token_type || 'Bearer',
      account_id: tokens.account_id,
      uid: tokens.uid,
    };
  }

  async storeSession(userId: string, tokens: OAuthTokens): Promise<void> {
    const expiresAt = tokens.expires_in
      ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
      : undefined;

    const sessionData = {
      userId,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt,
      createdAt: new Date().toISOString(),
      accountId: tokens.account_id,
    };

    await this.env.SESSIONS.put(
      `session:${userId}`,
      JSON.stringify(sessionData),
      { expirationTtl: 60 * 60 * 24 * 30 }
    );
  }

  async getSession(userId: string): Promise<any | null> {
    const data = await this.env.SESSIONS.get(`session:${userId}`);
    return data ? JSON.parse(data) : null;
  }

  async isSessionValid(userId: string): Promise<boolean> {
    const session = await this.getSession(userId);
    if (!session) return false;
    if (!session.expiresAt) return true;
    return new Date(session.expiresAt) > new Date();
  }

  async getValidAccessToken(userId: string): Promise<string | null> {
    const session = await this.getSession(userId);
    if (session && (await this.isSessionValid(userId))) {
      return session.accessToken;
    }

    if (session && session.refreshToken) {
      try {
        const newTokens = await this.refreshAccessToken(session.refreshToken);
        await this.storeSession(userId, newTokens);
        return newTokens.access_token;
      } catch (error) {
        console.error('Failed to refresh token from KV:', error);
      }
    }

    // Fallback to backend API
    try {
      const backendUrl =
        this.env.BACKEND_API_URL ||
        (this.env.FRONTEND_URL ? this.env.FRONTEND_URL.replace(/\/$/, '') : null) ||
        'https://api.zerotwo.app';

      const response = await fetch(
        `${backendUrl}/api/ai/tools/dropbox/token?userId=${userId}`,
        {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
          },
        }
      );

      if (response.ok) {
        const data = (await response.json()) as {
          accessToken?: string;
          refreshToken?: string;
          expiresIn?: number;
        };
        if (data.accessToken) {
          await this.storeSession(userId, {
            access_token: data.accessToken,
            refresh_token: data.refreshToken,
            expires_in: data.expiresIn,
            token_type: 'Bearer',
          });
          return data.accessToken;
        }
      }
    } catch (error) {
      console.error('Failed to fetch token from backend API (fallback):', error);
    }

    return null;
  }

  async removeSession(userId: string): Promise<void> {
    await this.env.SESSIONS.delete(`session:${userId}`);
  }
}

/**
 * CORS headers
 */
function getCorsHeaders(origin?: string): Record<string, string> {
  const allowedOrigins = [
    'http://localhost:5173',
    'http://localhost:3000',
    'https://zerotwo.app',
  ];

  const requestOrigin = origin || '';
  const allowOrigin = allowedOrigins.includes(requestOrigin)
    ? requestOrigin
    : allowedOrigins[0];

  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, mcp-session-id, Authorization',
    'Access-Control-Expose-Headers': 'Mcp-Session-Id',
    'Access-Control-Allow-Credentials': 'true',
  };
}

/**
 * Handle OPTIONS requests
 */
function handleOptions(request: Request): Response {
  return new Response(null, {
    status: 204,
    headers: getCorsHeaders(request.headers.get('Origin') || undefined),
  });
}

/**
 * Execute MCP tool
 */
async function executeTool(
  toolName: string,
  args: any,
  oauthManager: CloudflareOAuthManager,
  requestHeaders?: Headers
): Promise<any> {
  let userId = args?.userId;
  if (!userId && requestHeaders) {
    userId = requestHeaders.get('X-User-Id');
  }

  if (!userId) {
    return {
      content: [
        {
          type: 'text',
          text: 'User ID is required for all Dropbox operations. Please provide userId in tool arguments or X-User-Id header.',
        },
      ],
      isError: true,
    };
  }

  // First, try to get access token from X-Access-Token header (passed directly from backend)
  let accessToken = requestHeaders?.get('X-Access-Token') || null;
  
  // If not in header, fall back to KV storage lookup
  if (!accessToken) {
    accessToken = await oauthManager.getValidAccessToken(userId);
  }
  
  if (!accessToken) {
    return {
      content: [
        {
          type: 'text',
          text: 'Authentication required. Please authenticate with Dropbox first.',
        },
      ],
      isError: true,
    };
  }

  const dropboxClient = new DropboxClientWorker(accessToken);

  try {
    switch (toolName) {
      case 'dropbox_search':
      case 'dropbox_search_files': {
        const { query, maxResults, fileCategories, fileExtensions } = args;
        
        // Log the arguments for debugging
        console.log('dropbox_search called with args:', JSON.stringify(args));
        
        // Validate required query parameter
        if (!query || typeof query !== 'string' || query.trim() === '') {
          return {
            content: [
              {
                type: 'text',
                text: 'Error: query parameter is required and must be a non-empty string',
              },
            ],
            isError: true,
          };
        }
        
        const files = await dropboxClient.search({
          query,
          maxResults,
          fileCategories,
          fileExtensions,
        });

        // Process files and get signed URLs for images
        const processedFiles = await Promise.all(
          files.map(async (file) => {
            const isImage = file['.tag'] === 'file' && DropboxClientWorker.isImageFile(file.name);
            let signedUrl: string | undefined;

            if (isImage) {
              try {
                signedUrl = await dropboxClient.getTemporaryLink(file.path_display);
                console.log('[Worker] Generated signed URL for image in search:', file.path_display, file.name);
              } catch (error: any) {
                console.warn('[Worker] Failed to generate signed URL in search:', file.path_display, error.message);
              }
            }

            return {
              name: file.name,
              path: file.path_display,
              id: file.id,
              type: file['.tag'],
              size: file.size,
              modified: file.server_modified || file.client_modified,
              contentHash: file.content_hash,
              isImage,
              signedUrl,
            };
          })
        );

        const output = {
          files: processedFiles,
          count: processedFiles.length,
        };

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(output, null, 2),
            },
          ],
          structuredContent: output,
        };
      }

      case 'dropbox_fetch':
      case 'dropbox_fetch_file': {
        const { path, rawDownload } = args;
        
        // First, get metadata to check if it's an image
        const metadata = await dropboxClient.getFileMetadata(path);
        const isImage = DropboxClientWorker.isImageFile(metadata.name);
        
        // For images, skip downloading content and just get the signed URL
        if (isImage) {
          let signedUrl: string | undefined;
          try {
            signedUrl = await dropboxClient.getTemporaryLink(path);
            console.log('[Worker] Generated signed URL for image:', path, signedUrl);
          } catch (error: any) {
            console.warn('[Worker] Failed to generate signed URL:', path, error.message);
          }

          const output = {
            content: '[Image file - content not downloaded, use signedUrl to view]',
            metadata: {
              name: metadata.name,
              path: metadata.path_display,
              id: metadata.id,
              size: metadata.size || 0,
              modified: metadata.server_modified || metadata.client_modified || '',
              contentHash: metadata.content_hash,
              isImage: true,
              signedUrl,
            },
          };

          return {
            content: [
              {
                type: 'text',
                text: signedUrl
                  ? `Image file: ${metadata.name}\nSize: ${metadata.size} bytes\nViewable URL (valid for 4 hours): ${signedUrl}`
                  : `Image file: ${metadata.name}\nSize: ${metadata.size} bytes\nFailed to generate viewable URL`,
              },
            ],
            structuredContent: output,
          };
        }

        // For non-image files, fetch the content as before
        const { content, metadata: fetchedMetadata } = await dropboxClient.fetchFile(path, rawDownload);

        const output = {
          content,
          metadata: {
            name: fetchedMetadata.name,
            path: fetchedMetadata.path_display,
            id: fetchedMetadata.id,
            size: fetchedMetadata.size || 0,
            modified: fetchedMetadata.server_modified || fetchedMetadata.client_modified || '',
            contentHash: fetchedMetadata.content_hash,
            isImage: false,
            signedUrl: undefined,
          },
        };

        return {
          content: [
            {
              type: 'text',
              text: rawDownload
                ? `File fetched as base64 (${content.length} bytes):\n${content.slice(0, 100)}...`
                : `File content (${content.length} characters):\n${content}`,
            },
          ],
          structuredContent: output,
        };
      }

      case 'dropbox_list_recent_files': {
        const { limit } = args;
        const files = await dropboxClient.listRecentFiles(limit);

        // Process files and get signed URLs for images
        const processedFiles = await Promise.all(
          files.map(async (file) => {
            const isImage = DropboxClientWorker.isImageFile(file.name);
            let signedUrl: string | undefined;

            if (isImage) {
              try {
                signedUrl = await dropboxClient.getTemporaryLink(file.path_display);
                console.log('[Worker] Generated signed URL for image in recent files:', file.path_display, file.name);
              } catch (error: any) {
                console.warn('[Worker] Failed to generate signed URL in recent files:', file.path_display, error.message);
              }
            }

            return {
              name: file.name,
              path: file.path_display,
              id: file.id,
              size: file.size,
              modified: file.server_modified || file.client_modified || '',
              isImage,
              signedUrl,
            };
          })
        );

        const output = {
          files: processedFiles,
          count: processedFiles.length,
        };

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(output, null, 2),
            },
          ],
          structuredContent: output,
        };
      }

      case 'dropbox_get_profile': {
        const profile = await dropboxClient.getProfile();

        const output = {
          profile: {
            accountId: profile.account_id,
            name: {
              displayName: profile.name.display_name,
              givenName: profile.name.given_name,
              surname: profile.name.surname,
            },
            email: profile.email,
            emailVerified: profile.email_verified,
            accountType: profile.account_type['.tag'],
            country: profile.country,
            locale: profile.locale,
          },
        };

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(output, null, 2),
            },
          ],
        };
      }

      default:
        return {
          content: [
            {
              type: 'text',
              text: `Unknown tool: ${toolName}`,
            },
          ],
          isError: true,
        };
    }
  } catch (error: any) {
    console.error(`Error executing tool ${toolName}:`, error);
    return {
      content: [
        {
          type: 'text',
          text: `Error: ${error.message}`,
        },
      ],
      isError: true,
    };
  }
}

/**
 * Handle MCP protocol requests
 */
async function handleMcpRequest(
  request: Request,
  env: Env,
  oauthManager: CloudflareOAuthManager
): Promise<Response> {
  try {
    let body: {
      method?: string;
      id?: string | number;
      params?: {
        name?: string;
        arguments?: any;
      };
    };
    
    try {
      body = await request.json();
    } catch (parseError: any) {
      console.error('Failed to parse request body:', parseError);
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: {
            code: -32700,
            message: 'Parse error',
            data: parseError.message,
          },
        }),
        {
          status: 400,
          headers: {
            'Content-Type': 'application/json',
            ...getCorsHeaders(request.headers.get('Origin') || undefined),
          },
        }
      );
    }

    // Handle initialize request
    if (body.method === 'initialize') {
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: {
              tools: {},
            },
            serverInfo: {
              name: env.MCP_SERVER_NAME || 'dropbox-mcp-server',
              version: env.MCP_SERVER_VERSION || '1.0.0',
            },
          },
        }),
        {
          headers: {
            'Content-Type': 'application/json',
            ...getCorsHeaders(request.headers.get('Origin') || undefined),
          },
        }
      );
    }

    // Handle tools/list request
    if (body.method === 'tools/list') {
      const tools = dropboxTools.map((tool) => ({
        name: tool.name,
        description: tool.definition.description || tool.definition.title || '',
        inputSchema: {
          type: 'object',
          properties: {},
          required: [],
        },
      }));

      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            tools,
          },
        }),
        {
          headers: {
            'Content-Type': 'application/json',
            ...getCorsHeaders(request.headers.get('Origin') || undefined),
          },
        }
      );
    }

    // Handle tools/call request
    if (body.method === 'tools/call') {
      if (!body.params) {
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            error: {
              code: -32602,
              message: 'Invalid params',
            },
          }),
          {
            status: 400,
            headers: {
              'Content-Type': 'application/json',
              ...getCorsHeaders(),
            },
          }
        );
      }

      const { name, arguments: args } = body.params;
      if (!name) {
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            error: {
              code: -32602,
              message: 'Tool name is required',
            },
          }),
          {
            status: 400,
            headers: {
              'Content-Type': 'application/json',
              ...getCorsHeaders(),
            },
          }
        );
      }

      const result = await executeTool(name, args || {}, oauthManager, request.headers);

      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            content: result.content,
            isError: result.isError || false,
          },
        }),
        {
          headers: {
            'Content-Type': 'application/json',
            ...getCorsHeaders(request.headers.get('Origin') || undefined),
          },
        }
      );
    }

    // Handle notifications (no id field, no response expected)
    // Notifications like notifications/initialized don't have an id and don't require a JSON-RPC response
    // Use 204 No Content for proper HTTP semantics
    if (body.method?.startsWith('notifications/') || (!body.id && body.method)) {
      // For notifications, just acknowledge with 204 No Content
      return new Response(null, {
        status: 204,
        headers: getCorsHeaders(request.headers.get('Origin') || undefined),
      });
    }

    // Unknown method (only for requests with id)
    return new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        id: body.id,
        error: {
          code: -32601,
          message: 'Method not found',
        },
      }),
      {
        status: 400,
        headers: {
          'Content-Type': 'application/json',
          ...getCorsHeaders(request.headers.get('Origin') || undefined),
        },
      }
    );
  } catch (error: any) {
    console.error('MCP request error:', error);
    return new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32603,
          message: 'Internal error',
          data: error.message,
        },
      }),
      {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          ...getCorsHeaders(request.headers.get('Origin') || undefined),
        },
      }
    );
  }
}

/**
 * SSE endpoint for MCP protocol
 */
function createSseResponse(env: Env): Response {
  const encoder = new TextEncoder();
  let keepAliveInterval: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream({
    start(controller) {
      const initMessage = {
        jsonrpc: '2.0',
        method: 'notifications/initialized',
        params: {},
      };
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(initMessage)}\n\n`));

      keepAliveInterval = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': keepalive\n\n'));
        } catch (e) {
          if (keepAliveInterval) {
            clearInterval(keepAliveInterval);
            keepAliveInterval = null;
          }
        }
      }, 30000);
    },
    cancel() {
      if (keepAliveInterval) {
        clearInterval(keepAliveInterval);
        keepAliveInterval = null;
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      ...getCorsHeaders(),
    },
  });
}

/**
 * Main Worker fetch handler
 */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    const corsHeaders = getCorsHeaders(origin || undefined);

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return handleOptions(request);
    }

    try {
      const oauthManager = new CloudflareOAuthManager(env);

      // Health check
      if (url.pathname === '/health' || url.pathname === '/') {
        return new Response(
          JSON.stringify({
            status: 'healthy',
            server: env.MCP_SERVER_NAME,
            version: env.MCP_SERVER_VERSION,
            timestamp: new Date().toISOString(),
          }),
          {
            headers: {
              'Content-Type': 'application/json',
              ...corsHeaders,
            },
          }
        );
      }

      // OAuth authorization endpoint
      if (url.pathname === '/oauth/authorize' && request.method === 'GET') {
        const userId = url.searchParams.get('userId');
        const state = url.searchParams.get('state');

        if (!userId || !state) {
          return new Response(
            JSON.stringify({ error: 'Missing required parameters: userId and state' }),
            {
              status: 400,
              headers: { 'Content-Type': 'application/json', ...corsHeaders },
            }
          );
        }

        const { codeVerifier, codeChallenge } = await oauthManager.generatePKCE();
        const authUrl = oauthManager.getAuthorizationUrl(state, codeChallenge);

        return new Response(
          JSON.stringify({ authorizationUrl: authUrl, state, codeVerifier }),
          {
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
          }
        );
      }

      // OAuth callback endpoint
      if (url.pathname === '/oauth/callback' && request.method === 'GET') {
        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');
        const error = url.searchParams.get('error');

        if (error) {
          return Response.redirect(
            `${env.FRONTEND_URL}/settings?oauth_error=${encodeURIComponent(error)}`,
            302
          );
        }

        if (!code || !state) {
          return new Response(
            JSON.stringify({ error: 'Missing required parameters: code and state' }),
            {
              status: 400,
              headers: { 'Content-Type': 'application/json', ...corsHeaders },
            }
          );
        }

        return Response.redirect(
          `${env.FRONTEND_URL}/settings?oauth_code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
          302
        );
      }

      // OAuth token exchange endpoint
      if (url.pathname === '/oauth/exchange' && request.method === 'POST') {
        const body = (await request.json()) as {
          code?: string;
          codeVerifier?: string;
          userId?: string;
        };
        const { code, codeVerifier, userId } = body;

        if (!code || !codeVerifier || !userId) {
          return new Response(
            JSON.stringify({
              error: 'Missing required parameters: code, codeVerifier, and userId',
            }),
            {
              status: 400,
              headers: { 'Content-Type': 'application/json', ...corsHeaders },
            }
          );
        }

        const tokens = await oauthManager.exchangeCodeForTokens(code, codeVerifier);
        await oauthManager.storeSession(userId, tokens);

        return new Response(
          JSON.stringify({
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token,
            expiresIn: tokens.expires_in,
            timestamp: new Date().toISOString(),
          }),
          {
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
          }
        );
      }

      // OAuth refresh endpoint
      if (url.pathname === '/oauth/refresh' && request.method === 'POST') {
        const body = (await request.json()) as { userId?: string; refreshToken?: string };
        const { userId, refreshToken } = body;

        if (!userId || !refreshToken) {
          return new Response(
            JSON.stringify({ error: 'Missing required parameters: userId and refreshToken' }),
            {
              status: 400,
              headers: { 'Content-Type': 'application/json', ...corsHeaders },
            }
          );
        }

        const tokens = await oauthManager.refreshAccessToken(refreshToken);
        await oauthManager.storeSession(userId, tokens);

        return new Response(
          JSON.stringify({
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token,
            expiresIn: tokens.expires_in,
            timestamp: new Date().toISOString(),
          }),
          {
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
          }
        );
      }

      // OAuth disconnect endpoint
      if (url.pathname === '/oauth/disconnect' && request.method === 'POST') {
        const body = (await request.json()) as { userId?: string };
        const { userId } = body;

        if (!userId) {
          return new Response(
            JSON.stringify({ error: 'Missing required parameter: userId' }),
            {
              status: 400,
              headers: { 'Content-Type': 'application/json', ...corsHeaders },
            }
          );
        }

        await oauthManager.removeSession(userId);

        return new Response(
          JSON.stringify({ success: true, message: 'Successfully disconnected' }),
          {
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
          }
        );
      }

      // OAuth token sync endpoint
      if (url.pathname === '/oauth/sync' && request.method === 'POST') {
        const body = (await request.json()) as {
          userId?: string;
          accessToken?: string;
          refreshToken?: string;
          expiresIn?: number;
        };
        const { userId, accessToken, refreshToken, expiresIn } = body;

        if (!userId || !accessToken) {
          return new Response(
            JSON.stringify({ error: 'Missing required parameters: userId and accessToken' }),
            {
              status: 400,
              headers: { 'Content-Type': 'application/json', ...corsHeaders },
            }
          );
        }

        await oauthManager.storeSession(userId, {
          access_token: accessToken,
          refresh_token: refreshToken,
          expires_in: expiresIn,
          token_type: 'Bearer',
        });

        return new Response(
          JSON.stringify({ success: true, message: 'Tokens synced successfully' }),
          {
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
          }
        );
      }

      // MCP endpoint - POST for JSON-RPC (StreamableHTTP)
      if (url.pathname === '/mcp' && request.method === 'POST') {
        return handleMcpRequest(request, env, oauthManager);
      }

      // MCP endpoint - GET for SSE (fallback transport)
      // The MCP SDK tries StreamableHTTP first, then falls back to SSE on the same endpoint
      if (url.pathname === '/mcp' && request.method === 'GET') {
        return createSseResponse(env);
      }

      // Legacy SSE endpoint for backward compatibility
      if (url.pathname === '/sse' && request.method === 'GET') {
        return createSseResponse(env);
      }

      // 404 - Not Found
      return new Response(
        JSON.stringify({ error: 'Not Found', message: 'The requested endpoint does not exist' }),
        {
          status: 404,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        }
      );
    } catch (error: any) {
      console.error('Worker error:', error);
      // Always return proper JSON-RPC error format
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: {
            code: -32603,
            message: 'Internal error',
            data: error.message || String(error),
          },
        }),
        {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        }
      );
    }
  },
};

