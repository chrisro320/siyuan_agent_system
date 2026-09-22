import { expect, test } from "bun:test";
import { AppError, type Operation } from "../src/contracts";
import { AGENT_ATTR, AGENT_OWNER, type BlockReadback, SiyuanClient } from "../src/siyuan/client";
import { canonicalMarkdown, SiyuanWriter } from "../src/siyuan/writer";

function fixture(readback: { markdown?: string; kramdown?: string } = {}) {
  const markdown =
    readback.markdown ??
    '{{{row\n## Decision\n\n> Source quote\n\n}}}\n{: id="20260921000000-block01" custom-agent-owner="siyuan-agent-system"}';
  const operation: Operation = {
    id: "operation",
    candidateId: "candidate",
    projectId: "project",
    contentKey: "content",
    kind: "append",
    notebookId: "notebook",
    path: "/Managed",
    rootPath: "/Managed",
    topic: "topic",
    documentId: "20260921000000-doc0001",
    blockId: "20260921000000-block01",
    markdown,
    expectedAttributes: {},
    status: "uncertain",
    receipt: null,
    error: null,
    createdAt: "2026-09-21T00:00:00Z",
    updatedAt: "2026-09-21T00:00:00Z",
  };
  let block: BlockReadback | null = {
    id: operation.blockId,
    rootId: operation.documentId,
    notebookId: operation.notebookId,
    hpath: "/Managed/Document",
    kramdown:
      readback.kramdown ??
      markdown.replace(
        "> Source quote",
        '> Source quote\n> {: id="20260921000000-child01" updated="20260921000000"}\n>\n{: id="20260921000000-quote01"}',
      ),
    attributes: {
      [AGENT_ATTR.owner]: AGENT_OWNER,
      [AGENT_ATTR.project]: "project",
      [AGENT_ATTR.operation]: "operation",
      [AGENT_ATTR.contentKey]: "content",
      [AGENT_ATTR.candidate]: "candidate",
    },
  };
  const client = new SiyuanClient({ url: "http://synthetic.invalid", token: null });
  client.getBlock = async () => block;
  // 同一份 Markdown 的渲染結果相同；種種離線測試只需要可預期的比較基準。
  client.renderMarkdown = async (source) => source;
  client.getTextMarkKramdown = async () => block?.kramdown ?? "";
  let writes = 0;
  client.appendOwnedBlock = async () => {
    writes++;
  };
  client.createDocument = async () => {
    writes++;
    return operation.documentId;
  };
  client.deleteBlock = async () => {
    writes++;
    block = null;
  };
  let saved = operation;
  const writer = new SiyuanWriter(
    client,
    (op) => {
      saved = structuredClone(op);
    },
    "http://localhost:8787",
  );
  return {
    client,
    operation,
    writer,
    get block() {
      return block;
    },
    set block(value) {
      block = value;
    },
    get writes() {
      return writes;
    },
    get saved() {
      return saved;
    },
  };
}

test("lost-response recovery accepts generated quotation IALs without another write", async () => {
  const f = fixture();
  const verified = await f.writer.execute(f.operation);
  expect(verified.status).toBe("verified");
  expect(verified.receipt?.markdown).toContain("child01");
  expect(f.writes).toBe(0);
  const undone = await f.writer.undo(verified);
  expect(undone.status).toBe("undone");
  expect(f.block).toBeNull();
});

test("a missing uncertain target is not permission to blindly append again", async () => {
  const f = fixture();
  f.block = null;
  await expect(f.writer.execute(f.operation)).rejects.toMatchObject({
    code: "write_outcome_unknown",
  });
  expect(f.saved.status).toBe("uncertain");
  expect(f.writes).toBe(0);
});

test("human content and attribute changes prevent deletion of a previously verified block", async () => {
  for (const change of ["content", "attributes"]) {
    const f = fixture();
    const verified = await f.writer.execute(f.operation);
    if (!f.block) throw new Error("fixture block missing");
    if (change === "content") f.block.kramdown += "\nHuman addition";
    else f.block.attributes["custom-human-note"] = "keep";
    await expect(f.writer.undo(verified)).rejects.toBeInstanceOf(AppError);
    expect(f.saved.status).toBe("conflict");
    expect(f.writes).toBe(0);
    expect(f.block).not.toBeNull();
  }
});

test("verified documents can move within their managed root without rewriting receipts", async () => {
  for (const change of ["move", "outside", "content"]) {
    const f = fixture();
    if (!f.block) throw new Error("fixture block missing");
    f.operation.kind = "create";
    f.operation.path = f.block.hpath;
    const verified = await f.writer.execute(f.operation);
    const receipt = structuredClone(verified.receipt);
    f.block.hpath = change === "outside" ? "/Elsewhere/Document" : "/Managed/Topic/Document";
    if (change === "content") f.block.kramdown += "\nHuman addition";
    if (change === "move") {
      const undone = await f.writer.undo(verified);
      expect(undone.status).toBe("undone");
      expect(undone.receipt).toEqual(receipt);
      expect(f.block).toBeNull();
    } else {
      await expect(f.writer.undo(verified)).rejects.toMatchObject({ code: "siyuan_conflict" });
      expect(f.writes).toBe(0);
      expect(f.block).not.toBeNull();
    }
  }
});

test("first publication still requires its exact planned document path", async () => {
  const f = fixture();
  f.operation.kind = "create";
  f.operation.path = "/Managed/OtherDocument";
  await expect(f.writer.execute(f.operation)).rejects.toMatchObject({ code: "siyuan_conflict" });
  expect(f.writes).toBe(0);
  expect(f.saved.receipt).toBeNull();
});

test("IAL-looking text inside code retains its meaning during read-back comparison", () => {
  const before = '```text\n{: id="example"}\n```';
  const after = '```text\n{: id="different"}\n```';
  expect(canonicalMarkdown(before)).not.toBe(canonicalMarkdown(after));
});

test("first read-back cannot lose paragraph boundaries or declared source properties", async () => {
  expect(canonicalMarkdown("a\n\nb")).not.toBe(canonicalMarkdown("a\nb"));
  const f = fixture();
  f.operation.expectedAttributes = {
    [AGENT_ATTR.source]: "original-source",
    [AGENT_ATTR.revision]: "original-revision",
  };
  await expect(f.writer.execute(f.operation)).rejects.toMatchObject({ code: "siyuan_conflict" });
  expect(f.writes).toBe(0);
});

/**
 * 思源（Lute）存檔時會在行內程式碼開頭前補一個零寬空格，並插入區塊 IAL。
 * 下面的計畫與讀回取自真實服務：計畫裡沒有任何零寬空格，讀回多了一個。
 */
const INLINE_CODE_PLAN =
  '{{{row\n## 決策\n\n每行以 `-` 開頭。\n\n標記 `truncated`。\n\n}}}\n{: id="20260921000000-block01" custom-agent-owner="siyuan-agent-system"}';
const INLINE_CODE_READBACK = [
  "{{{row",
  "## 決策",
  '{: id="20260921000000-heading01" updated="20260921000000"}',
  "",
  "每行以 \u200b`-` 開頭。",
  '{: id="20260921000000-para0001" updated="20260921000000"}',
  "",
  "標記 \u200b`truncated`。",
  '{: id="20260921000000-para0002" updated="20260921000000"}',
  "",
  "}}}",
  '{: id="20260921000000-block01" custom-agent-owner="siyuan-agent-system"}',
].join("\n");

test("zero-width space SiYuan adds at an inline-code boundary is not treated as a change", async () => {
  const f = fixture({ markdown: INLINE_CODE_PLAN, kramdown: INLINE_CODE_READBACK });
  const verified = await f.writer.execute(f.operation);
  expect(verified.status).toBe("verified");
  // 收據仍然是逐字讀回；撤回比對不會被放寬。
  expect(verified.receipt?.markdown).toBe(INLINE_CODE_READBACK);
  expect(f.writes).toBe(0);
  const undone = await f.writer.undo(verified);
  expect(undone.status).toBe("undone");
  expect(f.block).toBeNull();
});

test("only the boundary zero-width space is ignored, never the code or plain text", () => {
  expect(canonicalMarkdown("甲 `a` 乙")).toBe(canonicalMarkdown("甲 \u200b`a`\u200b 乙"));
  expect(canonicalMarkdown("甲 `a` 乙")).not.toBe(canonicalMarkdown("甲 `b` 乙"));
  expect(canonicalMarkdown("`a`")).not.toBe(canonicalMarkdown("`a\u200b`"));
  expect(canonicalMarkdown("甲\u200b乙")).not.toBe(canonicalMarkdown("甲乙"));
  // 跳脫後的字面反引號與未配對的反引號都不是行內程式碼，旁邊的零寬空格必須保留。
  expect(canonicalMarkdown("甲 \\`a\\`\u200b乙")).toBe("甲 \\`a\\`\u200b乙");
  expect(canonicalMarkdown("甲 \u200b`a 乙")).toBe("甲 \u200b`a 乙");
  const fenced = "```text\n說明 \u200b`a` 之後\n```";
  expect(canonicalMarkdown(fenced)).toBe(fenced);
  // 引用區塊裡的圍籬程式碼整段照抄比對，引用區塊裡的行內程式碼仍要正規化。
  const quoted = "> ```text\n> 甲 \u200b`b`\u200b 乙\n> ```";
  expect(canonicalMarkdown(quoted)).toBe(quoted);
  expect(canonicalMarkdown(quoted)).not.toBe(canonicalMarkdown("> ```text\n> 甲 `b` 乙\n> ```"));
  expect(canonicalMarkdown("> 引用 `code` 尾")).toBe(canonicalMarkdown("> 引用 \u200b`code` 尾"));
});

test("fence closure tolerates indentation changes within the same quote depth", async () => {
  const top = "說明\n\n   ```text\n甲 \u200b`b`\u200b 乙\n```\n\n尾端 `code`。";
  const quoted = "說明\n\n> ```text\n> 甲 \u200b`b`\u200b 乙\n>```\n\n尾端 `code`。";
  for (const markdown of [top, quoted]) {
    const f = fixture({
      markdown,
      kramdown: markdown.replace("尾端 `code`", "尾端 \u200b`code`"),
    });
    expect((await f.writer.execute(f.operation)).status).toBe("verified");
    expect(canonicalMarkdown(markdown)).toContain("甲 \u200b`b`\u200b 乙");
  }
});

test("changed inline-code content is still a conflict", async () => {
  const f = fixture({
    markdown: INLINE_CODE_PLAN,
    kramdown: INLINE_CODE_READBACK.replace("`truncated`", "`truncate`"),
  });
  await expect(f.writer.execute(f.operation)).rejects.toMatchObject({ code: "siyuan_conflict" });
  expect(f.saved.status).toBe("conflict");
  expect(f.writes).toBe(0);
});

test("a zero-width space in plain text is still a conflict", async () => {
  const f = fixture({
    markdown: INLINE_CODE_PLAN,
    kramdown: INLINE_CODE_READBACK.replace("標記", "標\u200b記"),
  });
  await expect(f.writer.execute(f.operation)).rejects.toMatchObject({ code: "siyuan_conflict" });
  expect(f.saved.status).toBe("conflict");
  expect(f.writes).toBe(0);
});

test("native textmark readback verifies serializer padding without weakening exact undo", async () => {
  const markdown = "<strong>項目）</strong>：保留  兩個空格";
  const kramdown = "<strong>項目）</strong> ：保留  兩個空格";
  const native = '<span data-type="strong">項目）</span>：保留  兩個空格';
  const renderer = new SiyuanClient({
    url: "http://synthetic.invalid",
    token: null,
    fetch: (async (_url, init) => {
      const input = JSON.parse(String(init?.body)) as { markdown: string };
      return Response.json({ code: 0, data: { html: Bun.markdown.html(input.markdown) } });
    }) as typeof fetch,
  });
  const f = fixture({ markdown, kramdown });
  f.client.renderMarkdown = renderer.renderMarkdown.bind(renderer);
  f.client.getTextMarkKramdown = async () => native;
  const verified = await f.writer.execute(f.operation);
  expect(verified.status).toBe("verified");
  expect(verified.receipt?.markdown).toBe(kramdown);
  expect(f.writes).toBe(0);
  if (!f.block) throw new Error("fixture block missing");
  f.block.kramdown = kramdown.replace("保留  ", "保留 ");
  await expect(f.writer.undo(verified)).rejects.toMatchObject({ code: "siyuan_conflict" });
  expect(f.writes).toBe(0);

  for (const changed of [native.replace("保留  ", "保留 "), native.replace("兩個", "三個")]) {
    const different = fixture({ markdown, kramdown });
    different.client.renderMarkdown = renderer.renderMarkdown.bind(renderer);
    different.client.getTextMarkKramdown = async () => changed;
    await expect(different.writer.execute(different.operation)).rejects.toMatchObject({
      code: "siyuan_conflict",
    });
    expect(different.writes).toBe(0);
  }
});
