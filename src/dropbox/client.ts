/**
 * Dropbox API Client for MCP Server
 */

import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { DropboxFile, DropboxSearchMatch, DropboxAccount } from '../types/index.js';

export class DropboxClient {
  private accessToken: string;

  constructor(accessToken: string) {
    this.accessToken = accessToken;
  }

  /**
   * Get authorization headers
   */
  private getHeaders(contentType: string = 'application/json'): HeadersInit {
    return {
      'Authorization': `Bearer ${this.accessToken}`,
      'Content-Type': contentType,
    };
  }

  /**
   * Search for files and folders in Dropbox
   */
  async search(options: {
    query: string;
    maxResults?: number;
    fileCategories?: string[];
    fileExtensions?: string[];
  }): Promise<DropboxFile[]> {
    try {
      const {
        query,
        maxResults = 100,
        fileCategories = [],
        fileExtensions = [],
      } = options;

      logger.info('[DropboxClient] Searching files', { query, maxResults });

      const searchOptions: any = {
        query,
        options: {
          max_results: Math.min(Math.max(1, maxResults), 1000),
          file_status: 'active',
          filename_only: false,
        },
      };

      // Add file category filter if provided
      if (fileCategories && fileCategories.length > 0) {
        searchOptions.options.file_categories = fileCategories;
      }

      // Add file extension filter if provided
      if (fileExtensions && fileExtensions.length > 0) {
        searchOptions.options.file_extensions = fileExtensions;
      }

      const response = await fetch(`${config.dropboxApi.apiUrl}/files/search_v2`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify(searchOptions),
      });

      if (!response.ok) {
        const errorData = await response.json() as any;
        logger.error('[DropboxClient] Search failed', errorData);
        throw new Error(errorData.error_summary || 'Search failed');
      }

      const data = await response.json() as any;
      const matches: DropboxSearchMatch[] = data.matches || [];

      const files = matches.map((match) => match.metadata?.metadata).filter(Boolean);
      logger.info('[DropboxClient] Search completed', { resultCount: files.length });

      return files;
    } catch (error: any) {
      logger.error('[DropboxClient] Search error:', error);
      throw error;
    }
  }

  /**
   * Fetch file metadata by path
   */
  async getFileMetadata(path: string): Promise<DropboxFile> {
    try {
      logger.info('[DropboxClient] Fetching file metadata', { path });

      const response = await fetch(`${config.dropboxApi.apiUrl}/files/get_metadata`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify({ path }),
      });

      if (!response.ok) {
        const errorData = await response.json() as any;
        logger.error('[DropboxClient] Get metadata failed', errorData);
        throw new Error(errorData.error_summary || 'Get metadata failed');
      }

      const metadata = await response.json() as DropboxFile;
      logger.info('[DropboxClient] Metadata retrieved', { path });

      return metadata;
    } catch (error: any) {
      logger.error('[DropboxClient] Get metadata error:', error);
      throw error;
    }
  }

  /**
   * Fetch file content by path
   */
  async fetchFile(path: string, rawDownload: boolean = false): Promise<{ content: string; metadata: DropboxFile }> {
    try {
      logger.info('[DropboxClient] Fetching file', { path, rawDownload });

      const response = await fetch(`${config.dropboxApi.contentUrl}/files/download`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Dropbox-API-Arg': JSON.stringify({ path }),
        },
      });

      if (!response.ok) {
        const errorData = await response.json() as any;
        logger.error('[DropboxClient] File download failed', errorData);
        throw new Error(errorData.error_summary || 'File download failed');
      }

      // Get metadata from response headers
      const metadataHeader = response.headers.get('dropbox-api-result');
      const metadata = metadataHeader ? JSON.parse(metadataHeader) : {};

      // Read content
      let content: string;
      if (rawDownload) {
        const buffer = await response.arrayBuffer();
        content = Buffer.from(buffer).toString('base64');
      } else {
        content = await response.text();
      }

      logger.info('[DropboxClient] File fetched', { path, contentLength: content.length });

      return { content, metadata };
    } catch (error: any) {
      logger.error('[DropboxClient] Fetch file error:', error);
      throw error;
    }
  }

  /**
   * List recently modified files
   */
  async listRecentFiles(limit: number = 20): Promise<DropboxFile[]> {
    try {
      logger.info('[DropboxClient] Listing recent files', { limit });

      const response = await fetch(`${config.dropboxApi.apiUrl}/files/list_revisions`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify({
          path: '',
          mode: 'path',
          limit: Math.min(Math.max(1, limit), 100),
        }),
      });

      // If list_revisions doesn't work, fallback to list_folder with recursive
      if (!response.ok) {
        logger.info('[DropboxClient] Falling back to list_folder for recent files');
        
        const folderResponse = await fetch(`${config.dropboxApi.apiUrl}/files/list_folder`, {
          method: 'POST',
          headers: this.getHeaders(),
          body: JSON.stringify({
            path: '',
            recursive: true,
            include_deleted: false,
            include_has_explicit_shared_members: false,
            include_mounted_folders: true,
            limit: Math.min(Math.max(1, limit), 2000),
          }),
        });

        if (!folderResponse.ok) {
          const errorData = await folderResponse.json() as any;
          logger.error('[DropboxClient] List folder failed', errorData);
          throw new Error(errorData.error_summary || 'List folder failed');
        }

        const folderData = await folderResponse.json() as any;
        const files: DropboxFile[] = folderData.entries || [];
        
        // Sort by server_modified date and take most recent
        const sortedFiles = files
          .filter((file) => file['.tag'] === 'file' && file.server_modified)
          .sort((a, b) => {
            const dateA = new Date(a.server_modified!).getTime();
            const dateB = new Date(b.server_modified!).getTime();
            return dateB - dateA;
          })
          .slice(0, limit);

        logger.info('[DropboxClient] Recent files retrieved', { count: sortedFiles.length });
        return sortedFiles;
      }

      const data = await response.json() as any;
      const files: DropboxFile[] = data.entries || [];
      
      logger.info('[DropboxClient] Recent files retrieved', { count: files.length });
      return files;
    } catch (error: any) {
      logger.error('[DropboxClient] List recent files error:', error);
      throw error;
    }
  }

  /**
   * Get current user's Dropbox profile
   */
  async getProfile(): Promise<DropboxAccount> {
    try {
      logger.info('[DropboxClient] Getting user profile');

      const response = await fetch(`${config.dropboxApi.apiUrl}/users/get_current_account`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: 'null',
      });

      if (!response.ok) {
        const errorData = await response.json() as any;
        logger.error('[DropboxClient] Get profile failed', errorData);
        throw new Error(errorData.error_summary || 'Get profile failed');
      }

      const profile = await response.json() as DropboxAccount;
      logger.info('[DropboxClient] Profile retrieved', { accountId: profile.account_id });

      return profile;
    } catch (error: any) {
      logger.error('[DropboxClient] Get profile error:', error);
      throw error;
    }
  }

  /**
   * List folder contents
   */
  async listFolder(path: string = '', recursive: boolean = false): Promise<DropboxFile[]> {
    try {
      logger.info('[DropboxClient] Listing folder', { path, recursive });

      const response = await fetch(`${config.dropboxApi.apiUrl}/files/list_folder`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify({
          path,
          recursive,
          include_deleted: false,
          include_has_explicit_shared_members: false,
          include_mounted_folders: true,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json() as any;
        logger.error('[DropboxClient] List folder failed', errorData);
        throw new Error(errorData.error_summary || 'List folder failed');
      }

      const data = await response.json() as any;
      const entries: DropboxFile[] = data.entries || [];

      logger.info('[DropboxClient] Folder listed', { entryCount: entries.length });
      return entries;
    } catch (error: any) {
      logger.error('[DropboxClient] List folder error:', error);
      throw error;
    }
  }

  /**
   * Get a temporary link for a file (valid for 4 hours)
   * Converts download link to viewable link for rendering in browsers/chat
   */
  async getTemporaryLink(path: string): Promise<string> {
    try {
      logger.info('[DropboxClient] Getting temporary link', { path });

      const response = await fetch(`${config.dropboxApi.apiUrl}/files/get_temporary_link`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify({ path }),
      });

      if (!response.ok) {
        const errorData = await response.json() as any;
        logger.error('[DropboxClient] Get temporary link failed', errorData);
        throw new Error(errorData.error_summary || 'Get temporary link failed');
      }

      const data = await response.json() as any;
      let link = data.link;
      
      // Convert download link to viewable link by changing dl=1 to dl=0 or raw=1
      // This makes the link render directly in browsers instead of forcing download
      if (link.includes('dl=1')) {
        link = link.replace('dl=1', 'raw=1');
      } else if (!link.includes('raw=1')) {
        // Add raw=1 parameter if neither dl nor raw is present
        link += (link.includes('?') ? '&' : '?') + 'raw=1';
      }
      
      logger.info('[DropboxClient] Temporary link retrieved and converted to viewable', { path, link });

      return link;
    } catch (error: any) {
      logger.error('[DropboxClient] Get temporary link error:', error);
      throw error;
    }
  }

  /**
   * Check if a file is an image based on its extension
   */
  static isImageFile(filename: string): boolean {
    const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg', '.ico', '.tiff', '.tif', '.heic', '.heif'];
    const lowerFilename = filename.toLowerCase();
    return imageExtensions.some(ext => lowerFilename.endsWith(ext));
  }
}

