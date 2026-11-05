/** Selects the background Laplace Runtime as the single local owner. Disabled by default. */
export const unifiedRuntimeEnabled = () => process.env.LAPLACE_UNIFIED_RUNTIME_V1 === "true";
