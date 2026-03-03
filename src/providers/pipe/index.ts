import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { Socket } from "node:net";
import type { Provider, Tool } from "../../provider";
import type {
  Node,
  Change,
  FetchRequest,
  FetchResult,
  PushResult,
  Event,
  SubscribeOptions,
} from "../../types";
import { registerProvider } from "../../provider";
import type { PipeConfig, PipeTransport, PipeCodec } from "../../config";

export interface PipeProviderConfig {
  pipes?: PipeConfig[];
}

function openTransport(transport: PipeTransport): {
  iterable: AsyncIterable<Buffer>;
  cleanup: () => void;
} {
  switch (transport.type) {
    case "exec": {
      const child = spawn(transport.command, transport.args ?? [], {
        cwd: transport.cwd,
        env: transport.env ? { ...process.env, ...transport.env } : undefined,
        stdio: ["ignore", "pipe", "pipe"],
      });

      const iterable = (async function* () {
        for await (const chunk of child.stdout!) {
          yield chunk as Buffer;
        }
      })();

      return {
        iterable,
        cleanup: () => child.kill(),
      };
    }

    case "file": {
      const stream = createReadStream(transport.path, {
        flags: transport.follow ? "r" : "r",
        encoding: undefined,
      });

      let bytesRead = 0;
      const iterable = (async function* () {
        for await (const chunk of stream) {
          const buf = chunk as Buffer;
          bytesRead += buf.length;
          yield buf;
        }

        if (transport.follow) {
          const { watchFile, unwatchFile } = await import("node:fs");
          let stopped = false;

          watchFile(transport.path, { interval: 500 }, () => {
            // trigger re-read on change
          });

          try {
            while (!stopped) {
              await new Promise((resolve) => setTimeout(resolve, 500));
              const followStream = createReadStream(transport.path, {
                start: bytesRead,
              });
              for await (const chunk of followStream) {
                const buf = chunk as Buffer;
                bytesRead += buf.length;
                yield buf;
              }
            }
          } finally {
            unwatchFile(transport.path);
          }
        }
      })();

      return { iterable, cleanup: () => stream.destroy() };
    }

    case "socket": {
      let conn: Socket | null = null;
      const iterable = (async function* () {
        conn = new Socket();
        conn.connect(transport.path);
        for await (const chunk of conn) {
          yield chunk as Buffer;
        }
      })();

      return { iterable, cleanup: () => conn?.destroy() };
    }

    case "tcp": {
      let conn: Socket | null = null;
      const iterable = (async function* () {
        conn = new Socket();
        conn.connect(transport.port, transport.host);
        for await (const chunk of conn) {
          yield chunk as Buffer;
        }
      })();

      return { iterable, cleanup: () => conn?.destroy() };
    }

    case "http": {
      let server: HttpServer | null = null;
      const iterable = (async function* () {
        const chunks: Buffer[] = [];
        let resolve: (() => void) | null = null;

        server = createHttpServer((req, res) => {
          const path = transport.path ?? "/";
          if (req.url !== path) {
            res.writeHead(404);
            res.end();
            return;
          }

          const body: Buffer[] = [];
          req.on("data", (chunk: Buffer) => body.push(chunk));
          req.on("end", () => {
            chunks.push(Buffer.concat(body));
            if (resolve) resolve();
            res.writeHead(200);
            res.end("ok");
          });
        });

        server.listen(transport.port);

        while (true) {
          if (chunks.length === 0) {
            await new Promise<void>((r) => (resolve = r));
          }
          while (chunks.length > 0) {
            yield chunks.shift()!;
          }
        }
      })();

      return { iterable, cleanup: () => server?.close() };
    }
  }
}

function createCodec(codec: PipeCodec): (buf: Buffer) => Partial<Event>[] {
  let remainder = "";

  switch (codec.type) {
    case "lines":
      return (buf: Buffer) => {
        remainder += buf.toString();
        const lines = remainder.split("\n");
        remainder = lines.pop() ?? "";
        return lines
          .filter((l) => l.length > 0)
          .map((line) => ({
            type: "line",
            timestamp: Date.now(),
            attrs: { text: line },
          }));
      };

    case "jsonl":
      return (buf: Buffer) => {
        remainder += buf.toString();
        const lines = remainder.split("\n");
        remainder = lines.pop() ?? "";
        return lines
          .filter((l) => l.trim().length > 0)
          .map((line) => {
            try {
              const parsed = JSON.parse(line);
              return {
                type: parsed.type ?? "data",
                timestamp: parsed.timestamp ?? Date.now(),
                attrs: parsed,
              };
            } catch {
              return {
                type: "parse_error",
                timestamp: Date.now(),
                attrs: { raw: line },
              };
            }
          });
      };

    case "sse":
      return (buf: Buffer) => {
        remainder += buf.toString();
        const parts = remainder.split("\n\n");
        remainder = parts.pop() ?? "";
        return parts
          .filter((p) => p.trim().length > 0)
          .map((part) => {
            const lines = part.split("\n");
            let eventType = "message";
            let data = "";
            for (const line of lines) {
              if (line.startsWith("event:")) eventType = line.slice(6).trim();
              else if (line.startsWith("data:")) data += line.slice(5).trim();
            }
            let attrs: Record<string, unknown> = { data };
            try {
              attrs = JSON.parse(data);
            } catch {
              // keep raw data
            }
            return { type: eventType, timestamp: Date.now(), attrs };
          });
      };

    case "chunks": {
      const size = codec.size ?? 4096;
      return (buf: Buffer) => {
        const events: Partial<Event>[] = [];
        for (let i = 0; i < buf.length; i += size) {
          events.push({
            type: "chunk",
            timestamp: Date.now(),
            attrs: { data: buf.subarray(i, i + size).toString() },
          });
        }
        return events;
      };
    }
  }
}

export function createPipeProvider(config: PipeProviderConfig): Provider {
  const pipes = config.pipes ?? [];

  return {
    name: "pipe",
    nodeTypes: [],
    edgeTypes: [],
    streams: pipes.map((p) => ({
      name: p.stream,
      provider: "pipe",
      retention: p.retention,
    })),

    async fetch(_request: FetchRequest): Promise<FetchResult> {
      return { nodes: [], edges: [], hasMore: false, cached: true };
    },

    async push(_node: Node, _changes: Change[]): Promise<PushResult> {
      return { success: false, error: "Pipe provider is read-only" };
    },

    async fetchNode(_nodeId: string): Promise<Node | null> {
      return null;
    },

    getTools(): Tool[] {
      return [];
    },

    async *subscribe(stream: string, _options?: SubscribeOptions): AsyncIterable<Event[]> {
      const pipe = pipes.find((p) => p.stream === stream);
      if (!pipe) return;

      const { iterable, cleanup } = openTransport(pipe.transport);
      const parser = createCodec(pipe.codec);
      const sessionId = `pipe:${stream}:${Date.now()}`;

      yield [
        {
          id: sessionId,
          stream,
          type: "session.start",
          timestamp: Date.now(),
          attrs: { transport: pipe.transport },
          sourceId: pipe.sourceId,
        },
      ];

      try {
        for await (const chunk of iterable) {
          const events = parser(chunk).map((e, i) => ({
            id: `${sessionId}:${Date.now()}:${i}`,
            stream,
            type: e.type ?? "data",
            timestamp: e.timestamp ?? Date.now(),
            attrs: e.attrs ?? {},
            parentId: sessionId,
            sourceId: pipe.sourceId,
          }));
          if (events.length) yield events;
        }
      } finally {
        cleanup();
        yield [
          {
            id: `${sessionId}:end`,
            stream,
            type: "session.end",
            timestamp: Date.now(),
            attrs: {},
            parentId: sessionId,
            sourceId: pipe.sourceId,
          },
        ];
      }
    },
  };
}

registerProvider("pipe", (config) =>
  createPipeProvider(config as PipeProviderConfig),
);

export { createPipeProvider as default };
