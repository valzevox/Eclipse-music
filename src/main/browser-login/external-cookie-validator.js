'use strict';

const { BrowserLoginFailure, BrowserLoginException } = require('./browser-login-errors');

const EXTERNAL_COOKIE_NAME = 'sp_dc';
const EXTERNAL_TARGET_HOST = 'open.spotify.com';
const EXTERNAL_DOMAIN_REGEX = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*spotify\.com$/i;

function isValidExternalCookieDomain(domain) {
  if (!domain || typeof domain !== 'string') return false;
  const clean = domain.trim().toLowerCase().replace(/^\./, '');
  if (!clean || clean.includes('..')) return false;
  return EXTERNAL_DOMAIN_REGEX.test(clean);
}

function matchesExternalHost(domain, hostOnly = false) {
  if (!isValidExternalCookieDomain(domain)) return false;
  const clean = domain.trim().toLowerCase().replace(/^\./, '');
  if (hostOnly) {
    return clean === EXTERNAL_TARGET_HOST;
  }
  return clean === EXTERNAL_TARGET_HOST || clean === 'spotify.com';
}

function matchesExternalPath(cookiePath, requestPath = '/') {
  if (cookiePath === undefined || cookiePath === null) return true;
  if (typeof cookiePath !== 'string' || !cookiePath.startsWith('/')) return false;
  const req = (requestPath || '/').trim();
  if (cookiePath === '/' || req === cookiePath) return true;
  if (req.startsWith(cookiePath)) {
    return cookiePath.endsWith('/') || req[cookiePath.length] === '/';
  }
  return false;
}

function normalizeExpiry(rawExpiry) {
  if (rawExpiry === undefined || rawExpiry === null) return null;
  const num = Number(rawExpiry);
  if (!Number.isFinite(num) || num <= 0) return NaN;
  return Math.floor(num);
}

function validateExternalSessionCookies(cookies, options = {}) {
  if (!Array.isArray(cookies) || cookies.length === 0) {
    throw new BrowserLoginException(
      BrowserLoginFailure.COOKIE_FORMAT_INVALID,
      'No external session cookies provided'
    );
  }

  const nowSeconds = Number.isFinite(options.nowSeconds)
    ? options.nowSeconds
    : Math.floor(Date.now() / 1000);
  const requestPath = typeof options.requestPath === 'string' && options.requestPath.startsWith('/')
    ? options.requestPath
    : '/';

  const matchingName = cookies.filter(c => c && typeof c === 'object' && c.name === EXTERNAL_COOKIE_NAME);
  if (matchingName.length === 0) {
    throw new BrowserLoginException(
      BrowserLoginFailure.COOKIE_FORMAT_INVALID,
      'Missing required external session cookie'
    );
  }

  const distinctValues = new Set();
  for (const c of matchingName) {
    if (typeof c.value !== 'string' || c.value.trim().length === 0) {
      throw new BrowserLoginException(
        BrowserLoginFailure.COOKIE_FORMAT_INVALID,
        'External session cookie value must be a non-empty string'
      );
    }
    distinctValues.add(c.value);
  }

  if (distinctValues.size > 1) {
    throw new BrowserLoginException(
      BrowserLoginFailure.COOKIE_FORMAT_INVALID,
      'Conflicting external session cookies detected'
    );
  }

  const validRecords = [];
  for (const c of matchingName) {
    if (c.secure !== true) continue;
    const hostOnly = !!c.hostOnly;
    if (!matchesExternalHost(c.domain, hostOnly)) continue;
    if (!matchesExternalPath(c.path, requestPath)) continue;

    const rawExp = c.expirationDate !== undefined ? c.expirationDate : c.expiry;
    const expiry = normalizeExpiry(rawExp);
    if (Number.isNaN(expiry)) continue;
    if (expiry !== null && expiry < nowSeconds) continue;

    const cleanDom = c.domain.trim().toLowerCase();
    const normalizedDomain = hostOnly
      ? cleanDom.replace(/^\./, '')
      : (cleanDom.startsWith('.') ? cleanDom : `.${cleanDom}`);

    validRecords.push({
      name: EXTERNAL_COOKIE_NAME,
      value: c.value,
      domain: normalizedDomain,
      path: typeof c.path === 'string' && c.path.startsWith('/') ? c.path : '/',
      secure: true,
      httpOnly: !!c.httpOnly,
      expiry,
      hostOnly
    });
  }

  if (validRecords.length === 0) {
    throw new BrowserLoginException(
      BrowserLoginFailure.COOKIE_FORMAT_INVALID,
      'External session cookie failed security, domain, path, or expiry validation'
    );
  }

  validRecords.sort((a, b) => {
    const aExact = a.domain.replace(/^\./, '') === EXTERNAL_TARGET_HOST ? 1 : 0;
    const bExact = b.domain.replace(/^\./, '') === EXTERNAL_TARGET_HOST ? 1 : 0;
    if (aExact !== bExact) return bExact - aExact;
    return b.path.length - a.path.length;
  });

  return validRecords[0];
}

module.exports = {
  EXTERNAL_COOKIE_NAME,
  EXTERNAL_TARGET_HOST,
  isValidExternalCookieDomain,
  matchesExternalHost,
  matchesExternalPath,
  validateExternalSessionCookies
};
