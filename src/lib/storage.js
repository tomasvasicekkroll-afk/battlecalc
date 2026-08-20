// Drop-in replacement for the old `window.storage` global that only existed
// inside the Claude.ai artifact sandbox. Same get/set(key, value) shape, backed
// by localStorage for now. When user accounts land (Supabase), this file is the
// only thing that needs to change — callers in App.jsx stay untouched.
const PREFIX = "battlecalc:";

export const storage = {
  async get(key) {
    try {
      const raw = localStorage.getItem(PREFIX + key);
      return raw === null ? null : { value: raw };
    } catch (e) {
      return null;
    }
  },
  async set(key, value) {
    localStorage.setItem(PREFIX + key, value);
  },
  async delete(key) {
    localStorage.removeItem(PREFIX + key);
  },
  async list() {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(PREFIX)) keys.push(k.slice(PREFIX.length));
    }
    return keys;
  },
};
