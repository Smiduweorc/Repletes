import { decide } from "./decide.js";
import { RepletesError } from "./errors.js";
import type {
	Action,
	Entry,
	Event,
	Freshness,
	Result,
	Store,
} from "./types.js";
import { assertWindows, retentionFor } from "./windows.js";

export interface CacheOptions<T> {
	store: Store<T>;
	/** Whether a completed value is stored, and for how long. */
	freshness: Freshness<T>;
	/**
	 * Prefixed onto every key. Nothing is derived, hashed or normalised. Must be
	 * non-empty and free of `:`, so no two caches' prefixes can overlap.
	 */
	namespace?: string;
	/**
	 * Prefixed after the namespace. Bump it to orphan every entry of an old
	 * shape. The same rules as `namespace` apply.
	 */
	version?: string | number;
	/** Swappable clock. Defaults to `Date.now`. */
	now?: () => number;
	/**
	 * Told about everything. A listener that throws is ignored, not propagated.
	 * Store failures are reported nowhere else, so pass one if you need to know
	 * when the store is down.
	 */
	onEvent?: (event: Event) => void;
}

/**
 * One running action. `forget` and `clear` set `invalidated` when they drop its
 * key, so the result still reaches its caller but is not written back over the
 * drop.
 */
interface Flight {
	readonly id: string;
	invalidated: boolean;
}

function segment(name: string, value: string | number | undefined): string | undefined {
	if (value === undefined) return undefined;
	const text = String(value);
	if (text === "" || text.includes(":")) {
		throw new RepletesError(
			"invalid-namespace",
			`${name} must be non-empty and contain no ":", received ${JSON.stringify(text)}`
		);
	}
	return text;
}

/**
 * A store plus every decision about caching one kind of thing. Construct it
 * once and share it deliberately.
 *
 * The cache belongs outside your retry and rate-limit layers: a hit should not
 * consume a bulkhead slot. Only a miss becomes a call.
 */
export class Cache<T> {
	readonly #store: Store<T>;
	readonly #freshness: Freshness<T>;
	readonly #namespace: string | undefined;
	readonly #prefix: string;
	readonly #now: () => number;
	readonly #onEvent: ((event: Event) => void) | undefined;
	/** Every action running now, foreground or background. */
	readonly #flights = new Set<Flight>();
	/** At most one refresh per key. */
	readonly #refreshing = new Map<string, Promise<void>>();
	/** Every refresh still running, including ones `forget` or `clear` cut loose. */
	readonly #background = new Set<Promise<void>>();

	constructor(options: CacheOptions<T>) {
		this.#store = options.store;
		this.#freshness = options.freshness;
		this.#now = options.now ?? Date.now;
		this.#onEvent = options.onEvent;

		// Both slots are always written once either is set, and neither may hold a
		// colon, so `users::` and `users:2:` can never be prefixes of each other.
		const namespace = segment("namespace", options.namespace);
		const version = segment("version", options.version);
		this.#namespace = namespace;
		this.#prefix =
			namespace === undefined && version === undefined
				? ""
				: `${namespace ?? ""}:${version ?? ""}:`;
	}

	/**
	 * The value behind a key, from the store when the windows say so and from
	 * `action` when they do not.
	 *
	 * An action failure on a miss rethrows untouched. An action failure covered
	 * by `staleIfError` serves the retained value instead. A result that lands
	 * after `forget` or `clear` dropped its key is returned but not written.
	 *
	 * Concurrent misses on one key each call the action. To share one call
	 * between them, wrap the action in a single-flight layer.
	 */
	async wrap(key: string, action: Action<T>): Promise<T> {
		const result = await this.read(key, action);
		return result.value;
	}

	/**
	 * {@link wrap}, with where the value came from. Use this when a caller has
	 * to tell a fresh answer from one that survived an upstream failure.
	 */
	async read(key: string, action: Action<T>): Promise<Result<T>> {
		const id = this.#id(key);
		const entry = await this.#get(id);
		const decision = decide(entry, this.#now());

		switch (decision.state) {
		case "fresh": {
			this.#emit({ type: "hit", key: id, state: "fresh", age: decision.age });
			return { value: decision.value, state: "fresh", age: decision.age };
		}

		case "stale": {
			this.#emit({ type: "hit", key: id, state: "stale", age: decision.age });
			this.#refresh(id, entry, action);
			return { value: decision.value, state: "stale", age: decision.age };
		}

		case "retained": {
			try {
				return await this.#call(id, entry, action);
			} catch {
				this.#emit({ type: "served-stale", key: id, age: decision.age });
				this.#emit({
					type: "hit",
					key: id,
					state: "retained",
					age: decision.age,
				});
				return { value: decision.value, state: "retained", age: decision.age };
			}
		}

		case "miss": {
			return await this.#call(id, entry, action);
		}
		}
	}

	/**
	 * What the store holds, without calling anything and without triggering a
	 * refresh. `undefined` when nothing readable is there.
	 */
	async peek(key: string): Promise<Result<T> | undefined> {
		const id = this.#id(key);
		const decision = decide(await this.#get(id), this.#now());
		if (decision.state === "miss") return undefined;
		return { value: decision.value, state: decision.state, age: decision.age };
	}

	/**
	 * Drop one key. This is the mechanism; deciding when a write made a read
	 * wrong is the caller's, because a cache cannot see it. An action already
	 * running for the key will not write its result back.
	 */
	async forget(key: string): Promise<void> {
		const id = this.#id(key);
		this.#invalidate((flightId) => flightId === id);
		try {
			await this.#store.delete(id);
		} catch (error) {
			this.#storeError(id, "delete", error);
		}
	}

	/**
	 * Drop every key this cache wrote: everything under its namespace and
	 * version, through `Store.deletePrefix`. Other caches sharing the store are
	 * untouched. A cache with neither namespace nor version owns no prefix, so
	 * this empties the store like {@link clearAll}.
	 *
	 * Actions this cache has running will not write their results back. Another
	 * `Cache` instance with the same namespace is not told, so share one.
	 */
	async clear(): Promise<void> {
		if (this.#prefix === "") return this.clearAll();

		const deletePrefix = this.#store.deletePrefix;
		if (deletePrefix === undefined) {
			throw new RepletesError(
				"clear-unsupported",
				"clear() on a namespaced cache needs a store that implements deletePrefix()"
			);
		}
		this.#invalidate(() => true);
		try {
			await deletePrefix.call(this.#store, this.#prefix);
		} catch (error) {
			this.#storeError(this.#prefix, "deletePrefix", error);
		}
	}

	/**
	 * Destructive beyond this cache: empties the whole store, including entries
	 * written by every other cache and process that shares it. Reach for
	 * {@link clear} unless the application means to empty everything. Optional
	 * on the `Store` interface and potentially O(n).
	 *
	 * Only this cache's running actions are stopped from writing back; other
	 * caches on the store may repopulate it as theirs finish.
	 */
	async clearAll(): Promise<void> {
		const clear = this.#store.clear;
		if (clear === undefined) {
			throw new RepletesError(
				"clear-unsupported",
				"this store does not implement clear()"
			);
		}
		this.#invalidate(() => true);
		try {
			await clear.call(this.#store);
		} catch (error) {
			this.#storeError("", "clear", error);
		}
	}

	/**
	 * Resolves once no background refresh is in flight. For tests and for
	 * shutdown; a caller never has to await a refresh to get an answer.
	 */
	async settled(): Promise<void> {
		while (this.#background.size > 0) {
			await Promise.all([...this.#background]);
		}
	}

	#id(key: string): string {
		if (typeof key !== "string" || key === "") {
			throw new RepletesError(
				"invalid-key",
				`key must be a non-empty string, received ${String(key)}`
			);
		}
		return this.#prefix + key;
	}

	async #call(
		id: string,
		previous: Entry<T> | undefined,
		action: Action<T>
	): Promise<Result<T>> {
		const flight: Flight = { id, invalidated: false };
		this.#flights.add(flight);
		try {
			let value: T;
			try {
				value = await action(previous);
			} catch (error) {
				this.#emit({ type: "action-error", key: id, error, background: false });
				throw error;
			}

			// The miss is why the write happens, so it is reported first. Exactly one
			// of hit or miss is emitted per read that returns a value.
			this.#emit({ type: "miss", key: id });
			await this.#write(flight, value);
			return { value, state: "miss", age: 0 };
		} finally {
			this.#flights.delete(flight);
		}
	}

	#refresh(id: string, previous: Entry<T> | undefined, action: Action<T>): void {
		if (this.#refreshing.has(id)) return;

		const flight: Flight = { id, invalidated: false };
		this.#flights.add(flight);
		const task = (async (): Promise<void> => {
			try {
				const value = await action(previous);
				await this.#write(flight, value);
				this.#emit({ type: "refresh", key: id, ok: true });
			} catch (error) {
				this.#emit({ type: "action-error", key: id, error, background: true });
				this.#emit({ type: "refresh", key: id, ok: false });
			}
		})().finally(() => {
			this.#flights.delete(flight);
			if (this.#refreshing.get(id) === task) this.#refreshing.delete(id);
			this.#background.delete(task);
		});

		this.#refreshing.set(id, task);
		this.#background.add(task);
	}

	/**
	 * Stop every running action whose key matches from writing its result. A
	 * refresh cut loose also stops counting as the key's one refresh, so a
	 * later stale read can start another.
	 */
	#invalidate(matches: (id: string) => boolean): void {
		for (const flight of this.#flights) {
			if (!matches(flight.id)) continue;
			flight.invalidated = true;
			this.#refreshing.delete(flight.id);
		}
	}

	async #get(id: string): Promise<Entry<T> | undefined> {
		try {
			return await this.#store.get(id);
		} catch (error) {
			this.#storeError(id, "get", error);
			return undefined;
		}
	}

	async #write(flight: Flight, value: T): Promise<void> {
		const { id } = flight;
		if (flight.invalidated) {
			this.#emit({ type: "skip", key: id, reason: "invalidated" });
			return;
		}

		const windows = this.#freshness(value);
		if (windows === undefined) {
			this.#emit({ type: "skip", key: id, reason: "freshness" });
			return;
		}

		const checked = assertWindows(windows);
		const retainFor = retentionFor(checked);
		if (retainFor <= 0) {
			this.#emit({ type: "skip", key: id, reason: "freshness" });
			return;
		}

		const entry: Entry<T> = { value, storedAt: this.#now(), ...checked };
		try {
			await this.#store.set(id, entry, retainFor);
			this.#emit({ type: "write", key: id, retainFor });
		} catch (error) {
			this.#storeError(id, "set", error);
		}
	}

	#storeError(
		key: string,
		operation: Extract<Event, { type: "store-error" }>["operation"],
		error: unknown
	): void {
		this.#emit({ type: "store-error", key, namespace: this.#namespace, operation, error });
	}

	#emit(event: Event): void {
		if (this.#onEvent === undefined) return;
		try {
			this.#onEvent(event);
		} catch {
			// A listener is an observer. It does not get to fail a read.
		}
	}
}
