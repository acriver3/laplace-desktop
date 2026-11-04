export type BridgeLink<T> = { client: T; closed: Promise<unknown>; close(): Promise<void> };

/** Reconnect discovery/subscriptions, never the caller's operation. No helper session is reserved. */
export class BridgeConnection<T> {
	private pending?: Promise<BridgeLink<T>>;
	private stopped = false;
	private timer?: ReturnType<typeof setTimeout>;
	private delay = 250;

	constructor(
		private readonly connect: () => Promise<BridgeLink<T>>,
		private readonly changed = () => {},
	) {}

	async ready(): Promise<T> {
		if (this.stopped) throw new Error("Laplace Desktop bridge is closed");
		if (!this.pending) {
			clearTimeout(this.timer);
			this.timer = undefined;
			const pending = this.connect();
			this.pending = pending;
			void pending.then(
				async (link) => {
					if (this.stopped || this.pending !== pending) {
						await link.close();
						return;
					}
					this.delay = 250;
					this.changed();
					void link.closed.then(async () => {
						if (this.pending !== pending) return;
						this.pending = undefined;
						await link.close();
						this.schedule();
					});
				},
				() => {
					if (this.pending === pending) {
						this.pending = undefined;
						this.schedule();
					}
				},
			);
		}
		const link = await this.pending;
		if (this.stopped) throw new Error("Laplace Desktop bridge is closed");
		return link.client;
	}
	private schedule() {
		if (this.stopped || this.timer) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			void this.ready().catch(() => {});
		}, this.delay);
		this.delay = Math.min(this.delay * 2, 5000);
		this.timer.unref();
	}
	async close() {
		if (this.stopped) return;
		this.stopped = true;
		clearTimeout(this.timer);
		const pending = this.pending;
		this.pending = undefined;
		await pending?.then((link) => link.close()).catch(() => {});
	}
}
