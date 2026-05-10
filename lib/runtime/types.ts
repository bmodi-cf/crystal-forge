export type RuntimeStatus =
  | 'starting'
  | 'running'
  | 'stopping'
  | 'crashed'
  | 'setup-failed';

export type RuntimeStateEntry = {
  forgeId: string;
  slug: string;
  status: RuntimeStatus;
  pid: number;
  port: number;
  startedAt: string; // ISO
  logPath: string;
  setupError?: string;
};

/** Public-facing entry: same shape but `pid` is omitted when the viewer cannot write the forge. */
export type RuntimeStateView = Omit<RuntimeStateEntry, 'pid'> & { pid?: number };

/**
 * On-disk shape of state.json — a flat map of forgeId → entry, exactly as
 * the spec describes. Stopped forges are represented by absence.
 */
export type RuntimeStateFile = Record<string, RuntimeStateEntry>;
