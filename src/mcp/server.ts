/**
 * MCP Server implementation for Dropbox
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express, { Request, Response } from 'express';
import cors from 'cors';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { dropboxTools } from './tools.js';
import { oauthManager } from '../auth/oauth-manager.js';
import { randomUUID } from 'node:crypto';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

export class DropboxMcpServer {
  private mcpServer: McpServer;
  private app: express.Application;
  private transports: Map<string, StreamableHTTPServerTransport>;

  constructor() {
    // Initialize MCP server
    this.mcpServer = new McpServer({
      name: config.server.name,
      version: config.server.version,
    });

    // Initialize Express app
    this.app = express();
    this.transports = new Map();

    this.setupMiddleware();
    this.registerTools();
    this.setupRoutes();
  }

  /**
   * Setup Express middleware
   */
  private setupMiddleware(): void {
    // CORS configuration
    this.app.use(
      cors({
        origin: [config.frontend.url, 'http://localhost:5173', 'http://localhost:3000'],
        exposedHeaders: ['Mcp-Session-Id'],
        allowedHeaders: ['Content-Type', 'mcp-session-id', 'Authorization'],
        credentials: true,
      })
    );

    // Body parser
    this.app.use(express.json());
    this.app.use(express.urlencoded({ extended: true }));

    // Request logging
    this.app.use((req, _res, next) => {
      logger.debug(`${req.method} ${req.path}`, {
        headers: req.headers,
        body: req.body,
      });
      next();
    });
  }

  /**
   * Register MCP tools
   */
  private registerTools(): void {
    logger.info('[DropboxMcpServer] Registering tools');

    for (const tool of dropboxTools) {
      this.mcpServer.registerTool(
        tool.name,
        tool.definition as any,
        tool.handler as any
      );
      logger.info(`[DropboxMcpServer] Registered tool: ${tool.name}`);
    }
  }

  /**
   * Setup Express routes
   */
  private setupRoutes(): void {
    // Health check
    this.app.get('/health', (_req, res) => {
      res.json({
        status: 'healthy',
        server: config.server.name,
        version: config.server.version,
        timestamp: new Date().toISOString(),
      });
    });

    // OAuth authorization endpoint
    this.app.get('/oauth/authorize', (req, res) => {
      try {
        const { userId, state } = req.query;

        if (!userId || !state) {
          return res.status(400).json({
            error: 'Missing required parameters: userId and state',
          });
        }

        // Generate PKCE code challenge
        const { codeVerifier, codeChallenge } = oauthManager.generatePKCE();

        // Store code verifier temporarily (in production, use Redis or similar)
        // For now, we'll include it in the response for frontend to store
        const authUrl = oauthManager.getAuthorizationUrl(state as string, codeChallenge);

        logger.info('[OAuth] Authorization requested', { userId, state });

        res.json({
          authorizationUrl: authUrl,
          state,
          codeVerifier, // Frontend will need to send this back during callback
        });
      } catch (error: any) {
        logger.error('[OAuth] Authorization error:', error);
        res.status(500).json({
          error: 'Failed to generate authorization URL',
          message: error.message,
        });
      }
    });

    // OAuth callback endpoint
    this.app.get('/oauth/callback', async (req, res) => {
      try {
        const { code, state, error } = req.query;

        if (error) {
          logger.error('[OAuth] Callback error:', error);
          return res.redirect(
            `${config.frontend.url}/settings?oauth_error=${encodeURIComponent(error as string)}`
          );
        }

        if (!code || !state) {
          return res.status(400).json({
            error: 'Missing required parameters: code and state',
          });
        }

        logger.info('[OAuth] Processing callback', { state });

        // In production, retrieve code_verifier from session/storage
        // For now, we expect it to be passed from the frontend
        res.redirect(
          `${config.frontend.url}/settings?oauth_code=${encodeURIComponent(code as string)}&state=${encodeURIComponent(state as string)}`
        );
      } catch (error: any) {
        logger.error('[OAuth] Callback processing error:', error);
        res.redirect(
          `${config.frontend.url}/settings?oauth_error=${encodeURIComponent(error.message)}`
        );
      }
    });

    // OAuth token exchange endpoint (called by frontend with code and code_verifier)
    this.app.post('/oauth/exchange', async (req, res) => {
      try {
        const { code, codeVerifier, userId } = req.body;

        if (!code || !codeVerifier || !userId) {
          return res.status(400).json({
            error: 'Missing required parameters: code, codeVerifier, and userId',
          });
        }

        logger.info('[OAuth] Exchanging code for tokens', { userId });

        // Exchange code for tokens
        const tokens = await oauthManager.exchangeCodeForTokens(code, codeVerifier);

        // Store session
        oauthManager.storeSession(userId, tokens);

        logger.info('[OAuth] Successfully authenticated user', { userId });

        res.json({
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          expiresIn: tokens.expires_in,
          timestamp: new Date().toISOString(),
        });
      } catch (error: any) {
        logger.error('[OAuth] Token exchange error:', error);
        res.status(500).json({
          error: 'Failed to exchange code for tokens',
          message: error.message,
        });
      }
    });

    // OAuth token refresh endpoint
    this.app.post('/oauth/refresh', async (req, res) => {
      try {
        const { userId, refreshToken } = req.body;

        if (!userId || !refreshToken) {
          return res.status(400).json({
            error: 'Missing required parameters: userId and refreshToken',
          });
        }

        logger.info('[OAuth] Refreshing token', { userId });

        const tokens = await oauthManager.refreshAccessToken(refreshToken);
        oauthManager.storeSession(userId, tokens);

        res.json({
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          expiresIn: tokens.expires_in,
          timestamp: new Date().toISOString(),
        });
      } catch (error: any) {
        logger.error('[OAuth] Token refresh error:', error);
        res.status(500).json({
          error: 'Failed to refresh token',
          message: error.message,
        });
      }
    });

    // OAuth disconnect endpoint
    this.app.post('/oauth/disconnect', (req, res) => {
      try {
        const { userId } = req.body;

        if (!userId) {
          return res.status(400).json({
            error: 'Missing required parameter: userId',
          });
        }

        logger.info('[OAuth] Disconnecting user', { userId });

        oauthManager.removeSession(userId);

        res.json({
          success: true,
          message: 'Successfully disconnected',
        });
      } catch (error: any) {
        logger.error('[OAuth] Disconnect error:', error);
        res.status(500).json({
          error: 'Failed to disconnect',
          message: error.message,
        });
      }
    });

    // MCP endpoint - POST for client-to-server communication
    this.app.post('/mcp', async (req: Request, res: Response) => {
      try {
        const sessionId = req.headers['mcp-session-id'] as string | undefined;
        let transport: StreamableHTTPServerTransport;

        if (sessionId && this.transports.has(sessionId)) {
          // Reuse existing transport
          transport = this.transports.get(sessionId)!;
          logger.debug('[MCP] Reusing existing session', { sessionId });
        } else if (!sessionId && isInitializeRequest(req.body)) {
          // New initialization request
          logger.info('[MCP] Creating new session');

          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (id) => {
              this.transports.set(id, transport);
              logger.info('[MCP] Session initialized', { sessionId: id });
            },
            enableDnsRebindingProtection: false, // Disable for development
          });

          transport.onclose = () => {
            if (transport.sessionId) {
              this.transports.delete(transport.sessionId);
              logger.info('[MCP] Session closed', { sessionId: transport.sessionId });
            }
          };

          await this.mcpServer.connect(transport);
        } else {
          // Invalid request
          logger.warn('[MCP] Invalid request - no valid session ID');
          return res.status(400).json({
            jsonrpc: '2.0',
            error: {
              code: -32000,
              message: 'Bad Request: No valid session ID provided',
            },
            id: null,
          });
        }

        // Handle the request
        await transport.handleRequest(req, res, req.body);
      } catch (error: any) {
        logger.error('[MCP] Request handling error:', error);
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: '2.0',
            error: {
              code: -32603,
              message: 'Internal server error',
            },
            id: null,
          });
        }
      }
    });

    // MCP endpoint - GET for server-to-client notifications via SSE
    this.app.get('/mcp', async (req: Request, res: Response) => {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;

      if (!sessionId || !this.transports.has(sessionId)) {
        logger.warn('[MCP] Invalid session for GET request', { sessionId });
        return res.status(400).send('Invalid or missing session ID');
      }

      const transport = this.transports.get(sessionId)!;
      await transport.handleRequest(req, res);
    });

    // MCP endpoint - DELETE for session termination
    this.app.delete('/mcp', async (req: Request, res: Response) => {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;

      if (!sessionId || !this.transports.has(sessionId)) {
        logger.warn('[MCP] Invalid session for DELETE request', { sessionId });
        return res.status(400).send('Invalid or missing session ID');
      }

      const transport = this.transports.get(sessionId)!;
      await transport.handleRequest(req, res);
    });

    // 404 handler
    this.app.use((_req, res) => {
      res.status(404).json({
        error: 'Not Found',
        message: 'The requested endpoint does not exist',
      });
    });

    // Error handler
    this.app.use((err: any, _req: Request, res: Response, _next: any) => {
      logger.error('[Express] Unhandled error:', err);
      res.status(500).json({
        error: 'Internal Server Error',
        message: err.message,
      });
    });
  }

  /**
   * Start the server
   */
  start(): void {
    const port = config.server.port;

    this.app.listen(port, () => {
      logger.info(`[DropboxMcpServer] Server running on http://localhost:${port}`);
      logger.info(`[DropboxMcpServer] MCP endpoint: http://localhost:${port}/mcp`);
      logger.info(`[DropboxMcpServer] OAuth authorize: http://localhost:${port}/oauth/authorize`);
      logger.info(`[DropboxMcpServer] OAuth callback: http://localhost:${port}/oauth/callback`);
      logger.info(`[DropboxMcpServer] Health check: http://localhost:${port}/health`);
    });
  }

  /**
   * Get Express app instance
   */
  getApp(): express.Application {
    return this.app;
  }
}







