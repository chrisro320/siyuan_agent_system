import { expect, test } from "bun:test";
import { AppError, type Operation } from "../src/contracts";
import { AGENT_ATTR, AGENT_OWNER, type BlockReadback, SiyuanClient } from "../src/siyuan/client";
import { canonicalMarkdown, SiyuanWriter } from "../src/siyuan/writer";

function fixture() {
  const markdown =
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
    kramdown: markdown.replace(
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
