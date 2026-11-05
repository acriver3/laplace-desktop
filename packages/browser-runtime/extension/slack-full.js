// Runs only in the explicitly approved tab's isolated world. The browser sends
// its own cookies; no cookie API, credential export, or page-to-extension messages.
export async function slackFullAction(method, args, expected, requestedWorkspace) {
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

		const readMethods = [
			"auth.test",
			"users.list",
			"users.info",
			"conversations.list",
			"conversations.info",
			"conversations.members",
			"conversations.history",
			"conversations.replies",
			"conversations.genericInfo",
			"users.conversations",
			"search.all",
			"search.messages",
			"files.info",
			"client.userBoot",
			"client.counts",
			"client.dms",
			"im.list",
			"users.prefs.get",
			"search.modules.channels",
			"usergroups.list",
			"usergroups.users.list",
			"saved.list",
		];
		const writeMethods = [
			"chat.postMessage",
			"reactions.add",
			"reactions.remove",
			"conversations.mark",
			"conversations.leave",
			"conversations.join",
			"conversations.open",
			"conversations.view",
			"usergroups.create",
			"usergroups.update",
			"usergroups.users.update",
			"saved.update",
			"saved.clearCompleted",
		];
		const edgeMethods = ["users/info", "users/list", "users/search", "channels/membership"];
		const api = method.startsWith("api.") ? method.slice(4) : null;
		const edge = method.startsWith("edge.") ? method.slice(5) : null;
		if (
			method !== "account.identify" &&
			method !== "files.download" &&
			!(api && [...readMethods, ...writeMethods].includes(api)) &&
			!(edge && edgeMethods.includes(edge))
		)
			throw Error();
		if (!args || typeof args !== "object") throw Error();
		const allowedFields = new Set([
			...[
				"_x_app_name",
				"_x_mode",
				"_x_reason",
				"_x_sonic",
				"as_admin",
				"browse",
				"browse_session_id",
				"build_version_ts",
				"canonical_avatars",
				"channel",
				"channel_type",
				"channels",
				"check_interaction",
				"client_req_id",
				"count",
				"cursor",
				"date_due",
				"exclude_bots",
				"exclude_my_channels",
				"extra_message_data",
				"extracts",
				"file_title_only",
				"filter",
				"get_latest",
				"get_read_state",
				"highlight",
				"ignore_replies",
				"include_channel",
				"include_closed",
				"include_file_channels",
				"include_files_shares",
				"include_free_team_extra_messages",
				"include_full_users",
				"include_min_version_bump_check",
				"include_mutation_timestamps",
				"include_profile_only_users",
				"include_stories",
				"include_tombstones",
				"include_use_cases",
				"index",
				"item_id",
				"item_type",
				"limit",
				"locale",
				"mark",
				"marker",
				"max_filter_suggestions",
				"min_channel_updated",
				"module",
				"no_members",
				"no_self",
				"no_user_profile",
				"org_wide_aware",
				"page",
				"present_first",
				"query",
				"query_rewrite_disabled",
				"recommend_source",
				"search_context",
				"search_only_my_channels",
				"sort",
				"sort_dir",
				"thread_counts_by_channel",
				"ts",
				"updated_channels",
				"updated_ids",
				"users",
				"version_ts",
			],
			"cursor",
			"limit",
			"channel",
			"channels",
			"ts",
			"oldest",
			"latest",
			"inclusive",
			"include_all_metadata",
			"types",
			"exclude_archived",
			"user",
			"users",
			"query",
			"count",
			"page",
			"sort",
			"sort_dir",
			"highlight",
			"file",
			"token",
			"team_id",
			"pretty",
			"text",
			"thread_ts",
			"reply_broadcast",
			"parse",
			"link_names",
			"unfurl_links",
			"unfurl_media",
			"as_user",
			"username",
			"icon_url",
			"icon_emoji",
			"blocks",
			"attachments",
			"metadata",
			"client_msg_id",
			"name",
			"timestamp",
			"full",
			"include_locale",
			"include_count",
			"include_disabled",
			"include_users",
			"usergroup",
			"description",
			"handle",
			"include_subteam_count",
			"include_inactive",
			"include_single_channel_guests",
			"include_invited_users",
			"include_restricted",
			"include_bots",
			"include_deleted",
			"presence",
			"filter",
			"index",
			"locale",
			"marker",
			"present_first",
			"include_profile_only_users",
			"updated_ids",
			"check_interaction",
			"as_admin",
			"item_type",
			"item_id",
			"mark",
			"date_due",
			"thread_counts_by_channel",
			"org_wide_aware",
			"include_file_channels",
			"include_closed",
			"include_channel",
			"exclude_bots",
			"_x_reason",
			"_x_mode",
			"_x_sonic",
			"_x_app_name",
			"search_only_my_channels",
			"exclude_my_channels",
			"recommend_source",
			"channel_type",
			"search",
			"include_membership",
			"include_num_members",
			"return_im",
			"return_mpim",
			"return_channels",
		]);
		if (
			args.params &&
			(typeof args.params !== "object" ||
				Object.keys(args.params).some(
					(key) =>
						!allowedFields.has(key) || /token|cookie|authorization|password|secret/i.test(key),
				))
		)
			throw Error();
		const call = async (api, parameters, raw = false) => {
			failure = "request_failed";
			const body = new URLSearchParams({ token });
			if (apiTeamId) body.set("team_id", apiTeamId);
			for (const [key, value] of Object.entries(parameters)) {
				if (value === undefined || key === "token" || key === "team_id") continue;
				if (typeof value === "object") {
					body.set(key, JSON.stringify(value));
					continue;
				}
				if (!["string", "number", "boolean"].includes(typeof value)) throw Error();
				if (key === "token" || key === "team_id") continue;
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
					if (length > 24 * 1024 * 1024) throw new Error();
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
			if (result.ok !== true && !raw) {
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
		if (method === "account.identify")
			return { ok: true, result: { workspace, teamId, userId: identity.user_id } };

		if (!expected) throw Error();
		// Check the active workspace again immediately before a write dispatch.
		if (location.pathname.match(/^\/client\/([TE][A-Z0-9]{5,40})(?:\/|$)/)?.[1] !== contextId)
			throw Error();
		if (api === "auth.test")
			return { ok: true, result: { status: 200, contentType: "application/json", body: identity } };
		if (api) {
			failure = writeMethods.includes(api) ? "SAVE_UNVERIFIED" : "request_failed";
			const body = await call(api, args.params || {}, true);
			if (api === "files.info" && body.ok === true && body.file) {
				const key = `${workspace}:${teamId}:${identity.user_id}`;
				const cache = (globalThis.__laplaceSlackDownloads ??= new Map());
				for (const [url, entry] of cache)
					if (entry.expires < Date.now() || entry.identity !== key) cache.delete(url);
				for (const url of [body.file.url_private, body.file.url_private_download]) {
					if (typeof url !== "string") continue;
					if (cache.size >= 128) cache.delete(cache.keys().next().value);
					cache.set(url, { identity: key, expires: Date.now() + 300000 });
				}
			}
			return { ok: true, result: { status: 200, contentType: "application/json", body } };
		}
		let url, init;
		if (edge) {
			const domain = location.hostname.endsWith("slack-gov.com") ? "slack-gov.com" : "slack.com";
			url = `https://edgeapi.${domain}/cache/${teamId}/${edge}`;
			init = {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ ...args.params, token }),
			};
		} else {
			const requested = new URL(args.url);
			const domain = location.hostname.endsWith("slack-gov.com") ? "slack-gov.com" : "slack.com";
			// Only a URL returned by files.info for this approved account can be used.
			// Shared files may belong to another workspace; the account grant is decisive.
			const grant = globalThis.__laplaceSlackDownloads?.get(args.url);
			if (
				!grant ||
				grant.identity !== `${workspace}:${teamId}:${identity.user_id}` ||
				grant.expires < Date.now() ||
				requested.origin !== `https://files.${domain}` ||
				!/^\/files-pri\/[TE][A-Z0-9]+-F[A-Z0-9]+\//.test(requested.pathname) ||
				requested.username ||
				requested.password
			)
				throw Error();
			url = requested.href;
			init = { method: "GET", headers: { Authorization: `Bearer ${token}` } };
		}
		const response = await fetch(url, {
			...init,
			credentials: "include",
			redirect: "error",
			signal: AbortSignal.timeout(90000),
		});
		if (!response.ok)
			return {
				ok: true,
				result: {
					status: response.status,
					contentType: "application/json",
					body: { ok: false, error: "browser_http_error" },
				},
			};
		const reader = response.body.getReader(),
			chunks = [];
		let size = 0;
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				size += value.length;
				if (size > 23 * 1024 * 1024) throw Error();
				chunks.push(value);
			}
		} finally {
			await reader.cancel();
		}
		const bytes = new Uint8Array(size);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.length;
		}
		if (edge)
			return {
				ok: true,
				result: {
					status: 200,
					contentType: "application/json",
					body: JSON.parse(new TextDecoder().decode(bytes)),
				},
			};
		let binary = "";
		for (let i = 0; i < bytes.length; i += 8192)
			binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
		return {
			ok: true,
			result: {
				status: 200,
				contentType: response.headers.get("content-type") || "application/octet-stream",
				base64: btoa(binary),
			},
		};
	} catch {
		return {
			ok: false,
			error:
				method.startsWith("api.") &&
				[
					"chat.postMessage",
					"reactions.add",
					"reactions.remove",
					"conversations.mark",
					"conversations.leave",
					"conversations.join",
					"conversations.open",
					"conversations.view",
					"usergroups.create",
					"usergroups.update",
					"usergroups.users.update",
					"saved.update",
					"saved.clearCompleted",
				].includes(method.slice(4))
					? "SAVE_UNVERIFIED"
					: failure,
		};
	}
}
