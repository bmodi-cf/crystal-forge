/** A published port binding: host side is always bound to a specific IP. */
export type PortPublish = { hostIp: string; hostPort: number; containerPort: number };

/** A volume mount: a named docker volume mounted at an in-container path. */
export type VolumeMount = { volume: string; target: string };

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
  inspect(id: string): Promise<ContainerStatus>;
  stop(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  /** List containers, optionally filtered by a `key=value` label. */
  list(opts?: { label?: string }): Promise<ContainerSummary[]>;
};
