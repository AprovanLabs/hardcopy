import type { ServiceDefinition, ProcedureDefinition, TypeDefinition, JsonSchema } from "./types";

export interface OpenApiSpec {
  openapi?: string;
  info?: { title?: string; version?: string };
  paths?: Record<string, Record<string, OpenApiOperation>>;
  components?: { schemas?: Record<string, JsonSchema> };
}

interface OpenApiOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  requestBody?: {
    content?: Record<string, { schema?: JsonSchema }>;
  };
  responses?: Record<string, { content?: Record<string, { schema?: JsonSchema }> }>;
}

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: JsonSchema;
}

export function extractFromOpenApi(
  namespace: string,
  spec: OpenApiSpec,
  baseUrl: string
): ServiceDefinition {
  const procedures: ProcedureDefinition[] = [];
  const types: TypeDefinition[] = [];
  const seenTypes = new Set<string>();

  if (spec.components?.schemas) {
    for (const [name, schema] of Object.entries(spec.components.schemas)) {
      if (!seenTypes.has(name)) {
        seenTypes.add(name);
        types.push({ name, schema: resolveRefs(schema, spec) });
      }
    }
  }

  if (spec.paths) {
    for (const [path, methods] of Object.entries(spec.paths)) {
      for (const [method, operation] of Object.entries(methods)) {
        if (method === "parameters") continue;
        const procName = operation.operationId ?? `${method}_${path.replace(/\//g, "_")}`;
        const inputSchema = extractInputSchema(operation);
        const outputSchema = extractOutputSchema(operation);

        procedures.push({
          name: procName,
          description: operation.summary ?? operation.description ?? "",
          input: resolveRefs(inputSchema, spec),
          output: resolveRefs(outputSchema, spec),
          streaming: false,
        });
      }
    }
  }

  return {
    namespace,
    version: spec.info?.version ?? "1.0.0",
    source: {
      type: "http",
      config: { baseUrl },
    },
    procedures,
    types,
  };
}

export function extractFromMcp(
  namespace: string,
  tools: McpToolInfo[],
  config: { command: string; args?: string[] }
): ServiceDefinition {
  const procedures: ProcedureDefinition[] = tools.map((tool) => ({
    name: tool.name,
    description: tool.description ?? "",
    input: tool.inputSchema ?? { type: "object" },
    output: { type: "object" },
    streaming: false,
  }));

  return {
    namespace,
    version: "1.0.0",
    source: {
      type: "mcp",
      config,
    },
    procedures,
    types: [],
  };
}

export function generateEntityType(
  namespace: string,
  procedureName: string,
  outputSchema: JsonSchema
): { type: string; uriPattern: string; schema: JsonSchema } {
  const typeName = `${namespace}.${capitalizeFirst(procedureName)}`;
  const uriPattern = `${namespace}:{id}`;
  return {
    type: typeName,
    uriPattern,
    schema: outputSchema,
  };
}

export function inferUriPattern(namespace: string, schema: JsonSchema): string {
  const props = schema.properties ?? {};
  const identifiers = ["id", "number", "key", "slug", "name"];
  for (const id of identifiers) {
    if (props[id]) {
      return `${namespace}:{${id}}`;
    }
  }
  return `${namespace}:{id}`;
}

function extractInputSchema(operation: OpenApiOperation): JsonSchema {
  const content = operation.requestBody?.content;
  if (content) {
    const jsonContent = content["application/json"];
    if (jsonContent?.schema) {
      return jsonContent.schema;
    }
  }
  return { type: "object" };
}

function extractOutputSchema(operation: OpenApiOperation): JsonSchema {
  const successResponses = ["200", "201", "202"];
  for (const code of successResponses) {
    const response = operation.responses?.[code];
    if (response?.content) {
      const jsonContent = response.content["application/json"];
      if (jsonContent?.schema) {
        return jsonContent.schema;
      }
    }
  }
  return { type: "object" };
}

function resolveRefs(schema: JsonSchema, spec: OpenApiSpec): JsonSchema {
  if (!schema) return { type: "object" };
  if (schema.$ref) {
    const refPath = schema.$ref.replace("#/components/schemas/", "");
    const resolved = spec.components?.schemas?.[refPath];
    if (resolved) {
      return resolveRefs(resolved, spec);
    }
    return { type: "object", description: `Unresolved: ${schema.$ref}` };
  }

  const result: JsonSchema = { ...schema };

  if (result.properties) {
    result.properties = {};
    for (const [key, prop] of Object.entries(schema.properties!)) {
      result.properties[key] = resolveRefs(prop, spec);
    }
  }

  if (result.items) {
    result.items = resolveRefs(schema.items!, spec);
  }

  return result;
}

function capitalizeFirst(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}
