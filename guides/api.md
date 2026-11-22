# API guide

Everything is exported from the package root. All durations are milliseconds, measured against the clock the `Cache` was constructed with.

## `new Cache<T>(options)`

`store` and `freshness` are required. Everything else is optional.

| Option | Description |
|---|---|
| `store` | Where entries live. See [Stores](#stores). |
| `freshness` | Decides whether a completed value is stored, and with which windows. See [Freshness](#freshness). |
| `namespace` | Prefixed onto every key. See [Keys](#keys). |
| `version` | Prefixed after the namespace. Bump it to orphan every entry written in an old shape. |
| `now` | The clock. Defaults to `Date.now`. Swap it in tests. |
| `onEvent` | Receives every [event](#events). A listener that throws is ignored. Store failures are reported nowhere else. |

Construct one cache per kind of value and share it. Keep it outside your retry and rate-limit layers, so that only a miss turns into a call.

## Reading

### `wrap(key, action)`

Returns the value. On a miss, an error thrown by `action` is rethrown as it was, never wrapped. If the entry is inside its `staleIfError` window, the old value is served instead.

### `read(key, action)`

The same as `wrap`, but returns `{ value, state, age }`. `state` is `fresh`, `stale`, `retained` or `miss`; `age` is the served entry's age, and `0` when the action produced the value.

### Actions

An action receives whatever the store still holds for the key, in any state, or `undefined` if it holds nothing. Use it to revalidate, for example by sending the old ETag.

```ts
await cache.wrap(key, async (previous) => {
	const headers = previous ? { "If-None-Match": previous.value.etag } : {};
	return fetchItem(key, headers);
});
```

### Keys

A key is a non-empty string, or any method that takes one throws `invalid-key`. The namespace and version are prefixed; nothing else is done to it. If your key comes from hashing a request body, await the hash before calling `wrap`.

The stored key is `namespace:version:key`, with a slot left empty when it is not set: `users::42` for a namespace alone, `:3:42` for a version alone, and plain `42` when neither is set. A namespace or version that is empty or contains `:` throws `invalid-namespace`, so one cache's prefix can never be the start of another's.

## Other methods

| Method | What it does |
|---|---|
| `peek(key)` | Reads the store without calling an action or starting a refresh. Returns `{ value, state, age }`, or `undefined` if nothing readable is stored. |
| `forget(key)` | Deletes one key. Deciding when a write has made a cached read wrong is up to you. |
| `clear()` | Deletes every entry under this cache's prefix through `Store.deletePrefix`. Other caches in the store keep theirs. A cache with no namespace or version has no prefix, so it empties the store like `clearAll()`. |
| `clearAll()` | Deletes every entry in the store, written by any cache in any process. |
| `settled()` | Resolves when no background refresh is running. For tests and shutdown. |

`clearAll()` is the one call here that destroys other caches' data. Call it only when emptying the whole store is what the application wants, for example in a test teardown or an admin action, never as a way to reset one cache.

An action still running when `forget`, `clear` or `clearAll` drops its key returns its value to its caller but does not write it, so a late result cannot put back what was just deleted. This covers actions started by the same `Cache` instance only. Another instance with the same namespace, or another process, is not told.

## Freshness

A freshness policy is a function `(value: T) => Windows | undefined`. Returning `undefined` skips the write. Every window must be a finite number `>= 0`, or Repletes throws `invalid-windows`.

### `fixed(windows)`

The same windows for every value.

```ts
fixed({ freshFor: 30_000, staleWhileRevalidate: 60_000, staleIfError: 300_000 });
```

### `fromCacheControl(options)`

Takes the windows from the value's `Cache-Control` header. The value must look like `{ headers, status? }`, where `headers` is either an object with `get(name)` (a `Headers`) or an array of `[name, value]` pairs. Store the pairs, because a `Headers` object does not survive serialisation.

```ts
import { Cache, MemoryStore, fromCacheControl } from "repletes";

interface Page {
	status: number;
	headers: [string, string][];
	body: string;
}

const pages = new Cache<Page>({
	store: new MemoryStore({ maxEntries: 500 }),
	freshness: fromCacheControl({
		fallback: { freshFor: 10_000, staleWhileRevalidate: 30_000, staleIfError: 60_000 },
	}),
});

const page = await pages.wrap(url, async () => {
	const res = await fetch(url);
	return { status: res.status, headers: [...res.headers], body: await res.text() };
});
```

It reads `no-store`, `no-cache`, `private`, `max-age`, `s-maxage`, `stale-while-revalidate` and `stale-if-error`, and ignores the rest of RFC 9111. It skips the write for `no-store`, for `private` when `shared` is true, and for any status `storable` rejects. `no-cache` stores the value with `freshFor: 0` and `staleWhileRevalidate: 0`, so every read revalidates; it is served stale only if the response itself carries `stale-if-error`, never from your defaults.

| Option | Description |
|---|---|
| `fallback` | Required. The windows used for anything the header does not set. |
| `shared` | Default `true`: prefer `s-maxage` and refuse `private`. Set `false` for a per-user cache. |
| `staleWhileRevalidate` | Used instead of `fallback.staleWhileRevalidate` when the header has none. |
| `staleIfError` | Used instead of `fallback.staleIfError` when the header has none. |
| `storable` | `(status) => boolean`. Default: 2xx only. |

## Stores

### `MemoryStore`

```ts
new MemoryStore({ maxEntries: 1_000 });
```

An in-process `Map`, so each process has its own. `maxEntries` is required; past it, the least recently used entry is evicted. Entries past their retention are dropped when read. `size` reports how many entries it holds. It takes an optional `now` clock for expiry, and implements both `deletePrefix` and `clear`.

### Your own store

Implement `Store<T>`. Every method is async, so a networked store fits the same interface. `deletePrefix` and `clear` are optional. Without `deletePrefix`, `clear()` on a namespaced cache throws `clear-unsupported`; without `clear`, so does `clearAll()`.

```ts
import type { Entry, Store } from "repletes";

class RedisStore<T> implements Store<T> {
	async get(key: string): Promise<Entry<T> | undefined> { /* ... */ }
	async set(key: string, entry: Entry<T>, retainFor: number): Promise<void> { /* ... */ }
	async delete(key: string): Promise<void> { /* ... */ }
	async deletePrefix(prefix: string): Promise<void> { /* optional */ }
	async clear(): Promise<void> { /* optional */ }
}
```

`retainFor` is a hint for when the entry can be thrown away, for example a Redis `PX`. Repletes checks the windows again when it reads, so a store that keeps entries longer is still correct.

`deletePrefix` must delete exactly the keys that start with the prefix. In Redis that is `SCAN` with `MATCH prefix*` and `UNLINK` on each batch. A namespace may contain `*`, `?`, `[` or `\`, so escape those with a backslash before building the pattern, or a namespace like `a*` also clears `ab::`.

A store that throws never fails a call; see [Known quirks](../README.md#known-quirks). The error is reported as a `store-error` event.

The `Codec<T, Wire>` type (`encode` and `decode`) is exported so out-of-process stores agree on one serialisation shape. Repletes does not call it.

## Events

`onEvent` receives one of these objects. Each read that returns a value emits exactly one `hit` or one `miss`.

| `type` | Emitted when | Extra fields |
|---|---|---|
| `hit` | A value was served from the store | `state`, `age` |
| `miss` | The action produced the value | |
| `write` | An entry was stored | `retainFor` |
| `skip` | A value was not stored | `reason` |
| `refresh` | A background refresh finished | `ok` |
| `served-stale` | A `retained` value was served because the action threw | `age` |
| `action-error` | The action threw, anywhere | `error`, `background` |
| `store-error` | A store call threw | `operation`, `namespace`, `error` |

`action-error` fires on a miss, under a retained entry, and behind a stale read, so the upstream failure rate is a single count. `background` is `true` for the refresh case.

`skip` has `reason: "freshness"` when the policy declined the value, and `reason: "invalidated"` when `forget` or `clear` dropped the key while the action ran.

On `store-error`, `operation` is `get`, `set`, `delete`, `deletePrefix` or `clear`, and `namespace` is the cache's. `key` is the full stored key, the prefix for `deletePrefix`, or `""` for `clear`.

## Errors

Repletes throws only for caller mistakes, as a `RepletesError` (which extends `TypeError`). Match on `code`:

| `code` | Cause |
|---|---|
| `invalid-windows` | A window is negative, infinite or not a number. |
| `invalid-key` | The key is not a non-empty string. |
| `invalid-namespace` | A namespace or version is empty or contains `:`. |
| `invalid-capacity` | `maxEntries` is not a positive integer. |
| `clear-unsupported` | The store lacks the method `clear()` or `clearAll()` needs. |

## `decide(entry, now)`

The function behind every read. Given an entry (or `undefined`) and a timestamp, it returns the [state](../README.md#how-it-works) with the value and age. It does no I/O, so you can reuse it if you build your own layer. A `storedAt` in the future is treated as age `0`.
