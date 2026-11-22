/**
 * Why repletes refused. Every one is a caller mistake caught at a boundary, so
 * the fix belongs in your code rather than in a retry.
 */
export type RepletesErrorCode =
	| "invalid-windows"
	| "invalid-key"
	| "invalid-namespace"
	| "invalid-capacity"
	| "clear-unsupported";

/**
 * Everything repletes throws, so a consumer can tell our refusal from their own
 * bad argument without matching on message text.
 *
 * It extends `TypeError` because every case is an argument of the wrong type or
 * the wrong shape.
 */
export class RepletesError extends TypeError {
	override readonly name = "RepletesError";
	readonly code: RepletesErrorCode;

	constructor(code: RepletesErrorCode, message: string) {
		super(`repletes: ${message}`);
		this.code = code;
	}
}
