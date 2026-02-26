import { renderTemplateContext } from "../format";
import type { NodeChange } from "./diff";

export function renderHookTemplate(template: string, change: NodeChange, sourceName: string): string {
  const context: Record<string, unknown> = {
    id: change.node.id,
    type: change.node.type,
    attrs: change.node.attrs,
    prior: change.prior ? { attrs: change.prior.attrs } : null,
    changes: change.changes,
    source: sourceName,
  };
  return renderTemplateContext(template, context);
}
