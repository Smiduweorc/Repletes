/**
 * Every duration in repletes is milliseconds, measured against the clock the
 * {@link Cache} was constructed with. There are no defaults: freshness is a
 * property of your data, so all three numbers are required.
 */
export interface Windows {
	/** How long a stored value answers a read outright. */
	freshFor: number;
	/** How long past `freshFor` a value is served while a refresh runs behind it. */
	staleWhileRevalidate: number;
	/** How long past `freshFor` a value is served, but only if the action failed. */
	staleIfError: number;
}

/**
 * What a store holds. The windows travel with the value rather than living on
 * the cache, so retention can be re-checked on the way out and a config change
 * never silently reinterprets what is already written down.
 */
export interface Entry<T> extends Windows {
	value: T;
	/** Milliseconds, from the clock of whoever wrote the entry. */
	storedAt: number;
}

/** What a read did. `miss` means the value came from the action, not the store. */
export type ReadState = "fresh" | "stale" | "retained" | "miss";

/** The policy decision over one entry. Pure: no store, no clock, no promises. */
export type Decision<T> =
	| { state: "fresh"; value: T; age: number }
	| { state: "stale"; value: T; age: number }
	| { state: "retained"; value: T; age: number }
	| { state: "miss" };

/**
 * Decides whether a completed value is worth storing and for how long.
 * Returning `undefined` declines the write.
 */
export type Freshness<T> = (value: T) => Windows | undefined;

/**
 * Where the bytes live. Async everywhere, including in memory, so that moving
 * from a process-local store to a networked one is a constructor change.
 */
export interface Store<T = unknown> {
	get(key: string): Promise<Entry<T> | undefined>;
	/**
	 * `retainFor` is `freshFor + max(swr, sie)`. Treat it as a hint for
	 * reclaiming space; repletes re-checks the windows on the way out and never
	 * trusts store expiry for correctness.
	 */
	set(key: string, entry: Entry<T>, retainFor: number): Promise<void>;
	delete(key: string): Promise<void>;
	/**
	 * Optional. Drops every key that starts with `prefix`, and nothing else. A
	 * namespaced {@link Cache} needs it for `clear()`. May be O(n) on a store
	 * that has to scan.
	 */
	deletePrefix?(prefix: string): Promise<void>;
	/** Optional. Empties the whole store, whoever wrote to it. */
	clear?(): Promise<void>;
}

/**
 * The work behind a key. `previous` is whatever the store still holds, in any
 * state, so an action can revalidate against it. It is `undefined` when the
 * store held nothing.
 */
export type Action<T> = (previous: Entry<T> | undefined) => T | Promise<T>;

/** A value plus where it came from. */
export interface Result<T> {
	value: T;
	state: ReadState;
	/** Age of the served entry in milliseconds. Zero when the action produced it. */
	age: number;
}

/**
 * How an out-of-process {@link Store} turns entries into something it can hold.
 * repletes never calls this itself; it is here so adapters agree on a shape.
 */
export interface Codec<T, Wire = string> {
	encode(entry: Entry<T>): Wire | Promise<Wire>;
	decode(wire: Wire): Entry<T> | Promise<Entry<T>>;
}

/**
 * Everything observable. Reported, never thrown.
 *
 * `action-error` and `store-error` carry what went wrong; the rest are facts
 * about what the cache did, so a listener counts them without unpacking an
 * error it does not need.
 */
export type Event =
	| { type: "hit"; key: string; state: "fresh" | "stale" | "retained"; age: number }
	| { type: "miss"; key: string }
	| { type: "write"; key: string; retainFor: number }
	/**
	 * Nothing was written. `freshness` means the policy declined the value;
	 * `invalidated` means `forget` or `clear` dropped the key while the action
	 * ran, so writing it back would have undone the drop.
	 */
	| { type: "skip"; key: string; reason: "freshness" | "invalidated" }
	| { type: "refresh"; key: string; ok: boolean }
	| { type: "served-stale"; key: string; age: number }
	/**
	 * The action failed. Emitted wherever an action throws (on a miss before the
	 * error is rethrown, under a retained entry before it is served, and behind a
	 * stale read), so that upstream failure rate is one count rather than three.
	 * `background` marks the refresh case, which no caller awaited.
	 */
	| { type: "action-error"; key: string; error: unknown; background: boolean }
	/**
	 * A store call threw and the read carried on without it. `key` is the full
	 * prefixed key, the prefix for `deletePrefix`, and `""` for `clear`.
	 * `namespace` is the cache's, so one listener can watch several caches.
	 */
	| {
			type: "store-error";
			key: string;
			namespace: string | undefined;
			operation: "get" | "set" | "delete" | "deletePrefix" | "clear";
			error: unknown;
	  };
