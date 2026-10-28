import { isDeepStrictEqual } from 'node:util';
import {
  CST,
  Document,
  isMap,
  isNode,
  isPair,
  isScalar,
  isSeq,
  type Node,
  type Pair,
  Parser,
  visit,
  type YAMLMap,
  type YAMLSeq,
} from 'yaml';

type Entry = {
  node: unknown;
  token: CST.CollectionItem;
  index: number;
  trailing: string;
};

/** Render the reconciled workspace nodes using their original source boundaries. */
export function workspaceSourceEditor(document: Document, original: string) {
  const root = document.contents;
  if (!root) throw new Error('Missing workspace YAML root');
  const rootToken = root.srcToken;
  const entries = new Map<Node, Entry[]>();
  const scalarValues = new Map<Node, unknown>();
  const members = new Map<Node, unknown[]>();
  const pairs = new Map<Pair, { key: unknown; value: unknown }>();
  const origins = new Map<Node, Node>();
  const indentWidths = new Map<number, number>();
  const newline = original.match(/\r?\n/)?.[0] ?? '\n';
  const text = (tokens: readonly CST.SourceToken[] = []) =>
    tokens.map((t) => t.source).join('');
  function flowLeading(tokens: CST.SourceToken[], hasPrevious: boolean) {
    let leading = tokens.filter((token) => token.type !== 'comma');
    const newlineIndex = leading.findIndex((token) => token.type === 'newline');
    const boundary = newlineIndex < 0 ? leading.length : newlineIndex;
    if (
      hasPrevious &&
      leading.slice(0, boundary).some((token) => token.type === 'comment')
    )
      leading = leading.slice(boundary);
    return text(leading);
  }

  visit(document, {
    Node(_key, node, path) {
      if (isScalar(node)) scalarValues.set(node, node.value);
      if (isMap(node) || isSeq(node)) members.set(node, [...node.items]);
      if (isMap(node))
        for (const pair of node.items)
          pairs.set(pair, { key: pair.key, value: pair.value });
      const token = node.srcToken;
      if (!token || !CST.isCollection(token) || !(isMap(node) || isSeq(node)))
        return;
      const parent = path.at(-1);
      const parentMap = path.at(-2);
      if (isPair(parent) && isMap(parentMap)) {
        const parentToken = parentMap.srcToken;
        if (parentToken && 'indent' in parentToken) {
          const width = token.indent - parentToken.indent;
          if (width > 0)
            indentWidths.set(width, (indentWidths.get(width) ?? 0) + 1);
        }
      }
      // A flow trailing comma is an extra token item, not a semantic entry.
      const items =
        token.type === 'flow-collection'
          ? token.items.filter(
              (item) => item.key !== undefined || item.value !== undefined,
            )
          : token.items;
      const captured = node.items.map((item, index): Entry => {
        const itemToken = items[index];
        if (!itemToken)
          throw new Error('Missing source for existing workspace YAML entry');
        return { node: item, token: itemToken, index, trailing: '' };
      });
      if (token.type !== 'flow-collection') {
        // A missing value's boundary may own the following entry's indentation.
        for (const [index, current] of captured.entries()) {
          const previous = captured[index - 1];
          if (!previous) continue;
          const field = token.type === 'block-map' ? 'sep' : 'start';
          const separator = previous.token[field];
          const indentation = separator?.at(-1);
          if (
            separator &&
            !previous.token.value &&
            indentation?.type === 'space'
          ) {
            previous.token = {
              ...previous.token,
              [field]: separator.slice(0, -1),
            };
            current.token = {
              ...current.token,
              start: [indentation, ...current.token.start],
            };
          }
        }
      }
      if (token.type === 'flow-collection') {
        // Inline comments after a comma belong to the preceding value. Keep
        // newline/indentation with the following entry, and commas as syntax.
        token.items.forEach((item, index) => {
          if (index === 0) return;
          const end = item.start.findIndex((t) => t.type === 'newline');
          const boundary = end < 0 ? item.start.length : end;
          const inline = item.start
            .slice(0, boundary)
            .filter((t) => t.type !== 'comma');
          if (!inline.some((t) => t.type === 'comment')) return;
          const previous = captured[index - 1];
          if (previous) previous.trailing = text(inline);
        });
      }
      entries.set(node, captured);
    },
  });
  const indentWidth =
    [...indentWidths].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 2;
  const indentText = (value: string, indent: number) =>
    value.replace(/\n(?=.)/g, `\n${' '.repeat(indent)}`);
  let part: Document | undefined;
  const pristine = new Map<Node, boolean>();

  function unchanged(node: unknown): boolean {
    if (!isNode(node)) return true;
    const cached = pristine.get(node);
    if (cached !== undefined) return cached;
    const result = isUnchanged(node);
    pristine.set(node, result);
    return result;
  }

  function isUnchanged(node: Node): boolean {
    if (isScalar(node))
      return (
        scalarValues.has(node) &&
        isDeepStrictEqual(scalarValues.get(node), node.value)
      );
    if (isMap(node) || isSeq(node)) {
      const previous = members.get(node);
      return (
        previous?.length === node.items.length &&
        node.items.every((item, index) => {
          if (item !== previous[index]) return false;
          if (!isMap(node)) return unchanged(item);
          const pair = item as Pair;
          const before = pairs.get(pair);
          return (
            before !== undefined &&
            before.key === pair.key &&
            before.value === pair.value &&
            unchanged(pair.key) &&
            unchanged(pair.value)
          );
        })
      );
    }
    return !!node.srcToken;
  }

  function fragment(
    node: Node,
    flow: boolean,
    indent = 0,
    originalEntry?: CST.CollectionItem,
  ): CST.Document {
    if (!part) {
      part = new Document(undefined, {
        ...document.options,
        schema: document.schema.clone(),
      });
      part.directives = document.directives?.clone();
    }
    const cloned = node.clone() as Node;
    cloned.commentBefore = null;
    cloned.spaceBefore = false;
    // The original separator already owns comments before the replaced value.
    if (originalEntry && (isMap(cloned) || isSeq(cloned))) {
      const key = isMap(cloned) ? cloned.items[0]?.key : undefined;
      if (isNode(key)) {
        key.comment = null;
        key.commentBefore = null;
        key.spaceBefore = false;
      }
      const value = isMap(cloned) ? cloned.items[0]?.value : cloned.items[0];
      if (isNode(value)) {
        value.commentBefore = null;
        value.spaceBefore = false;
        if (!originalEntry.value) value.comment = null;
      }
    }
    part.contents = cloned;
    const serialized = part.toString({
      indent: indentWidth,
      lineWidth: 0,
      directives: false,
      verifyAliasOrder: false,
      ...(flow ? { collectionStyle: 'flow' } : {}),
    });
    const source =
      `${' '.repeat(indent)}${indentText(serialized, indent)}`.replace(
        /\r?\n/g,
        newline,
      );
    const parsed = [...new Parser().parse(source)].find(
      (t) => t.type === 'document',
    );
    if (!parsed) throw new Error('Unable to render workspace YAML entry');
    return parsed;
  }

  function generatedItem(
    owner: YAMLMap | YAMLSeq,
    item: unknown,
    flow: boolean,
    indent: number,
    originalEntry?: CST.CollectionItem,
  ): CST.CollectionItem {
    let wrapper: YAMLMap | YAMLSeq;
    if (isMap(owner)) {
      if (!isPair(item))
        throw new Error('Unable to render workspace YAML entry');
      const map: YAMLMap = document.createNode({});
      map.items = [item];
      wrapper = map;
    } else {
      const seq: YAMLSeq = document.createNode([]);
      seq.items = [item];
      wrapper = seq;
    }
    const collection = fragment(wrapper, flow, indent, originalEntry).value;
    if (!collection || !CST.isCollection(collection) || !collection.items[0])
      throw new Error('Unable to render workspace YAML entry');
    return collection.items[0];
  }

  function renderScalar(node: Node, token: CST.Token, flow: boolean): string {
    if (
      !isScalar(node) ||
      isDeepStrictEqual(scalarValues.get(node), node.value)
    )
      return CST.stringify(token);
    const copy = node.clone() as Node;
    copy.comment = null;
    const wrapper: YAMLMap | YAMLSeq = flow
      ? document.createNode([])
      : document.createNode({ value: copy });
    const item = isMap(wrapper) ? wrapper.items[0] : copy;
    if (!item) throw new Error('Unable to render workspace YAML entry');
    const generated = generatedItem(
      wrapper,
      item,
      flow,
      'indent' in token ? token.indent : 0,
    ).value;
    if (!generated) throw new Error('Unable to render workspace YAML entry');
    if (generated.type === 'block-scalar') {
      const end =
        token.type === 'block-scalar'
          ? text(token.props.slice(1) as CST.SourceToken[])
          : 'end' in token
            ? text(token.end)
            : '';
      return (
        (generated.props[0] as CST.SourceToken).source +
        end +
        (end.endsWith('\n') ? '' : newline) +
        generated.source
      );
    }
    const body = 'end' in generated ? { ...generated, end: [] } : generated;
    return CST.stringify(body) + ('end' in token ? text(token.end) : '');
  }

  function render(node: unknown, inFlow = false): string {
    if (!isNode(node)) return '';
    const token = node.srcToken;
    if (!token && isScalar(node) && unchanged(node) && node.value === null)
      return '';
    if (!token)
      throw new Error('Missing source for existing workspace YAML node');
    if (unchanged(node)) return CST.stringify(token);
    if (!CST.isCollection(token) || !(isMap(node) || isSeq(node)))
      return renderScalar(node, token, inFlow);
    const captured = entries.get(node);
    if (!captured)
      throw new Error('Missing source for existing workspace YAML collection');
    const byItem = new Map(captured.map((entry) => [entry.node, entry]));
    const flow = token.type === 'flow-collection';
    const originFor = (item: unknown) =>
      isNode(item) ? (origins.get(item) ?? item) : item;
    const selected = node.items.map((item) => ({
      item,
      entry: byItem.get(originFor(item)),
    }));
    const rendered = selected.map(({ item, entry }) => {
      const value = isMap(node) ? (item as Pair).value : item;
      const old = entry?.token;
      const implicitMap = !isMap(node) && old?.key !== undefined;
      const generated =
        !old || (isNode(value) && !value.srcToken && !unchanged(value))
          ? generatedItem(node, item, flow, token.indent, old)
          : undefined;
      const source = old ?? generated;
      if (!source) throw new Error('Unable to render workspace YAML entry');
      let start = text(source.start);
      if (flow) start = flowLeading(source.start, (entry?.index ?? 0) > 0);
      if (!flow && entry?.index === 0) start = ' '.repeat(token.indent) + start;
      if (!flow && !old) start = ' '.repeat(token.indent) + start;
      if (
        !flow &&
        isSeq(node) &&
        generated &&
        old &&
        !old.value &&
        old.start.some((t) => t.type === 'newline' || t.type === 'comment')
      ) {
        start +=
          (start.endsWith('\n') ? '' : newline) +
          ' '.repeat(token.indent + indentWidth);
      }
      const key = !implicitMap && source.key ? CST.stringify(source.key) : '';
      let sep = implicitMap ? '' : text(source.sep);
      let body: string;
      let trailing = entry?.trailing ?? '';
      if (generated) {
        const valueToken = generated.value;
        if (flow && valueToken && 'end' in valueToken) {
          const end = valueToken.end ?? [];
          const boundary = valueToken.type === 'flow-collection' ? 1 : 0;
          trailing = text(
            end.slice(boundary).filter((t) => t.type !== 'newline'),
          ).trimEnd();
          valueToken.end = end.slice(0, boundary);
        }
        body = valueToken ? CST.stringify(valueToken) : '';
        if (old && isMap(node)) {
          const colon =
            old.sep?.findIndex((t) => t.type === 'map-value-ind') ?? -1;
          const generatedColon =
            generated.sep?.findIndex((t) => t.type === 'map-value-ind') ?? -1;
          const after = old.sep?.slice(colon + 1) ?? [];
          const generatedAfter = text(generated.sep?.slice(generatedColon + 1));
          let valueSide = generatedAfter;
          if (after.some((t) => t.type === 'comment')) {
            let lastNewline = after.length - 1;
            while (lastNewline >= 0 && after[lastNewline]?.type !== 'newline')
              lastNewline--;
            const indentation = generatedAfter.includes('\n')
              ? generatedAfter.slice(generatedAfter.lastIndexOf('\n') + 1)
              : old.value
                ? text(after.slice(lastNewline + 1))
                : ' '.repeat(token.indent + indentWidth);
            valueSide = text(after.slice(0, lastNewline + 1)) + indentation;
          }
          sep =
            colon < 0
              ? text(old.sep) +
                (text(old.sep).endsWith('\n') ? '' : newline) +
                ' '.repeat(token.indent) +
                ':' +
                generatedAfter
              : text(old.sep?.slice(0, colon + 1)) + valueSide;
        }
      } else if (implicitMap) body = CST.stringify({ ...source, start: [] });
      else body = render(value, flow);
      if (
        isMap(node) &&
        isSeq(value) &&
        value.items.length === 0 &&
        value.srcToken?.type === 'block-seq' &&
        value.srcToken.indent === token.indent
      )
        sep += ' '.repeat(indentWidth);
      if (flow && !generated && old?.value && 'end' in old.value) {
        const boundary = old.value.type === 'flow-collection' ? 1 : 0;
        const end = text(old.value.end?.slice(boundary));
        if (end && body.endsWith(end)) {
          body = body.slice(0, -end.length);
          trailing = end + trailing;
        }
      }
      // Indentation before a block collection's first item belongs to its
      // parent separator. A moved leading blank line must not inherit it.
      if (body.startsWith('\n') || body.startsWith('\r\n')) {
        if (isMap(node)) sep = sep.replace(/ +$/, '');
        else start = start.replace(/ +$/, '');
      }
      return { start, body: key + sep + body, trailing };
    });

    if (flow) {
      const extras = token.items.slice(captured.length);
      let body = '';
      rendered.forEach((item, index) => {
        let prefix = item.start;
        const previous = rendered[index - 1];
        if (
          index > 0 &&
          previous?.trailing &&
          !previous.trailing.endsWith('\n') &&
          !/^\r?\n/.test(prefix)
        )
          prefix = newline + ' '.repeat(token.indent + indentWidth) + prefix;
        body += prefix + item.body;
        if (index < rendered.length - 1 || extras.length || item.trailing)
          body += ',';
        body += item.trailing;
      });
      let tail = extras.map((item) => flowLeading(item.start, true)).join('');
      const last = rendered.at(-1);
      if (
        last?.trailing &&
        !last.trailing.endsWith('\n') &&
        !/^\r?\n/.test(tail)
      )
        tail = newline + ' '.repeat(token.indent) + tail;
      body += tail;
      return token.start.source + body + text(token.end);
    }
    if (!rendered.length) return (isMap(node) ? '{}' : '[]') + newline;
    let body = '';
    for (const item of rendered) {
      if (body && !body.endsWith('\n')) body += newline;
      body += item.start + item.body;
    }
    return body.startsWith(' '.repeat(token.indent))
      ? body.slice(token.indent)
      : body;
  }

  return {
    replace(previous: Node, next: Node) {
      origins.set(next, origins.get(previous) ?? previous);
    },
    stringify() {
      const contents = document.contents;
      if (!contents) throw new Error('Missing workspace YAML root');
      // An implicit null document has no value token. Insert the new root
      // after its header, before any explicit document end and footer.
      if (!rootToken) {
        const envelope = [...new Parser().parse(original)].find(
          (token) => token.type === 'document',
        );
        if (!envelope)
          throw new Error('Missing workspace YAML document source');
        const offset = envelope.offset + CST.stringify(envelope).length;
        const prefix = original.slice(0, offset);
        const node = contents.clone() as Node;
        node.comment = null;
        if ('anchor' in node) delete node.anchor;
        const separator = prefix.endsWith('\n')
          ? ''
          : /&\S+$/.test(prefix)
            ? ' '
            : newline;
        let value = CST.stringify(fragment(node, false));
        if (offset === original.length && !original.endsWith('\n'))
          value = value.replace(/\r?\n$/, '');
        return prefix + separator + value + original.slice(offset);
      }
      let result =
        contents === root
          ? render(root)
          : CST.stringify(fragment(contents, false));
      const suffix = original.slice(
        rootToken.offset + CST.stringify(rootToken).length,
      );
      if (!suffix && !original.endsWith('\n'))
        result = result.replace(/\r?\n$/, '');
      return original.slice(0, rootToken.offset) + result + suffix;
    },
  };
}
