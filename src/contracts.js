export const tools = [
  {
    name: "browser_inspect",
    description:
      "Inspect the current local portal page and save a real screenshot.",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "browser_click",
    description:
      "Click an exact visible link or button name in the current page.",
    input_schema: {
      type: "object",
      properties: {
        role: { type: "string", enum: ["link", "button"] },
        name: { type: "string" },
      },
      required: ["role", "name"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_fill",
    description:
      "Fill a form field using its exact visible label. Amounts are integer cents.",
    input_schema: {
      type: "object",
      properties: { label: { type: "string" }, value: { type: "string" } },
      required: ["label", "value"],
      additionalProperties: false,
    },
  },
];
const record = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value, maximum = 200) =>
  typeof value === "string" && value.length <= maximum && Boolean(value.trim());
const exact = (value, keys) =>
  record(value) &&
  Object.keys(value).sort().join(",") === keys.sort().join(",");

/** This parsed SDK boundary precedes every browser action; raw HTTP qualification follows separately. */
export function validateMessage(response, seenResponses, seenCalls) {
  if (
    !record(response) ||
    response.type !== "message" ||
    response.role !== "assistant" ||
    !text(response.id) ||
    !text(response.model) ||
    seenResponses.has(response.id) ||
    response.stop_sequence != null ||
    !Array.isArray(response.content) ||
    !response.content.length
  )
    throw new Error("Invalid or replayed native message");
  const calls = [],
    ids = new Set();
  let final = false;
  for (const block of response.content) {
    if (!record(block)) throw new Error("Invalid native content block");
    if (block.type === "thinking") {
      if (
        typeof block.thinking !== "string" ||
        block.thinking.length > 64000 ||
        (block.signature != null && typeof block.signature !== "string")
      )
        throw new Error("Invalid native thinking metadata");
      continue;
    }
    if (block.type === "redacted_thinking") {
      if (typeof block.data !== "string" || block.data.length > 64000)
        throw new Error("Invalid redacted thinking metadata");
      continue;
    }
    if (block.type === "text") {
      if (typeof block.text !== "string" || block.text.length > 64000)
        throw new Error("Invalid native text");
      final ||= Boolean(block.text.trim());
      continue;
    }
    if (
      block.type !== "tool_use" ||
      !text(block.id) ||
      seenCalls.has(block.id) ||
      ids.has(block.id)
    )
      throw new Error("Invalid or replayed browser tool call");
    const args = block.input;
    const valid =
      block.name === "browser_inspect"
        ? exact(args, [])
        : block.name === "browser_click"
          ? exact(args, ["role", "name"]) &&
            ["link", "button"].includes(args.role) &&
            text(args.name)
          : block.name === "browser_fill"
            ? exact(args, ["label", "value"]) &&
              text(args.label) &&
              typeof args.value === "string" &&
              args.value.length <= 2000
            : false;
    if (!valid)
      throw new Error("Unsupported or invalid browser tool arguments");
    ids.add(block.id);
    calls.push(block);
  }
  if (
    calls.length > 32 ||
    seenCalls.size + calls.length > 128 ||
    (calls.length
      ? response.stop_reason !== "tool_use"
      : response.stop_reason !== "end_turn" || !final)
  )
    throw new Error(
      "Native message did not complete its tool or final-answer turn",
    );
  for (const id of ids) seenCalls.add(id);
  seenResponses.add(response.id);
  return calls;
}
