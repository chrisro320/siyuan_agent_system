// 安全 DOM 建構工具：全程使用 textContent / replaceChildren，永不使用 innerHTML，
// 因此匯入內容與模型產出的 Markdown 一律以文字或明確建立的元素呈現，不會被當成 HTML 執行。

export type Child = Node | string;

export type Tone = "neutral" | "ok" | "warn" | "danger" | "info";

// 通知橫幅只使用這四種色調；neutral 沒有可讀的警示語意，因此不開放。
export type NoticeTone = "ok" | "warn" | "danger" | "info";

export interface ElProps {
  id?: string;
  class?: string;
  text?: string;
  open?: boolean;
  attrs?: Record<string, string | number | boolean | null | undefined>;
  data?: Record<string, string>;
  on?: Record<string, EventListener>;
}

export interface FieldProps extends ElProps {
  name?: string;
  value?: string;
  placeholder?: string;
  title?: string;
  type?: string;
  rows?: number;
  min?: string;
  max?: string;
  step?: string;
  accept?: string;
  required?: boolean;
  disabled?: boolean;
  readOnly?: boolean;
}

export interface SelectOption {
  value: string;
  label: string;
}

export type ButtonVariant = "default" | "primary" | "danger" | "ghost";

function applyCommon(node: HTMLElement, props: ElProps): void {
  if (props.id !== undefined) node.id = props.id;
  if (props.class !== undefined) node.className = props.class;
  if (props.text !== undefined) node.textContent = props.text;
  if (props.open !== undefined && node instanceof HTMLDetailsElement) node.open = props.open;
  for (const [name, value] of Object.entries(props.attrs ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    node.setAttribute(name, value === true ? "" : String(value));
  }
  for (const [name, value] of Object.entries(props.data ?? {})) {
    node.dataset[name] = value;
  }
  for (const [type, handler] of Object.entries(props.on ?? {})) {
    node.addEventListener(type, handler);
  }
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: ElProps = {},
  children: readonly Child[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  applyCommon(node, props);
  if (children.length > 0) node.replaceChildren(...children);
  return node;
}

export function badge(label: string, tone: Tone = "neutral"): HTMLSpanElement {
  return el("span", { class: `badge badge-${tone}`, text: label });
}

export function chip(label: string, tone: Tone = "neutral"): HTMLSpanElement {
  return el("span", { class: `chip chip-${tone}`, text: label });
}

export function hint(content: string): HTMLParagraphElement {
  return el("p", { class: "hint", text: content });
}

export function emptyState(content: string): HTMLParagraphElement {
  return el("p", { class: "empty", text: content });
}

export function loadingState(content: string): HTMLParagraphElement {
  return el("p", { class: "loading", text: content });
}

export function errorText(content: string): HTMLParagraphElement {
  return el("p", { class: "error-text", text: content });
}

export function notice(tone: "ok" | "danger" | "info" | "warn", content: string): HTMLDivElement {
  return el("div", { class: `notice notice-${tone}`, attrs: { role: "status" }, text: content });
}

// 原始文字區塊：用於引文、訊息全文、JSON 與讀回憑證，一律以純文字呈現，不做 Markdown 轉換。
export function rawText(source: string, className = "raw-text"): HTMLPreElement {
  return el("pre", { class: className, text: source });
}

export function button(
  label: string,
  onClick: (button: HTMLButtonElement, event: MouseEvent) => void,
  options: {
    variant?: ButtonVariant;
    disabled?: boolean;
    title?: string;
    class?: string;
    attrs?: ElProps["attrs"];
    data?: ElProps["data"];
  } = {},
): HTMLButtonElement {
  const node = document.createElement("button");
  node.type = "button";
  const classes = ["btn", options.variant ? `btn-${options.variant}` : ""];
  if (options.class) classes.push(options.class);
  node.className = classes.filter((value) => value !== "").join(" ");
  node.textContent = label;
  if (options.title !== undefined) node.title = options.title;
  applyCommon(node, { attrs: options.attrs, data: options.data });
  node.disabled = options.disabled === true;
  node.addEventListener("click", (event) => {
    onClick(node, event);
  });
  return node;
}

export function inputControl(props: FieldProps = {}): HTMLInputElement {
  const node = document.createElement("input");
  node.type = props.type ?? "text";
  applyCommon(node, props);
  if (props.name !== undefined) node.name = props.name;
  if (props.value !== undefined) node.value = props.value;
  if (props.placeholder !== undefined) node.placeholder = props.placeholder;
  if (props.title !== undefined) node.title = props.title;
  if (props.min !== undefined) node.min = props.min;
  if (props.max !== undefined) node.max = props.max;
  if (props.step !== undefined) node.step = props.step;
  if (props.accept !== undefined) node.accept = props.accept;
  node.required = props.required === true;
  node.disabled = props.disabled === true;
  node.readOnly = props.readOnly === true;
  return node;
}

export function textareaControl(props: FieldProps = {}): HTMLTextAreaElement {
  const node = document.createElement("textarea");
  applyCommon(node, props);
  if (props.name !== undefined) node.name = props.name;
  if (props.value !== undefined) node.value = props.value;
  if (props.placeholder !== undefined) node.placeholder = props.placeholder;
  if (props.title !== undefined) node.title = props.title;
  if (props.rows !== undefined) node.rows = props.rows;
  node.required = props.required === true;
  node.disabled = props.disabled === true;
  node.readOnly = props.readOnly === true;
  return node;
}

export function selectControl(
  props: FieldProps & { options: readonly SelectOption[] },
): HTMLSelectElement {
  const node = document.createElement("select");
  applyCommon(node, props);
  if (props.name !== undefined) node.name = props.name;
  if (props.title !== undefined) node.title = props.title;
  node.disabled = props.disabled === true;
  for (const option of props.options) {
    const optionNode = document.createElement("option");
    optionNode.value = option.value;
    optionNode.textContent = option.label;
    node.append(optionNode);
  }
  if (props.value !== undefined) node.value = props.value;
  return node;
}

export function labelled(text: string, control: HTMLElement): HTMLLabelElement {
  const label = el("label", { class: "field" }, [el("span", { class: "field-label", text })]);
  label.append(control);
  return label;
}

export function keyValueList(entries: readonly { key: string; value: Child }[]): HTMLDListElement {
  const list = el("dl", { class: "kv" });
  for (const entry of entries) {
    list.append(el("dt", { text: entry.key }), el("dd", {}, [entry.value]));
  }
  return list;
}

const INLINE_PATTERN = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\[[^\]\n]+\]\([^)\s]+\))/g;
// 只允許 http(s) 與 siyuan://，其餘（含 javascript:、data:）一律降級為純文字。
const ALLOWED_HREF = /^(https?:\/\/|siyuan:\/\/)/i;

function inlineToken(token: string): Child {
  if (token.length > 4 && token.startsWith("**") && token.endsWith("**")) {
    return el("strong", { text: token.slice(2, -2) });
  }
  if (token.length > 2 && token.startsWith("`") && token.endsWith("`")) {
    return el("code", { class: "inline-code", text: token.slice(1, -1) });
  }
  const link = /^\[([^\]\n]+)\]\(([^)\s]+)\)$/.exec(token);
  if (link) {
    const labelText = link[1] ?? "";
    const href = link[2] ?? "";
    if (ALLOWED_HREF.test(href)) {
      return el("a", {
        class: "md-link",
        attrs: { href, rel: "noreferrer noopener", target: "_blank" },
        text: labelText,
      });
    }
    return labelText;
  }
  return token;
}

function inlineNodes(source: string): Child[] {
  const nodes: Child[] = [];
  let cursor = 0;
  for (const match of source.matchAll(INLINE_PATTERN)) {
    const start = match.index ?? 0;
    if (start > cursor) nodes.push(source.slice(cursor, start));
    nodes.push(inlineToken(match[0]));
    cursor = start + match[0].length;
  }
  if (cursor < source.length) nodes.push(source.slice(cursor));
  return nodes;
}

// 最小但安全的 Markdown 子集：# 標題、有序/無序清單、引用、圍籬程式碼、水平線，
// 行內僅支援粗體、行內程式碼與 http(s)/siyuan 連結。原始 HTML 一律視為文字。
function markdownFragment(source: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.startsWith("```")) {
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !(lines[index] ?? "").startsWith("```")) {
        body.push(lines[index] ?? "");
        index += 1;
      }
      index += 1;
      fragment.append(el("pre", { class: "code-block" }, [el("code", { text: body.join("\n") })]));
      continue;
    }
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      fragment.append(el("hr"));
      index += 1;
      continue;
    }
    const headingMatch = /^(#{1,6})\s+(.+)$/.exec(line);
    if (headingMatch) {
      const level = Math.min(6, Math.max(1, (headingMatch[1] ?? "#").length));
      const headingNode = document.createElement(`h${level}`);
      headingNode.className = "md-heading";
      headingNode.append(...inlineNodes(headingMatch[2] ?? ""));
      fragment.append(headingNode);
      index += 1;
      continue;
    }
    if (/^\s*[-*+]\s+/.test(line)) {
      const list = el("ul", { class: "md-list" });
      while (index < lines.length && /^\s*[-*+]\s+/.test(lines[index] ?? "")) {
        const item = el("li");
        item.append(...inlineNodes((lines[index] ?? "").replace(/^\s*[-*+]\s+/, "")));
        list.append(item);
        index += 1;
      }
      fragment.append(list);
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const list = el("ol", { class: "md-list" });
      while (index < lines.length && /^\s*\d+\.\s+/.test(lines[index] ?? "")) {
        const item = el("li");
        item.append(...inlineNodes((lines[index] ?? "").replace(/^\s*\d+\.\s+/, "")));
        list.append(item);
        index += 1;
      }
      fragment.append(list);
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index] ?? "")) {
        quote.push((lines[index] ?? "").replace(/^\s*>\s?/, ""));
        index += 1;
      }
      const quoteNode = el("blockquote", { class: "md-quote" });
      quoteNode.append(...inlineNodes(quote.join(" ")));
      fragment.append(quoteNode);
      continue;
    }
    if (line.trim() === "") {
      index += 1;
      continue;
    }
    const buffer: string[] = [];
    while (index < lines.length) {
      const current = lines[index] ?? "";
      if (
        current.trim() === "" ||
        current.startsWith("```") ||
        /^(#{1,6})\s/.test(current) ||
        /^\s*([-*+]|\d+\.)\s+/.test(current) ||
        /^\s*>/.test(current)
      ) {
        break;
      }
      buffer.push(current);
      index += 1;
    }
    fragment.append(el("p", { class: "md-paragraph" }, inlineNodes(buffer.join("\n"))));
  }
  return fragment;
}

export function markdown(source: string): HTMLDivElement {
  const container = el("div", { class: "md" });
  container.append(markdownFragment(source));
  return container;
}
