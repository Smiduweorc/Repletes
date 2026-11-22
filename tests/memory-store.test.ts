import assert from "node:assert/strict";
import { test } from "node:test";

import { MemoryStore } from "../src/index.js";
import type { Entry } from "../src/index.js";
import { clock } from "./clock.js";
import { refusal } from "./refusal.js";

function entry(value: string, storedAt: number): Entry<string> {
	return {
		value,
		storedAt,
		freshFor: 100,
		staleWhileRevalidate: 100,
		staleIfError: 400,
	};
}

test("maxEntries is required and has to be sane", () => {
	assert.throws(
		() => new MemoryStore({ maxEntries: 0 }),
		refusal("invalid-capacity")
	);
	assert.throws(
		() => new MemoryStore({ maxEntries: 1.5 }),
		refusal("invalid-capacity")
	);
});

test("capacity evicts the least recently used entry", async () => {
	const store = new MemoryStore<string>({ maxEntries: 2 });

	await store.set("a", entry("a", 0), 10_000);
	await store.set("b", entry("b", 0), 10_000);
	await store.get("a");
	await store.set("c", entry("c", 0), 10_000);

	assert.equal(store.size, 2);
	assert.equal((await store.get("a"))?.value, "a");
	assert.equal(await store.get("b"), undefined, "b was the least recent");
	assert.equal((await store.get("c"))?.value, "c");
});

test("writing an existing key refreshes its recency without growing the store", async () => {
	const store = new MemoryStore<string>({ maxEntries: 2 });

	await store.set("a", entry("a", 0), 10_000);
	await store.set("b", entry("b", 0), 10_000);
	await store.set("a", entry("a2", 0), 10_000);
	await store.set("c", entry("c", 0), 10_000);

	assert.equal(store.size, 2);
	assert.equal((await store.get("a"))?.value, "a2");
	assert.equal(await store.get("b"), undefined);
});

test("retention is honoured on read, at the boundary", async () => {
	const time = clock(0);
	const store = new MemoryStore<string>({ maxEntries: 4, now: time.now });

	await store.set("a", entry("a", 0), 500);

	time.advance(500);
	assert.equal((await store.get("a"))?.value, "a", "the last readable instant");

	time.advance(1);
	assert.equal(await store.get("a"), undefined);
	assert.equal(store.size, 0, "an expired entry is dropped, not kept");
});

test("delete, deletePrefix and clear", async () => {
	const store = new MemoryStore<string>({ maxEntries: 4 });

	await store.set("a", entry("a", 0), 10_000);
	await store.set("b", entry("b", 0), 10_000);

	await store.delete("a");
	assert.equal(await store.get("a"), undefined);

	await store.set("ns:a", entry("a", 0), 10_000);
	await store.set("ns:b", entry("b", 0), 10_000);
	await store.deletePrefix("ns:");
	assert.equal(store.size, 1, "only the prefixed keys go");
	assert.equal((await store.get("b"))?.value, "b");

	await store.clear();
	assert.equal(store.size, 0);
});
