/**
 * TypeScript type definitions for Dropbox MCP Server
 */

export interface OAuthTokens {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  account_id?: string;
  uid?: string;
}

export interface SessionData {
  userId: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date;
  createdAt: Date;
  accountId?: string;
}

export interface DropboxFile {
  name: string;
  path_display: string;
  path_lower: string;
  id: string;
  '.tag': 'file' | 'folder';
  size?: number;
  client_modified?: string;
  server_modified?: string;
  rev?: string;
  content_hash?: string;
}

export interface DropboxSearchMatch {
  metadata: {
    metadata: DropboxFile;
  };
  match_type: {
    '.tag': string;
  };
}

export interface DropboxAccount {
  account_id: string;
  name: {
    given_name: string;
    surname: string;
    familiar_name: string;
    display_name: string;
  };
  email: string;
  email_verified: boolean;
  disabled: boolean;
  locale: string;
  referral_link: string;
  is_paired: boolean;
  account_type: {
    '.tag': 'basic' | 'pro' | 'business';
  };
  country?: string;
  profile_photo_url?: string;
}







