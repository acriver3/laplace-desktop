import { z } from "zod";
export const mcpInvocationSchema = z
	.object({
		agent_session_id: z.string().min(1).max(200),
		completion: z.enum(["wait", "background"]),
		deadline: z.number().int().positive().optional(),
		authority_origin: z.string().url().optional(),
	})
	.strict();
export type McpInvocation = z.infer<typeof mcpInvocationSchema>;
