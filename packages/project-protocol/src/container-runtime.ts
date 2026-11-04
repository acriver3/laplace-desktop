import { z } from "zod";

export const CONTAINER_RUNTIME = "cloudflare-containers";
export const containerEnvironment = z.enum(["preview", "production"]);
const path = z
	.string()
	.max(240)
	.refine(
		(value) =>
			value === "." ||
			(/^[A-Za-z0-9_./-]+$/.test(value) &&
				!value.startsWith("/") &&
				!value.split("/").includes("..")),
		"Use a relative repository path",
	);
const envName = z.string().regex(/^[A-Z][A-Z0-9_]{0,99}$/);
export const containerConfigSchema = z
	.object({
		dockerfile: path.default("Dockerfile"),
		context: path.default("."),
		// Optional isolated Python environment for a repository's existing pyproject.toml.
		pythonProject: path.optional(),
		// Optional Node browser geometry globals from the image's existing native Canvas package.
		canvasModuleRoot: z
			.string()
			.regex(/^\/[A-Za-z0-9_./-]+$/)
			.refine((value) => !value.split("/").includes(".."))
			.optional(),
		image: z
			.string()
			.regex(/^[a-z0-9./:_-]+@sha256:[a-f0-9]{64}$/)
			.optional(),
		port: z.number().int().min(1).max(65535).default(3000),
		releaseEnvironment: z.enum(["preview", "staging", "production"]).optional(),
		healthPath: z
			.string()
			.regex(/^\/[A-Za-z0-9_./-]*$/)
			.max(240)
			.default("/"),
		instanceType: z
			.enum(["lite", "basic", "standard-1", "standard-2", "standard-3", "standard-4"])
			.default("standard-1"),
		maxInstances: z.number().int().min(1).max(10).default(1),
		idleTimeoutSeconds: z.number().int().min(30).max(86400).default(120),
		startupTimeoutSeconds: z.number().int().min(10).max(180).default(60),
		readinessCommand: z.array(z.string().min(1).max(4000)).max(32).default([]),
		keepAlive: z.boolean().default(false),
		// Only public build values. Sensitive build inputs use BuildKit secret mounts.
		buildArgs: z.record(envName, z.string().max(4000)).default({}),
		buildSecrets: z
			.record(z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/), z.string().min(1).max(200))
			.default({}),
		// Values are Secret Manager IDs, never plaintext secrets.
		secrets: z.record(envName, z.string().min(1).max(200)).default({}),
		secretProjectId: z.string().min(1).max(200).optional(),
		publicEnv: z.record(envName, z.string().max(4000)).default({}),
		// Public URL variables compiled by frameworks must match this immutable deployment.
		originEnv: z.array(envName).max(10).default([]),
		staticDirectory: path.optional(),
		staticImageDirectories: z
			.record(
				z.string().regex(/^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$|^$/),
				z
					.string()
					.regex(/^\/[A-Za-z0-9_./-]+$/)
					.refine((value) => !value.split("/").includes("..")),
			)
			.default({}),
	})
	.strict();
export type ContainerConfig = z.infer<typeof containerConfigSchema>;
export type ContainerEnvironment = z.infer<typeof containerEnvironment>;
export const containerDeploymentSchema = z.object({
	id: z.string().uuid(),
	environment: containerEnvironment,
	commit: z.string().regex(/^[a-f0-9]{40}$/),
	repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
	config: containerConfigSchema,
	status: z.enum(["queued", "building", "ready", "failed"]),
	createdBy: z.string(),
	createdAt: z.string(),
	lease: z.string().optional(),
	leaseExpiresAt: z.number().optional(),
	image: z.string().optional(),
	origin: z.string().url().optional(),
	worker: z.string().optional(),
	logs: z.array(z.string().max(2000)).max(100).default([]),
});
export type ContainerDeployment = z.infer<typeof containerDeploymentSchema>;
export const containerStateSchema = z.object({
	version: z.literal(1),
	previousRuntime: z.string(),
	configs: z.object({
		preview: containerConfigSchema.optional(),
		production: containerConfigSchema.optional(),
	}),
	active: z.object({ preview: z.string().optional(), production: z.string().optional() }),
	deployments: z.array(containerDeploymentSchema).max(50),
});
export type ContainerState = z.infer<typeof containerStateSchema>;

/** Conservative recommendation only; importing never allocates a container. */
export function assessContainerRuntime(files: Record<string, string>) {
	const reasons = new Set<string>();
	for (const [name, source] of Object.entries(files)) {
		if (/(^|\/)Dockerfile(?:\.[^/]+)?$/.test(name)) reasons.add("Existing Dockerfile");
		if (/\.(py|node)$/.test(name) || /(^|\/)(requirements[^/]*\.txt|pyproject\.toml)$/.test(name))
			reasons.add("Python or native binaries");
		if (/(^|\/)package\.json$/.test(name)) {
			try {
				const pkg = JSON.parse(source) as {
					dependencies?: Record<string, string>;
					devDependencies?: Record<string, string>;
				};
				const deps = { ...pkg.dependencies, ...pkg.devDependencies };
				for (const dependency of [
					"next",
					"sharp",
					"canvas",
					"better-sqlite3",
					"puppeteer",
					"playwright",
					"@prisma/client",
					"onnxruntime-node",
					"pdf-to-img",
				])
					if (deps[dependency]) reasons.add(`Requires ${dependency}`);
			} catch {
				/* A malformed manifest is reported by the source build. */
			}
		}
		if (
			/\.[cm]?[jt]sx?$/.test(name) &&
			/(?:node:)?(?:child_process|worker_threads)|process\.binding\s*\(/.test(source)
		)
			reasons.add("Full Node.js process APIs");
	}
	return {
		recommendedRuntime: reasons.size ? CONTAINER_RUNTIME : null,
		reasons: [...reasons],
		requiresSelection: true,
	};
}
