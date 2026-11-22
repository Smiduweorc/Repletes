# Design and scope

When I was working on my own project, I felt that I was perhaps too pedantic about how stale-if-error was handled. I wanted something that clearly communicated whether a returned value was fresh or just fallback stale data because something upstream failed. I want people to think of this library for its cache policies, not its storage. What it leaves out, and where that goes, is the "Not included" list in the [README](../README.md#not-included).

[Motivation](../Motivation.md) has the backstory.

## Windows and retention

- The store is asked to keep an entry for `freshFor + max(staleWhileRevalidate, staleIfError)`. The windows are checked again on every read, so a store that keeps entries longer, or a store whose expiry is off, does not change what a read returns.
- The windows are stored with the value. Changing your config does not reinterpret entries already written.
- Capacity is the store's business. `MemoryStore` evicts the least recently used entry past `maxEntries`; the read decision never looks at whether a store still has room.
- A failed action is never written. A value that represents a failure (a 500 response, say) is written only if your freshness policy accepts it.
- A failed background refresh leaves the existing entry in place and never surfaces as an unhandled rejection. It is reported as an `action-error` event.

## About keys

Repletes doesn't care what the key looks like. A URL, a UUID, whatever: it all works the same. Only the namespace and version are prefixed onto it.

If you're using content-addressed keys (where the key is derived from the content), that's on you. The upside: the entry can never go stale, since the content determines the key. The downside: Repletes has no way to detect a collision if you hash wrong. That risk is yours now, not ours.

## Clearing a shared store

Several caches can share one store under different namespaces, so `clear()` deletes only the calling cache's prefix and emptying the whole store is a separate call, `clearAll()`. A namespaced `clear()` on a store without `deletePrefix` throws instead of falling back to `clear`, because that fallback is the cross-cache wipe the split exists to prevent.

The prefix always has two slots once either is set (`users::`, `users:2:`) and neither may contain `:`. With one slot, `users:` would be the start of `users:2:`, and clearing the unversioned cache would delete every versioned one.

An action that was already running when its key was dropped does not write its result. Without that, a slow call started before `clear()` would finish after it and put the old value back.

## Store failures

A cache is an optimisation, so a store that throws turns a read into a miss and a write into a skip, and the caller still gets the action's result. The failure is reported as a `store-error` event and nowhere else: Repletes does not log, so an application that needs to know its store is down passes `onEvent`.

## No single-flight, no `put`

Concurrent misses on the same key each call the action. Only the background refresh behind a stale read is deduplicated, one per key. Coalescing in-flight work belongs in the layer that also owns retries and deadlines, which is Firefly.

There is no way to prime the cache directly. Every stored value is the result of an action that ran, so an entry's windows always describe a call that completed.
