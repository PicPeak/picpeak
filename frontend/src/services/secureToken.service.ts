import { api } from '../config/api';
import { buildResourceUrl } from '../utils/url';

interface SecureToken {
  token: string;
  expiresIn: number;
  maxUses: number;
  protectionLevel: string;
  generatedAt: number;
}

interface TokenCacheEntry {
  token: SecureToken;
  photoId: number;
  accessType: string;
  slug: string;
}

class SecureTokenService {
  private tokenCache = new Map<string, TokenCacheEntry>();
  private readonly CACHE_BUFFER_MS = 30000; // 30 seconds buffer before expiry

  /**
   * Get cache key for token
   */
  private getCacheKey(slug: string, photoId: number, accessType: string): string {
    return `${slug}-${photoId}-${accessType}`;
  }

  /**
   * Check if cached token is still valid
   */
  private isTokenValid(cacheEntry: TokenCacheEntry): boolean {
    const now = Date.now();
    const expiresAt = cacheEntry.token.generatedAt + (cacheEntry.token.expiresIn * 1000);
    return expiresAt > (now + this.CACHE_BUFFER_MS);
  }

  /**
   * Generate secure token for photo access
   */
  async generateToken(slug: string, photoId: number, accessType: 'view' | 'download' = 'view'): Promise<string> {
    const cacheKey = this.getCacheKey(slug, photoId, accessType);
    
    // Check cache first
    const cached = this.tokenCache.get(cacheKey);
    if (cached && this.isTokenValid(cached)) {
      return cached.token.token;
    }

    try {
      // Generate new token from backend – authentication handled via cookies
      const response = await api.post<SecureToken>(
        `/secure-images/${slug}/generate-token`,
        { photoId, accessType }
      );

      const tokenData: SecureToken = {
        ...response.data,
        generatedAt: Date.now()
      };

      // Cache the token
      this.tokenCache.set(cacheKey, {
        token: tokenData,
        photoId,
        accessType,
        slug
      });

      return tokenData.token;
    } catch (error) {
      console.error('Failed to generate secure token:', error);
      throw new Error('Unable to generate secure access token');
    }
  }

  /**
   * Replace {{token}} placeholder in URL with actual token
   */
  async processSecureUrl(url: string, slug: string, photoId: number, accessType: 'view' | 'download' = 'view'): Promise<string> {
    if (!url.includes('{{token}}')) {
      return url;
    }

    try {
      const token = await this.generateToken(slug, photoId, accessType);
      return url.replace('{{token}}', token);
    } catch (error) {
      console.error('Failed to process secure URL:', error);
      // Return URL without token replacement as fallback
      return url.replace('{{token}}', 'invalid');
    }
  }

  /**
   * Process multiple URLs with token replacement
   */
  async processSecureUrls(
    urls: Array<{ url: string; photoId: number; accessType?: 'view' | 'download' }>, 
    slug: string
  ): Promise<Array<{ url: string; photoId: number }>> {
    const processPromises = urls.map(async ({ url, photoId, accessType = 'view' }) => ({
      url: await this.processSecureUrl(url, slug, photoId, accessType),
      photoId
    }));

    return Promise.all(processPromises);
  }

  /**
   * Check if URL requires token processing
   */
  requiresToken(url: string): boolean {
    return url.includes('{{token}}');
  }

  /**
   * Clear expired tokens from cache
   */
  clearExpiredTokens(): void {
    for (const [key, entry] of this.tokenCache.entries()) {
      if (!this.isTokenValid(entry)) {
        this.tokenCache.delete(key);
      }
    }
  }

  /**
   * Clear all cached tokens
   */
  clearAllTokens(): void {
    this.tokenCache.clear();
  }

  /**
   * Clear tokens for specific gallery
   */
  clearGalleryTokens(slug: string): void {
    for (const [key, entry] of this.tokenCache.entries()) {
      if (entry.slug === slug) {
        this.tokenCache.delete(key);
      }
    }
  }

  /**
   * Get full secure image URL with token
   */
  async getSecureImageUrl(slug: string, photoId: number): Promise<string> {
    const template = `/api/secure-images/${slug}/secure/${photoId}/{{token}}`;
    return this.processSecureUrl(template, slug, photoId, 'view');
  }

  /**
   * Get secure download URL with token
   */
  async getSecureDownloadUrl(slug: string, photoId: number): Promise<string> {
    const template = `/api/secure-images/${slug}/secure-download/${photoId}/{{token}}`;
    return this.processSecureUrl(template, slug, photoId, 'download');
  }

  /**
   * Build full resource URL for secure image
   */
  async buildSecureResourceUrl(slug: string, photoId: number): Promise<string> {
    const secureUrl = await this.getSecureImageUrl(slug, photoId);
    return buildResourceUrl(secureUrl);
  }
}

// Export singleton instance
export const secureTokenService = new SecureTokenService();

// Auto-cleanup expired tokens every 5 minutes
if (typeof window !== 'undefined') {
  setInterval(() => {
    secureTokenService.clearExpiredTokens();
  }, 5 * 60 * 1000);
}
