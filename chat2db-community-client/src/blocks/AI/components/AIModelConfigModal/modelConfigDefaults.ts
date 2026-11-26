import type { AIProvider } from '@/service/aiModelConfig';

export const DEFAULT_MINIMAX_BASE_URL = 'https://api.minimax.io/v1';
export const DEFAULT_OPENAI_RESPONSES_BASE_URL = 'http://127.0.0.1:15721';

export const resolveProviderBaseUrl = (provider: AIProvider, baseUrl?: string): string => {
  if (provider === 'MINIMAX' && !baseUrl?.trim()) {
    return DEFAULT_MINIMAX_BASE_URL;
  }
  if (provider === 'OPENAI_RESPONSES' && !baseUrl?.trim()) {
    return DEFAULT_OPENAI_RESPONSES_BASE_URL;
  }
  return baseUrl || '';
};

export const resolveBaseUrlOnProviderChange = (provider: AIProvider, baseUrl?: string): string => {
  if (provider === 'MINIMAX' || provider === 'OPENAI_RESPONSES') {
    return resolveProviderBaseUrl(provider, baseUrl);
  }
  const trimmed = baseUrl?.trim();
  if (trimmed === DEFAULT_MINIMAX_BASE_URL || trimmed === DEFAULT_OPENAI_RESPONSES_BASE_URL) {
    return '';
  }
  return baseUrl || '';
};
