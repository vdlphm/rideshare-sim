export interface UpstreamErrorInit {
  service: string;
  method: string;
  path: string;
  status: number;
  body?: unknown;
}

/** Thrown by HttpClient when an upstream service returns a non-2xx final response. */
export class UpstreamError extends Error {
  readonly service: string;
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly body?: unknown;

  constructor(init: UpstreamErrorInit) {
    super(`${init.method} ${init.service}${init.path} failed with status ${init.status}`);
    this.name = 'UpstreamError';
    this.service = init.service;
    this.method = init.method;
    this.path = init.path;
    this.status = init.status;
    this.body = init.body;
  }
}
