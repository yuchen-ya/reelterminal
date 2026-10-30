import MDEditor, { commands } from "@uiw/react-md-editor/nohighlight";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import "./review-markdown.css";

const previewOptions = {
  skipHtml: false,
  pluginsFilter: ((type, plugins) => type === "rehype" ? [
    ...plugins.filter(plugin => (Array.isArray(plugin) ? plugin[0] : plugin) !== rehypeSanitize),
    ...plugins.filter(plugin => (Array.isArray(plugin) ? plugin[0] : plugin) === rehypeSanitize),
  ] : plugins) as NonNullable<React.ComponentProps<typeof MDEditor.Markdown>["pluginsFilter"]>,
  rehypePlugins: [rehypeSanitize],
  components: {
    a: ({ href, children }: { href?: string; children?: React.ReactNode }) =>
      <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
  },
};

export default function ReviewMarkdown({ source, editing = false, onChange, onLink, boardResources = false }: {
  source: string;
  editing?: boolean;
  onChange?: (value: string) => void;
  onLink?: (href: string) => void;
  boardResources?: boolean;
}) {
  const options = boardResources || onLink ? {
    skipHtml: false,
    pluginsFilter: previewOptions.pluginsFilter,
    rehypePlugins: boardResources ? [[rehypeSanitize, { ...defaultSchema, protocols: { ...defaultSchema.protocols, src: [...(defaultSchema.protocols?.src ?? []), "app"] } }]] : previewOptions.rehypePlugins,
    urlTransform: (url: string) => /^app:\/\/reelterminal\/review-media\/[\da-f-]+$/i.test(url) || !/^(?:javascript|vbscript|data):/i.test(url) ? url : "",
    components: { a: ({ href, children }: { href?: string; children?: React.ReactNode }) => <a href={href} target="_blank" rel="noopener noreferrer" onClick={onLink ? event => { event.preventDefault(); if (href) onLink(href); } : undefined}>{children}</a> },
  } : previewOptions;
  return <div className="review-markdown" data-testid={editing ? "review-markdown-editor" : "review-markdown-preview"}>
    {editing ? <MDEditor value={source} onChange={value => onChange?.(value ?? "")}
      height={420} minHeight={240} preview="live" autoFocus
      commands={[commands.bold, commands.italic, commands.title, commands.divider, commands.link,
        commands.quote, commands.code, commands.codeBlock, commands.unorderedListCommand,
        commands.orderedListCommand, commands.checkedListCommand, commands.table]}
      extraCommands={[commands.codeEdit, commands.codeLive, commands.codePreview]}
      textareaProps={{ "aria-label": "Markdown 原文" }}
      previewOptions={options as typeof previewOptions}
    /> : <MDEditor.Markdown source={source} {...options as typeof previewOptions} />}
  </div>;
}
