// Shared public descriptors. Execution and account authorization stay in the hosted API.
export const mcpTools = [
	{
		name: "list_accounts",
		description:
			"List the Personal and Work accounts authorized for this MCP connection. Use accountId to choose an account for actions.",
		inputSchema: { type: "object", properties: {} },
	},
	{
		name: "list_apps",
		description:
			"List provider apps and published Laplace app connections across authorized accounts. Optionally filter by accountId.",
		inputSchema: {
			type: "object",
			properties: {
				accountId: { type: "string", description: "Account id from list_accounts." },
				query: {
					type: "string",
					description: "Optional case-insensitive app name, service, or category filter.",
				},
			},
		},
	},
	{
		name: "list_connections",
		description:
			"List connections across authorized accounts, including accountId when multiple accounts are authorized. Never returns credentials.",
		inputSchema: {
			type: "object",
			properties: {
				accountId: { type: "string", description: "Optional account id from list_accounts." },
				source: {
					type: "string",
					enum: ["all", "cloud"],
					description:
						"Default all. Use cloud to read saved cloud connections independently of Desktop availability.",
				},
				service: {
					type: "string",
					description: "Optional provider service id such as github or gmail.",
				},
			},
		},
	},
	{
		name: "get_connection_setup",
		description:
			"Get authentication methods and required credential fields for a provider or custom hosted MCP. Owners/admins only. Never returns credentials.",
		inputSchema: {
			type: "object",
			properties: {
				accountId: {
					type: "string",
					description: "Required when multiple accounts are authorized.",
				},
				service: { type: "string", description: "Catalog service ID, or custom_mcp." },
			},
			required: ["service"],
			additionalProperties: false,
		},
	},
	{
		name: "add_connection",
		description:
			"Add or refresh a hosted connection as an owner/admin. Use get_connection_setup first. Supply credentials directly or omit values for user setup. OAuth requires user consent; never approve on their behalf. Reuse the same idempotencyKey for retries and check get_connection_request before starting again. The verified provider account determines reuse.",
		inputSchema: {
			type: "object",
			properties: {
				accountId: { type: "string" },
				service: { type: "string" },
				authType: {
					type: "string",
					enum: ["api_key", "custom_credential", "oauth2"],
					description: "Required when multiple authentication methods are supported.",
				},
				values: {
					type: "object",
					additionalProperties: { type: "string" },
					description:
						"Credential fields from get_connection_setup. Never include these in links, source code, or logs.",
				},
				idempotencyKey: { type: "string", minLength: 1, maxLength: 200 },
			},
			required: ["service", "idempotencyKey"],
			additionalProperties: false,
		},
	},
	{
		name: "get_connection_request",
		description:
			"Check a connection setup request started by this MCP session. Report success only when status is connected. Returns canonical connection metadata after account reuse or creation.",
		inputSchema: {
			type: "object",
			properties: { accountId: { type: "string" }, requestId: { type: "string", format: "uuid" } },
			required: ["requestId"],
			additionalProperties: false,
		},
	},

	{
		name: "search_actions",
		description:
			"Search provider actions and authorized published app tools. Execution requires a permitted connection.",
		inputSchema: {
			type: "object",
			properties: {
				connectionName: {
					type: "string",
					description:
						"Use a permitted connection from list_connections to search its backend contracts.",
				},
				accountId: { type: "string", description: "Optional account id from list_accounts." },
				query: {
					type: "string",
					description: "Search text matched against action id, name, and description.",
				},
				service: { type: "string", description: "Optional provider service id." },
				limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
			},
		},
	},
	{
		name: "get_action_guide",
		description: "Return one action's input shape and description before execute_action.",
		inputSchema: {
			type: "object",
			properties: {
				connectionName: {
					type: "string",
					description:
						"Connection from search_actions/list_connections; required when backend contracts differ.",
				},
				accountId: {
					type: "string",
					description:
						"Account id from list_accounts. Required for app tools when multiple accounts are authorized.",
				},
				actionId: {
					type: "string",
					description: "Full action id, for example github.get_current_user.",
				},
			},
			required: ["actionId"],
		},
	},
	{
		name: "execute_action",
		description:
			"Execute an action in an authorized account. For multiple accounts, specify accountId or an owned connectionName from list_connections. Specify connectionName when multiple connections match.",
		inputSchema: {
			type: "object",
			properties: {
				accountId: { type: "string", description: "Account id from list_accounts." },
				actionId: { type: "string" },
				input: { type: "object", additionalProperties: true },
				connectionName: { type: "string" },
			},
			required: ["actionId"],
		},
	},
	{
		name: "connect_cloud_apps",
		description:
			"Request app-building access. Returns a five-minute approval link and a private authorizationId. Ask the user to approve; never approve on their behalf.",
		inputSchema: {
			type: "object",
			properties: {
				accountId: {
					type: "string",
					description:
						"Account id from list_accounts. Required when multiple accounts are authorized.",
				},
			},
		},
	},
	{
		name: "manage_cloud_app",
		description:
			"Create, read, save, deploy, and publish team apps after connect_cloud_apps approval. Enabled organizations can manage optional imported-app runtimes. Cannot change sharing, vault secrets, or connection grants.",
		inputSchema: {
			type: "object",
			properties: {
				accountId: {
					type: "string",
					description:
						"Account id from list_accounts. Must match the separately approved app access.",
				},
				operation: {
					type: "string",
					enum: ["guide", "list", "create", "get", "save", "deploy", "publish", "runtime"],
				},
				authorizationId: { type: "string" },
				input: { type: "object", additionalProperties: true },
			},
			required: ["operation"],
		},
	},
] as const;
