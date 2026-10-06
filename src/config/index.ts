/**
 * Configuration management for Dropbox MCP Server
 */

import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

export const config = {
  server: {
    port: parseInt(process.env.PORT || '3003', 10),
    nodeEnv: process.env.NODE_ENV || 'development',
    name: process.env.MCP_SERVER_NAME || 'dropbox-mcp-server',
    version: process.env.MCP_SERVER_VERSION || '1.0.0',
  },
  dropbox: {
    clientId: process.env.DROPBOX_CLIENT_ID || '',
    clientSecret: process.env.DROPBOX_CLIENT_SECRET || '',
    redirectUri: process.env.DROPBOX_REDIRECT_URI || 'http://localhost:3003/oauth/callback',
  },
  frontend: {
    url: process.env.FRONTEND_URL || 'http://localhost:5173',
  },
  backend: {
    apiUrl: process.env.BACKEND_API_URL || 'http://localhost:3002',
  },
  dropboxApi: {
    authUrl: 'https://www.dropbox.com/oauth2/authorize',
    tokenUrl: 'https://api.dropboxapi.com/oauth2/token',
    apiUrl: 'https://api.dropboxapi.com/2',
    contentUrl: 'https://content.dropboxapi.com/2',
    scopes: [
      'files.metadata.read',
      'files.content.read',
      'account_info.read',
    ],
  },
};

// Validate required configuration
export function validateConfig(): void {
  const required = [
    { key: 'DROPBOX_CLIENT_ID', value: config.dropbox.clientId },
    { key: 'DROPBOX_CLIENT_SECRET', value: config.dropbox.clientSecret },
  ];

  const missing = required.filter((item) => !item.value);

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.map((item) => item.key).join(', ')}`
    );
  }
}







