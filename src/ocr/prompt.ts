export const TRANSCRIPTION_PROMPT = `Transcribe all handwritten and typed text verbatim.
Preserve the writing's structure, including headings, bullets, numbered lists, checkboxes, emphasis, line breaks, and reading order, as Markdown.
Do not correct, add, summarize, explain, or rephrase content.
Transcribe uncertain words best-effort and mark them with [?].
Return only the transcription.`;

const CUSTOM_DOCUMENT_PROMPT_FRAME = `The attached images are handwritten and/or typed note pages in reading order.
Follow the user's document instructions below.

{{instructions}}

Produce only the final Markdown document. Do not include a preamble or explanation.`;

export const customDocumentPrompt = (instructions: string): string =>
  CUSTOM_DOCUMENT_PROMPT_FRAME.replace("{{instructions}}", instructions.trim());
