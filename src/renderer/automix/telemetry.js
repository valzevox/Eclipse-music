// src/renderer/automix/telemetry.js
// JavaScript / telemetry.js / Web / Eclipse PC & Mobile
// Structured logging & telemetry metrics for Smart AutoMix DJ pipeline

class AutoMixTelemetry {
  constructor(tag = 'AutoMixTelemetry') {
    this.tag = tag;
  }

  log(event, payload = {}) {
    const timestamp = new Date().toISOString();
    console.log(`[${this.tag}][${timestamp}] [${event}]`, payload);
  }

  warn(event, payload = {}) {
    const timestamp = new Date().toISOString();
    console.warn(`[${this.tag}][${timestamp}] [WARN][${event}]`, payload);
  }

  error(event, error, payload = {}) {
    const timestamp = new Date().toISOString();
    console.error(`[${this.tag}][${timestamp}] [ERROR][${event}]`, {
      message: error?.message || String(error),
      stack: error?.stack || null,
      ...payload
    });
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { AutoMixTelemetry };
}
if (typeof window !== 'undefined') {
  window.AutoMixTelemetry = AutoMixTelemetry;
}
