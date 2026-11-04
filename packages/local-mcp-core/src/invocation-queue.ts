/** One executor per connector. Cancelled queued work is removed without waiting for its predecessor. */
export class InvocationQueue {
	private active = false;
	private waiting: Array<() => void> = [];
	add<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			const cancel = () => {
				const index = this.waiting.indexOf(run);
				if (index !== -1) this.waiting.splice(index, 1);
				signal.removeEventListener("abort", cancel);
				reject(new Error("Tool call was not started: cancelled while queued"));
			};
			const run = () => {
				signal.removeEventListener("abort", cancel);
				this.active = true;
				void Promise.resolve()
					.then(work)
					.then(resolve, reject)
					.finally(() => {
						this.active = false;
						this.next();
					});
			};
			if (signal.aborted) {
				cancel();
				return;
			}
			this.waiting.push(run);
			signal.addEventListener("abort", cancel, { once: true });
			this.next();
		});
	}
	private next() {
		if (!this.active) this.waiting.shift()?.();
	}
}
