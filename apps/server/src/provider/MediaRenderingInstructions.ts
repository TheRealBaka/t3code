/**
 * Tells an agent how to show images and videos inline in T3 Code chat. Claude
 * appends it to the Claude Code system prompt, Codex adds it to each turn's
 * developer instructions, and Pi receives it through `--append-system-prompt`.
 *
 * Keep it on one line with no double quotes. Pi takes it as a command-line
 * argument, and on Windows an npm-installed `pi.cmd` shim runs it through
 * cmd.exe, which cuts an argument off at the first newline and drops quotes.
 *
 * The claims mirror the renderer: `classifyMarkdownImageSource` in
 * client-runtime, the preview extensions in `@t3tools/shared/filePreview`, and
 * the workspace-root check in `AssetAccess`. Update this text when those change.
 */
export const T3_MEDIA_RENDERING_INSTRUCTIONS =
  "T3 Code renders Markdown images inline in chat. When a visual result helps the user, such as a screenshot, plot, diagram, or generated image or video, embed the file with `![short description](path/to/file.png)` written as plain Markdown, not inside a code span or block. Do not embed every file you touch. Relative paths resolve against your working directory. Absolute paths must point inside it, and files elsewhere, such as temp or home directories, will not render. Wrap a path that contains spaces in angle brackets, like `![demo](<out/my demo.mp4>)`. Supported images are .png .jpg .jpeg .gif .webp .svg .avif .ico. Videos in .mp4 .webm .mov .m4v .ogv use the same syntax and play inline. Remote http or https image URLs render directly, but remote videos do not.";
