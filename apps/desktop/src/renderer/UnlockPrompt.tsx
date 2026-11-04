import { useState } from "react";

import { Modal } from "./Dialogs";
import { invoke } from "./types";

export function UnlockPrompt({ close }: { close: () => void }) {
	const [password, setPassword] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	return (
		<Modal title="Unlock Bitwarden" close={close}>
			<form
				className="dialog-body stack"
				onSubmit={async (e) => {
					e.preventDefault();
					if (busy || !password) return;
					setBusy(true);
					setError("");
					const value = password;
					setPassword("");
					try {
						const result = await invoke<{ error?: unknown }>("credentials.unlock", {
							password: value,
						});
						if (result?.error) throw Error();
						close();
					} catch {
						setError("Could not unlock Bitwarden. Check your master password and try again.");
					} finally {
						setBusy(false);
					}
				}}
			>
				<p>Your connection request stays open in chat. This password stays on this computer.</p>
				<label>
					Master password
					<input
						autoFocus
						autoComplete="off"
						type="password"
						value={password}
						onChange={(e) => setPassword(e.target.value)}
					/>
				</label>
				{error && <p role="alert">{error}</p>}
				<button className="primary" disabled={busy || !password}>
					{busy ? "Unlocking…" : "Unlock and continue"}
				</button>
				<p className="small muted">
					Unlocks for up to 15 minutes. Return to your chat after unlocking.
				</p>
			</form>
		</Modal>
	);
}
