import { RepletesError } from "./errors.js";
import type { Entry, Store } from "./types.js";

export interface MemoryStoreOptions {
	/** Required. A cache with no ceiling is a leak with a good reputation. */
	maxEntries: number;
	/** Swappable clock, for expiry only. Defaults to `Date.now`. */
	now?: () => number;
}

/**
 * In-process store. Evicts the least recently used entry once `maxEntries` is
 * exceeded, and drops entries past their retention on read.
 *
 * Eviction here is about space, not about correctness: the read decision is
 * made from the entry's own windows, never from whether this store still has it.
 *
 * Entries live in this process only. Several processes (cluster workers,
 * replicas, serverless instances) each hold an independent copy and never see
 * each other's writes or `forget` calls; share a networked store for that.
 */
export class MemoryStore<T = unknown> implements Store<T> {
	readonly #entries = new Map<string, { entry: Entry<T>; expiresAt: number }>();
	readonly #maxEntries: number;
	readonly #now: () => number;

	constructor(options: MemoryStoreOptions) {
		const { maxEntries } = options;
		if (!Number.isInteger(maxEntries) || maxEntries < 1) {
			throw new RepletesError(
				"invalid-capacity",
				`MemoryStore maxEntries must be an integer >= 1, received ${String(maxEntries)}`
			);
		}
		this.#maxEntries = maxEntries;
		this.#now = options.now ?? Date.now;
	}

	/** How many entries are held right now. Useful in tests, not a policy input. */
	get size(): number {
		return this.#entries.size;
	}

	async get(key: string): Promise<Entry<T> | undefined> {
		const slot = this.#entries.get(key);
		if (slot === undefined) return undefined;

		if (this.#now() > slot.expiresAt) {
			this.#entries.delete(key);
			return undefined;
		}

		this.#entries.delete(key);
		this.#entries.set(key, slot);
		return slot.entry;
	}

	/** Expiry is measured against this store's own clock, not the writer's. */
	async set(key: string, entry: Entry<T>, retainFor: number): Promise<void> {
		this.#entries.delete(key);
		this.#entries.set(key, { entry, expiresAt: this.#now() + retainFor });

		while (this.#entries.size > this.#maxEntries) {
			const oldest = this.#entries.keys().next();
			if (oldest.done === true) break;
			this.#entries.delete(oldest.value);
		}
	}

	async delete(key: string): Promise<void> {
		this.#entries.delete(key);
	}

	async deletePrefix(prefix: string): Promise<void> {
		for (const key of [...this.#entries.keys()]) {
			if (key.startsWith(prefix)) this.#entries.delete(key);
		}
	}

	async clear(): Promise<void> {
		this.#entries.clear();
	}
}
