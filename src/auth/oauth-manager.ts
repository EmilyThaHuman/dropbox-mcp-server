/**
 * OAuth Manager for handling Dropbox OAuth 2.0 authentication with PKCE
 */

import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { OAuthTokens, SessionData } from '../types/index.js';
import crypto from 'node:crypto';

export class OAuthManager {
  private sessions: Map<string, SessionData>;

  constructor() {
    this.sessions = new Map();
  }

  /**
   * Generate PKCE code verifier and challenge
   */
  generatePKCE(): { codeVerifier: string; codeChallenge: string } {
    const codeVerifier = crypto.randomBytes(32).toString('base64url');
    const codeChallenge = crypto
      .createHash('sha256')
      .update(codeVerifier)
      .digest('base64url');

    return { codeVerifier, codeChallenge };
  }

  /**
   * Generate OAuth authorization URL with PKCE
   */
  getAuthorizationUrl(state: string, codeChallenge: string): string {
    const params = new URLSearchParams({
      client_id: config.dropbox.clientId,
      response_type: 'code',
      redirect_uri: config.dropbox.redirectUri,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      token_access_type: 'offline', // Request refresh token
      scope: config.dropboxApi.scopes.join(' '),
    });

    const authUrl = `${config.dropboxApi.authUrl}?${params.toString()}`;
    logger.info('[OAuthManager] Generated authorization URL', { state });
    return authUrl;
  }

  /**
   * Exchange authorization code for tokens
   */
  async exchangeCodeForTokens(code: string, codeVerifier: string): Promise<OAuthTokens> {
    try {
      logger.info('[OAuthManager] Exchanging code for tokens');

      const params = new URLSearchParams({
        code,
        grant_type: 'authorization_code',
        code_verifier: codeVerifier,
        client_id: config.dropbox.clientId,
        client_secret: config.dropbox.clientSecret,
        redirect_uri: config.dropbox.redirectUri,
      });

      const response = await fetch(config.dropboxApi.tokenUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params.toString(),
      });

      if (!response.ok) {
        const errorData = await response.json() as any;
        logger.error('[OAuthManager] Token exchange failed', errorData);
        throw new Error(errorData.error_description || errorData.error || 'Token exchange failed');
      }

      const tokens = await response.json() as any;
      logger.info('[OAuthManager] Successfully exchanged code for tokens');

      return {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token || undefined,
        expires_in: tokens.expires_in || 14400, // Dropbox tokens typically expire in 4 hours
        token_type: tokens.token_type || 'Bearer',
        account_id: tokens.account_id,
        uid: tokens.uid,
      };
    } catch (error) {
      logger.error('[OAuthManager] Error exchanging code for tokens:', error);
      throw new Error('Failed to exchange authorization code for tokens');
    }
  }

  /**
   * Refresh access token using refresh token
   */
  async refreshAccessToken(refreshToken: string): Promise<OAuthTokens> {
    try {
      logger.info('[OAuthManager] Refreshing access token');

      const params = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: config.dropbox.clientId,
        client_secret: config.dropbox.clientSecret,
      });

      const response = await fetch(config.dropboxApi.tokenUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params.toString(),
      });

      if (!response.ok) {
        const errorData = await response.json() as any;
        logger.error('[OAuthManager] Token refresh failed', errorData);
        throw new Error(errorData.error_description || errorData.error || 'Token refresh failed');
      }

      const tokens = await response.json() as any;
      logger.info('[OAuthManager] Successfully refreshed access token');

      return {
        access_token: tokens.access_token,
        refresh_token: refreshToken, // Keep the same refresh token
        expires_in: tokens.expires_in || 14400,
        token_type: tokens.token_type || 'Bearer',
        account_id: tokens.account_id,
        uid: tokens.uid,
      };
    } catch (error) {
      logger.error('[OAuthManager] Error refreshing access token:', error);
      throw new Error('Failed to refresh access token');
    }
  }

  /**
   * Store session data
   */
  storeSession(userId: string, tokens: OAuthTokens): void {
    const expiresAt = tokens.expires_in
      ? new Date(Date.now() + tokens.expires_in * 1000)
      : undefined;

    const sessionData: SessionData = {
      userId,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt,
      createdAt: new Date(),
      accountId: tokens.account_id,
    };

    this.sessions.set(userId, sessionData);
    logger.info('[OAuthManager] Stored session for user', { userId });
  }

  /**
   * Get session data
   */
  getSession(userId: string): SessionData | undefined {
    return this.sessions.get(userId);
  }

  /**
   * Check if session is valid (not expired)
   */
  isSessionValid(userId: string): boolean {
    const session = this.sessions.get(userId);
    if (!session) {
      return false;
    }

    if (!session.expiresAt) {
      return true; // No expiration set
    }

    return session.expiresAt > new Date();
  }

  /**
   * Get valid access token (refresh if needed)
   */
  async getValidAccessToken(userId: string): Promise<string | null> {
    const session = this.sessions.get(userId);
    if (!session) {
      logger.warn('[OAuthManager] No session found for user', { userId });
      return null;
    }

    // Check if token is still valid
    if (this.isSessionValid(userId)) {
      return session.accessToken;
    }

    // Token expired, try to refresh
    if (!session.refreshToken) {
      logger.warn('[OAuthManager] No refresh token available for user', { userId });
      return null;
    }

    try {
      const newTokens = await this.refreshAccessToken(session.refreshToken);
      this.storeSession(userId, newTokens);
      return newTokens.access_token;
    } catch (error) {
      logger.error('[OAuthManager] Failed to refresh token for user', { userId, error });
      return null;
    }
  }

  /**
   * Remove session
   */
  removeSession(userId: string): void {
    this.sessions.delete(userId);
    logger.info('[OAuthManager] Removed session for user', { userId });
  }

  /**
   * Get all active sessions
   */
  getActiveSessions(): string[] {
    return Array.from(this.sessions.keys());
  }
}

// Singleton instance
export const oauthManager = new OAuthManager();

