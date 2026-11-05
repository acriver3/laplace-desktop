import { z } from "zod";

/** Control API generation spoken between the Laplace Runtime and its Desktop/CLI clients. */
export const LOCAL_RUNTIME_PROTOCOL = 1;
export const localRuntimeDescriptorFile = "runtime.json";

/** Written beside endpoint.json (0600) while a runtime service owns the profile. */
export const localRuntimeDescriptor = z
	.object({
		version: z.literal(1),
		protocol: z.number().int().positive(),
		pid: z.number().int().positive(),
		control: z
			.string()
			.url()
			.refine((value) => {
				const url = new URL(value);
				return (
					url.protocol === "http:" &&
					url.hostname === "127.0.0.1" &&
					url.pathname === "/control/v1/" &&
					!url.username &&
					!url.password &&
					!url.search &&
					!url.hash
				);
			}),
		token: z.string().min(32).max(100),
	})
	.strict();
export type LocalRuntimeDescriptor = z.infer<typeof localRuntimeDescriptor>;
