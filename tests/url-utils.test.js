const assert = require("node:assert/strict");
const BookmarkUrl = require("../js/url-utils.js");

const OWNER = "0123456789abcdef".repeat(2);
const NONCE = "abcdef0123456789".repeat(4);
const PRESERVE_TOKEN = `${OWNER}_p_${NONCE}`;
const MIGRATE_TOKEN = `${OWNER}_m_${NONCE}`;
const TOKEN = PRESERVE_TOKEN;
const OTHER_OWNER = "fedcba9876543210".repeat(2);
const OTHER_TOKEN = `${OTHER_OWNER}_p_${NONCE}`;
const V3_TOKEN = "abcdefghijklmnopabcdefghijklmnop";
const cases = [];

function test(name, fn) {
  cases.push({name, fn});
}

function roundTrip(original) {
  const marked = BookmarkUrl.markUrl(original, TOKEN);
  assert.notEqual(marked, original);
  assert.equal(BookmarkUrl.getOriginalUrl(marked, TOKEN), original);
  assert.equal(BookmarkUrl.restoreUrl(marked, TOKEN), original);
}

test("round-trips paths, queries, fragments, and letter case exactly", () => {
  roundTrip("HTTPS://Example.COM:443/a%2Fb?q=one%20two#Part?still-fragment");
});

test("round-trips LAN IPv4, localhost, IPv6, and ports", () => {
  roundTrip("http://192.168.1.10:8080/admin#status");
  roundTrip("http://router.local:9090/?screen=network");
  roundTrip("http://[fd00::12]:3000/dashboard?view=all");
});

test("preserves credentials without parsing or rewriting userinfo", () => {
  roundTrip("https://alice:secret@example.com/private?token=a#b");
  roundTrip("https://newtab@example.com/legitimate-username");
  roundTrip("https://name%40realm:p%2Fss@example.com/private");
});

test("preserves unusual and empty query delimiters", () => {
  roundTrip("https://example.com/path?");
  roundTrip("https://example.com/path?one=1&");
  roundTrip("https://example.com/path?&&odd??=value&&#fragment");
});

test("preserves signed-looking URLs byte-for-byte", () => {
  roundTrip(
    "https://cdn.example.com/file?X-Amz-Signature=A%2FB%2BC&X-Amz-Expires=60#download"
  );
});

test("places its marker last and immediately before a fragment", () => {
  assert.equal(
    BookmarkUrl.markUrl("https://example.com/p?a=1#section", TOKEN),
    `https://example.com/p?a=1&__obnt_v4=${TOKEN}#section`
  );
  assert.equal(
    BookmarkUrl.markUrl("https://example.com/p#section", TOKEN),
    `https://example.com/p?__obnt_v4=${TOKEN}#section`
  );
});

test("is idempotent and recognizes only the configured final token", () => {
  const original = "https://example.com/?__obnt_v4=page-data";
  const marked = BookmarkUrl.markUrl(original, TOKEN);
  assert.equal(BookmarkUrl.markUrl(marked, TOKEN), marked);
  assert.equal(BookmarkUrl.isMarkedUrl(marked, TOKEN), true);
  assert.equal(BookmarkUrl.isMarkedUrl(marked, OTHER_TOKEN), false);
  assert.equal(
    BookmarkUrl.isMarkedUrl(
      `https://example.com/?__obnt_v4=${TOKEN}&after=page-data`,
      TOKEN
    ),
    false
  );
  assert.equal(
    BookmarkUrl.isMarkedUrl(
      `https://example.com/#fragment?__obnt_v4=${TOKEN}`,
      TOKEN
    ),
    false
  );
});

test("migrates a simple released newtab authority marker", () => {
  const migrated = BookmarkUrl.migrateLegacyUrl(
    "https://newtab@example.com/path",
    MIGRATE_TOKEN
  );
  assert.equal(
    BookmarkUrl.restoreUrl(migrated, MIGRATE_TOKEN),
    "https://example.com/path"
  );
});

test("can preserve an ambiguous passwordless newtab username", () => {
  const credential = "https://newtab@example.com/path";
  assert.equal(
    BookmarkUrl.getLegacyOriginalUrl(credential, {allowAmbiguousSingle: false}),
    null
  );
  assert.equal(
    BookmarkUrl.migrateLegacyUrl(
      credential,
      TOKEN,
      {allowAmbiguousSingle: false}
    ),
    BookmarkUrl.markUrl(credential, TOKEN)
  );
});

test("migrates the exact released GitHub redirect wrapper", () => {
  const target = "https://mail.google.com/mail/u/0/#inbox/private?token=secret";
  const legacy =
    `https://newtab@sssstf0rest.github.io/` +
    `Open-Bookmarks-in-New-Tab/redirect.html?url=${encodeURIComponent(target)}`;
  const migrated = BookmarkUrl.migrateLegacyUrl(legacy, MIGRATE_TOKEN);
  assert.equal(BookmarkUrl.restoreUrl(migrated, MIGRATE_TOKEN), target);
  assert.doesNotMatch(migrated, /github\.io/);
});

test("rejects lookalike legacy redirect wrappers and unsafe targets", () => {
  const encoded = encodeURIComponent("https://mail.google.com/");
  assert.equal(
    BookmarkUrl.readLegacyRedirectTarget(
      `https://sssstf0rest.github.io.evil.test/` +
      `Open-Bookmarks-in-New-Tab/redirect.html?url=${encoded}`
    ),
    null
  );
  assert.equal(
    BookmarkUrl.readLegacyRedirectTarget(
      "https://sssstf0rest.github.io/Open-Bookmarks-in-New-Tab/" +
      "redirect.html?url=javascript%3Aalert(1)"
    ),
    null
  );
});

test("repairs repeated encoded prefixes while preserving Basic Auth", () => {
  const legacy =
    "https://newtab%40newtab%40alice:secret@example.com/private?x=1#part";
  const recovered = BookmarkUrl.getLegacyOriginalUrl(legacy);
  assert.equal(
    recovered,
    "https://alice:secret@example.com/private?x=1#part"
  );
  const migrated = BookmarkUrl.migrateLegacyUrl(legacy, MIGRATE_TOKEN);
  assert.equal(BookmarkUrl.restoreUrl(migrated, MIGRATE_TOKEN), recovered);
});

test("repairs mixed literal and encoded repeated markers", () => {
  assert.equal(
    BookmarkUrl.getLegacyOriginalUrl(
      "HTTP://newtab@newtab%40[fd00::1]:8080/path?x=%2F#Frag"
    ),
    "HTTP://[fd00::1]:8080/path?x=%2F#Frag"
  );
});

test("recovers legacy URLs without canonicalizing remaining bytes", () => {
  assert.equal(
    BookmarkUrl.getLegacyOriginalUrl(
      "HTTPS://newtab@Example.COM:443/a%2Fb?sig=A%2FB%2BC#Part"
    ),
    "HTTPS://Example.COM:443/a%2Fb?sig=A%2FB%2BC#Part"
  );
  assert.equal(
    BookmarkUrl.getLegacyOriginalUrl(
      "https://newtab@alice:secret@example.com/a%2Fb",
      {allowAmbiguousSingle: false}
    ),
    "https://alice:secret@example.com/a%2Fb"
  );
});

test("leaves unsupported and malformed URLs unchanged", () => {
  const unsupported = [
    "chrome://newtab",
    "file:///tmp/a",
    "javascript:alert(1)",
    "not a url",
    "https://[invalid-ipv6]/",
  ];
  for (const url of unsupported) {
    assert.equal(BookmarkUrl.isSupportedUrl(url), false);
    assert.equal(BookmarkUrl.markUrl(url, TOKEN), url);
    assert.equal(BookmarkUrl.restoreUrl(url, TOKEN), url);
  }
});

test("rejects malformed owner, provenance, and nonce capabilities", () => {
  for (const token of [
    "",
    "a".repeat(32) + "_p_" + "b".repeat(63),
    "A".repeat(32) + "_p_" + "b".repeat(64),
    "g".repeat(32) + "_p_" + "b".repeat(64),
    "a".repeat(32) + "_x_" + "b".repeat(64),
    "a".repeat(32) + "_P_" + "b".repeat(64),
    "a".repeat(32) + "_" + "b".repeat(64),
  ]) {
    assert.throws(
      () => BookmarkUrl.markUrl("https://example.com/", token),
      TypeError
    );
  }
});

test("builds a fixed-shape final-query DNR regex without matching paths", () => {
  const source = BookmarkUrl.markerRegexFilter(OWNER);
  assert.equal(
    source,
    `\\?([^#]*&)?__obnt_v4=${OWNER}_[mp]_[a-f0-9]+(#.*)?$`
  );
  const regex = new RegExp(source);
  assert.match(
    `https://example.com/?a=1&__obnt_v4=${TOKEN}`,
    regex
  );
  assert.match(
    `https://example.com/?__obnt_v4=${TOKEN}#part`,
    regex
  );
  assert.doesNotMatch(
    `https://example.com/path&__obnt_v4=${TOKEN}`,
    regex
  );
  assert.doesNotMatch(
    `https://example.com/?__obnt_v4=${TOKEN}&after=1`,
    regex
  );
  assert.doesNotMatch(
    `https://example.com/?__obnt_v4=${OWNER}_x_${NONCE}`,
    regex
  );
  const shortCapability = `https://example.com/?__obnt_v4=${OWNER}_m_a`;
  assert.match(shortCapability, regex, "DNR uses a low-memory nonce filter");
  assert.equal(
    BookmarkUrl.readMarker(shortCapability),
    null,
    "the worker still enforces the exact capability length"
  );
});

test("recovers public v3 and recursively mixed migration layers", () => {
  const original = "https://mail.google.com/mail/u/0/#inbox";
  const v3 = `${original.replace("#", `?__obnt_v3=${V3_TOKEN}#`)}`;
  assert.equal(BookmarkUrl.getV3OriginalUrl(v3, V3_TOKEN), original);

  const legacyV3 = v3.replace(/^https:\/\//, "https://newtab@");
  const mixed = BookmarkUrl.markUrl(legacyV3, MIGRATE_TOKEN);
  assert.equal(
    BookmarkUrl.unwrapManagedUrl(mixed, {
      acceptedMarkerSecrets: [OWNER],
      allowLegacy: true,
      v3MarkerToken: V3_TOKEN,
    }),
    original
  );
});

test("migration provenance recovers a direct legacy layer without broad compatibility", () => {
  const legacy =
    "HTTPS://newtab%40newtab%40Alice:Secret@Example.COM:443/a%2Fb?sig=A%2FB#Part";
  const marked = BookmarkUrl.markUrl(legacy, MIGRATE_TOKEN);
  assert.equal(BookmarkUrl.readMarker(marked).mode, "m");
  assert.equal(
    BookmarkUrl.getOriginalUrl(marked, MIGRATE_TOKEN),
    legacy,
    "plain marker removal must remain byte-exact even for migration mode"
  );
  assert.equal(
    BookmarkUrl.unwrapManagedUrl(marked, {
      acceptedMarkerSecrets: [OWNER],
      allowLegacy: false,
      allowAmbiguousSingle: false,
    }),
    "HTTPS://Alice:Secret@Example.COM:443/a%2Fb?sig=A%2FB#Part"
  );

  const ambiguous = BookmarkUrl.markUrl(
    "https://newtab@example.com/private?x=%2F#part",
    MIGRATE_TOKEN
  );
  assert.equal(
    BookmarkUrl.unwrapManagedUrl(ambiguous, {
      acceptedMarkerSecrets: [OWNER],
      allowLegacy: false,
      allowAmbiguousSingle: false,
    }),
    "https://example.com/private?x=%2F#part"
  );

  const nestedLegacyTarget =
    "https://newtab@Example.COM:443/a%2Fb?sig=A%2FB#Part";
  const nestedLegacyWrapper =
    "https://newtab@sssstf0rest.github.io/" +
    "Open-Bookmarks-in-New-Tab/redirect.html?url=" +
    encodeURIComponent(nestedLegacyTarget);
  assert.equal(
    BookmarkUrl.unwrapManagedUrl(
      BookmarkUrl.markUrl(nestedLegacyWrapper, MIGRATE_TOKEN),
      {
        acceptedMarkerSecrets: [OWNER],
        allowLegacy: false,
        allowAmbiguousSingle: false,
      }
    ),
    "https://Example.COM:443/a%2Fb?sig=A%2FB#Part"
  );
});

test("preserve provenance is a hard byte-exact unwrap barrier", () => {
  const original =
    `HTTPS://newtab@Example.COM:443/a%2Fb?__obnt_v3=${V3_TOKEN}#Part`;
  const marked = BookmarkUrl.markUrl(original, PRESERVE_TOKEN);
  assert.equal(
    BookmarkUrl.unwrapManagedUrl(marked, {
      acceptedMarkerSecrets: [OWNER],
      allowLegacy: true,
      allowAmbiguousSingle: true,
      v3MarkerToken: V3_TOKEN,
    }),
    original
  );
});

test("recovers an authenticated target inside the exact released wrapper", () => {
  const original =
    "HTTPS://Mail.Google.COM/mail/u/0/?sig=A%2FB%2BC#inbox";
  const authenticated = BookmarkUrl.markUrl(original, PRESERVE_TOKEN);
  const outerLegacy =
    "https://newtab@sssstf0rest.github.io/" +
    "Open-Bookmarks-in-New-Tab/redirect.html?url=" +
    encodeURIComponent(authenticated);

  assert.equal(
    BookmarkUrl.unwrapManagedUrl(outerLegacy, {
      acceptedMarkerSecrets: [OWNER],
      allowLegacy: false,
      allowAmbiguousSingle: false,
    }),
    original
  );
});

test("does not look through an unaccepted foreign outer capability", () => {
  const original = "https://example.com/a%2Fb?sig=A%2FB#Part";
  const owned = BookmarkUrl.markUrl(original, MIGRATE_TOKEN);
  const foreignOuter = BookmarkUrl.markUrl(owned, OTHER_TOKEN);

  assert.equal(
    BookmarkUrl.unwrapManagedUrl(foreignOuter, {
      acceptedMarkerSecrets: [OWNER],
      allowLegacy: false,
    }),
    null
  );
  assert.equal(
    BookmarkUrl.getOriginalUrl(foreignOuter, OTHER_TOKEN),
    owned
  );
});

test("reads a per-bookmark capability without accepting lookalikes", () => {
  const original = "https://example.com/path?x=1#part";
  const marked = BookmarkUrl.markUrl(original, TOKEN);
  assert.deepEqual(BookmarkUrl.readMarker(marked), {
    capability: TOKEN,
    owner: OWNER,
    mode: "p",
    nonce: NONCE,
    originalUrl: original,
  });
  assert.equal(
    BookmarkUrl.readMarker(marked.replace(TOKEN, "A".repeat(32) + "_" + NONCE)),
    null
  );
});

test("preserves foreign marker-shaped page data under an owned outer marker", () => {
  const foreign =
    `https://example.com/api?__obnt_v4=${OTHER_TOKEN}`;
  const marked = BookmarkUrl.markUrl(foreign, TOKEN);
  assert.notEqual(marked, foreign);
  assert.equal(BookmarkUrl.getOriginalUrl(marked, TOKEN), foreign);
  assert.equal(BookmarkUrl.readMarker(foreign).owner, OTHER_OWNER);
});

test("recognizes the unscoped format-4 draft only through migration helper", () => {
  const draft =
    `https://example.com/path?__obnt_v4=${NONCE}#part`;
  assert.equal(BookmarkUrl.readMarker(draft), null);
  assert.deepEqual(BookmarkUrl.readDraftV4Marker(draft), {
    nonce: NONCE,
    originalUrl: "https://example.com/path#part",
  });
});

for (const {name, fn} of cases) {
  fn();
  console.log(`ok - ${name}`);
}

console.log(`${cases.length} URL transformation tests passed.`);
