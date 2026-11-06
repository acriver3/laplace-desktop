/**
 * Selects the background Laplace Runtime as the single local owner (default). Setting
 * LAPLACE_UNIFIED_RUNTIME_V1=false restores the Electron-owned helper as a kill switch.
 */
export const unifiedRuntimeEnabled = () => process.env.LAPLACE_UNIFIED_RUNTIME_V1 !== "false";
