/**
 * Reversible bookmark URL transformations shared by the extension worker and
 * Node-based tests. Current bookmarks use a final query parameter; legacy
 * `newtab@` and the unreleased v3 query marker are recognized only by the
 * explicit migration helpers.
 */
(function initializeBookmarkUrlUtils(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.BookmarkUrl = api;
  }
})(globalThis, function createBookmarkUrlUtils() {
  "use strict";

  const MARKER_PARAMETER = "__obnt_v4";
  const V3_MARKER_PARAMETER = "__obnt_v3";
  const MARKER_SECRET_PATTERN = /^[a-f0-9]{32}$/;
  const MARKER_CAPABILITY_PATTERN = /^([a-f0-9]{32})_([mp])_([a-f0-9]{64})$/;
  const LEGACY_MARKER_USERNAME = "newtab";
  const LEGACY_REDIRECT_PAGE =
    "https://sssstf0rest.github.io/Open-Bookmarks-in-New-Tab/redirect.html";
  const legacyRedirectPage = new URL(LEGACY_REDIRECT_PAGE);

  /**
   * Parses a URL only to validate its scheme. Transformations operate on the
   * original string so case, escaping, delimiters, and fragments round-trip.
   *
   * @param {string} url
   * @returns {URL|null}
   */
  function parseHttpUrl(url) {
    if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return null;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  function isSupportedUrl(url) {
    return parseHttpUrl(url) !== null;
  }

  function markerPair(markerCapability) {
    if (
      typeof markerCapability !== "string" ||
      !MARKER_CAPABILITY_PATTERN.test(markerCapability)
    ) {
      throw new TypeError(
        "The marker capability must contain a 128-bit owner, provenance mode, and 256-bit nonce."
      );
    }
    return `${MARKER_PARAMETER}=${markerCapability}`;
  }

  function splitFragment(url) {
    const fragmentIndex = url.indexOf("#");
    if (fragmentIndex === -1) return {base: url, fragment: ""};
    return {
      base: url.slice(0, fragmentIndex),
      fragment: url.slice(fragmentIndex),
    };
  }

  /**
   * Tests only for this extension's exact final marker. A similarly named
   * parameter elsewhere in the query or fragment is ordinary page data.
   */
  function readMarker(url) {
    if (!isSupportedUrl(url)) return null;
    const {base} = splitFragment(url);
    const match = base.match(
      /[?&]__obnt_v4=([a-f0-9]{32})_([mp])_([a-f0-9]{64})$/
    );
    if (!match) return null;
    return {
      capability: `${match[1]}_${match[2]}_${match[3]}`,
      owner: match[1],
      mode: match[2],
      nonce: match[3],
      originalUrl: base.slice(0, -match[0].length) + splitFragment(url).fragment,
    };
  }

  function readDraftV4Marker(url) {
    if (!isSupportedUrl(url)) return null;
    const {base, fragment} = splitFragment(url);
    const match = base.match(/[?&]__obnt_v4=([a-f0-9]{64})$/);
    if (!match) return null;
    return {
      nonce: match[1],
      originalUrl: base.slice(0, -match[0].length) + fragment,
    };
  }

  function isMarkedUrl(url, markerCapability) {
    const marker = readMarker(url);
    if (!marker) return false;
    return markerCapability === undefined || marker.capability === markerPair(
      markerCapability
    ).slice(MARKER_PARAMETER.length + 1);
  }

  /**
   * Appends a marker immediately before the fragment without serializing the
   * URL. This preserves credentials, IPv6 spelling, escapes, and empty query
   * delimiters byte-for-byte.
   */
  function markUrl(originalUrl, markerCapability) {
    const pair = markerPair(markerCapability);
    if (!isSupportedUrl(originalUrl) || isMarkedUrl(
      originalUrl,
      markerCapability
    )) {
      return originalUrl;
    }

    const {base, fragment} = splitFragment(originalUrl);
    const separator = base.includes("?") ? "&" : "?";
    return `${base}${separator}${pair}${fragment}`;
  }

  /**
   * Returns the exact pre-marker string, or null when the marker is absent.
   */
  function getOriginalUrl(markedUrl, markerCapability) {
    const marker = readMarker(markedUrl);
    if (!marker) return null;
    if (
      markerCapability !== undefined &&
      marker.capability !== markerCapability
    ) return null;
    return marker.originalUrl;
  }

  function restoreUrl(url, markerCapability) {
    return getOriginalUrl(url, markerCapability) || url;
  }

  function v3Pair(markerToken) {
    if (
      typeof markerToken !== "string" ||
      !/^[a-z0-9_-]+$/i.test(markerToken)
    ) {
      throw new TypeError("The v3 marker token contains unsupported characters.");
    }
    return `${V3_MARKER_PARAMETER}=${markerToken}`;
  }

  function getV3OriginalUrl(url, markerToken) {
    if (!isSupportedUrl(url)) return null;
    const pair = v3Pair(markerToken);
    const {base, fragment} = splitFragment(url);
    if (!base.endsWith(`?${pair}`) && !base.endsWith(`&${pair}`)) return null;
    return `${base.slice(0, -(pair.length + 1))}${fragment}`;
  }

  function isLegacyRedirectPage(parsed) {
    return (
      parsed.origin === legacyRedirectPage.origin &&
      parsed.pathname === legacyRedirectPage.pathname
    );
  }

  /**
   * Reads a supported target from the exact GitHub Pages wrapper used by
   * versions through 2.3.0. Other lookalike hosts and paths are rejected.
   */
  function readLegacyRedirectTarget(url) {
    const parsed = parseHttpUrl(url);
    if (!parsed || !isLegacyRedirectPage(parsed)) return null;
    const target = parsed.searchParams.get("url");
    return target && isSupportedUrl(target) ? target : null;
  }

  /**
   * Removes every leading released marker representation from the authority.
   * Chrome serializes an `@` embedded in userinfo as `%40`, so multiple
   * extension passes can produce `newtab%40newtab%40...`.
   */
  function stripLegacyAuthorityPrefixes(url) {
    const scheme = url.match(/^(https?:\/\/)/i);
    if (!scheme) return null;

    let remainder = url.slice(scheme[0].length);
    let prefixCount = 0;
    while (/^newtab(?:@|%40)/i.test(remainder)) {
      remainder = remainder.replace(/^newtab(?:@|%40)/i, "");
      prefixCount += 1;
    }
    if (prefixCount === 0) return null;
    return {prefixCount, recoveredUrl: scheme[0] + remainder};
  }

  function hasUserinfo(url) {
    const schemeEnd = url.indexOf("://");
    if (schemeEnd === -1) return false;
    const authority = url.slice(schemeEnd + 3).split(/[/?#]/, 1)[0];
    return authority.includes("@");
  }

  /**
   * Recovers URLs written by versions through 2.3.0.
   *
   * A single passwordless username exactly equal to `newtab` is
   * indistinguishable from a legitimate Basic Auth username. Set
   * `allowAmbiguousSingle` to false unless release state or a migration backup
   * proves the bookmark was managed by the extension.
   *
   * @param {string} url
   * @param {{allowAmbiguousSingle?: boolean}} options
   * @returns {string|null}
   */
  function getLegacyOriginalUrl(url, options = {}) {
    const allowAmbiguousSingle = options.allowAmbiguousSingle !== false;
    const stripped = stripLegacyAuthorityPrefixes(url);
    if (!stripped || !isSupportedUrl(stripped.recoveredUrl)) return null;

    const target = readLegacyRedirectTarget(stripped.recoveredUrl);
    if (target) return target;

    const isAmbiguousSingle = (
      stripped.prefixCount === 1 &&
      !hasUserinfo(stripped.recoveredUrl)
    );
    if (isAmbiguousSingle && !allowAmbiguousSingle) return null;
    return stripped.recoveredUrl;
  }

  function migrateLegacyUrl(url, markerToken, options = {}) {
    const original = getLegacyOriginalUrl(url, options);
    return original ? markUrl(original, markerToken) : markUrl(url, markerToken);
  }

  /**
   * Recursively removes only marker layers owned by this extension. This
   * handles mixed-version sync forms such as legacy(v4(url)) and
   * legacy(url)+v3+v4 without serializing the recovered URL.
   */
  function unwrapManagedUrl(url, options = {}) {
    const allowLegacy = options.allowLegacy === true;
    const acceptedMarkerSecrets = new Set(options.acceptedMarkerSecrets || []);
    const v3MarkerToken = options.v3MarkerToken;
    let current = url;
    let changed = false;

    for (let depth = 0; depth < 16; depth += 1) {
      const marker = readMarker(current);
      if (marker && acceptedMarkerSecrets.has(marker.owner)) {
        current = marker.originalUrl;
        changed = true;

        // `p` records that every byte inside this capability belongs to the
        // user. In particular, a single `newtab@` may be a legitimate Basic
        // Auth username rather than a released extension prefix.
        if (marker.mode === "p") break;

        // `m` authenticates migration provenance. It is therefore safe to
        // recover a released legacy layer immediately inside the capability,
        // including the otherwise ambiguous single `newtab@` form, without a
        // broad legacy-compatibility switch.
        for (let legacyDepth = 0; legacyDepth < 16; legacyDepth += 1) {
          const migratedLegacyOriginal = getLegacyOriginalUrl(current, {
            allowAmbiguousSingle: true,
          });
          if (!migratedLegacyOriginal || migratedLegacyOriginal === current) {
            break;
          }
          current = migratedLegacyOriginal;
        }
        continue;
      }

      // A still-running 2.3 device can put its released wrapper outside an
      // already authenticated marker. Only peel that unauthenticated outer
      // layer when doing so exposes one of this installation's accepted
      // capabilities. This also covers the exact GitHub redirect wrapper,
      // whose target contains the encoded v4 URL.
      const outerLegacyOriginal = getLegacyOriginalUrl(current, {
        allowAmbiguousSingle: true,
      });
      const exposedMarker = outerLegacyOriginal
        ? readMarker(outerLegacyOriginal)
        : null;
      if (exposedMarker && acceptedMarkerSecrets.has(exposedMarker.owner)) {
        current = outerLegacyOriginal;
        changed = true;
        continue;
      }

      if (options.allowDraftV4) {
        const draftMarker = readDraftV4Marker(current);
        if (draftMarker) {
          current = draftMarker.originalUrl;
          changed = true;
          continue;
        }
      }

      if (v3MarkerToken) {
        const v3Original = getV3OriginalUrl(current, v3MarkerToken);
        if (v3Original) {
          current = v3Original;
          changed = true;
          continue;
        }
      }

      if (allowLegacy) {
        const legacyOriginal = getLegacyOriginalUrl(current, {
          allowAmbiguousSingle: options.allowAmbiguousSingle,
        });
        if (legacyOriginal) {
          current = legacyOriginal;
          changed = true;
          continue;
        }
      }
      break;
    }

    return changed ? current : null;
  }

  /**
   * Returns an RE2-compatible DNR filter. Chrome's 2 KB compiled-regex limit
   * rejects a `{64}` repetition, so DNR checks a final lowercase-hex nonce and
   * the worker enforces the exact capability shape before acting.
   * Requiring `?` before the final pair prevents a marker-shaped path segment
   * from matching accidentally.
   */
  function markerRegexFilter(markerSecret) {
    if (
      typeof markerSecret !== "string" ||
      !MARKER_SECRET_PATTERN.test(markerSecret)
    ) {
      throw new TypeError("The marker owner secret must be 128-bit lowercase hex.");
    }
    return `\\?([^#]*&)?__obnt_v4=${markerSecret}_[mp]_[a-f0-9]+(#.*)?$`;
  }

  function draftV4RegexFilter() {
    return "\\?([^#]*&)?__obnt_v4=[a-f0-9]+(#.*)?$";
  }

  return Object.freeze({
    LEGACY_MARKER_USERNAME,
    LEGACY_REDIRECT_PAGE,
    MARKER_PARAMETER,
    V3_MARKER_PARAMETER,
    draftV4RegexFilter,
    getLegacyOriginalUrl,
    getOriginalUrl,
    getV3OriginalUrl,
    isMarkedUrl,
    isSupportedUrl,
    markUrl,
    markerRegexFilter,
    migrateLegacyUrl,
    readDraftV4Marker,
    readMarker,
    readLegacyRedirectTarget,
    restoreUrl,
    unwrapManagedUrl,
  });
});
