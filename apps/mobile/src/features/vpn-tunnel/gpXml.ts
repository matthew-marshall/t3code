/** Just enough XML for GlobalProtect portal/gateway responses (no namespaces, DTDs, or validation). */
export interface XmlNode {
  readonly name: string;
  readonly attrs: Readonly<Record<string, string>>;
  readonly children: XmlNode[];
  text: string;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

export function decodeXmlEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (match, entity: string) => {
    if (entity[0] === "#") {
      const code =
        entity[1] === "x" || entity[1] === "X"
          ? parseInt(entity.slice(2), 16)
          : Number(entity.slice(1));
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[entity] ?? match;
  });
}

export function parseXml(source: string): XmlNode {
  const root: XmlNode = { name: "#document", attrs: {}, children: [], text: "" };
  const stack: XmlNode[] = [root];
  const token =
    /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!(?:[^>"']|"[^"]*"|'[^']*')*>|<\/([^\s>]+)\s*>|<([^\s/>]+)((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|([^<]+)/g;
  for (const match of source.matchAll(token)) {
    const [, cdata, closeName, openName, rawAttrs, selfClose, text] = match;
    const current = stack[stack.length - 1]!;
    if (cdata !== undefined) {
      current.text += cdata;
    } else if (text !== undefined) {
      current.text += decodeXmlEntities(text);
    } else if (closeName !== undefined) {
      const index = stack.map((node) => node.name).lastIndexOf(closeName);
      if (index > 0) stack.length = index;
    } else if (openName !== undefined) {
      const attrs: Record<string, string> = {};
      for (const attr of (rawAttrs ?? "").matchAll(
        /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g,
      )) {
        attrs[attr[1]!] = decodeXmlEntities(attr[2] ?? attr[3] ?? attr[4] ?? "");
      }
      const node: XmlNode = { name: openName, attrs, children: [], text: "" };
      current.children.push(node);
      if (!selfClose) stack.push(node);
    }
  }
  return root;
}

/** First node named `name` in document order, searching all descendants. */
export function findFirst(node: XmlNode, name: string): XmlNode | undefined {
  for (const child of node.children) {
    if (child.name === name) return child;
    const found = findFirst(child, name);
    if (found) return found;
  }
  return undefined;
}

export function firstText(node: XmlNode, name: string): string | undefined {
  const found = findFirst(node, name);
  return found === undefined ? undefined : found.text.trim();
}

export function childrenNamed(node: XmlNode | undefined, name: string): XmlNode[] {
  return node?.children.filter((child) => child.name === name) ?? [];
}

/** Follows a path of direct children, e.g. ["gateways", "external", "list"]. */
export function childPath(
  node: XmlNode | undefined,
  path: ReadonlyArray<string>,
): XmlNode | undefined {
  let current = node;
  for (const name of path) current = current?.children.find((child) => child.name === name);
  return current;
}
