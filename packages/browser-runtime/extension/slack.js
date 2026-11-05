// Runs only in the explicitly approved tab's isolated world. The browser sends
// its own cookies; no cookie API, credential export, or page-to-extension messages.
export async function slackRead(method, args, expected, requestedWorkspace) {
	let retryAfterMs;

	let failure = "not_slack_tab";
	try {
		if (
			location.protocol !== "https:" ||
			!/^(?:[a-z0-9-]+\.)?(?:slack\.com|slack-gov\.com)$/.test(location.hostname)
		)
			throw new Error();
		failure = "workspace_tab_required";
		const contextId = location.pathname.match(/^\/client\/([TE][A-Z0-9]{5,40})(?:\/|$)/)?.[1];
		if (!contextId) throw new Error();
		const desired = requestedWorkspace || expected?.workspace;
		if (!desired || !/^https:\/\/[a-z0-9-]+\.(?:slack\.com|slack-gov\.com)$/.test(desired))
			throw new Error();
		failure = "session_unavailable";
		const teams = JSON.parse(localStorage.getItem("localConfig_v2") || "{}").teams || {};
		// Enterprise URLs identify an organization (E...), not a workspace (T...).
		// Use only the active context or a unique, explicitly requested workspace.
		// Slack's authenticated response below remains the source of identity.
		const matches = Object.entries(teams).filter(
			([id, team]) =>
				/^T[A-Z0-9]{5,40}$/.test(id) &&
				team &&
				typeof team === "object" &&
				(team.url === desired ||
					team.url === desired + "/" ||
					team.domain === new URL(desired).hostname.split(".")[0]),
		);
		const selectedId = contextId.startsWith("T")
			? contextId
			: matches.length === 1
				? matches[0][0]
				: contextId;
		const token = teams[selectedId]?.token || teams[contextId]?.token;
		if (typeof token !== "string" || !token.startsWith("xoxc-")) throw new Error();
		let apiTeamId = selectedId.startsWith("T") ? selectedId : undefined;
		failure = "invalid_request";
		const allowed = {
			"auth.test": [],
			"conversations.list": ["cursor", "limit"],
			"conversations.history": ["channel", "cursor", "limit"],
			"conversations.replies": ["channel", "ts", "cursor", "limit"],
			"search.messages": ["query", "count", "page"],
		};
		if (
			!Object.hasOwn(allowed, method) ||
			!args ||
			typeof args !== "object" ||
			Object.keys(args).some((key) => !allowed[method].includes(key))
		)
			throw new Error();
		const call = async (api, parameters) => {
			failure = "request_failed";
			const body = new URLSearchParams({ token });
			if (apiTeamId) body.set("team_id", apiTeamId);
			for (const [key, value] of Object.entries(parameters)) {
				if (value === undefined) continue;
				if (typeof value !== "string" && typeof value !== "number") {
					failure = "invalid_request";
					throw new Error();
				}
				body.set(key, String(value));
			}
			const response = await fetch(`${location.origin}/api/${api}`, {
				method: "POST",
				credentials: "include",
				redirect: "error",
				body,
				signal: AbortSignal.timeout(15000),
			});
			if (!response.ok) {
				if (response.status === 429) {
					failure = "rate_limited";
					const retry = response.headers.get("retry-after");
					const ms = retry
						? /^\d+(?:\.\d+)?$/.test(retry)
							? Number(retry) * 1000
							: Date.parse(retry) - Date.now()
						: NaN;
					if (Number.isFinite(ms)) retryAfterMs = Math.max(0, ms);
				}
				throw new Error();
			}
			failure = "invalid_response";
			const reader = response.body.getReader();
			let length = 0;
			const chunks = [];
			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					length += value.length;
					if (length > 1024 * 1024) throw new Error();
					chunks.push(value);
				}
			} finally {
				await reader.cancel();
			}
			const bytes = new Uint8Array(length);
			let offset = 0;
			for (const chunk of chunks) {
				bytes.set(chunk, offset);
				offset += chunk.length;
			}
			const result = JSON.parse(new TextDecoder().decode(bytes));
			if (result.ok !== true) {
				failure = [
					"invalid_auth",
					"not_authed",
					"token_expired",
					"token_revoked",
					"account_inactive",
				].includes(result.error)
					? "session_expired"
					: result.error === "ratelimited"
						? "rate_limited"
						: "provider_denied";
				throw new Error();
			}
			return result;
		};
		const identity = await call("auth.test", {});
		failure = "identity_mismatch";
		const teamId = identity.team_id;
		const workspaceUrl = new URL(identity.url);
		const workspace = workspaceUrl.origin;
		if (
			workspaceUrl.username ||
			workspaceUrl.password ||
			!/^https:\/\/[a-z0-9-]+\.(?:slack\.com|slack-gov\.com)$/.test(workspace) ||
			!/^[TE][A-Z0-9]{5,40}$/.test(teamId) ||
			(contextId !== teamId &&
				!(contextId.startsWith("E") && identity.enterprise_id === contextId)) ||
			(selectedId.startsWith("T") && selectedId !== teamId) ||
			!/^[UW][A-Z0-9]{5,40}$/.test(identity.user_id) ||
			(expected && (expected.teamId !== teamId || expected.userId !== identity.user_id))
		)
			throw new Error();
		failure = "workspace_mismatch";
		if (workspace !== desired || (expected && expected.workspace !== workspace)) throw new Error();
		// Every subsequent read is scoped to the verified workspace where available.
		apiTeamId = teamId.startsWith("T") ? teamId : undefined;
		if (method === "auth.test")
			return { ok: true, result: { workspace, teamId, userId: identity.user_id } };
		const raw = await call(method, args);
		// Explicit projections prevent new Slack API fields from becoming a credential channel.
		const message = (m) => ({
			text: typeof m.text === "string" ? m.text.slice(0, 40000) : "",
			user: m.user,
			ts: m.ts,
			thread_ts: m.thread_ts,
			reply_count: m.reply_count,
			channel:
				typeof m.channel === "object" ? { id: m.channel.id, name: m.channel.name } : m.channel,
		});
		const result =
			method === "conversations.list"
				? {
						channels: (raw.channels || []).slice(0, 100).map((c) => ({
							id: c.id,
							name: c.name,
							is_private: c.is_private,
							is_member: c.is_member,
							is_archived: c.is_archived,
						})),
						next_cursor: raw.response_metadata?.next_cursor,
					}
				: method === "search.messages"
					? {
							messages: (raw.messages?.matches || []).slice(0, 100).map(message),
							total: raw.messages?.total,
							paging: raw.messages?.paging,
						}
					: {
							messages: (raw.messages || []).slice(0, 100).map(message),
							has_more: raw.has_more,
							next_cursor: raw.response_metadata?.next_cursor,
						};
		return { ok: true, result };
	} catch {
		return { ok: false, error: failure, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
	}
}
