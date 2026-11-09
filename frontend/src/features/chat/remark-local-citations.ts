type MarkdownNode = { type: string; value?: string; children?: MarkdownNode[]; data?: unknown };

// Transform parsed text nodes only. Code, links, images and raw HTML stay literal.
export function remarkLocalCitations() {
  return (tree: MarkdownNode) => {
    function walk(node: MarkdownNode) {
      if (["code", "inlineCode", "html", "link", "image", "definition"].includes(node.type) || !node.children) return;
      node.children = node.children.flatMap<MarkdownNode>(child => {
        if (child.type !== "text" || !child.value) { walk(child); return [child]; }
        const text = child.value;
        const parts: MarkdownNode[] = [];
        let offset = 0;
        for (const match of text.matchAll(/\[\[cite:(e_[0-9a-f]{32})\]\]/g)) {
          if (match.index > offset) parts.push({ type: "text", value: text.slice(offset, match.index) });
          parts.push({ type: "localCitation", data: {
            hName: "span", hProperties: { "data-local-citation": match[1] },
            hChildren: [{ type: "text", value: match[0] }]
          } });
          offset = match.index + match[0].length;
        }
        if (!offset) return [child];
        if (offset < text.length) parts.push({ type: "text", value: text.slice(offset) });
        return parts;
      });
    }
    walk(tree);
  };
}
