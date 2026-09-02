import type { Readable } from 'node:stream';

/** A published port binding: host side is always bound to a specific IP. */
export type PortPublish = { hostIp: string; hostPort: number; containerPort: number };

/**
 * A mount at an in-container path. `volume` is a named docker volume, or an
 * absolute host path for a bind mount (docker's --volume accepts both). Bind a
 * single *file* rather than a directory when the target sits inside a directory
 * the image populates: mounting over such a directory hides the image's copy —
 * a host directory empties it, and a named volume is seeded from the image once
 * and then silently pins that first version across later image upgrades.
 */
export type VolumeMount = { volume: string; target: string; readOnly?: boolean };

export type CreateContainerSpec = {
  /** docker --name; must be unique. */
  name: string;
  image: string;
  /** docker --label key=value pairs (used for discovery during cleanup). */
  labels?: Record<string, string>;
  /** Environment variables injected into the container. */
  env?: Record<string, string>;
  publish?: PortPublish;
  volumes?: VolumeMount[];
  network?: string;
  /** Long-lived PID 1. Defaults to a keep-alive (`sleep infinity`). */
  command?: string[];
};

export type ExecOpts = {
  workdir?: string;
  env?: Record<string, string>;
  /** Allocate an interactive TTY (docker exec -it). For the agent PTY. */
  tty?: boolean;
  /**
   * Run detached (docker exec -d): returns immediately and the process keeps
   * running in the container, reparented to PID 1. For long-lived background
   * processes like the dev-server supervisor.
   */
  detached?: boolean;
  /** Append combined stdout/stderr to this host file. */
  logPath?: string;
  timeoutMs?: number;
};

export type ContainerStatus = {
  exists: boolean;
  running: boolean;
  /** Published host port bound to container port 3000/tcp, if any. Only the
   *  reconcile orphan-adopt path reads this; other callers ignore it. */
  port?: number;
};

export type ContainerSummary = {
  id: string;
  name: string;
  labels: Record<string, string>;
};

export type ContainerManager = {
  /** Create + start a detached container; returns its id. */
  create(spec: CreateContainerSpec): Promise<string>;
  /** Run a one-off command inside a running container. */
  exec(id: string, cmd: string, args: string[], opts?: ExecOpts): Promise<{ exitCode: number }>;
  /**
   * Stream `body` into <workdir>/uploads/ inside the container, resolving name
   * collisions with a numeric suffix. Returns the resolved repo-relative path.
   * Streaming (rather than exec) because uploads are up to 100 MB and must not
   * be buffered in the dashboard's heap.
   */
  writeUpload(id: string, opts: { name: string; body: Readable }): Promise<{ path: string }>;
  inspect(id: string): Promise<ContainerStatus>;
  stop(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  /** List containers, optionally filtered by a `key=value` label. Includes
   *  stopped containers unless `running` is set — crashed forges do linger,
   *  since a probe timeout deliberately keeps the container. */
  list(opts?: { label?: string; running?: boolean }): Promise<ContainerSummary[]>;
  /**
   * Docker's disk consumption. EXPENSIVE: ~17 s on the pilot host, because the
   * daemon walks every image, volume and build-cache record. Callers must
   * rate-limit it (the usage sampler runs it every 30 min, not every tick).
   */
  diskUsage(): Promise<DockerDiskUsage>;
};

/**
 * Docker's own disk accounting, in exact bytes, from the daemon's /system/df.
 * `imagesBytes` is the DEDUPLICATED total (the endpoint's `LayersSize`), not the
 * sum of image sizes, which double-counts shared layers.
 */
export type DockerDiskUsage = {
  imagesBytes: number;
  containersBytes: number;
  volumesBytes: number;
  buildCacheBytes: number;
};
