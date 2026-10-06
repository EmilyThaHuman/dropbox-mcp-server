/**
 * MCP Tool definitions for Dropbox operations
 */

import { z } from 'zod';
import { DropboxClient } from '../dropbox/client.js';
import { oauthManager } from '../auth/oauth-manager.js';
import { logger } from '../utils/logger.js';

/**
 * Dropbox Search Tool
 */
export const dropboxSearchTool = {
  name: 'dropbox_search',
  definition: {
    title: 'Search Dropbox Files',
    description: 'Use this to find Dropbox files and folders before fetching one. It returns each result\'s full `path` for `dropbox_fetch` or `dropbox_fetch_file`, and image results may also include temporary `signedUrl` links.',
    inputSchema: {
      userId: z.string().describe('User ID for authentication'),
      query: z.string().describe('Search query text'),
      maxResults: z.number().min(1).max(1000).default(100).describe('Maximum number of results to return'),
      fileCategories: z.array(z.string()).optional().describe('Filter by file categories (e.g., image, document, video, audio)'),
      fileExtensions: z.array(z.string()).optional().describe('Filter by file extensions (e.g., .pdf, .jpg, .docx)'),
    },
    outputSchema: {
      files: z.array(
        z.object({
          name: z.string(),
          path: z.string(),
          id: z.string(),
          type: z.enum(['file', 'folder']),
          size: z.number().optional(),
          modified: z.string().optional(),
          contentHash: z.string().optional(),
          isImage: z.boolean().optional(),
          signedUrl: z.string().optional(),
        })
      ),
      count: z.number(),
    },
  },
  handler: async (args: any, oauthManagerOverride?: any) => {
    try {
      const { userId, query, maxResults, fileCategories, fileExtensions } = args;

      logger.info('[Tool:dropbox_search] Executing', { userId, query, maxResults });

      // Use provided oauth manager (for Cloudflare Workers) or default
      const manager = oauthManagerOverride || oauthManager;

      // Get valid access token
      const accessToken = await manager.getValidAccessToken(userId);
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

      // Search files
      const dropboxClient = new DropboxClient(accessToken);
      const files = await dropboxClient.search({
        query,
        maxResults,
        fileCategories,
        fileExtensions,
      });

      // Process files and get signed URLs for images
      const processedFiles = await Promise.all(
        files.map(async (file) => {
          const isImage = file['.tag'] === 'file' && DropboxClient.isImageFile(file.name);
          let signedUrl: string | undefined;

          if (isImage) {
            try {
              signedUrl = await dropboxClient.getTemporaryLink(file.path_display);
              logger.info('[Tool:dropbox_search] Generated signed URL for image', { 
                path: file.path_display, 
                name: file.name 
              });
            } catch (error: any) {
              logger.warn('[Tool:dropbox_search] Failed to generate signed URL', { 
                path: file.path_display, 
                error: error.message 
              });
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
    } catch (error: any) {
      logger.error('[Tool:dropbox_search] Error:', error);
      return {
        content: [
          {
            type: 'text',
            text: `Error searching Dropbox: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  },
};

/**
 * Dropbox Fetch File Tool
 */
export const dropboxFetchTool = {
  name: 'dropbox_fetch',
  definition: {
    title: 'Fetch Dropbox File',
    description: 'Use this when you need the contents of a specific Dropbox file and already know its full `path`, usually from `dropbox_search` or `dropbox_list_recent_files`. For images it returns a temporary `signedUrl` instead of downloading the binary payload, and `rawDownload=true` returns base64-encoded binary content for non-text files.',
    inputSchema: {
      userId: z.string().describe('User ID for authentication'),
      path: z.string().describe('Full Dropbox file path, typically returned by `dropbox_search` or `dropbox_list_recent_files` (for example `/Documents/file.txt`).'),
      rawDownload: z.boolean().default(false).describe('Download as raw binary (base64 encoded) instead of text'),
    },
    outputSchema: {
      content: z.string(),
      metadata: z.object({
        name: z.string(),
        path: z.string(),
        id: z.string(),
        size: z.number(),
        modified: z.string(),
        contentHash: z.string().optional(),
        signedUrl: z.string().optional(),
        isImage: z.boolean().optional(),
      }),
    },
  },
  handler: async (args: any, oauthManagerOverride?: any) => {
    try {
      const { userId, path, rawDownload } = args;

      logger.info('[Tool:dropbox_fetch] Executing', { userId, path, rawDownload });

      // Use provided oauth manager (for Cloudflare Workers) or default
      const manager = oauthManagerOverride || oauthManager;

      // Get valid access token
      const accessToken = await manager.getValidAccessToken(userId);
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

      // Create Dropbox client
      const dropboxClient = new DropboxClient(accessToken);
      
      // First, get metadata to check if it's an image
      const metadata = await dropboxClient.getFileMetadata(path);
      const isImage = DropboxClient.isImageFile(metadata.name);
      
      // For images, skip downloading content and just get the signed URL
      if (isImage) {
        let signedUrl: string | undefined;
        try {
          signedUrl = await dropboxClient.getTemporaryLink(path);
          logger.info('[Tool:dropbox_fetch] Generated signed URL for image', { path, signedUrl });
        } catch (error: any) {
          logger.warn('[Tool:dropbox_fetch] Failed to generate signed URL', { path, error: error.message });
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
    } catch (error: any) {
      logger.error('[Tool:dropbox_fetch] Error:', error);
      return {
        content: [
          {
            type: 'text',
            text: `Error fetching file: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  },
};

/**
 * Dropbox Search Files Tool (alias for search)
 */
export const dropboxSearchFilesTool = {
  name: 'dropbox_search_files',
  definition: {
    title: 'Search Dropbox Files',
    description: 'Alias of `dropbox_search`. Use it to find files and folders and get the full `path` value needed for `dropbox_fetch` or `dropbox_fetch_file`.',
    inputSchema: {
      userId: z.string().describe('User ID for authentication'),
      query: z.string().describe('Search query text'),
      maxResults: z.number().min(1).max(1000).default(100).describe('Maximum number of results'),
    },
    outputSchema: {
      files: z.array(
        z.object({
          name: z.string(),
          path: z.string(),
          id: z.string(),
          type: z.enum(['file', 'folder']),
        })
      ),
      count: z.number(),
    },
  },
  handler: async (args: any, oauthManagerOverride?: any) => {
    // Delegate to dropboxSearchTool
    return dropboxSearchTool.handler(args, oauthManagerOverride);
  },
};

/**
 * Dropbox Fetch File Tool (alias with different name)
 */
export const dropboxFetchFileTool = {
  name: 'dropbox_fetch_file',
  definition: {
    title: 'Fetch Dropbox File',
    description: 'Alias of `dropbox_fetch`. Use it to read a known Dropbox file by full `path`, usually after `dropbox_search` or `dropbox_list_recent_files`.',
    inputSchema: {
      userId: z.string().describe('User ID for authentication'),
      path: z.string().describe('Full Dropbox file path returned by `dropbox_search` or `dropbox_list_recent_files`.'),
      rawDownload: z.boolean().default(false).describe('Download as raw binary'),
    },
    outputSchema: {
      content: z.string(),
      metadata: z.object({
        name: z.string(),
        path: z.string(),
        size: z.number(),
      }),
    },
  },
  handler: async (args: any, oauthManagerOverride?: any) => {
    // Delegate to dropboxFetchTool
    return dropboxFetchTool.handler(args, oauthManagerOverride);
  },
};

/**
 * Dropbox List Recent Files Tool
 */
export const dropboxListRecentTool = {
  name: 'dropbox_list_recent_files',
  definition: {
    title: 'List Recent Dropbox Files',
    description: 'Use this to browse the user\'s recently modified Dropbox files before choosing one to fetch. It returns each file\'s full `path`, and images may also include temporary `signedUrl` links.',
    inputSchema: {
      userId: z.string().describe('User ID for authentication'),
      limit: z.number().min(1).max(100).default(20).describe('Maximum number of files to return'),
    },
    outputSchema: {
      files: z.array(
        z.object({
          name: z.string(),
          path: z.string(),
          id: z.string(),
          size: z.number().optional(),
          modified: z.string(),
          isImage: z.boolean().optional(),
          signedUrl: z.string().optional(),
        })
      ),
      count: z.number(),
    },
  },
  handler: async (args: any, oauthManagerOverride?: any) => {
    try {
      const { userId, limit } = args;

      logger.info('[Tool:dropbox_list_recent_files] Executing', { userId, limit });

      // Use provided oauth manager (for Cloudflare Workers) or default
      const manager = oauthManagerOverride || oauthManager;

      // Get valid access token
      const accessToken = await manager.getValidAccessToken(userId);
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

      // List recent files
      const dropboxClient = new DropboxClient(accessToken);
      const files = await dropboxClient.listRecentFiles(limit);

      // Process files and get signed URLs for images
      const processedFiles = await Promise.all(
        files.map(async (file) => {
          const isImage = DropboxClient.isImageFile(file.name);
          let signedUrl: string | undefined;

          if (isImage) {
            try {
              signedUrl = await dropboxClient.getTemporaryLink(file.path_display);
              logger.info('[Tool:dropbox_list_recent_files] Generated signed URL for image', { 
                path: file.path_display, 
                name: file.name 
              });
            } catch (error: any) {
              logger.warn('[Tool:dropbox_list_recent_files] Failed to generate signed URL', { 
                path: file.path_display, 
                error: error.message 
              });
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
    } catch (error: any) {
      logger.error('[Tool:dropbox_list_recent_files] Error:', error);
      return {
        content: [
          {
            type: 'text',
            text: `Error listing recent files: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  },
};

/**
 * Dropbox Get Profile Tool
 */
export const dropboxGetProfileTool = {
  name: 'dropbox_get_profile',
  definition: {
    title: 'Get Dropbox Profile',
    description: 'Use this when you need the authenticated Dropbox account identity and basic account metadata. It does not search or list files.',
    inputSchema: {
      userId: z.string().describe('User ID for authentication'),
    },
    outputSchema: {
      profile: z.object({
        accountId: z.string(),
        name: z.object({
          displayName: z.string(),
          givenName: z.string(),
          surname: z.string(),
        }),
        email: z.string(),
        emailVerified: z.boolean(),
        accountType: z.string(),
      }),
    },
  },
  handler: async (args: any, oauthManagerOverride?: any) => {
    try {
      const { userId } = args;

      logger.info('[Tool:dropbox_get_profile] Executing', { userId });

      // Use provided oauth manager (for Cloudflare Workers) or default
      const manager = oauthManagerOverride || oauthManager;

      // Get valid access token
      const accessToken = await manager.getValidAccessToken(userId);
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

      // Get profile
      const dropboxClient = new DropboxClient(accessToken);
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
        structuredContent: output,
      };
    } catch (error: any) {
      logger.error('[Tool:dropbox_get_profile] Error:', error);
      return {
        content: [
          {
            type: 'text',
            text: `Error getting profile: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  },
};

/**
 * Export all tools
 */
export const dropboxTools = [
  dropboxSearchTool,
  dropboxFetchTool,
  dropboxSearchFilesTool,
  dropboxFetchFileTool,
  dropboxListRecentTool,
  dropboxGetProfileTool,
];






