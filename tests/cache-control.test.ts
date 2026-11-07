import assert from "node:assert/strict";
import { test } from "node:test";

import { fromCacheControl } from "../src/index.js";
import { WINDOWS } from "./clock.js";

function value(
	cacheControl: string | null,
	status = 200
): { headers: Headers; status: number } {
	const headers = new Headers();
	if (cacheControl !== null) headers.set("cache-control", cacheControl);
	return { headers, status };
}

const freshness = fromCacheControl({ fallback: WINDOWS });

test("a silent response falls back to the numbers you chose", () => {
	assert.deepEqual(freshness(value(null)), WINDOWS);
});

test("seconds become milliseconds", () => {
	assert.deepEqual(
		freshness(value("max-age=60, stale-while-revalidate=30, stale-if-error=120")),
		{ freshFor: 60_000, staleWhileRevalidate: 30_000, staleIfError: 120_000 }
	);
});

test("a shared cache prefers s-maxage, a private one ignores it", () => {
	assert.equal(freshness(value("max-age=10, s-maxage=60"))?.freshFor, 60_000);

	const privateCache = fromCacheControl({ fallback: WINDOWS, shared: false });
	assert.equal(
		privateCache(value("max-age=10, s-maxage=60"))?.freshFor,
		10_000
	);
});

test("no-store declines the write", () => {
	assert.equal(freshness(value("no-store")), undefined);
	assert.equal(freshness(value("max-age=60, no-store")), undefined);
});

test("private declines on a shared cache and is kept on a private one", () => {
	assert.equal(freshness(value("private, max-age=60")), undefined);

	const privateCache = fromCacheControl({ fallback: WINDOWS, shared: false });
	assert.equal(privateCache(value("private, max-age=60"))?.freshFor, 60_000);
});

test("no-cache means zero freshness, not no storage", () => {
	const windows = freshness(value("no-cache, max-age=60, stale-if-error=30"));
	assert.equal(windows?.freshFor, 0);
	assert.equal(windows?.staleIfError, 30_000);
});

test("no-cache is never served while it refreshes", () => {
	const windows = freshness(value("no-cache, stale-while-revalidate=60"));
	assert.equal(windows?.freshFor, 0);
	assert.equal(windows?.staleWhileRevalidate, 0);
});

test("no-cache ignores the caller's defaults for serving stale", () => {
	const withDefaults = fromCacheControl({
		fallback: WINDOWS,
		staleWhileRevalidate: 5_000,
		staleIfError: 7_000,
	});
	const windows = withDefaults(value("no-cache"));
	assert.equal(windows?.staleWhileRevalidate, 0);
	assert.equal(windows?.staleIfError, 0);
});

test("only the caller's storable statuses are written down", () => {
	assert.equal(freshness(value("max-age=60", 500)), undefined);
	assert.equal(freshness(value("max-age=60", 404)), undefined);

	const withErrors = fromCacheControl({
		fallback: WINDOWS,
		storable: (status) => status === 404,
	});
	assert.equal(withErrors(value("max-age=60", 404))?.freshFor, 60_000);
});

test("junk directives fall through to the fallback rather than to zero", () => {
	assert.equal(freshness(value("max-age=banana"))?.freshFor, WINDOWS.freshFor);
	assert.equal(freshness(value("max-age=-5"))?.freshFor, WINDOWS.freshFor);
	assert.equal(freshness(value("max-age=\"60\""))?.freshFor, 60_000);
	assert.equal(freshness(value("  MAX-AGE = 60 "))?.freshFor, 60_000);
});

test("defaults for the windows the response says nothing about", () => {
	const withDefaults = fromCacheControl({
		fallback: WINDOWS,
		staleWhileRevalidate: 5_000,
		staleIfError: 9_000,
	});
	assert.deepEqual(withDefaults(value("max-age=60")), {
		freshFor: 60_000,
		staleWhileRevalidate: 5_000,
		staleIfError: 9_000,
	});
});

test("flattened header pairs read the same as a Headers object", () => {
	const stored = {
		status: 200,
		headers: [
			["etag", "\"v1\""],
			["cache-control", "max-age=60"],
		] as [string, string][],
	};

	assert.equal(freshness(stored)?.freshFor, 60_000);
	assert.equal(freshness({ status: 200, headers: [] })?.freshFor, WINDOWS.freshFor);
});
