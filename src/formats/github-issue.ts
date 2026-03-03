import type { FormatHandler, ParsedFile } from "../format";
import type { Node } from "../types";
import matter from "gray-matter";

export const githubIssueFormat: FormatHandler = {
  type: "github.Issue",
  editableFields: ["title", "body", "labels", "assignee", "milestone", "state"],

  render(node: Node): string {
    const attrs = node.attrs as Record<string, unknown>;
    const frontmatter: Record<string, unknown> = {
      _type: "github.Issue",
      _id: node.id,
    };

    const addIfDefined = (key: string, value: unknown) => {
      if (value !== undefined && value !== null) {
        frontmatter[key] = value;
      }
    };

    addIfDefined("number", attrs["number"]);
    addIfDefined("title", attrs["title"]);
    addIfDefined("state", attrs["state"]);
    addIfDefined("url", attrs["url"]);
    addIfDefined("labels", attrs["labels"]);
    addIfDefined("assignee", attrs["assignee"]);
    addIfDefined("milestone", attrs["milestone"]);
    addIfDefined("created_at", attrs["created_at"]);
    addIfDefined("updated_at", attrs["updated_at"]);
    
    if (attrs["syncedAt"]) {
      frontmatter["_synced"] = new Date(attrs["syncedAt"] as number).toISOString();
    }

    const body = (attrs["body"] as string) ?? "";
    return matter.stringify(body, frontmatter);
  },

  parse(content: string): ParsedFile {
    const { data, content: body } = matter(content);
    const attrs: Record<string, unknown> = {};

    if (data["title"]) attrs["title"] = data["title"];
    if (data["state"]) attrs["state"] = data["state"];
    if (data["labels"]) attrs["labels"] = data["labels"];
    if (data["assignee"]) attrs["assignee"] = data["assignee"];
    if (data["milestone"]) attrs["milestone"] = data["milestone"];

    return {
      attrs,
      body: body.trim(),
    };
  },
};
