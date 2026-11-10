import { createUnsupportedTreeFormatError } from '../errors/convertErrors';
import { parseDateTimeSkeletonOptions } from '../parser/skeleton';
import { printAST } from '../parser/printer';
import { canonicalStyle, toMessage } from '../tree/canonical';
import type {
  FormattedNode,
  FormattingNode,
  FormattingTree,
  MessageBranches,
  MessageNode,
  MessageTree,
} from '../tree/messageTree';
import { formattedNode, styleProblem } from '../tree/validateMessageTree';
import { messageNodes } from '../tree/walk';
import { printDateTimeSkeleton } from './skeleton';
import {
  SKELETON_TYPE,
  TYPE,
  type DateElement,
  type DateTimeSkeleton,
  type ExtendedNumberFormatOptions,
  type MessageFormatElement,
  type NumberElement,
  type PluralOrSelectOption,
  type TimeElement,
} from '../types-dir/ast';

type FormatElement = NumberElement | DateElement | TimeElement;
// A style as an ICU string spells it: a name, or the Intl options of a skeleton.
type IntlStyle =
  | string
  | ExtendedNumberFormatOptions
  | Intl.DateTimeFormatOptions
  | null
  | undefined;
type FormatReader<Format> = (element: FormatElement) => Format;

/**
 * Converts the parser's syntax tree to a message tree node for node, in the
 * parsed order; `normalizeTree` gives the form keys are hashed from.
 * Locations are dropped. Throws for a format a tree cannot hold, such as a
 * number skeleton with digits: its options are formatting context.
 */
export function toMessageTree(ast: MessageFormatElement[]): MessageTree {
  return convert(ast, treeNode);
}

/**
 * Converts the parser's syntax tree for formatting an ICU string: a format
 * keeps every Intl option its skeleton spells, which a message tree cannot
 * hold, and the formatter reads them like a tree's styles.
 */
export function toFormattingTree(ast: MessageFormatElement[]): FormattingTree {
  // Plain text as one string takes the formatter's fast path.
  return toMessage(convert(ast, formattingNode));
}

function convert<Format>(
  ast: MessageFormatElement[],
  readFormat: FormatReader<Format>
): MessageNode<Format>[] {
  return ast.map((element) => toNode(element, readFormat));
}

function toNode<Format>(
  element: MessageFormatElement,
  readFormat: FormatReader<Format>
): MessageNode<Format> {
  switch (element.type) {
    case TYPE.literal:
      return element.value;
    case TYPE.pound:
      return 0;
    case TYPE.argument:
      return [element.value];
    case TYPE.number:
    case TYPE.date:
    case TYPE.time:
      return readFormat(element);
    case TYPE.select:
      return [element.value, 'select', toBranches(element.options, readFormat)];
    case TYPE.plural: {
      const kind =
        element.pluralType === 'ordinal' ? 'selectordinal' : 'plural';
      const branches = toBranches(element.options, readFormat);
      return element.offset
        ? [element.value, kind, branches, element.offset]
        : [element.value, kind, branches];
    }
    case TYPE.tag:
      return [element.value, 'tag', convert(element.children, readFormat)];
  }
}

/**
 * A format for the formatter only: the style is the name, or every Intl
 * option the skeleton spells.
 */
function formattingNode(element: FormatElement): FormattingNode {
  if (element.type === TYPE.number) {
    const style = element.style ?? undefined;
    return [
      element.value,
      'number',
      typeof style === 'object' ? style.parsedOptions : style,
    ];
  }
  const style = element.style ?? undefined;
  return [
    element.value,
    element.type === TYPE.date ? 'date' : 'time',
    typeof style === 'object' ? dateTimeOptions(style) : style,
  ];
}

// Parsed without a locale, `::j` would otherwise lose its hour.
function dateTimeOptions(
  skeleton: DateTimeSkeleton
): Intl.DateTimeFormatOptions {
  return parseDateTimeSkeletonOptions(skeleton.pattern, { localeHour: true });
}

/**
 * A format with the style a tree holds: a style name, a number's `::unit/…`,
 * or date and time fields. An hour symbol is the hour; its cycle, from `h`,
 * `H`, `K`, `k`, `J` or a day period `a`, is formatting context and is dropped.
 */
function treeNode(element: FormatElement): FormattedNode {
  const kind =
    element.type === TYPE.number
      ? 'number'
      : element.type === TYPE.date
        ? 'date'
        : 'time';
  const fail = (reason: string) =>
    new Error(createUnsupportedTreeFormatError(printAST([element]), reason));
  let style: IntlStyle;
  const skeleton = element.style;
  if (skeleton == null || typeof skeleton === 'string') {
    style = skeleton;
  } else if (skeleton.type === SKELETON_TYPE.number) {
    const [token, ...rest] = skeleton.tokens;
    if (rest.length || token.stem !== 'unit' || token.options.length !== 1) {
      throw fail(
        'a number skeleton can only be ::unit/<unit>; other number options are formatting context'
      );
    }
    // Read like ICU4C, which takes the whole identifier, as in `unit/kilometer-per-hour`.
    style = { style: 'unit', unit: token.options[0] };
  } else {
    // The parser shows at most three fractional digits, as Intl does.
    if (/S{4}/.test(skeleton.pattern.replace(/'[^']*'/g, ''))) {
      throw fail('fractional seconds have at most three digits, SSS');
    }
    const { hourCycle: _, hour12: __, ...fields } = dateTimeOptions(skeleton);
    style = canonicalStyle(fields);
  }
  return formattedNode(element.value, kind, style, fail);
}

function toBranches<Format>(
  options: Record<string, PluralOrSelectOption>,
  readFormat: FormatReader<Format>
): MessageBranches<Format> {
  // Object.fromEntries defines own properties, so a `__proto__` branch stays one.
  return Object.fromEntries(
    Object.keys(options).map((key) => [
      key,
      convert(options[key].value, readFormat),
    ])
  );
}

/**
 * Converts a message tree back to the parser's syntax tree. A tree holds only
 * what ICU spells, so nothing is lost; a style a tree cannot hold throws.
 */
export function fromMessageTree(tree: MessageTree): MessageFormatElement[] {
  return messageNodes(tree).map(fromNode);
}

function fromNode(node: MessageNode): MessageFormatElement {
  if (typeof node === 'string') return { type: TYPE.literal, value: node };
  if (node === 0) return { type: TYPE.pound };
  const value = node[0];
  switch (node[1]) {
    case undefined:
      return { type: TYPE.argument, value };
    case 'number':
    case 'date':
    case 'time': {
      const problem = styleProblem(node[1], node[2]);
      if (problem) {
        throw new Error(
          createUnsupportedTreeFormatError(
            JSON.stringify(node),
            problem.message
          )
        );
      }
      if (node[1] === 'number') {
        const style = node[2] ?? null;
        const unit = typeof style === 'object' ? style : null;
        return {
          type: TYPE.number,
          value,
          style: unit
            ? {
                type: SKELETON_TYPE.number,
                tokens: [{ stem: 'unit', options: [unit.unit] }],
                parsedOptions: unit,
              }
            : typeof style === 'string'
              ? style
              : null,
        };
      }
      const style = node[2] ?? null;
      const fields = typeof style === 'object' ? style : null;
      const pattern = fields && printDateTimeSkeleton(fields);
      return {
        type: node[1] === 'date' ? TYPE.date : TYPE.time,
        value,
        style:
          fields && pattern
            ? { type: SKELETON_TYPE.dateTime, pattern, parsedOptions: fields }
            : typeof style === 'string'
              ? style
              : null,
      };
    }
    case 'select':
      return {
        type: TYPE.select,
        value,
        options: fromBranches(node[2]),
      };
    case 'plural':
    case 'selectordinal': {
      const [, kind, branches, offset = 0] = node;
      return {
        type: TYPE.plural,
        value,
        options: fromBranches(branches),
        offset,
        pluralType: kind === 'plural' ? 'cardinal' : 'ordinal',
      };
    }
    case 'tag':
      return {
        type: TYPE.tag,
        value,
        children: fromMessageTree(node[2]),
      };
  }
}

function fromBranches(
  branches: MessageBranches
): Record<string, PluralOrSelectOption> {
  const options: Record<string, PluralOrSelectOption> = Object.create(null);
  // A leading `offset` branch would read back as a plural's `offset:`.
  const keys = Object.keys(branches).sort(
    (a, b) => Number(a === 'offset') - Number(b === 'offset')
  );
  for (const key of keys) {
    options[key] = { value: fromMessageTree(branches[key]) };
  }
  return Object.setPrototypeOf(options, Object.prototype);
}
