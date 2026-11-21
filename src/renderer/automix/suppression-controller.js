// src/renderer/automix/suppression-controller.js
// JavaScript / suppression-controller.js / Web & Node.js / Eclipse PC & Mobile
// Unified volume sync suppression ownership manager for AutoMixDJ and PlaybackHandover

class VolumeSyncSuppressionManager {
  constructor() {
    this._generation = 0;
    this._currentToken = null;
    this._currentOwner = null;
  }

  /**
   * Acquire suppression ownership. Generates a unique sequential token.
   * Sets window._autoMixSuppressVolumeSync = true and updates owner metadata.
   * @param {string} [owner='unknown']
   * @returns {number} unique token
   */
  acquire(owner = 'unknown') {
    const token = ++this._generation;
    this._currentToken = token;
    this._currentOwner = owner;
    if (typeof window !== 'undefined') {
      window._autoMixSuppressVolumeSync = true;
      window._autoMixSuppressOwnerToken = token;
      window._autoMixSuppressOwner = owner;
    }
    return token;
  }

  /**
   * Release suppression ownership only if the token matches the current owner.
   * If token matches, sets window._autoMixSuppressVolumeSync = false and clears metadata.
   * @param {number} token
   * @returns {boolean} true if released, false if stale or unmatched
   */
  release(token) {
    if (token && this._currentToken === token) {
      this._currentToken = null;
      this._currentOwner = null;
      if (typeof window !== 'undefined') {
        window._autoMixSuppressVolumeSync = false;
        window._autoMixSuppressOwnerToken = null;
        window._autoMixSuppressOwner = null;
      }
      return true;
    }
    return false;
  }

  /**
   * Check if a given token currently holds suppression ownership
   * @param {number} token
   * @returns {boolean}
   */
  isOwner(token) {
    return token !== null && typeof token !== 'undefined' && this._currentToken === token;
  }

  /**
   * Get current active token (or null if none)
   * @returns {number|null}
   */
  getCurrentToken() {
    return this._currentToken;
  }

  /**
   * Reset manager state completely (useful in test harnesses)
   */
  reset() {
    this._currentToken = null;
    this._currentOwner = null;
    if (typeof window !== 'undefined') {
      window._autoMixSuppressVolumeSync = false;
      window._autoMixSuppressOwnerToken = null;
      window._autoMixSuppressOwner = null;
    }
  }
}

// Global singleton instance shared across renderer components
let sharedSuppression = null;
if (typeof window !== 'undefined') {
  if (!window.volumeSyncSuppression) {
    window.volumeSyncSuppression = new VolumeSyncSuppressionManager();
  }
  window.VolumeSyncSuppressionManager = VolumeSyncSuppressionManager;
  sharedSuppression = window.volumeSyncSuppression;
} else {
  sharedSuppression = new VolumeSyncSuppressionManager();
}

function getVolumeSyncSuppression() {
  if (typeof window !== 'undefined' && window.volumeSyncSuppression) {
    return window.volumeSyncSuppression;
  }
  return sharedSuppression;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    VolumeSyncSuppressionManager,
    volumeSyncSuppression: sharedSuppression,
    getVolumeSyncSuppression
  };
}
