// -----------------------------------------------------------------------------
// A small XML reader for the SOAP answers of the cameras, and the escaping of
// the values the integration writes into its requests.
//
// Why not a library: the answers are small, well-formed documents (or close
// to it), and what the integration needs is a tree of elements by LOCAL name
// (`tt:Uri`, `trt:Uri` and `Uri` are the same thing from one firmware to the
// next). Document type declarations are refused, so no entity can expand and
// no external resource is ever read.
// -----------------------------------------------------------------------------

export class XmlError extends Error {
  constructor(message) {
    super(message);
    this.name = 'XmlError';
  }
}

const MAX_DEPTH = 64;
const MAX_LENGTH = 4 * 1024 * 1024;

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

/** Decode the five XML entities and the numeric references. */
export function decodeEntities(text) {
  if (!text.includes('&')) {
    return text;
  }
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, entity) => {
    if (entity[0] === '#') {
      const code =
        entity[1] === 'x' ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[entity] ?? whole;
  });
}

/** Escape a value written between tags or in an attribute. */
export function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function splitName(qualified) {
  const colon = qualified.indexOf(':');
  return colon === -1
    ? { prefix: '', name: qualified }
    : { prefix: qualified.slice(0, colon), name: qualified.slice(colon + 1) };
}

const NAME_END = /[\s/>]/;

/**
 * Parse a document into its root element:
 * `{ name, prefix, ns, attrs, children, text }`, names without their
 * namespace prefix (`attrs` too; `xmlns` declarations are left out), `ns` the
 * namespace URI of the element.
 * @param {string | Buffer} input
 */
export function parseXml(input) {
  const xml = Buffer.isBuffer(input) ? input.toString('utf8') : String(input ?? '');
  if (xml.length > MAX_LENGTH) {
    throw new XmlError('document too large');
  }
  const stack = [];
  let root = null;
  let at = 0;

  const appendText = (raw) => {
    const top = stack[stack.length - 1];
    if (top) {
      top.rawText.push(raw);
    }
  };

  while (at < xml.length) {
    const open = xml.indexOf('<', at);
    if (open === -1) {
      appendText(decodeEntities(xml.slice(at)));
      break;
    }
    if (open > at) {
      appendText(decodeEntities(xml.slice(at, open)));
    }
    if (xml.startsWith('<?', open)) {
      const end = xml.indexOf('?>', open + 2);
      if (end === -1) throw new XmlError('unterminated processing instruction');
      at = end + 2;
    } else if (xml.startsWith('<!--', open)) {
      const end = xml.indexOf('-->', open + 4);
      if (end === -1) throw new XmlError('unterminated comment');
      at = end + 3;
    } else if (xml.startsWith('<![CDATA[', open)) {
      const end = xml.indexOf(']]>', open + 9);
      if (end === -1) throw new XmlError('unterminated CDATA section');
      appendText(xml.slice(open + 9, end));
      at = end + 3;
    } else if (xml.startsWith('<!', open)) {
      // A DOCTYPE (or anything else of the kind): never in a SOAP message.
      throw new XmlError('document type declarations are not accepted');
    } else if (xml[open + 1] === '/') {
      const end = xml.indexOf('>', open + 2);
      if (end === -1) throw new XmlError('unterminated closing tag');
      const { name } = splitName(xml.slice(open + 2, end).trim());
      const node = stack.pop();
      if (!node || node.name !== name) {
        throw new XmlError(`unexpected closing tag </${name}>`);
      }
      finish(node);
      at = end + 1;
    } else {
      at = readStartTag(open);
    }
  }
  if (stack.length > 0) {
    throw new XmlError(`unclosed element <${stack[stack.length - 1].name}>`);
  }
  if (!root) {
    throw new XmlError('no root element');
  }
  return root;

  function finish(node) {
    node.text = node.rawText.join('').trim();
    delete node.rawText;
    delete node.scope;
  }

  function readStartTag(open) {
    let index = open + 1;
    while (index < xml.length && !NAME_END.test(xml[index])) {
      index += 1;
    }
    const qualified = xml.slice(open + 1, index);
    if (!qualified) {
      throw new XmlError('empty tag name');
    }
    const node = {
      ...splitName(qualified),
      ns: '',
      attrs: {},
      children: [],
      rawText: [],
      text: '',
    };
    const parentScope = stack.length > 0 ? stack[stack.length - 1].scope : {};
    let scope = parentScope;
    // Attributes, up to the end of the tag.
    for (;;) {
      while (index < xml.length && /\s/.test(xml[index])) {
        index += 1;
      }
      if (index >= xml.length) {
        throw new XmlError(`unterminated tag <${qualified}>`);
      }
      if (xml[index] === '>' || xml.startsWith('/>', index)) {
        break;
      }
      const equals = xml.indexOf('=', index);
      if (equals === -1) {
        throw new XmlError(`malformed attribute in <${qualified}>`);
      }
      const attrName = xml.slice(index, equals).trim();
      let quoteAt = equals + 1;
      while (/\s/.test(xml[quoteAt] ?? '')) {
        quoteAt += 1;
      }
      const quote = xml[quoteAt];
      if (quote !== '"' && quote !== "'") {
        throw new XmlError(`unquoted attribute ${attrName} in <${qualified}>`);
      }
      const close = xml.indexOf(quote, quoteAt + 1);
      if (close === -1) {
        throw new XmlError(`unterminated attribute ${attrName} in <${qualified}>`);
      }
      const { prefix, name } = splitName(attrName);
      const value = decodeEntities(xml.slice(quoteAt + 1, close));
      if (attrName === 'xmlns' || prefix === 'xmlns') {
        scope = scope === parentScope ? { ...parentScope } : scope;
        scope[attrName === 'xmlns' ? '' : name] = value;
      } else {
        node.attrs[name] = value;
      }
      index = close + 1;
    }
    node.ns = scope[node.prefix] ?? '';
    const parent = stack[stack.length - 1];
    if (parent) {
      parent.children.push(node);
    } else if (root) {
      throw new XmlError('more than one root element');
    } else {
      root = node;
    }
    if (xml[index] === '/') {
      finish(node);
      return index + 2;
    }
    node.scope = scope;
    if (stack.length >= MAX_DEPTH) {
      throw new XmlError('document nested too deeply');
    }
    stack.push(node);
    return index + 1;
  }
}

// --- Walking the tree, by local name -------------------------------------------

/** The first child element called `name`, or null. */
export function child(node, name) {
  return node?.children.find((item) => item.name === name) ?? null;
}

/** Every child element called `name`. */
export function children(node, name) {
  return node ? node.children.filter((item) => item.name === name) : [];
}

/** Follow a path of child names: `path(envelope, 'Body', 'GetProfilesResponse')`. */
export function path(node, ...names) {
  let current = node;
  for (const name of names) {
    current = child(current, name);
    if (!current) {
      return null;
    }
  }
  return current;
}

/** The first element called `name` under `node` (depth first), or null. */
export function find(node, name) {
  if (!node) {
    return null;
  }
  for (const item of node.children) {
    if (item.name === name) {
      return item;
    }
    const found = find(item, name);
    if (found) {
      return found;
    }
  }
  return null;
}

/** Every element called `name` under `node`, depth first. */
export function findAll(node, name, found = []) {
  for (const item of node?.children ?? []) {
    if (item.name === name) {
      found.push(item);
    }
    findAll(item, name, found);
  }
  return found;
}

/** The text of the child `name` (or of `node` itself), '' when absent. */
export function textOf(node, name) {
  const target = name === undefined ? node : child(node, name);
  return target?.text ?? '';
}

/**
 * Write an element back, each element declaring its own namespace: used to
 * echo the reference parameters of an event subscription, as WS-Addressing
 * requires.
 */
export function serialize(node) {
  const name = node.prefix ? `${node.prefix}:${node.name}` : node.name;
  const declaration = node.ns
    ? node.prefix
      ? ` xmlns:${node.prefix}="${escapeXml(node.ns)}"`
      : ` xmlns="${escapeXml(node.ns)}"`
    : '';
  const attrs = Object.entries(node.attrs)
    .map(([key, value]) => ` ${key}="${escapeXml(value)}"`)
    .join('');
  const inner =
    node.children.length > 0 ? node.children.map(serialize).join('') : escapeXml(node.text);
  return `<${name}${declaration}${attrs}>${inner}</${name}>`;
}
