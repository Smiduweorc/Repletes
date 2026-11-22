import assert from "node:assert/strict";
import { test } from "node:test";

import { Cache, MemoryStore, fixed } from "../src/index.js";
import type { Entry, Event, Store } from "../src/index.js";
import { WINDOWS, clock } from "./clock.js";
import { refusal } from "./refusal.js";

function build(options?: {
	onEvent?: (event: Event) => void;
	store?: Store<string>;
	namespace?: string;
	version?: string;
}): { cache: Cache<string>; time: ReturnType<typeof clock> } {
	const time = clock();
	const cache = new Cache<string>({
		store: options?.store ?? new MemoryStore<string>({ maxEntries: 8, now: time.now }),
		freshness: fixed(WINDOWS),
		now: time.now,
		onEvent: options?.onEvent,
		namespace: options?.namespace,
		version: options?.version,
	});
	return { cache, time };
}

/** A promise plus the switch that settles it, for holding an action open. */
function gate<V>(): {
	promise: Promise<V>;
	open: (value: V) => void;
	fail: (error: unknown) => void;
	} {
	let open: (value: V) => void = () => {};
	let fail: (error: unknown) => void = () => {};
	const promise = new Promise<V>((resolve, reject) => {
		open = resolve;
		fail = reject;
	});
	return { promise, open, fail };
}

/** Lets every pending microtask run, so a started read has reached its action. */
async function turn(): Promise<void> {
	await new Promise((resolve) => setImmediate(resolve));
}

function counter(value: string): {
	action: () => Promise<string>;
	calls: () => number;
} {
	let calls = 0;
	return {
		action: async () => {
			calls += 1;
			return `${value}-${calls}`;
		},
		calls: () => calls,
	};
}

test("a miss calls the action, stores it, and reports itself as a miss", async () => {
	const { cache } = build();
	const { action, calls } = counter("v");

	const result = await cache.read("k", action);

	assert.deepEqual(result, { value: "v-1", state: "miss", age: 0 });
	assert.equal(calls(), 1);
});

test("a fresh read serves without calling the action", async () => {
	const { cache, time } = build();
	const { action, calls } = counter("v");

	await cache.wrap("k", action);
	time.advance(50);
	const result = await cache.read("k", action);

	assert.deepEqual(result, { value: "v-1", state: "fresh", age: 50 });
	assert.equal(calls(), 1);
});

test("a stale read serves now and refreshes behind", async () => {
	const { cache, time } = build();
	const { action, calls } = counter("v");

	await cache.wrap("k", action);
	time.advance(150);

	const stale = await cache.read("k", action);
	assert.deepEqual(stale, { value: "v-1", state: "stale", age: 150 });
	assert.equal(calls(), 2, "the refresh is already running");

	await cache.settled();
	assert.deepEqual(await cache.read("k", action), {
		value: "v-2",
		state: "fresh",
		age: 0,
	});
});

test("concurrent stale reads produce exactly one refresh", async () => {
	const { cache, time } = build();
	const { action, calls } = counter("v");

	await cache.wrap("k", action);
	time.advance(150);

	const reads = await Promise.all([
		cache.read("k", action),
		cache.read("k", action),
		cache.read("k", action),
	]);

	assert.deepEqual(
		reads.map((read) => read.state),
		["stale", "stale", "stale"]
	);
	await cache.settled();
	assert.equal(calls(), 2, "one fill plus one refresh");
});

test("concurrent misses on one key each call the action", async () => {
	const { cache } = build();
	const { action, calls } = counter("v");

	const reads = await Promise.all([cache.read("k", action), cache.read("k", action)]);

	assert.equal(calls(), 2, "no single-flight here; that is Firefly's");
	assert.deepEqual(
		reads.map((read) => read.state),
		["miss", "miss"]
	);
});

test("an action that throws synchronously is rethrown, not cached, and retried next read", async () => {
	const events: Event[] = [];
	const { cache } = build({ onEvent: (event) => events.push(event) });
	const original = new Error("thrown, not rejected");

	await assert.rejects(
		cache.wrap("k", () => {
			throw original;
		}),
		(error: unknown) => error === original
	);
	assert.equal(events.filter((event) => event.type === "action-error").length, 1);
	assert.equal(await cache.wrap("k", async () => "retried"), "retried");
});

test("a read concurrent with a refresh is answered from the entry, not the refresh", async () => {
	const { cache, time } = build();
	let release: (value: string) => void = () => {};
	const slow = async (): Promise<string> =>
		new Promise<string>((resolve) => {
			release = resolve;
		});

	await cache.wrap("k", async () => "first");
	time.advance(150);

	assert.equal((await cache.read("k", slow)).value, "first");
	assert.equal((await cache.read("k", slow)).value, "first");

	release("second");
	await cache.settled();
	assert.equal((await cache.read("k", slow)).value, "second");
});

test("a failed refresh leaves the previous entry readable", async () => {
	const events: Event[] = [];
	const { cache, time } = build({ onEvent: (event) => events.push(event) });

	await cache.wrap("k", async () => "held");
	time.advance(150);

	const stale = await cache.read("k", async () => {
		throw new Error("upstream down");
	});
	assert.equal(stale.value, "held");
	await cache.settled();

	assert.equal((await cache.read("k", async () => "unused")).value, "held");
	assert.ok(
		events.some((event) => event.type === "refresh" && event.ok === false),
		"the failure is reported, not thrown"
	);
});

test("stale-if-error serves the retained entry when the action fails", async () => {
	const events: Event[] = [];
	const { cache, time } = build({ onEvent: (event) => events.push(event) });

	await cache.wrap("k", async () => "held");
	time.advance(250);

	const result = await cache.read("k", async () => {
		throw new Error("upstream down");
	});

	assert.deepEqual(result, { value: "held", state: "retained", age: 250 });
	assert.ok(events.some((event) => event.type === "served-stale"));
});

test("a retained entry is replaced when the action succeeds", async () => {
	const { cache, time } = build();

	await cache.wrap("k", async () => "old");
	time.advance(250);

	assert.deepEqual(await cache.read("k", async () => "new"), {
		value: "new",
		state: "miss",
		age: 0,
	});
	assert.equal((await cache.read("k", async () => "unused")).value, "new");
});

test("every action failure is reported exactly once, wherever it happened", async () => {
	const events: Event[] = [];
	const { cache, time } = build({ onEvent: (event) => events.push(event) });
	const boom = async (): Promise<string> => {
		throw new Error("upstream down");
	};
	const types = (): string[] => events.map((event) => event.type);
	const failures = (): Extract<Event, { type: "action-error" }>[] =>
		events.filter((event) => event.type === "action-error");

	// On a miss, before the error is rethrown.
	await assert.rejects(cache.wrap("k", boom));
	assert.deepEqual(types(), ["action-error"]);
	assert.equal(failures()[0]?.background, false);
	assert.equal((failures()[0]?.error as Error).message, "upstream down");

	// Behind a stale read, marked as the refresh nobody awaited.
	events.length = 0;
	await cache.wrap("k", async () => "held");
	time.advance(150);
	await cache.wrap("k", boom);
	await cache.settled();
	assert.deepEqual(types(), ["miss", "write", "hit", "action-error", "refresh"]);
	assert.equal(failures()[0]?.background, true);

	// Under a retained entry, before the stale value is served.
	events.length = 0;
	time.advance(150);
	await cache.wrap("k", boom);
	assert.deepEqual(types(), ["action-error", "served-stale", "hit"]);
	assert.equal(failures()[0]?.background, false);
});

test("a successful read reports no error at all", async () => {
	const events: Event[] = [];
	const { cache, time } = build({ onEvent: (event) => events.push(event) });

	await cache.wrap("k", async () => "v");
	time.advance(50);
	await cache.wrap("k", async () => "v");

	assert.deepEqual(
		events.filter((event) => event.type === "action-error"),
		[]
	);
});

test("the original error survives stale-if-error untouched", async () => {
	const { cache, time } = build();
	class UpstreamError extends Error {
		readonly status = 503;
	}
	const original = new UpstreamError("gone");

	await cache.wrap("k", async () => "held");
	time.advance(600);

	await assert.rejects(
		cache.wrap("k", async () => {
			throw original;
		}),
		(error: unknown) => {
			assert.equal(error, original, "same instance, not wrapped");
			return true;
		}
	);
});

test("a failure is never written down", async () => {
	const { cache } = build();

	await assert.rejects(
		cache.wrap("k", async () => {
			throw new Error("no");
		})
	);
	assert.equal(await cache.peek("k"), undefined);
});

test("freshness declining a value skips the write", async () => {
	const events: Event[] = [];
	const time = clock();
	const cache = new Cache<string>({
		store: new MemoryStore<string>({ maxEntries: 4, now: time.now }),
		freshness: (value) => (value === "skip" ? undefined : WINDOWS),
		now: time.now,
		onEvent: (event) => events.push(event),
	});

	await cache.wrap("k", async () => "skip");

	assert.equal(await cache.peek("k"), undefined);
	assert.ok(events.some((event) => event.type === "skip"));
});

test("peek reads without calling anything or triggering a refresh", async () => {
	const { cache, time } = build();

	assert.equal(await cache.peek("k"), undefined);
	await cache.wrap("k", async () => "held");
	time.advance(150);

	assert.deepEqual(await cache.peek("k"), {
		value: "held",
		state: "stale",
		age: 150,
	});
	await cache.settled();
	assert.equal((await cache.peek("k"))?.value, "held", "peek refreshed nothing");

	time.advance(1000);
	assert.equal(await cache.peek("k"), undefined, "beyond retention");
});

test("forget drops one key, clear on an unnamespaced cache drops the store", async () => {
	const { cache } = build();

	await cache.wrap("a", async () => "a");
	await cache.wrap("b", async () => "b");

	await cache.forget("a");
	assert.equal(await cache.peek("a"), undefined);
	assert.equal((await cache.peek("b"))?.value, "b");

	await cache.clear();
	assert.equal(await cache.peek("b"), undefined);
});

test("clear drops only its own namespace, clearAll drops everything", async () => {
	const time = clock();
	const store = new MemoryStore<string>({ maxEntries: 8, now: time.now });
	const users = build({ store, namespace: "users" }).cache;
	const usersV2 = build({ store, namespace: "users", version: "2" }).cache;
	const orders = build({ store, namespace: "orders" }).cache;

	await users.wrap("1", async () => "u");
	await usersV2.wrap("1", async () => "u2");
	await orders.wrap("1", async () => "o");

	await usersV2.clear();
	assert.equal(await usersV2.peek("1"), undefined);
	assert.equal((await users.peek("1"))?.value, "u", "an older version is its own cache");
	assert.equal((await orders.peek("1"))?.value, "o");

	await orders.clear();
	assert.equal(await orders.peek("1"), undefined);
	assert.equal((await users.peek("1"))?.value, "u");

	await orders.clearAll();
	assert.equal(store.size, 0);
});

test("namespace and version prefixes never overlap", async () => {
	const time = clock();
	const store = new MemoryStore<string>({ maxEntries: 16, now: time.now });
	const plain = build({ store, namespace: "users" }).cache;
	const v1 = build({ store, namespace: "users", version: "1" }).cache;
	const v2 = build({ store, namespace: "users", version: "2" }).cache;
	const versionOnly = build({ store, version: "1" }).cache;

	// Without both slots, plain's "1:k" and v1's "k" would be the same key.
	await plain.wrap("1:k", async () => "plain");
	await v1.wrap("k", async () => "v1");
	await v2.wrap("k", async () => "v2");
	await versionOnly.wrap("k", async () => "version-only");
	assert.equal((await plain.peek("1:k"))?.value, "plain");
	assert.equal((await v1.peek("k"))?.value, "v1");

	await plain.clear();
	assert.equal(await plain.peek("1:k"), undefined);
	assert.equal((await v1.peek("k"))?.value, "v1", "a namespace clear spares its versions");
	assert.equal((await v2.peek("k"))?.value, "v2");

	await v1.clear();
	assert.equal(await v1.peek("k"), undefined);
	assert.equal((await v2.peek("k"))?.value, "v2", "version 1 spares version 2");
	assert.equal((await versionOnly.peek("k"))?.value, "version-only");
});

test("a namespace or version that could blur a prefix is refused", () => {
	assert.throws(() => build({ namespace: "a:b" }), refusal("invalid-namespace"));
	assert.throws(() => build({ namespace: "" }), refusal("invalid-namespace"));
	assert.throws(() => build({ version: "1:2" }), refusal("invalid-namespace"));
	assert.throws(() => build({ version: "" }), refusal("invalid-namespace"));
});

test("an action in flight across clear() does not write its result back", async () => {
	const events: Event[] = [];
	const { cache } = build({ namespace: "users", onEvent: (event) => events.push(event) });
	const action = gate<string>();

	const before = cache.read("k", async () => action.promise);
	await turn();
	await cache.clear();
	assert.equal(await cache.wrap("k", async () => "after"), "after");
	action.open("before");

	assert.equal((await before).value, "before", "its caller still gets an answer");
	assert.equal((await cache.peek("k"))?.value, "after", "the late result did not overwrite");
	assert.ok(
		events.some((event) => event.type === "skip" && event.reason === "invalidated")
	);
});

test("an action in flight across forget() does not write its result back", async () => {
	const { cache } = build();
	const action = gate<string>();

	const before = cache.read("k", async () => action.promise);
	await turn();
	await cache.forget("k");
	action.open("before");

	assert.equal((await before).value, "before");
	assert.equal(await cache.peek("k"), undefined);
});

test("forget() leaves actions running for other keys alone", async () => {
	const { cache } = build();
	const action = gate<string>();

	const other = cache.read("other", async () => action.promise);
	await turn();
	await cache.forget("k");
	action.open("kept");
	await other;

	assert.equal((await cache.peek("other"))?.value, "kept");
});

test("a refresh in flight across clearAll() does not write its result back", async () => {
	const { cache, time } = build();
	const action = gate<string>();

	await cache.wrap("k", async () => "held");
	time.advance(150);
	await cache.read("k", async () => action.promise);
	await cache.clearAll();
	action.open("refreshed");
	await cache.settled();

	assert.equal(await cache.peek("k"), undefined);
});

test("a refresh cut loose by forget() does not block the next refresh", async () => {
	const { cache, time } = build();
	const stuck = gate<string>();
	const { action, calls } = counter("next");

	await cache.wrap("k", async () => "held");
	time.advance(150);
	await cache.read("k", async () => stuck.promise);
	await cache.forget("k");

	await cache.wrap("k", async () => "again");
	time.advance(150);
	await cache.read("k", action);
	assert.equal(calls(), 1, "a new refresh started while the old one still hangs");

	stuck.open("late");
	await cache.settled();
	assert.equal((await cache.peek("k"))?.value, "next-1");
});

test("clear on a namespaced cache refuses a store without deletePrefix", async () => {
	let cleared = false;
	const store: Store<string> = {
		get: async () => undefined,
		set: async () => {},
		delete: async () => {},
		clear: async () => {
			cleared = true;
		},
	};
	const { cache } = build({ store, namespace: "users" });

	await assert.rejects(cache.clear(), refusal("clear-unsupported"));
	assert.equal(cleared, false, "never falls back to emptying the whole store");
});

test("clear on a store without one is a type error, not a silent no-op", async () => {
	const store: Store<string> = {
		get: async () => undefined,
		set: async () => {},
		delete: async () => {},
	};
	const { cache } = build({ store });

	await assert.rejects(cache.clear(), refusal("clear-unsupported"));
	await assert.rejects(cache.clearAll(), refusal("clear-unsupported"));
});

test("namespace and version prefix the key", async () => {
	const keys: string[] = [];
	const store: Store<string> = {
		get: async (key) => {
			keys.push(key);
			return undefined;
		},
		set: async () => {},
		delete: async () => {},
	};
	await build({ store, namespace: "orders", version: "v2" }).cache.wrap("42", async () => "x");
	await build({ store, namespace: "orders" }).cache.wrap("42", async () => "x");
	await build({ store, version: "v2" }).cache.wrap("42", async () => "x");
	await build({ store }).cache.wrap("42", async () => "x");

	assert.deepEqual(keys, ["orders:v2:42", "orders::42", ":v2:42", "42"]);
});

test("an empty key is refused", async () => {
	const { cache } = build();
	await assert.rejects(cache.wrap("", async () => "x"), refusal("invalid-key"));
});

test("a store failure is a miss on read and a no-op on write", async () => {
	const events: Event[] = [];
	const store: Store<string> = {
		get: async () => {
			throw new Error("redis down");
		},
		set: async () => {
			throw new Error("redis down");
		},
		delete: async () => {
			throw new Error("redis down");
		},
	};
	const { cache } = build({
		store,
		namespace: "users",
		onEvent: (event) => events.push(event),
	});

	assert.equal(await cache.wrap("k", async () => "v"), "v");
	assert.equal(await cache.peek("k"), undefined);
	await cache.forget("k");

	const first = events.find((event) => event.type === "store-error");
	assert.equal(first?.type === "store-error" && first.key, "users::k");
	assert.equal(first?.type === "store-error" && first.namespace, "users");
	assert.equal(
		first?.type === "store-error" && (first.error as Error).message,
		"redis down"
	);

	assert.deepEqual(
		events
			.filter((event) => event.type === "store-error")
			.map((event) => (event.type === "store-error" ? event.operation : "")),
		["get", "set", "get", "delete"]
	);
});

test("an onEvent listener that throws does not fail a read", async () => {
	const { cache } = build({
		onEvent: () => {
			throw new Error("bad listener");
		},
	});

	assert.equal(await cache.wrap("k", async () => "v"), "v");
});

test("the action is handed whatever the store still holds", async () => {
	const { cache, time } = build();
	const seen: (Entry<string> | undefined)[] = [];
	const record = async (previous: Entry<string> | undefined): Promise<string> => {
		seen.push(previous);
		return "v";
	};

	await cache.wrap("k", record);
	time.advance(150);
	await cache.wrap("k", record);
	await cache.settled();

	assert.equal(seen.length, 2);
	assert.equal(seen[0], undefined);
	assert.equal(seen[1]?.value, "v");
});

test("windows are validated, not defaulted", () => {
	assert.throws(
		() => fixed({ freshFor: -1, staleWhileRevalidate: 0, staleIfError: 0 }),
		refusal("invalid-windows")
	);
	assert.throws(
		() =>
			fixed({
				freshFor: Number.NaN,
				staleWhileRevalidate: 0,
				staleIfError: 0,
			}),
		refusal("invalid-windows")
	);
});
