// A unified diff as it comes from the server, in a scrollable block. The
// registry shows it before any owner decision (spec RU-11).
export function DiffBlock({ diff }: { diff: string }) {
  return (
    <pre className="bg-muted/50 max-h-96 overflow-auto rounded-md border border-border p-3 font-mono text-xs leading-relaxed">
      {diff}
    </pre>
  );
}
