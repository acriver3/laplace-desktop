/** Explicit or unexpected stops are reported to AI clients; bridges never restart them. */
export class RuntimeStoppedError extends Error {
	constructor(unexpected = false) {
		super(
			unexpected
				? "Laplace Runtime stopped unexpectedly. Start it from Laplace Desktop or run `laplace-runtime start`; calls were not replayed."
				: "Laplace Runtime is stopped. Start it from Laplace Desktop or run `laplace-runtime start`.",
		);
	}
}
