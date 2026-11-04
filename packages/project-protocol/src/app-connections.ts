import { Validator } from "@cfworker/json-schema";
import { z } from "zod";

export const APP_TOOLS_PATH = "/__laplace/tools";
export const APP_TOOL_INPUT_LIMIT = 65536;
export const APP_TOOL_OUTPUT_LIMIT = 524288;
const schemaTypes = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);

/** Check schema structure before publishing a catalog; the interpreter owns input validation. */
export function validAppToolSchema(schema: unknown, depth = 0): boolean {
	if (typeof schema === "boolean") return true;
	if (!schema || typeof schema !== "object" || Array.isArray(schema) || depth > 50) return false;
	const value = schema as Record<string, unknown>;
	if (value.type !== undefined) {
		const types = Array.isArray(value.type) ? value.type : [value.type];
		if (!types.length || types.some((type) => typeof type !== "string" || !schemaTypes.has(type)))
			return false;
	}
	if (value.$ref !== undefined && (typeof value.$ref !== "string" || !value.$ref.startsWith("#")))
		return false;
	if (
		value.required !== undefined &&
		(!Array.isArray(value.required) ||
			value.required.some((item) => typeof item !== "string") ||
			new Set(value.required).size !== value.required.length)
	)
		return false;
	if (value.enum !== undefined && (!Array.isArray(value.enum) || !value.enum.length)) return false;
	for (const key of [
		"minimum",
		"maximum",
		"exclusiveMinimum",
		"exclusiveMaximum",
		"multipleOf",
		"minLength",
		"maxLength",
		"minItems",
		"maxItems",
		"minProperties",
		"maxProperties",
		"minContains",
		"maxContains",
	]) {
		if (
			value[key] !== undefined &&
			(typeof value[key] !== "number" || !Number.isFinite(value[key]))
		)
			return false;
		if (typeof value[key] === "number") {
			if (key === "multipleOf" && value[key] <= 0) return false;
			if (
				/^(min|max)(Length|Items|Properties|Contains)$/.test(key) &&
				(!Number.isInteger(value[key]) || value[key] < 0)
			)
				return false;
		}
	}
	if (value.uniqueItems !== undefined && typeof value.uniqueItems !== "boolean") return false;
	for (const key of [
		"properties",
		"patternProperties",
		"$defs",
		"definitions",
		"dependentSchemas",
	]) {
		const children = value[key];
		if (children === undefined) continue;
		if (
			!children ||
			typeof children !== "object" ||
			Array.isArray(children) ||
			Object.values(children).some((child) => !validAppToolSchema(child, depth + 1))
		)
			return false;
	}
	for (const key of ["allOf", "anyOf", "oneOf"]) {
		if (
			value[key] !== undefined &&
			(!Array.isArray(value[key]) ||
				!value[key].length ||
				value[key].some((child) => !validAppToolSchema(child, depth + 1)))
		)
			return false;
	}
	for (const key of [
		"additionalProperties",
		"additionalItems",
		"contains",
		"propertyNames",
		"not",
		"if",
		"then",
		"else",
		"unevaluatedProperties",
		"unevaluatedItems",
	]) {
		if (value[key] !== undefined && !validAppToolSchema(value[key], depth + 1)) return false;
	}
	if (
		value.items !== undefined &&
		!(Array.isArray(value.items)
			? value.items.every((child) => validAppToolSchema(child, depth + 1))
			: validAppToolSchema(value.items, depth + 1))
	)
		return false;
	if (value.pattern !== undefined) {
		if (typeof value.pattern !== "string") return false;
		try {
			new RegExp(value.pattern);
		} catch {
			return false;
		}
	}
	return true;
}
export const appToolSchema = z
	.object({
		name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/),
		description: z.string().min(1).max(2000),
		inputSchema: z
			.record(z.string(), z.unknown())
			.refine(
				(schema) => schema.type === "object" && validAppToolSchema(schema),
				"Tool input must be a valid object JSON Schema with local references",
			),
		readOnly: z.boolean().default(false),
	})
	.strict();
export const appToolCatalogSchema = z
	.object({ tools: z.array(appToolSchema).max(100) })
	.strict()
	.refine(
		({ tools }) => new Set(tools.map((tool) => tool.name)).size === tools.length,
		"Duplicate tool names",
	);
export type AppTool = z.infer<typeof appToolSchema>;
export const appToolRuntimeSchema = z
	.object({
		appId: z.string().uuid(),
		actor: z
			.object({
				userId: z.string().min(1),
				organizationId: z.string().min(1),
				sessionId: z.string().optional(),
				sourceAppId: z.string().uuid().optional(),
				environment: z.enum(["preview", "live"]).optional(),
			})
			.strict(),
		operation: z.enum(["catalog", "call"]),
		connectionId: z.string().uuid().optional(),
		reviewConnectionId: z.string().uuid().optional(),
		toolName: appToolSchema.shape.name.optional(),
		input: z.record(z.string(), z.unknown()).default({}),
	})
	.strict()
	.refine(
		(request) => request.operation !== "call" || (!!request.connectionId && !!request.toolName),
		"Calls require a connection and tool name",
	);
export type AppToolRuntimeRequest = z.infer<typeof appToolRuntimeSchema>;
export type AppConnectionActor = AppToolRuntimeRequest["actor"];

export function appConnectionService(appId: string) {
	return `laplace_app_${z.string().uuid().parse(appId).replaceAll("-", "")}`;
}

// Schema validation runs without eval so it also works in the Workers runtime.
export function validateAppToolInput(tool: AppTool, input: Record<string, unknown>) {
	const validator = new Validator(tool.inputSchema);
	if (!validator.validate(input).valid) throw new Error("Tool input does not match its schema.");
}

export async function readAppToolJson(
	response: Response,
	limit = APP_TOOL_OUTPUT_LIMIT,
): Promise<unknown> {
	if (!response.ok || response.status === 101) throw new Error("App tool runtime unavailable.");
	const reader = response.body?.getReader();
	if (!reader) throw new Error("App tool returned no JSON.");
	const chunks: Uint8Array[] = [];
	let size = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > limit) {
			await reader.cancel();
			throw new Error("App tool response too large.");
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.length;
	}
	return JSON.parse(new TextDecoder().decode(bytes));
}

/** Bound the entire discovery/validation/invocation so app code cannot hold publication forever. */
export async function withAppToolTimeout<T>(
	run: (signal: AbortSignal) => Promise<T>,
	timeoutMs = 20_000,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const controller = new AbortController();
	try {
		return await Promise.race([
			run(controller.signal),
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => {
					const error = new Error("App tool timed out");
					controller.abort(error);
					reject(error);
				}, timeoutMs);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

export const APP_CONNECTION_GUIDELINES = `To expose this app as a Laplace connection, implement GET /__laplace/tools returning {tools:[{name,description,inputSchema,readOnly}]}. Use unique names starting with a letter and containing only letters, digits, underscores or hyphens. inputSchema must be an object JSON Schema. Declare readOnly:true only for tools with no data changes or external side effects; omitted readOnly means write access. Implement POST /__laplace/tools/<name> accepting a JSON object and returning JSON. These routes are reserved for the authenticated connection broker and must work without browser cookies. Never expose credentials or generic SQL execution. Publish the app, then use Add to Connections and obtain receiving-organization admin approval. Preview tools are never used by connections.`;
