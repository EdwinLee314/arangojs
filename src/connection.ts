import { ArangoError, HttpError } from "./error";
import createRequest, {
  ArangojsResponse,
  RequestFunction,
  isBrowser
} from "./util/request";

import { Errback } from "./util/types";
import Route from "./route";
import byteLength from "./util/bytelength";
import qs from "querystring";

const MIME_JSON = /\/(json|javascript)(\W|$)/;

type Task = {
  host?: string;
  resolve: Function;
  reject: Function;
  run: (
    request: RequestFunction,
    host: string | undefined,
    callback: Errback<any>
  ) => void;
};

export default class Connection {
  static defaults = {
    url: "http://localhost:8529",
    databaseName: "_system",
    arangoVersion: 30000
  };

  static agentDefaults = isBrowser
    ? {
        maxSockets: 3,
        keepAlive: false
      }
    : {
        maxSockets: 3,
        keepAlive: true,
        keepAliveMsecs: 1000
      };

  config: any;
  arangoMajor: number;
  private _queue: Task[];
  private _activeTasks: number;
  private _requests: RequestFunction[];
  private _databasePath: string;

  constructor(config: string | string[] | any) {
    if (typeof config === "string") config = { url: config };
    else if (Array.isArray(config)) config = { url: config };
    this.config = { ...Connection.defaults, ...config };
    this.config.agentOptions = {
      ...Connection.agentDefaults,
      ...this.config.agentOptions
    };
    this.config.headers = {
      ["x-arango-version"]: this.config.arangoVersion,
      ...this.config.headers
    };
    if (!Array.isArray(this.config.url)) {
      this.config.url = [this.config.url];
    }
    this.arangoMajor = Math.floor(this.config.arangoVersion / 10000);
    this._queue = [];
    this._activeTasks = 0;

    this._requests = this.config.url.map((url: string) =>
      createRequest(url, this.config.agentOptions, this.config.agent)
    );
    if (this.config.databaseName === false) {
      this._databasePath = "";
    } else {
      this._databasePath = `/_db/${this.config.databaseName}`;
    }
  }

  _drainQueue() {
    const maxConcurrent = this.config.agentOptions.keepAlive
      ? this.config.agentOptions.maxSockets * 2
      : this.config.agentOptions.maxSockets;
    if (!this._queue.length || this._activeTasks >= maxConcurrent) return;
    const task = this._queue.shift()!;
    this._activeTasks += 1;
    task.run(this._requests[0], "whatever", (err, result) => {
      this._activeTasks -= 1;
      if (err) task.reject(err);
      else task.resolve(result);
      this._drainQueue();
    });
  }

  _buildUrl(opts: any) {
    let pathname = "";
    let search;
    if (!opts.absolutePath) {
      pathname = this._databasePath;
      if (opts.basePath) pathname += opts.basePath;
    }
    if (opts.path) pathname += opts.path;
    if (opts.qs) {
      if (typeof opts.qs === "string") search = `?${opts.qs}`;
      else search = `?${qs.stringify(opts.qs)}`;
    }
    return search ? { pathname, search } : { pathname };
  }

  route(path: string, headers?: Object) {
    return new Route(this, path, headers);
  }

  request(opts: any) {
    const expectBinary = opts.expectBinary || false;
    let contentType = "text/plain";
    let body = opts.body;

    if (body) {
      if (typeof body === "object") {
        if (opts.ld) {
          body =
            body.map((obj: any) => JSON.stringify(obj)).join("\r\n") + "\r\n";
          contentType = "application/x-ldjson";
        } else {
          body = JSON.stringify(body);
          contentType = "application/json";
        }
      } else {
        body = String(body);
      }
    } else {
      body = opts.rawBody;
    }

    if (!opts.headers.hasOwnProperty("content-type")) {
      opts.headers["content-type"] = contentType;
    }

    if (!isBrowser && !opts.headers.hasOwnProperty("content-length")) {
      // Can't override content-length in browser but ArangoDB needs it to be set
      opts.headers["content-length"] = String(
        body ? byteLength(body, "utf-8") : 0
      );
    }

    for (const key of Object.keys(this.config.headers)) {
      if (!opts.headers.hasOwnProperty(key)) {
        opts.headers[key] = this.config.headers[key];
      }
    }

    const url = this._buildUrl(opts);
    return new Promise<ArangojsResponse>((resolve, reject) => {
      this._queue.push({
        resolve,
        reject,
        host: opts.host,
        run: (request, host, next) =>
          request(
            {
              url,
              headers: opts.headers,
              method: opts.method,
              expectBinary,
              body
            },
            (err, res): void => {
              if (err) {
                next(err);
              } else {
                const response = res!;
                response.host = host;
                const contentType = response.headers["content-type"];
                let parsedBody: any = {};
                if (contentType && contentType.match(MIME_JSON)) {
                  try {
                    if (!response.body) {
                      parsedBody = "";
                    }
                    if (expectBinary) {
                      parsedBody = (response.body as Buffer).toString("utf-8");
                    } else {
                      parsedBody = response.body as string;
                    }
                    parsedBody = JSON.parse(parsedBody);
                  } catch (e) {
                    if (!expectBinary) {
                      e.response = response;
                      next(e);
                      return;
                    }
                  }
                }
                if (
                  parsedBody &&
                  parsedBody.hasOwnProperty("error") &&
                  parsedBody.hasOwnProperty("code") &&
                  parsedBody.hasOwnProperty("errorMessage") &&
                  parsedBody.hasOwnProperty("errorNum")
                ) {
                  response.body = parsedBody;
                  next(new ArangoError(response));
                } else if (response.statusCode && response.statusCode >= 400) {
                  response.body = parsedBody;
                  next(new HttpError(response));
                } else {
                  if (!expectBinary) response.body = parsedBody;
                  next(null, response);
                }
              }
            }
          )
      });
      this._drainQueue();
    });
  }
}