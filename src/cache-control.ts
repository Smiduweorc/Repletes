import type { Freshness, Windows } from "./types.js";
import { assertWindows } from "./windows.js";

/**
 * Headers as a live `Headers` object or as the flattened pairs an out-of-process
 * store holds. Both have to work: a stored response is JSON, not a `Headers`.
 */
export type HeadersLike =
	| { get(name: string): string | null }
	| readonly (readonly [string, string])[];

/** The least a value has to look like for its `Cache-Control` to be read. */
export interface HasCacheControl {
	headers: HeadersLike;
	status?: number;
}

function headerValue(headers: HeadersLike, name: string): string | null {
	if (typeof (headers as { get?: unknown }).get === "function") {
		return (headers as { get(name: string): string | null }).get(name);
	}

	const found = (headers as readonly (readonly [string, string])[])
		.filter(([field]) => field.toLowerCase() === name)
		.map(([, value]) => value);
	return found.length === 0 ? null : found.join(", ");
}

export interface CacheControlOptions {
	/**
	 * Used when the response says nothing. Every window still has to be a
	 * number you chose; an upstream that is silent is not an upstream that is
	 * telling you zero.
	 */
	fallback: Windows;
	/** Read `s-maxage` and refuse `private`. Defaults to true. */
	shared?: boolean;
	/** Used when the response carries no `stale-while-revalidate`. */
	staleWhileRevalidate?: number;
	/** Used when the response carries no `stale-if-error`. */
	staleIfError?: number;
	/** Which statuses are worth writing down. Defaults to 2xx. */
	storable?: (status: number) => boolean;
}

const SECOND = 1000;

function parse(header: string | null): Map<string, string | true> {
	const directives = new Map<string, string | true>();
	if (!header) return directives;

	for (const part of header.split(",")) {
		const token = part.trim();
		if (token === "") continue;
		const eq = token.indexOf("=");
		if (eq === -1) {
			directives.set(token.toLowerCase(), true);
			continue;
		}
		const name = token.slice(0, eq).trim().toLowerCase();
		const raw = token.slice(eq + 1).trim();
		directives.set(name, raw.replace(/^"|"$/g, ""));
	}
	return directives;
}

function seconds(
	directives: Map<string, string | true>,
	name: string
): number | undefined {
	const raw = directives.get(name);
	if (typeof raw !== "string") return undefined;
	const value = Number(raw);
	if (!Number.isFinite(value) || value < 0) return undefined;
	return value * SECOND;
}

/**
 * Freshness read from response headers, for servers worth trusting.
 *
 * Reads `no-store`, `no-cache`, `private`, `max-age`, `s-maxage`,
 * `stale-while-revalidate` and `stale-if-error`. Everything else in RFC 9111 is
 * out of scope. Returns `undefined`, declining the write, for `no-store`, for
 * `private` on a shared cache, and for a status the caller did not call
 * storable.
 */
export function fromCacheControl<T extends HasCacheControl>(
	options: CacheControlOptions
): Freshness<T> {
	const fallback = assertWindows(options.fallback);
	const shared = options.shared ?? true;
	const storable = options.storable ?? ((status: number) => status >= 200 && status < 300);

	return (value: T): Windows | undefined => {
		if (typeof value.status === "number" && !storable(value.status)) {
			return undefined;
		}

		const directives = parse(headerValue(value.headers, "cache-control"));
		if (directives.has("no-store")) return undefined;
		if (shared && directives.has("private")) return undefined;

		const lifetime = shared
			? (seconds(directives, "s-maxage") ?? seconds(directives, "max-age"))
			: seconds(directives, "max-age");

		// RFC 9111 5.2.2.4: a no-cache response is never used without a
		// successful revalidation, so nothing may be served while a refresh runs.
		// Only the response's own stale-if-error can permit serving it stale
		// (4.2.4); the caller's defaults cannot.
		if (directives.has("no-cache")) {
			return assertWindows({
				freshFor: 0,
				staleWhileRevalidate: 0,
				staleIfError: seconds(directives, "stale-if-error") ?? 0,
			});
		}

		return assertWindows({
			freshFor: lifetime ?? fallback.freshFor,
			staleWhileRevalidate:
				seconds(directives, "stale-while-revalidate") ??
				options.staleWhileRevalidate ??
				fallback.staleWhileRevalidate,
			staleIfError:
				seconds(directives, "stale-if-error") ??
				options.staleIfError ??
				fallback.staleIfError,
		});
	};
}
