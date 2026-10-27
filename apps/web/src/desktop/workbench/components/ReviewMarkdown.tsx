import MDEditor, { commands } from "@uiw/react-md-editor/nohighlight";
import rehypeSanitize from "rehype-sanitize";
import "./review-markdown.css";

const previewOptions = {
  rehypePlugins: [rehypeSanitize],
  components: {
    a: ({ href, children }: { href?: string; children?: React.ReactNode }) =>
      <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
  },
};

export default function ReviewMarkdown({ source, editing = false, onChange }: {
  source: string;
  editing?: boolean;
  onChange?: (value: string) => void;
}) {
  return <div className="review-markdown" data-testid={editing ? "review-markdown-editor" : "review-markdown-preview"}>
    {editing ? <MDEditor value={source} onChange={value => onChange?.(value ?? "")}
      height={420} minHeight={240} preview="live" autoFocus
      commands={[commands.bold, commands.italic, commands.title, commands.divider, commands.link,
        commands.quote, commands.code, commands.codeBlock, commands.unorderedListCommand,
        commands.orderedListCommand, commands.checkedListCommand, commands.table]}
      extraCommands={[commands.codeEdit, commands.codeLive, commands.codePreview]}
      textareaProps={{ "aria-label": "Markdown 原文" }}
      previewOptions={previewOptions}
    /> : <MDEditor.Markdown source={source} {...previewOptions} />}
  </div>;
}
