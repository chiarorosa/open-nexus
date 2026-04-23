// config.ts — Nexus configuration management
// API key is stored in localStorage (desktop app — no server-side storage).

const KEYS = {
  API_KEY:  "nexus_api_key",
  MODEL:    "nexus_model",
  BASE_URL: "nexus_base_url",
} as const;

const DEFAULTS = {
  MODEL:    "google/gemma-3-27b-it:free",
  BASE_URL: "https://openrouter.ai/api/v1",
} as const;

export const config = {
  getApiKey:  ()          => localStorage.getItem(KEYS.API_KEY) ?? "",
  setApiKey:  (k: string) => localStorage.setItem(KEYS.API_KEY, k),

  getModel:   ()          => localStorage.getItem(KEYS.MODEL) ?? DEFAULTS.MODEL,
  setModel:   (m: string) => localStorage.setItem(KEYS.MODEL, m),

  getBaseUrl: ()          => localStorage.getItem(KEYS.BASE_URL) ?? DEFAULTS.BASE_URL,
  setBaseUrl: (u: string) => localStorage.setItem(KEYS.BASE_URL, u),

  isConfigured: () => !!localStorage.getItem(KEYS.API_KEY)?.trim(),

  clear: () => Object.values(KEYS).forEach((k) => localStorage.removeItem(k)),
};
