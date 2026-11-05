/** Host adapters supply activity and a maintenance lease covering all local work. */
export interface AutomaticUpdateHost {
	check(signal: AbortSignal): Promise<void>;
	prepare(signal: AbortSignal): Promise<void>;
	ready(): boolean;
	idleSeconds(): number | undefined;
	busy(): boolean;
	acquireMaintenance(): (() => void) | undefined | Promise<(() => void) | undefined>;
	apply(): Promise<void>;
	countdown(deadline: number | undefined): void;
	error(error: unknown): void;
}

export const automaticUpdateTiming = {
	startup: 15_000,
	interval: 6 * 60 * 60 * 1000,
	idleSeconds: 15 * 60,
	countdown: 60_000,
	postpone: 24 * 60 * 60 * 1000,
} as const;

/** No timers or OS calls here: Desktop and CLI drive this with their own lifecycle. */
export class AutomaticUpdates {
	private enabled = false;
	private controller?: AbortController;
	private operation?: Promise<void>;
	private deadline?: number;
	private deferredUntil = 0;
	private nextCheck: number;
	private applying = false;
	private application?: Promise<void>;
	private stopped = false;
	private generation = 0;
	constructor(
		private host: AutomaticUpdateHost,
		private featureEnabled: () => boolean,
		private now: () => number = Date.now,
	) {
		this.nextCheck = now() + automaticUpdateTiming.startup;
	}
	setEnabled(enabled: boolean) {
		this.enabled = enabled;
		if (!enabled) {
			this.generation++;
			this.controller?.abort();
			this.clearCountdown();
		}
	}
	postpone(until = this.now() + automaticUpdateTiming.postpone) {
		this.deferredUntil = until;
		this.clearCountdown();
	}
	resume() {
		this.postpone(Math.max(this.deferredUntil, this.now() + automaticUpdateTiming.countdown));
	}
	private clearCountdown() {
		if (this.deadline === undefined) return;
		this.deadline = undefined;
		this.host.countdown(undefined);
	}
	private allowed() {
		return !this.stopped && this.enabled && this.featureEnabled();
	}
	private idle() {
		const seconds = this.host.idleSeconds();
		return (
			seconds !== undefined &&
			Number.isFinite(seconds) &&
			seconds >= automaticUpdateTiming.idleSeconds &&
			!this.host.busy()
		);
	}
	async tick() {
		if (!this.allowed()) {
			this.controller?.abort();
			this.clearCountdown();
			return;
		}
		if (this.operation || this.applying) return;
		if (this.now() >= this.nextCheck) {
			const controller = new AbortController();
			const generation = this.generation;
			this.controller = controller;
			this.nextCheck = this.now() + automaticUpdateTiming.interval;
			this.operation = (async () => {
				try {
					await this.host.check(controller.signal);
					if (this.allowed() && generation === this.generation && !controller.signal.aborted)
						await this.host.prepare(controller.signal);
				} catch (error) {
					if (!controller.signal.aborted) this.host.error(error);
				}
			})();
			try {
				await this.operation;
			} finally {
				this.operation = undefined;
				this.controller = undefined;
			}
		}
		if (!this.allowed()) return;
		if (!this.host.ready() || this.now() < this.deferredUntil || !this.idle()) {
			this.clearCountdown();
			return;
		}
		if (this.deadline === undefined) {
			this.deadline = this.now() + automaticUpdateTiming.countdown;
			this.host.countdown(this.deadline);
			return;
		}
		if (this.now() < this.deadline) return;
		this.applying = true;
		this.application = (async () => {
			let release: (() => void) | undefined;
			try {
				release = await this.host.acquireMaintenance();
				this.clearCountdown();
				if (release && this.allowed() && this.idle()) await this.host.apply();
			} catch (error) {
				this.postpone();
				this.host.error(error);
			} finally {
				this.applying = false;
				release?.();
			}
		})();
		await this.application;
	}
	async stop() {
		this.stopped = true;
		this.setEnabled(false);
		await this.operation;
		await this.application;
	}
}
